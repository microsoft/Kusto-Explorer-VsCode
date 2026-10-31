// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/*
 * This module implements the ImportManager class, which handles the logic
 * of importing connections and scratch pads from desktop Kusto Explorer
 * (from its local data folder or from files the user picks), and of exporting
 * and importing this extension's connections as JSON.
 * It is UI-free and host-independent — the Importer class handles prompts and
 * messages, and desktop-only access to %LOCALAPPDATA% lives in kustoExplorerLocalData.ts.
 */

import { XMLParser } from 'fast-xml-parser';
import { type ConnectionManager, isServerGroup } from './connectionManager';
import type { ServerInfo, ServerGroupInfo, ServerOrGroup } from './connectionManager';
import type { ScratchPadManager } from './scratchPadManager';
import { pathBaseName } from './fileStore';

// =============================================================================
// Constants
// =============================================================================

/** Default group name used by Kusto Explorer for ungrouped connections. */
const DEFAULT_GROUP_NAME = 'Connections';

/** Format marker of this extension's connections export file. */
export const CONNECTIONS_EXPORT_FORMAT = 'msKustoExplorer.connections';

// =============================================================================
// Types
// =============================================================================

/** Shape of a Kusto Explorer scratch pad recovery (.kebak) file. */
export interface KustoExplorerRecoveryFile {
    CustomTitle?: string;
    QueryText?: string;
    ConnectionString?: string;
    TabOrdinal?: number;
    FullPath?: string;
}

/** Result of importing connections. */
export interface ImportConnectionsResult {
    importedCount: number;
    skippedCount: number;
}

/** Result of importing scratch pads. */
export interface ImportScratchPadsResult {
    importedCount: number;
}

/** Contents of this extension's connections export file. */
export interface ConnectionsExport {
    format: typeof CONNECTIONS_EXPORT_FORMAT;
    version: 1;
    items: ServerOrGroup[];
}

/**
 * Read access to a desktop Kusto Explorer installation's data folder
 * (%LOCALAPPDATA%\Kusto.Explorer). Not available on the web.
 */
export interface IKustoExplorerLocalData {
    /** True if UserConnectionGroups.xml exists. */
    hasGroupsFile(): boolean;
    /** Contents of UserConnectionGroups.xml, or undefined if it doesn't exist. */
    readGroupsFile(): Promise<string | undefined>;
    /** Contents of a group connections file referenced by the groups file, or undefined if it doesn't exist. */
    readFile(filePath: string): Promise<string | undefined>;
    /** True if any scratch pad recovery (.kebak) file exists. */
    hasRecoveryFiles(): boolean;
    /** Raw contents of the scratch pad recovery (.kebak) files. */
    readRecoveryFiles(): string[];
}

/** A file picked by the user for import. */
export interface ImportFile {
    /** File name, used in messages. */
    name: string;
    text: string;
    /**
     * Reads a file referenced by path from inside this file (the group files listed
     * in a Kusto Explorer UserConnectionGroups.xml). Returns undefined if unreadable.
     */
    readReferencedFile?(filePath: string): Promise<string | undefined>;
}

/** What kind of content an import file holds. */
export type ImportFileKind = 'connectionsExport' | 'connectionsXml' | 'groupsXml' | 'recovery' | 'unknown';

/** Result of importing user-picked files. */
export interface ImportFilesResult {
    importedConnections: number;
    skippedConnections: number;
    importedScratchPads: number;
    /** Names of files whose content wasn't recognized. */
    unrecognizedFiles: string[];
    /** Group connection files referenced by a groups file that couldn't be read. */
    missingGroupFiles: string[];
    /** True if any file was a connections export, whose connections come without their secrets. */
    importedConnectionsExport: boolean;
}

/** A group of servers to import; an undefined name means the root level. */
interface ImportGroup {
    name: string | undefined;
    servers: ServerInfo[];
}

// =============================================================================
// ImportManager Class
// =============================================================================

/**
 * Handles the logic of importing connections and scratch pads from desktop Kusto Explorer,
 * and of exporting and importing this extension's connections.
 * This class is UI-free — the Importer class handles prompts and messages.
 */
export class ImportManager {
    /**
     * @param localData access to a local Kusto Explorer installation; undefined where
     *   the local file system isn't readable (the web build).
     */
    constructor(
        private readonly scratchPadManager: ScratchPadManager,
        private readonly connections: ConnectionManager,
        private readonly localData?: IKustoExplorerLocalData,
    ) {}

    // ─── Discovery ───────────────────────────────────────────────────

    /** True if a local Kusto Explorer installation can be read on this host. */
    get canReadKustoExplorerData(): boolean {
        return this.localData !== undefined;
    }

    /** Returns true if there are connections from Kusto Explorer to import. */
    hasConnectionsToImport(): boolean {
        return this.localData?.hasGroupsFile() ?? false;
    }

    /** Returns true if there are scratch pads from Kusto Explorer to import. */
    hasScratchPadsToImport(): boolean {
        return this.localData?.hasRecoveryFiles() ?? false;
    }

    /** Returns the number of scratch pads from Kusto Explorer to import. */
    getScratchPadsToImportCount(): number {
        return this.getScratchPadRecoveryFiles()?.length ?? 0;
    }

    // ─── Import Connections ──────────────────────────────────────────

    /**
     * Imports connections from Kusto Explorer.
     * Reads the groups XML, parses each group's connections file, and adds
     * servers to the ConnectionManager, skipping duplicates.
     * @returns The result with imported and skipped counts, or undefined if no groups file found.
     */
    async importConnections(): Promise<ImportConnectionsResult | undefined> {
        const groupsXml = await this.localData?.readGroupsFile();
        if (groupsXml === undefined) {
            return undefined;
        }

        const groups = parseGroupsXml(groupsXml);
        if (groups.length === 0) {
            return { importedCount: 0, skippedCount: 0 };
        }

        const importGroups: ImportGroup[] = [];
        for (const group of groups) {
            const xml = await this.localData!.readFile(group.filePath);
            if (xml === undefined) {
                continue;
            }
            importGroups.push(await this.toImportGroup(group.name, xml));
        }

        return this.importGroups(importGroups);
    }

    /** Parses a Kusto Explorer connections XML file into a group to import. */
    private async toImportGroup(groupName: string | undefined, xml: string): Promise<ImportGroup> {
        const servers = await parseConnectionsXml(xml, this.connections);
        return { name: groupName === DEFAULT_GROUP_NAME ? undefined : groupName, servers };
    }

    /** Adds servers to the ConnectionManager, creating groups as needed and skipping duplicate clusters. */
    private async importGroups(groups: ImportGroup[]): Promise<ImportConnectionsResult> {
        let importedCount = 0;
        let skippedCount = 0;

        for (const group of groups) {
            if (group.servers.length === 0) {
                continue;
            }

            // Ensure the group exists (unless it's the root level)
            if (group.name !== undefined) {
                const existing = this.connections.getServersAndGroups();
                const groupExists = existing.items.some(
                    item => isServerGroup(item) && item.name === group.name
                );
                if (!groupExists) {
                    const newGroup: ServerGroupInfo = { name: group.name, servers: [] };
                    await this.connections.addServerGroup(newGroup);
                }
            }

            for (const server of group.servers) {
                // Check for duplicates by cluster hostname
                if (this.connections.findServerInfo(server.cluster)) {
                    skippedCount++;
                    continue;
                }

                await this.connections.addServer(server, group.name);
                importedCount++;
            }
        }

        return { importedCount, skippedCount };
    }

    // ─── Import Scratch Pads ─────────────────────────────────────────

    /**
     * Gets the list of recoverable scratch pad files from Kusto Explorer.
     * Returns undefined if none are found.
     */
    private getScratchPadRecoveryFiles(): KustoExplorerRecoveryFile[] | undefined {
        if (!this.localData?.hasRecoveryFiles()) {
            return undefined;
        }

        const entries: KustoExplorerRecoveryFile[] = [];
        for (const raw of this.localData.readRecoveryFiles()) {
            const entry = parseRecoveryFile(raw);
            if (entry) {
                entries.push(entry);
            }
        }

        if (entries.length === 0) {
            return undefined;
        }

        // Sort by tab ordinal to preserve the user's tab order
        entries.sort((a, b) => (a.TabOrdinal ?? 0) - (b.TabOrdinal ?? 0));
        return entries;
    }

    /**
     * Imports scratch pad recovery files as scratch pad documents.
     * @returns The result with imported count, or undefined if no recovery files found.
     */
    async importScratchPads(): Promise<ImportScratchPadsResult | undefined> {
        const recoveryFiles = this.getScratchPadRecoveryFiles();
        if (!recoveryFiles) {
            return undefined;
        }

        const importedCount = await this.importRecoveryFiles(recoveryFiles);
        return { importedCount };
    }

    /**
     * Imports a list of recovery files as scratch pad files.
     * Returns the number of successfully imported entries.
     */
    private async importRecoveryFiles(recoveryFiles: KustoExplorerRecoveryFile[]): Promise<number> {
        let importedCount = 0;
        for (const recoveryFile of recoveryFiles) {
            // Resolve the connection first so we can use the friendly name for naming
            let cluster: string | undefined;
            let database: string | undefined;
            if (recoveryFile.ConnectionString) {
                try {
                    cluster = await this.connections.getHostName(recoveryFile.ConnectionString);
                    database = parseDatabaseFromConnectionString(recoveryFile.ConnectionString);
                    if (cluster && !this.connections.findServerInfo(cluster)) {
                        const server: ServerInfo = {
                            connection: recoveryFile.ConnectionString,
                            cluster,
                        };
                        const serverKind = await this.connections.fetchServerKind(recoveryFile.ConnectionString);
                        if (serverKind) {
                            server.serverKind = serverKind;
                        }
                        await this.connections.addServer(server);
                    }
                } catch {
                    // Connection resolution is best-effort; don't block import
                }
            }

            // Determine the scratch pad name:
            // 1. Use CustomTitle if the user named it
            // 2. Derive from connection.database (matching Kusto Explorer's convention)
            // 3. Fall back to auto-naming (ScratchPad<N>)
            const customTitle = recoveryFile.CustomTitle?.trim() || null;
            let name: string | null;
            if (customTitle) {
                name = sanitizeFileName(customTitle);
            } else if (cluster) {
                const serverInfo = this.connections.findServerInfo(cluster);
                const connectionName = serverInfo?.displayName ?? cluster;
                name = database ? sanitizeFileName(`${connectionName}.${database}`) : sanitizeFileName(connectionName);
            } else {
                name = null;
            }

            const finalName = await this.scratchPadManager.addScratchPadFile(name, recoveryFile.QueryText!);

            // Associate the connection with the new scratch pad
            if (cluster) {
                try {
                    const scratchUri = `msKustoExplorer-scratch:/${finalName}`;
                    await this.connections.setDocumentConnection(scratchUri, cluster, database);
                } catch {
                    // Connection association is best-effort; don't block import
                }
            }

            importedCount++;
        }
        return importedCount;
    }

    // ─── Import from Files ───────────────────────────────────────────

    /**
     * Imports user-picked files: Kusto Explorer connection files (UserConnections.xml,
     * group files, or UserConnectionGroups.xml), Kusto Explorer scratch pad recovery
     * (.kebak) files, and this extension's connections export (JSON).
     */
    async importFiles(files: ImportFile[]): Promise<ImportFilesResult> {
        const result: ImportFilesResult = {
            importedConnections: 0,
            skippedConnections: 0,
            importedScratchPads: 0,
            unrecognizedFiles: [],
            missingGroupFiles: [],
            importedConnectionsExport: false,
        };
        const recoveryFiles: KustoExplorerRecoveryFile[] = [];

        // Groups files go first so a group file picked together with its UserConnectionGroups.xml
        // is imported once, into its group, rather than again at the root level.
        const classified = files.map(file => ({ file, kind: classifyImportFile(file.text) }));
        classified.sort((a, b) => Number(b.kind === 'groupsXml') - Number(a.kind === 'groupsXml'));
        const referencedFileNames = new Set<string>();

        for (const { file, kind } of classified) {
            const groups: ImportGroup[] = [];
            switch (kind) {
                case 'connectionsExport':
                    groups.push(...exportToImportGroups(JSON.parse(file.text) as ConnectionsExport));
                    result.importedConnectionsExport = true;
                    break;
                case 'connectionsXml':
                    if (!referencedFileNames.has(file.name.toLowerCase())) {
                        groups.push(await this.toImportGroup(undefined, file.text));
                    }
                    break;
                case 'groupsXml':
                    for (const group of parseGroupsXml(file.text)) {
                        const xml = await file.readReferencedFile?.(group.filePath);
                        if (xml === undefined) {
                            result.missingGroupFiles.push(group.filePath);
                            continue;
                        }
                        referencedFileNames.add(pathBaseName(group.filePath).toLowerCase());
                        groups.push(await this.toImportGroup(group.name, xml));
                    }
                    break;
                case 'recovery': {
                    const entry = parseRecoveryFile(file.text);
                    if (entry) {
                        recoveryFiles.push(entry);
                    }
                    break;
                }
                default:
                    result.unrecognizedFiles.push(file.name);
                    break;
            }

            const counts = await this.importGroups(groups);
            result.importedConnections += counts.importedCount;
            result.skippedConnections += counts.skippedCount;
        }

        recoveryFiles.sort((a, b) => (a.TabOrdinal ?? 0) - (b.TabOrdinal ?? 0));
        result.importedScratchPads = await this.importRecoveryFiles(recoveryFiles);
        return result;
    }

    // ─── Export Connections ──────────────────────────────────────────

    /**
     * Serializes all configured servers and groups to this extension's JSON export format.
     * Secrets (passwords, application keys, tokens, certificate private keys) are removed
     * from the connection strings so the file is safe to share.
     */
    exportConnections(): string {
        const stripServer = (server: ServerInfo): ServerInfo =>
            ({ ...server, connection: removeConnectionStringSecrets(server.connection) });
        const data: ConnectionsExport = {
            format: CONNECTIONS_EXPORT_FORMAT,
            version: 1,
            items: this.connections.getServersAndGroups().items.map(item =>
                isServerGroup(item) ? { ...item, servers: item.servers.map(stripServer) } : stripServer(item)),
        };
        return JSON.stringify(data, null, 2);
    }
}

// =============================================================================
// Pure Parsing Functions
// =============================================================================

const xmlParser = new XMLParser();

/**
 * Sanitizes a string for use as a filename by removing characters
 * that are invalid on Windows/macOS/Linux.
 */
export function sanitizeFileName(name: string): string {
    return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim() || 'ScratchPad';
}

/**
 * Extracts the database name (Initial Catalog) from a Kusto connection string.
 * Returns undefined if the database is "NetDefaultDB" (Kusto Explorer's placeholder).
 */
export function parseDatabaseFromConnectionString(connectionString: string): string | undefined {
    const match = connectionString.match(/Initial Catalog\s*=\s*([^;]+)/i);
    const database = match?.[1]?.trim();
    if (!database || database === 'NetDefaultDB') {
        return undefined;
    }
    return database;
}

/**
 * Secret-bearing connection string keywords and their aliases, lowercased with whitespace
 * removed. Taken from the keywords Kusto.Data's KustoConnectionStringBuilder masks
 * (Password, Application Key, Application Token, User Token) plus the certificate private
 * key keyword azure-kusto-data marks as secret. A client secret is the Application Key.
 */
export const SECRET_CONNECTION_STRING_KEYWORDS: ReadonlySet<string> = new Set([
    'password', 'pwd',
    'applicationkey', 'appkey',
    'applicationtoken', 'apptoken',
    'usertoken', 'usrtoken',
    'applicationcertificateprivatekey',
]);

/**
 * Removes secret-bearing `keyword=value` parts from a Kusto connection string, keeping every
 * other part verbatim. Keywords match case-insensitively and ignoring whitespace. Values may be
 * quoted with ' or " (a doubled quote escapes it), so a quoted secret containing ';' is removed
 * whole; an unterminated quote removes the rest of the string.
 */
export function removeConnectionStringSecrets(connectionString: string): string {
    const kept: string[] = [];
    let removed = false;
    let i = 0;
    while (i < connectionString.length) {
        const start = i;
        // Keyword: up to the first '=' that isn't doubled ('==' is a literal '=' in a keyword).
        let eq = -1;
        while (i < connectionString.length && connectionString[i] !== ';') {
            if (connectionString[i] === '=') {
                if (connectionString[i + 1] === '=') {
                    i += 2;
                    continue;
                }
                eq = i;
                break;
            }
            i++;
        }
        if (eq >= 0) {
            i = eq + 1;
            while (i < connectionString.length && /\s/.test(connectionString[i]!)) {
                i++;
            }
            const quote = connectionString[i];
            if (quote === '"' || quote === "'") {
                i++;
                while (i < connectionString.length) {
                    if (connectionString[i] === quote) {
                        if (connectionString[i + 1] !== quote) {
                            break;
                        }
                        i++;
                    }
                    i++;
                }
            }
            while (i < connectionString.length && connectionString[i] !== ';') {
                i++;
            }
        }
        const part = connectionString.substring(start, i);
        i++;
        const keyword = eq >= 0 ? connectionString.substring(start, eq).replace(/==/g, '=').replace(/\s+/g, '').toLowerCase() : undefined;
        if (keyword !== undefined && SECRET_CONNECTION_STRING_KEYWORDS.has(keyword)) {
            removed = true;
        } else {
            kept.push(part);
        }
    }
    return removed ? kept.join(';') : connectionString;
}

/**
 * Parses UserConnectionGroups.xml to get group names and their connection file paths.
 */
export function parseGroupsXml(xml: string): { name: string; filePath: string }[] {
    const doc = xmlParser.parse(xml);
    const entries = doc?.ArrayOfServerGroupDescription?.ServerGroupDescription;
    if (!entries) { return []; }
    const list = Array.isArray(entries) ? entries : [entries];
    return list
        .filter((e: any) => e.Name && e.Details)
        .map((e: any) => ({
            name: e.Name as string,
            filePath: e.Details as string,
        }));
}

/**
 * Parses a UserConnections.xml (or group connections file) into ServerInfo[].
 */
export async function parseConnectionsXml(xml: string, connections: ConnectionManager): Promise<ServerInfo[]> {
    const doc = xmlParser.parse(xml);
    const entries = doc?.ArrayOfServerDescriptionBase?.ServerDescriptionBase;
    if (!entries) { return []; }
    const list = Array.isArray(entries) ? entries : [entries];

    const results: ServerInfo[] = [];
    for (const entry of list) {
        const connectionString = entry.ConnectionString;
        if (!connectionString) { continue; }

        const cluster = await connections.getHostName(connectionString);
        const displayName = entry.Name as string | undefined;

        const server: ServerInfo = {
            connection: connectionString,
            cluster,
        };

        // Use the KE display name if it differs from the cluster hostname
        if (displayName && displayName !== cluster) {
            server.displayName = displayName;
        }

        // Fetch server kind (e.g. DataManager, ClusterManager) from the server API
        const serverKind = await connections.fetchServerKind(connectionString);
        if (serverKind) {
            server.serverKind = serverKind;
        }

        results.push(server);
    }

    return results;
}

/**
 * Parses a Kusto Explorer scratch pad recovery (.kebak) file. Returns undefined for
 * malformed files and for documents that were saved to disk (they have a FullPath and
 * are only recovery backups).
 */
export function parseRecoveryFile(raw: string): KustoExplorerRecoveryFile | undefined {
    try {
        const entry: KustoExplorerRecoveryFile = JSON.parse(raw);
        if (entry?.QueryText?.trim() && !entry.FullPath?.trim()) {
            return entry;
        }
    } catch {
        // Malformed file
    }
    return undefined;
}

/** Determines what an import file holds from its content. */
export function classifyImportFile(text: string): ImportFileKind {
    const trimmed = text.replace(/^\uFEFF/, '').trimStart();
    if (trimmed.startsWith('{')) {
        try {
            const json = JSON.parse(trimmed);
            if (json?.format === CONNECTIONS_EXPORT_FORMAT && Array.isArray(json.items)) {
                return 'connectionsExport';
            }
            if (typeof json?.QueryText === 'string') {
                return 'recovery';
            }
        } catch {
            // Not JSON
        }
        return 'unknown';
    }
    if (trimmed.startsWith('<')) {
        if (/<ArrayOfServerGroupDescription[\s>]/.test(trimmed)) {
            return 'groupsXml';
        }
        if (/<ArrayOfServerDescriptionBase[\s>]/.test(trimmed)) {
            return 'connectionsXml';
        }
    }
    return 'unknown';
}

/** Converts a connections export into groups to import, keeping only well-formed entries and known fields. */
function exportToImportGroups(data: ConnectionsExport): ImportGroup[] {
    const toServers = (items: unknown[]): ServerInfo[] => items.flatMap(item => {
        const s = item as Partial<ServerInfo> | null;
        if (typeof s?.connection !== 'string' || typeof s.cluster !== 'string' || !s.cluster) {
            return [];
        }
        const server: ServerInfo = { connection: s.connection, cluster: s.cluster };
        if (typeof s.displayName === 'string') { server.displayName = s.displayName; }
        if (typeof s.serverKind === 'string') { server.serverKind = s.serverKind; }
        return [server];
    });

    const root: ImportGroup = { name: undefined, servers: [] };
    const groups: ImportGroup[] = [root];
    for (const item of data.items as unknown[]) {
        const group = item as Partial<ServerGroupInfo> | null;
        if (typeof group?.name === 'string' && Array.isArray(group.servers)) {
            groups.push({ name: group.name, servers: toServers(group.servers) });
        } else {
            root.servers.push(...toServers([item]));
        }
    }
    return groups;
}

