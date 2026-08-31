// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/*
 * This module manages the data layer for Kusto server connections and per-document connection assignments.
 * Connections (servers and groups) are persisted in globalState; document-to-connection mappings are in workspaceState.
 * It also provides database schema caching and event notifications when connections change.
 */

import * as vscode from 'vscode';
import type { IServer, DatabaseInfo } from './server';

// =============================================================================
// Storage Keys
// =============================================================================

const SERVERS_STORAGE_KEY = 'kusto.serversAndGroups';
const DOCUMENT_CONNECTIONS_KEY = 'kusto.documentConnections';

// =============================================================================
// Data Types
// =============================================================================

/** Connection info for a single document (URI  cluster/database mapping). */
export interface DocumentConnection {
    uri: string;
    cluster: string | undefined;
    database: string | undefined;
}

/** Info about a configured server connection. */
export interface ServerInfo {
    connection: string;
    cluster: string;
    displayName?: string;
    serverKind?: string;
}

/** A named group of server connections. */
export interface ServerGroupInfo {
    name: string;
    servers: ServerInfo[];
}

/** A server or a group of servers. */
export type ServerOrGroup = ServerInfo | ServerGroupInfo;

/** Top-level structure for persisted servers and groups. */
export interface ServersAndGroupsData {
    items: ServerOrGroup[];
}

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Type guard to check if an item is a ServerGroupInfo.
 */
export function isServerGroup(item: ServerOrGroup): item is ServerGroupInfo {
    return 'servers' in item;
}

/**
 * Type guard to check if an item is a ServerInfo.
 */
export function isServer(item: ServerOrGroup): item is ServerInfo {
    return 'cluster' in item;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Matches a connection string that already carries an http(s) scheme.
 *
 * URL schemes are case-insensitive, so `HTTPS://cluster` is as valid as the lowercase
 * form. Testing with `startsWith('https://')` misses those and misses `http://` entirely,
 * and the consequence is silent rather than loud: prepending a second scheme yields
 * `https://HTTPS://cluster`, which `new URL()` parses without throwing and reports a
 * hostname of `https`. The catch-block fallback never fires, so the caller receives a
 * confidently wrong cluster name.
 */
const HAS_URL_SCHEME = /^https?:\/\//i;

/**
 * Simple synchronous cluster URI extraction for fallback scenarios.
 *
 * Returns the bare host name for an ordinary cluster, but preserves the whole
 * resource-scoped URI for an Azure Data Explorer proxy endpoint. Log Analytics and
 * Application Insights are reached through that proxy, and the routing target lives in
 * the URI path rather than the host:
 *
 *   https://ade.loganalytics.io/subscriptions/{sub}/resourcegroups/{rg}/providers/microsoft.operationalinsights/workspaces/{workspace}
 *   https://ade.applicationinsights.io/subscriptions/{sub}/resourcegroups/{rg}/providers/microsoft.insights/components/{app}
 *
 * Reducing those to `ade.loganalytics.io` yields the proxy front door, which is not a
 * routable cluster on its own.
 *
 * @param connection The connection string (URL or hostname)
 * @returns The cluster host name, or the full resource-scoped cluster URI
 */
function getHostNameSimple(connection: string): string {
    let dataSource = connection;
    const connectionParts = connection.split(';');
    if (connectionParts.length > 1) {
        // Connection string with parameters; find the "Data Source" part
        const dataSourcePart = connectionParts.find(part => part.trim().toLowerCase().startsWith('data source='));
        if (dataSourcePart) {
            const dsParts = dataSourcePart.split('=');
            if (dsParts.length > 1 && dsParts[1]) {
                dataSource = dsParts[1].trim();
            }
        }
        else if (connectionParts[0]) {
            // no Data Source part; assume first part is the data source
            dataSource = connectionParts[0].trim();
        }
    }
    else if (connectionParts.length > 0 && connectionParts[0]) {
        dataSource = connectionParts[0].trim();
    }
    try {
        const url = new URL(HAS_URL_SCHEME.test(dataSource) ? dataSource : `https://${dataSource}`);
        // A single path segment is a database (https://cluster/mydb), not a resource path,
        // so only multi-segment paths identify a proxy-routed resource.
        const path = url.pathname.replace(/^\/+|\/+$/g, '');
        if (path.includes('/')) {
            return `${url.protocol}//${url.host}/${path}`;
        }
        return url.hostname;
    } catch {
        // If it's not a valid URL, return as-is (might already be just a hostname)
        return dataSource;
    }
}

/**
 * Returns the workspace/component name a resource-scoped proxy cluster URI ends with,
 * or undefined when the cluster is an ordinary host name.
 */
function getResourceScopedName(cluster: string): string | undefined {
    if (!HAS_URL_SCHEME.test(cluster)) {
        return undefined;
    }
    try {
        const segments = new URL(cluster).pathname.split('/').filter(segment => segment.length > 0);
        return segments.length > 1 ? segments[segments.length - 1] : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Gets the suggested display name for a cluster.
 * For a resource-scoped proxy cluster URI, returns the workspace/component name, since the
 * full resource path is unreadable in the connections tree.
 * Otherwise, if the cluster ends with the configured default domain, returns the short name;
 * failing that returns undefined (meaning no special display name is needed).
 * @param cluster The cluster hostname or resource-scoped cluster URI
 * @returns The suggested display name, or undefined if the cluster name should be used as-is
 */
export function getDisplayName(cluster: string): string | undefined {
    const resourceScopedName = getResourceScopedName(cluster);
    if (resourceScopedName) {
        return resourceScopedName;
    }
    const defaultDomain = vscode.workspace.getConfiguration('msKustoExplorer').get<string>('defaultDomain', '.kusto.windows.net');
    if (defaultDomain && cluster.endsWith(defaultDomain)) {
        const shortName = cluster.substring(0, cluster.length - defaultDomain.length);
        if (shortName && shortName !== cluster) {
            return shortName;
        }
    }
    return undefined;
}

// =============================================================================
// ConnectionManager Class
// =============================================================================

/*
 * Manages a list of Kusto server connections and groups,
 * and all per-document connection associations.
 */
export class ConnectionManager {
    private readonly documentConnectionChangedListeners: ((uri: string) => Promise<void>)[] = [];
    private readonly serversAndGroupsChangedListeners: (() => void)[] = [];
    private readonly documentConnections = new Map<string, DocumentConnection>();
    private serversAndGroups: ServersAndGroupsData = { items: [] };
    // Array with linear search. Cluster count is small (typically <20) so Map overhead isn't warranted.
    private clusterConnections: { cluster: string, connection: string, databases?: DatabaseInfo[] }[] = [];

    constructor(private readonly context: vscode.ExtensionContext, private readonly server: IServer) {
    }

    // =========================================================================
    // Hostname Resolution
    // =========================================================================

    /**
     * Extracts the cluster identity from a connection string using the language server.
     * Falls back to simple parsing if the language client is not available.
     * @param connection The connection string (URL or hostname)
     * @returns The cluster hostname, or the full resource-scoped cluster URI for a proxy endpoint
     */
    async getHostName(connection: string): Promise<string> {
        try {
            const result = await this.server.decodeConnectionString(connection);
            if (result?.cluster) {
                return result.cluster;
            }
        } catch {
            // Fall through to simple parsing
        }
        return getHostNameSimple(connection);
    }

    // =========================================================================
    // Event Registration
    // =========================================================================

    /**
     * Registers a listener that is called after a document connection changes.
     * Multiple listeners can be registered.
     */
    registerOnDocumentConnectionChanged(callback: (uri: string) => Promise<void>): vscode.Disposable {
        this.documentConnectionChangedListeners.push(callback);
        return new vscode.Disposable(() => {
            const index = this.documentConnectionChangedListeners.indexOf(callback);
            if (index >= 0) this.documentConnectionChangedListeners.splice(index, 1);
        });
    }

    /**
     * Registers a listener that is called when servers and groups data changes.
     * Multiple listeners can be registered.
     */
    registerOnServersAndGroupsChanged(callback: () => void): vscode.Disposable {
        this.serversAndGroupsChangedListeners.push(callback);
        return new vscode.Disposable(() => {
            const index = this.serversAndGroupsChangedListeners.indexOf(callback);
            if (index >= 0) this.serversAndGroupsChangedListeners.splice(index, 1);
        });
    }

    /** Raises the document connection changed event for all registered listeners. */
    private async raiseDocumentConnectionChanged(uri: string): Promise<void> {
        for (const listener of this.documentConnectionChangedListeners) {
            await listener(uri);
        }
    }

    /** Raises the servers and groups changed event for all registered listeners. */
    private raiseServersAndGroupsChanged(): void {
        for (const listener of this.serversAndGroupsChangedListeners) listener();
    }

    // =========================================================================
    // Servers and Groups Management
    // =========================================================================

    /**
     * Loads servers and groups data from global state.
     */
    loadServersAndGroups(): void {
        const data = this.context.globalState.get<ServersAndGroupsData>(SERVERS_STORAGE_KEY);
        this.serversAndGroups = data ?? { items: [] };
    }

    /**
     * Saves servers and groups data to global state and notifies the language server.
     */
    private async saveServersAndGroups(): Promise<void> {
        await this.context.globalState.update(SERVERS_STORAGE_KEY, this.serversAndGroups);
        const connectionsList = this.getConfiguredConnections();
        this.server.sendConnectionsUpdated(connectionsList);
    }

    /**
     * Gets the servers and groups data structure.
     */
    getServersAndGroups(): ServersAndGroupsData {
        return this.serversAndGroups;
    }

    /**
     * Sorts the servers and groups data structure.
     * Groups are sorted alphabetically, then root-level servers.
     * Servers within each group are also sorted alphabetically.
     */
    private sortServersAndGroups(): void {
        const getServerSortName = (s: ServerInfo) => (s.displayName ?? s.cluster).toLowerCase();
        const getGroupSortName = (g: ServerGroupInfo) => g.name.toLowerCase();

        // Sort servers within each group
        for (const item of this.serversAndGroups.items) {
            if (isServerGroup(item)) {
                item.servers.sort((a, b) => getServerSortName(a).localeCompare(getServerSortName(b)));
            }
        }

        // Separate groups and root-level servers
        const groups = this.serversAndGroups.items.filter(isServerGroup);
        const servers = this.serversAndGroups.items.filter(isServer);

        // Sort each separately
        groups.sort((a, b) => getGroupSortName(a).localeCompare(getGroupSortName(b)));
        servers.sort((a, b) => getServerSortName(a).localeCompare(getServerSortName(b)));

        // Rebuild with servers first, then groups
        this.serversAndGroups.items = [...servers, ...groups];
    }

    /**
     * Adds a new server to the root level or to a specific group.
     */
    async addServer(server: ServerInfo, groupName?: string): Promise<void> {
        if (groupName) {
            const group = this.serversAndGroups.items.find(
                item => isServerGroup(item) && item.name === groupName
            ) as ServerGroupInfo | undefined;
            if (group) {
                group.servers.push(server);
            }
        } else {
            this.serversAndGroups.items.push(server);
        }

        this.sortServersAndGroups();
        await this.saveServersAndGroups();
        this.raiseServersAndGroupsChanged();
    }

    /**
     * Ensures a server entry exists for the given connection string.
     * If no server with the corresponding cluster hostname is found, creates one
     * (with display name and server kind) and adds it to the root level.
     * @param connectionString The connection string for the server
     */
    async ensureServer(connectionString: string): Promise<void> {
        const cluster = await this.getHostName(connectionString);
        if (this.findServerInfo(cluster)) {
            return;
        }

        const newServer: ServerInfo = {
            connection: connectionString,
            cluster: cluster
        };

        const displayName = getDisplayName(cluster);
        if (displayName) {
            newServer.displayName = displayName;
        }

        const serverKind = await this.fetchServerKind(connectionString);
        if (serverKind) {
            newServer.serverKind = serverKind;
        }

        await this.addServer(newServer);
    }

    /**
     * Adds a new server group.
     */
    async addServerGroup(group: ServerGroupInfo): Promise<void> {
        this.serversAndGroups.items.push(group);
        this.sortServersAndGroups();
        await this.saveServersAndGroups();
        this.raiseServersAndGroupsChanged();
    }

    /**
     * Removes a server from the root level or from a specific group.
     */
    async removeServer(cluster: string, groupName?: string): Promise<void> {
        if (groupName) {
            const group = this.serversAndGroups.items.find(
                item => isServerGroup(item) && item.name === groupName
            ) as ServerGroupInfo | undefined;
            if (group) {
                group.servers = group.servers.filter(s => s.cluster !== cluster);
            }
        } else {
            this.serversAndGroups.items = this.serversAndGroups.items.filter(
                item => !(isServer(item) && item.cluster === cluster)
            );
        }

        // Also remove from connections cache
        this.clusterConnections = this.clusterConnections.filter(c => c.cluster !== cluster);

        await this.saveServersAndGroups();
        this.raiseServersAndGroupsChanged();
    }

    /**
     * Removes a server group and all its servers.
     */
    async removeServerGroup(groupName: string): Promise<void> {
        const group = this.serversAndGroups.items.find(
            item => isServerGroup(item) && item.name === groupName
        ) as ServerGroupInfo | undefined;

        // Remove servers from connections cache
        if (group) {
            const clusterNames = group.servers.map(s => s.cluster);
            this.clusterConnections = this.clusterConnections.filter(c => !clusterNames.includes(c.cluster));
        }

        this.serversAndGroups.items = this.serversAndGroups.items.filter(
            item => !(isServerGroup(item) && item.name === groupName)
        );

        await this.saveServersAndGroups();
        this.raiseServersAndGroupsChanged();
    }

    /**
     * Moves a server from one location to another.
     */
    async moveServer(cluster: string, sourceGroupName?: string, targetGroupName?: string): Promise<void> {
        let serverInfo: ServerInfo | undefined;

        if (sourceGroupName) {
            const sourceGroup = this.serversAndGroups.items.find(
                item => isServerGroup(item) && item.name === sourceGroupName
            ) as ServerGroupInfo | undefined;
            serverInfo = sourceGroup?.servers.find(s => s.cluster === cluster);
        } else {
            serverInfo = this.serversAndGroups.items.find(
                item => isServer(item) && item.cluster === cluster
            ) as ServerInfo | undefined;
        }

        if (!serverInfo) return;

        const serverCopy: ServerInfo = { ...serverInfo };

        // Remove from source
        if (sourceGroupName) {
            const sourceGroup = this.serversAndGroups.items.find(
                item => isServerGroup(item) && item.name === sourceGroupName
            ) as ServerGroupInfo | undefined;
            if (sourceGroup) {
                sourceGroup.servers = sourceGroup.servers.filter(s => s.cluster !== cluster);
            }
        } else {
            this.serversAndGroups.items = this.serversAndGroups.items.filter(
                item => !(isServer(item) && item.cluster === cluster)
            );
        }

        // Add to target
        if (targetGroupName) {
            const targetGroup = this.serversAndGroups.items.find(
                item => isServerGroup(item) && item.name === targetGroupName
            ) as ServerGroupInfo | undefined;
            if (targetGroup) {
                targetGroup.servers.push(serverCopy);
            }
        } else {
            this.serversAndGroups.items.push(serverCopy);
        }

        this.sortServersAndGroups();
        await this.saveServersAndGroups();
        this.raiseServersAndGroupsChanged();
    }

    /**
     * Edits a server's connection string, cluster, display name, and/or server kind.
     */
    async editServer(oldCluster: string, newConnection: string, newDisplayName?: string, newServerKind?: string, groupName?: string): Promise<void> {
        let serverInfo: ServerInfo | undefined;

        if (groupName) {
            const group = this.serversAndGroups.items.find(
                item => isServerGroup(item) && item.name === groupName
            ) as ServerGroupInfo | undefined;
            serverInfo = group?.servers.find(s => s.cluster === oldCluster);
        } else {
            serverInfo = this.serversAndGroups.items.find(
                item => isServer(item) && item.cluster === oldCluster
            ) as ServerInfo | undefined;
        }

        if (!serverInfo) return;

        const newCluster = await this.getHostName(newConnection);

        serverInfo.connection = newConnection;
        serverInfo.cluster = newCluster;
        if (newDisplayName && newDisplayName !== newCluster) {
            serverInfo.displayName = newDisplayName;
        } else {
            delete serverInfo.displayName;
        }
        if (newServerKind) {
            serverInfo.serverKind = newServerKind;
        }

        // Update connections cache if cluster name changed
        if (oldCluster !== newCluster) {
            const connectionInfo = this.clusterConnections.find(c => c.cluster === oldCluster);
            if (connectionInfo) {
                connectionInfo.cluster = newCluster;
                connectionInfo.connection = newConnection;
            }
        }

        await this.saveServersAndGroups();
        this.raiseServersAndGroupsChanged();
    }

    /**
     * Renames a server's display name.
     */
    async renameServer(cluster: string, newDisplayName: string, groupName?: string): Promise<void> {
        let serverInfo: ServerInfo | undefined;

        if (groupName) {
            const group = this.serversAndGroups.items.find(
                item => isServerGroup(item) && item.name === groupName
            ) as ServerGroupInfo | undefined;
            serverInfo = group?.servers.find(s => s.cluster === cluster);
        } else {
            serverInfo = this.serversAndGroups.items.find(
                item => isServer(item) && item.cluster === cluster
            ) as ServerInfo | undefined;
        }

        if (!serverInfo) return;

        if (newDisplayName && newDisplayName !== serverInfo.cluster) {
            serverInfo.displayName = newDisplayName;
        } else {
            delete serverInfo.displayName;
        }

        await this.saveServersAndGroups();
        this.raiseServersAndGroupsChanged();
    }

    /**
     * Renames a server group.
     */
    async renameServerGroup(currentName: string, newName: string): Promise<void> {
        const group = this.serversAndGroups.items.find(
            item => isServerGroup(item) && item.name === currentName
        ) as ServerGroupInfo | undefined;

        if (!group) return;

        group.name = newName;

        await this.saveServersAndGroups();
        this.raiseServersAndGroupsChanged();
    }

    // =========================================================================
    // Database Cache Management
    // =========================================================================

    /**
     * Ensures a connection cache entry exists for the given cluster.
     */
    private ensureClusterConnection(cluster: string): { cluster: string, connection: string, databases?: DatabaseInfo[] } {
        let connectionInfo = this.clusterConnections.find(c => c.cluster === cluster);
        if (!connectionInfo) {
            let serverInfo: ServerInfo | undefined;
            for (const item of this.serversAndGroups.items) {
                if (isServerGroup(item)) {
                    serverInfo = item.servers.find(s => s.cluster === cluster);
                    if (serverInfo) break;
                } else if (item.cluster === cluster) {
                    serverInfo = item;
                    break;
                }
            }

            connectionInfo = {
                cluster,
                connection: serverInfo?.connection ?? cluster,
                databases: []
            };
            this.clusterConnections.push(connectionInfo);
        }
        return connectionInfo;
    }

    /**
     * Sets the list of databases for a cluster.
     */
    setClusterDatabases(cluster: string, databases: DatabaseInfo[]): void {
        const connectionInfo = this.ensureClusterConnection(cluster);
        connectionInfo.databases = databases;
        this.raiseServersAndGroupsChanged();
    }

    /**
     * Gets the cached database info list for a cluster.
     */
    getClusterDatabases(cluster: string): DatabaseInfo[] | undefined {
        return this.clusterConnections.find(c => c.cluster === cluster)?.databases;
    }

    /**
     * Sets (or updates) cached database info for a cluster/database.
     */
    setDatabaseInfo(cluster: string, databaseInfo: DatabaseInfo): void {
        const connectionInfo = this.ensureClusterConnection(cluster);
        if (!connectionInfo.databases) {
            connectionInfo.databases = [];
        }
        const existingIndex = connectionInfo.databases.findIndex(d => d.name === databaseInfo.name);
        if (existingIndex >= 0) {
            connectionInfo.databases[existingIndex] = databaseInfo;
        } else {
            connectionInfo.databases.push(databaseInfo);
        }
    }

    /**
     * Gets cached database info for a specific cluster/database.
     */
    getDatabaseInfo(cluster: string, database: string): DatabaseInfo | undefined {
        const connectionInfo = this.clusterConnections.find(c => c.cluster === cluster);
        return connectionInfo?.databases?.find(d => d.name === database);
    }

    // =========================================================================
    // Server Expansion / Database Fetching
    // =========================================================================

    /**
     * Fetches databases for a cluster from the language server and caches them.
     * Called when a server tree item is expanded.
     */
    async fetchDatabasesForCluster(clusterName: string): Promise<void> {
        try {
            const serverInfo = this.findServerInfo(clusterName);
            const serverKind = serverInfo?.serverKind ?? null;
            const result = await this.server.getServerInfo(clusterName, serverKind);

            if (result && result.databases) {
                const databases = result.databases.map(db => ({ name: db.name }));
                this.setClusterDatabases(clusterName, databases);
            }
        } catch (error) {
            console.error(`Failed to get server info for ${clusterName}:`, error);
            vscode.window.showErrorMessage(`Failed to load databases for ${clusterName}`);
        }
    }

    /**
     * Fetches full database info from the language server and caches it.
     * Called when a database tree item is expanded.
     */
    async fetchDatabaseInfo(clusterName: string, databaseName: string): Promise<void> {
        try {
            const result = await this.server.getDatabaseInfo(clusterName, databaseName);
            if (result) {
                this.setDatabaseInfo(clusterName, result);
            }
        } catch (error) {
            console.error(`Failed to get database info for ${clusterName}/${databaseName}:`, error);
            vscode.window.showErrorMessage(`Failed to load database info for ${clusterName}/${databaseName}`);
        }
    }

    /**
     * Refreshes the schema for a cluster from the language server.
     * Clears the server-side and client-side caches, then triggers tree refresh
     * so data will be re-fetched through the normal expansion process.
     * Called when user requests refresh on a server tree item.
     */
    async refreshClusterSchema(clusterName: string): Promise<void> {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Refreshing schema for ${clusterName}...`,
                cancellable: false
            },
            async () => {
                try {
                    // Call server to refresh its schema cache
                    await this.server.refreshSchema(clusterName);

                    // Clear the client-side cache for this cluster so tree will re-fetch on expand
                    const connectionInfo = this.clusterConnections.find(c => c.cluster === clusterName);
                    if (connectionInfo) {
                        connectionInfo.databases = [];
                    }

                    // Trigger tree refresh - items will re-fetch data when expanded
                    this.raiseServersAndGroupsChanged();
                } catch (error) {
                    console.error(`Failed to refresh schema for ${clusterName}:`, error);
                    vscode.window.showErrorMessage(`Failed to refresh schema for ${clusterName}`);
                }
            }
        );
    }

    /**
     * Refreshes the schema for a specific database from the language server.
     * Clears the server-side and client-side caches, then triggers tree refresh
     * so data will be re-fetched through the normal expansion process.
     * Called when user requests refresh on a database tree item.
     */
    async refreshDatabaseSchema(clusterName: string, databaseName: string): Promise<void> {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Refreshing schema for ${databaseName}...`,
                cancellable: false
            },
            async () => {
                try {
                    // Call server to refresh its schema cache for this database
                    await this.server.refreshSchema(clusterName, databaseName);

                    // Clear the client-side cache for this database so tree will re-fetch on expand
                    const connectionInfo = this.clusterConnections.find(c => c.cluster === clusterName);
                    if (connectionInfo?.databases) {
                        const dbIndex = connectionInfo.databases.findIndex(d => d.name === databaseName);
                        if (dbIndex >= 0) {
                            // Clear the detailed info, keep just the name
                            connectionInfo.databases[dbIndex] = { name: databaseName };
                        }
                    }

                    // Trigger tree refresh - items will re-fetch data when expanded
                    this.raiseServersAndGroupsChanged();
                } catch (error) {
                    console.error(`Failed to refresh schema for ${clusterName}/${databaseName}:`, error);
                    vscode.window.showErrorMessage(`Failed to refresh schema for ${clusterName}/${databaseName}`);
                }
            }
        );
    }

    // =========================================================================
    // Document Connection Management
    // =========================================================================

    /**
     * Loads document connections from workspace state.
     */
    async loadDocumentConnections(): Promise<void> {
        const stored = this.context.workspaceState.get<DocumentConnection[]>(DOCUMENT_CONNECTIONS_KEY);
        if (stored) {
            this.documentConnections.clear();
            for (const conn of stored) {
                this.documentConnections.set(conn.uri, conn);
            }
        }
    }

    /**
     * Saves document connections to workspace state.
     */
    private async saveDocumentConnections(): Promise<void> {
        const values = Array.from(this.documentConnections.values());
        await this.context.workspaceState.update(DOCUMENT_CONNECTIONS_KEY, values);
    }


    /**
     * Gets the saved connection for a document (does not infer).
     * Use this when you only want explicitly saved connections.
     */
    getSavedDocumentConnection(uri: string): DocumentConnection | undefined {
        return this.documentConnections.get(uri);
    }

    /**
     * Checks if a document has a saved connection (including "no connection").
     */
    hasSavedDocumentConnection(uri: string): boolean {
        return this.documentConnections.has(uri);
    }

    /**
     * Gets the connection for a document.
     * If the document has a saved connection (including "no connection"), returns that.
     * Otherwise, attempts to infer the connection from the document content.
     * 
     * Optimization: If a saved connection matches the inferred connection, the saved
     * entry is removed (will be inferred in the future).
     * 
     * @param uri The document URI
     */
    async getDocumentConnection(uri: string): Promise<DocumentConnection | undefined> {
        const saved = this.documentConnections.get(uri);
        
        // If saved is "no connection" (has entry but no cluster), return undefined without inferring
        if (saved && !saved.cluster) {
            return undefined;
        }

        // If we have a saved connection with a cluster, return it directly
        if (saved?.cluster) {
            return saved;
        }

        // No saved connection — try to infer from document content
        try {
            const inferredResult = await this.server.inferDocumentConnection(uri);
            
            if (inferredResult?.cluster) {
                return {
                    uri,
                    cluster: inferredResult.cluster,
                    database: inferredResult.database
                };
            }
        } catch (error) {
            console.error(`Failed to infer connection for ${uri}:`, error);
        }

        return undefined;
    }

    /**
     * Sets the connection for a document, saves it, and notifies the server.
     * Also calls the registered documentConnectionChanged callback for UI updates.
     * 
     * Behavior:
     * - All user-set connections are saved to documentConnections (including "no connection")
     * - If the connection matches the inferred connection, it is removed from saved (will be inferred)
     */
    async setDocumentConnection(uri: string, cluster: string | undefined, database: string | undefined): Promise<void> {
        // Check if the connection matches the inferred connection
        let matchesInferred = false;
        if (cluster) {
            try {
                const inferred = await this.server.inferDocumentConnection(uri);
                if (inferred?.cluster === cluster && inferred?.database === database) {
                    matchesInferred = true;
                }
            } catch (error) {
                // If inference fails, save the connection anyway
                console.error(`Failed to infer connection for ${uri}:`, error);
            }
        }

        if (matchesInferred) {
            // Connection matches inferred - remove any saved entry (will be inferred)
            this.documentConnections.delete(uri);
        } else {
            // Save the connection (including "no connection" with undefined cluster)
            const connection: DocumentConnection = {
                uri,
                cluster: cluster ?? undefined,
                database: database ?? undefined
            };
            this.documentConnections.set(uri, connection);
        }
        
        await this.saveDocumentConnections();

        // Notify listeners (status bar + tree selection)
        await this.raiseDocumentConnectionChanged(uri);

        // Get server kind from serversAndGroups if cluster is specified
        let serverKind: string | null = null;
        if (cluster) {
            const info = this.findServerInfo(cluster);
            serverKind = info?.serverKind ?? null;
        }

        // Notify server of the connection change
        this.server.sendDocumentConnectionChanged(uri, cluster || null, database || null, serverKind);
    }

    // =========================================================================
    // Server Info Helpers
    // =========================================================================

    /**
     * Finds a ServerInfo for a given cluster name by searching the servers and groups.
     */
    findServerInfo(cluster: string): ServerInfo | undefined {
        for (const item of this.serversAndGroups.items) {
            if (isServerGroup(item)) {
                const server = item.servers.find(s => s.cluster === cluster);
                if (server) {
                    return server;
                }
            } else if (isServer(item) && item.cluster === cluster) {
                return item;
            }
        }
        return undefined;
    }

    /**
     * Gets the server kind for a connection string from the language server.
     */
    async fetchServerKind(connectionString: string): Promise<string | undefined> {
        try {
            const result = await this.server.getServerKind(connectionString);
            return result?.serverKind;
        } catch (error) {
            console.error(`Failed to get server kind for ${connectionString}:`, error);
            return undefined;
        }
    }

    // =========================================================================
    // Query Functions
    // =========================================================================

    /**
     * Gets the list of configured server connections.
     * @returns Array of cluster names
     */
    getConfiguredConnections(): string[] {
        const servers: string[] = [];
        for (const item of this.serversAndGroups.items) {
            if (isServerGroup(item)) {
                for (const server of item.servers) {
                    servers.push(server.cluster);
                }
            } else {
                servers.push(item.cluster);
            }
        }
        return servers;
    }

    /**
     * Gets the list of databases for a cluster from the language server.
     * @param cluster The cluster name
     * @returns Promise resolving to array of database names
     */
    async getDatabasesForCluster(cluster: string): Promise<string[]> {
        try {
            const serverInfo = this.findServerInfo(cluster);
            const serverKind = serverInfo?.serverKind ?? null;
            const result = await this.server.getServerInfo(cluster, serverKind);

            if (result && result.databases) {
                return result.databases.map(db => db.name);
            }

            return [];
        } catch (error) {
            console.error(`Failed to get databases for ${cluster}:`, error);
            return [];
        }
    }

    /**
     * Gets the schema information for a database.
     * Fetches from server if not cached.
     * @param cluster The cluster name
     * @param database The database name
     * @returns Promise resolving to database info or undefined
     */
    async getDatabaseSchema(cluster: string, database: string): Promise<DatabaseInfo | undefined> {
        // Check if we already have the info cached
        let dbInfo = this.getDatabaseInfo(cluster, database);
        if (dbInfo && dbInfo.tables) {
            return dbInfo;
        }

        // Fetch from server
        try {
            const result = await this.server.getDatabaseInfo(cluster, database);

            if (result) {
                this.setDatabaseInfo(cluster, result);
                return result;
            }
        } catch (error) {
            console.error(`Failed to get database info for ${cluster}/${database}:`, error);
        }

        return undefined;
    }

    /**
     * Gets the connection for the active document.
     * @returns The cluster and database for the active document, or undefined
     */
    async getActiveDocumentConnection(): Promise<{ cluster: string; database: string | undefined } | undefined> {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'kusto') {
            return undefined;
        }

        const connection = await this.getDocumentConnection(editor.document.uri.toString());
        if (!connection?.cluster) {
            return undefined;
        }

        return {
            cluster: connection.cluster,
            database: connection.database
        };
    }
}
