// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    sanitizeFileName,
    parseDatabaseFromConnectionString,
    parseGroupsXml,
    parseConnectionsXml,
    ImportManager,
} from '../../features/importManager';
import type { KustoExplorerRecoveryFile } from '../../features/importManager';
import type { ConnectionManager } from '../../features/connectionManager';
import type { ScratchPadManager } from '../../features/scratchPadManager';

// ─── Mock Helpers ────────────────────────────────────────────────────────────

function createMockConnectionManager(overrides?: Partial<ConnectionManager>): ConnectionManager {
    return {
        getHostName: vi.fn(async (conn: string) => {
            // Mirrors the real ConnectionManager: the host name identifies an ordinary
            // cluster, but a resource-scoped proxy URI keeps its whole path.
            try {
                const url = new URL(conn.startsWith('https://') ? conn : `https://${conn}`);
                const path = url.pathname.replace(/^\/+|\/+$/g, '');
                return path.includes('/') ? `${url.protocol}//${url.host}/${path}` : url.hostname;
            } catch {
                return conn;
            }
        }),
        fetchServerKind: vi.fn(async () => undefined),
        findServerInfo: vi.fn(() => undefined),
        addServer: vi.fn(async () => {}),
        addServerGroup: vi.fn(async () => {}),
        getServersAndGroups: vi.fn(() => ({ items: [] })),
        setDocumentConnection: vi.fn(async () => {}),
        getConfiguredConnections: vi.fn(() => []),
        ...overrides,
    } as unknown as ConnectionManager;
}

function createMockScratchPadManager(overrides?: Partial<ScratchPadManager>): ScratchPadManager {
    let counter = 0;
    return {
        addScratchPadFile: vi.fn(async (name: string | null, _content: string) => {
            counter++;
            return name ?? `ScratchPad${counter}.kql`;
        }),
        ...overrides,
    } as unknown as ScratchPadManager;
}

// ─── Pure Functions ──────────────────────────────────────────────────────────

describe('sanitizeFileName', () => {
    it('removes invalid filename characters', () => {
        expect(sanitizeFileName('a<b>c:d"e/f\\g|h?i*j')).toBe('a_b_c_d_e_f_g_h_i_j');
    });

    it('collapses whitespace', () => {
        expect(sanitizeFileName('hello   world')).toBe('hello world');
    });

    it('trims leading and trailing whitespace', () => {
        expect(sanitizeFileName('  test  ')).toBe('test');
    });

    it('returns ScratchPad for empty string', () => {
        expect(sanitizeFileName('')).toBe('ScratchPad');
    });

    it('returns ScratchPad for all-invalid characters', () => {
        expect(sanitizeFileName('***')).toBe('___');
    });

    it('preserves valid characters', () => {
        expect(sanitizeFileName('My Query (1)')).toBe('My Query (1)');
    });
});

describe('parseDatabaseFromConnectionString', () => {
    it('extracts Initial Catalog value', () => {
        expect(parseDatabaseFromConnectionString(
            'Data Source=https://help.kusto.windows.net;Initial Catalog=Samples'
        )).toBe('Samples');
    });

    it('handles case-insensitive key', () => {
        expect(parseDatabaseFromConnectionString(
            'initial catalog=MyDB;Data Source=cluster'
        )).toBe('MyDB');
    });

    it('handles spaces around equals', () => {
        expect(parseDatabaseFromConnectionString(
            'Initial Catalog = TestDB ; Data Source=cluster'
        )).toBe('TestDB');
    });

    it('returns undefined for NetDefaultDB', () => {
        expect(parseDatabaseFromConnectionString(
            'Initial Catalog=NetDefaultDB;Data Source=cluster'
        )).toBeUndefined();
    });

    it('returns undefined when no Initial Catalog', () => {
        expect(parseDatabaseFromConnectionString(
            'Data Source=https://help.kusto.windows.net'
        )).toBeUndefined();
    });
});

describe('parseGroupsXml', () => {
    it('parses a single group', () => {
        const xml = `
            <ArrayOfServerGroupDescription>
                <ServerGroupDescription>
                    <Name>MyGroup</Name>
                    <Details>C:\\path\\to\\connections.xml</Details>
                </ServerGroupDescription>
            </ArrayOfServerGroupDescription>`;

        const groups = parseGroupsXml(xml);
        expect(groups).toHaveLength(1);
        expect(groups[0]!.name).toBe('MyGroup');
        expect(groups[0]!.filePath).toBe('C:\\path\\to\\connections.xml');
    });

    it('parses multiple groups', () => {
        const xml = `
            <ArrayOfServerGroupDescription>
                <ServerGroupDescription>
                    <Name>Group1</Name>
                    <Details>path1.xml</Details>
                </ServerGroupDescription>
                <ServerGroupDescription>
                    <Name>Group2</Name>
                    <Details>path2.xml</Details>
                </ServerGroupDescription>
            </ArrayOfServerGroupDescription>`;

        const groups = parseGroupsXml(xml);
        expect(groups).toHaveLength(2);
    });

    it('returns empty array for empty XML', () => {
        expect(parseGroupsXml('<ArrayOfServerGroupDescription/>')).toEqual([]);
    });

    it('skips entries missing Name or Details', () => {
        const xml = `
            <ArrayOfServerGroupDescription>
                <ServerGroupDescription>
                    <Name>Valid</Name>
                    <Details>path.xml</Details>
                </ServerGroupDescription>
                <ServerGroupDescription>
                    <Name>MissingDetails</Name>
                </ServerGroupDescription>
                <ServerGroupDescription>
                    <Details>missing-name.xml</Details>
                </ServerGroupDescription>
            </ArrayOfServerGroupDescription>`;

        const groups = parseGroupsXml(xml);
        expect(groups).toHaveLength(1);
        expect(groups[0]!.name).toBe('Valid');
    });
});

describe('parseConnectionsXml', () => {
    it('parses a single connection', async () => {
        const xml = `
            <ArrayOfServerDescriptionBase>
                <ServerDescriptionBase>
                    <ConnectionString>https://help.kusto.windows.net</ConnectionString>
                    <Name>Help Cluster</Name>
                </ServerDescriptionBase>
            </ArrayOfServerDescriptionBase>`;

        const connections = createMockConnectionManager();
        const servers = await parseConnectionsXml(xml, connections);

        expect(servers).toHaveLength(1);
        expect(servers[0]!.cluster).toBe('help.kusto.windows.net');
        expect(servers[0]!.displayName).toBe('Help Cluster');
    });

    it('parses multiple connections', async () => {
        const xml = `
            <ArrayOfServerDescriptionBase>
                <ServerDescriptionBase>
                    <ConnectionString>https://c1.kusto.windows.net</ConnectionString>
                </ServerDescriptionBase>
                <ServerDescriptionBase>
                    <ConnectionString>https://c2.kusto.windows.net</ConnectionString>
                </ServerDescriptionBase>
            </ArrayOfServerDescriptionBase>`;

        const connections = createMockConnectionManager();
        const servers = await parseConnectionsXml(xml, connections);

        expect(servers).toHaveLength(2);
    });

    it('skips entries without ConnectionString', async () => {
        const xml = `
            <ArrayOfServerDescriptionBase>
                <ServerDescriptionBase>
                    <Name>No Connection</Name>
                </ServerDescriptionBase>
            </ArrayOfServerDescriptionBase>`;

        const connections = createMockConnectionManager();
        const servers = await parseConnectionsXml(xml, connections);

        expect(servers).toHaveLength(0);
    });

    it('omits displayName when it matches cluster hostname', async () => {
        const xml = `
            <ArrayOfServerDescriptionBase>
                <ServerDescriptionBase>
                    <ConnectionString>https://mycluster.kusto.windows.net</ConnectionString>
                    <Name>mycluster.kusto.windows.net</Name>
                </ServerDescriptionBase>
            </ArrayOfServerDescriptionBase>`;

        const connections = createMockConnectionManager();
        const servers = await parseConnectionsXml(xml, connections);

        expect(servers[0]!.displayName).toBeUndefined();
    });

    it('sets serverKind when available', async () => {
        const xml = `
            <ArrayOfServerDescriptionBase>
                <ServerDescriptionBase>
                    <ConnectionString>https://c.kusto.windows.net</ConnectionString>
                </ServerDescriptionBase>
            </ArrayOfServerDescriptionBase>`;

        const connections = createMockConnectionManager({
            fetchServerKind: vi.fn(async () => 'Engine'),
        });
        const servers = await parseConnectionsXml(xml, connections);

        expect(servers[0]!.serverKind).toBe('Engine');
    });

    it('returns empty for empty XML', async () => {
        const connections = createMockConnectionManager();
        expect(await parseConnectionsXml('<ArrayOfServerDescriptionBase/>', connections)).toEqual([]);
    });
});

// ─── ImportManager.importScratchPads ──────────────────────────────────────────

describe('ImportManager.importScratchPads', () => {
    let tmpDir: string;
    let recoveryDir: string;
    let savedLocalAppData: string | undefined;
    let connections: ConnectionManager;
    let scratchPadManager: ScratchPadManager;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-test-'));
        recoveryDir = path.join(tmpDir, 'Kusto.Explorer', 'Recovery');
        fs.mkdirSync(recoveryDir, { recursive: true });

        savedLocalAppData = process.env.LOCALAPPDATA;
        process.env.LOCALAPPDATA = tmpDir;

        connections = createMockConnectionManager();
        scratchPadManager = createMockScratchPadManager();
    });

    afterEach(() => {
        process.env.LOCALAPPDATA = savedLocalAppData;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeRecoveryFile(name: string, data: KustoExplorerRecoveryFile): void {
        fs.writeFileSync(path.join(recoveryDir, name), JSON.stringify(data), 'utf-8');
    }

    function createManager(): ImportManager {
        return new ImportManager(scratchPadManager, connections);
    }

    it('returns undefined when no recovery files exist', async () => {
        // Empty recovery dir
        const mgr = createManager();
        const result = await mgr.importScratchPads();
        expect(result).toBeUndefined();
    });

    it('imports a recovery file with custom title', async () => {
        writeRecoveryFile('tab1.kebak', {
            CustomTitle: 'My Query',
            QueryText: 'StormEvents | take 10',
        });

        const mgr = createManager();
        const result = await mgr.importScratchPads();

        expect(result?.importedCount).toBe(1);
        expect(scratchPadManager.addScratchPadFile).toHaveBeenCalledWith('My Query', 'StormEvents | take 10');
    });

    it('uses auto-name when no title or connection', async () => {
        writeRecoveryFile('tab1.kebak', {
            QueryText: 'query text',
        });

        const mgr = createManager();
        await mgr.importScratchPads();

        expect(scratchPadManager.addScratchPadFile).toHaveBeenCalledWith(null, 'query text');
    });

    it('derives name from cluster and database', async () => {
        writeRecoveryFile('tab1.kebak', {
            QueryText: 'query',
            ConnectionString: 'Data Source=https://help.kusto.windows.net;Initial Catalog=Samples',
        });

        const connWithHostName = createMockConnectionManager({
            getHostName: vi.fn(async () => 'help.kusto.windows.net'),
        });
        const mgr = new ImportManager(scratchPadManager, connWithHostName);
        await mgr.importScratchPads();

        expect(scratchPadManager.addScratchPadFile).toHaveBeenCalledWith(
            'help.kusto.windows.net.Samples',
            'query',
        );
    });

    it('adds server when cluster is unknown', async () => {
        writeRecoveryFile('tab1.kebak', {
            QueryText: 'query',
            ConnectionString: 'https://newcluster.kusto.windows.net',
        });

        const mgr = createManager();
        await mgr.importScratchPads();

        expect(connections.addServer).toHaveBeenCalled();
    });

    it('does not duplicate server when cluster already exists', async () => {
        writeRecoveryFile('tab1.kebak', {
            QueryText: 'query',
            ConnectionString: 'https://existing.kusto.windows.net',
        });

        const connWithServer = createMockConnectionManager({
            findServerInfo: vi.fn((cluster: string) =>
                cluster === 'existing.kusto.windows.net'
                    ? { cluster, connection: `https://${cluster}` } as any
                    : undefined
            ),
        });
        const mgr = new ImportManager(scratchPadManager, connWithServer);
        await mgr.importScratchPads();

        expect(connWithServer.addServer).not.toHaveBeenCalled();
    });

    it('associates connection with new scratch pad', async () => {
        writeRecoveryFile('tab1.kebak', {
            QueryText: 'query',
            ConnectionString: 'Data Source=https://c.kusto.windows.net;Initial Catalog=DB1',
        });

        const mgr = createManager();
        await mgr.importScratchPads();

        expect(connections.setDocumentConnection).toHaveBeenCalled();
    });

    it('imports multiple files and returns correct count', async () => {
        writeRecoveryFile('tab1.kebak', { QueryText: 'q1', CustomTitle: 'First', TabOrdinal: 1 });
        writeRecoveryFile('tab2.kebak', { QueryText: 'q2', CustomTitle: 'Second', TabOrdinal: 2 });
        writeRecoveryFile('tab3.kebak', { QueryText: 'q3', TabOrdinal: 3 });

        const mgr = createManager();
        const result = await mgr.importScratchPads();

        expect(result?.importedCount).toBe(3);
    });

    it('sanitizes custom title for filename', async () => {
        writeRecoveryFile('tab1.kebak', {
            QueryText: 'query',
            CustomTitle: 'My <Cool> "Query"',
        });

        const mgr = createManager();
        await mgr.importScratchPads();

        expect(scratchPadManager.addScratchPadFile).toHaveBeenCalledWith(
            'My _Cool_ _Query_',
            'query',
        );
    });

    it('skips recovery files with empty QueryText', async () => {
        writeRecoveryFile('tab1.kebak', { QueryText: '', CustomTitle: 'Empty' });
        writeRecoveryFile('tab2.kebak', { QueryText: 'real query' });

        const mgr = createManager();
        const result = await mgr.importScratchPads();

        expect(result?.importedCount).toBe(1);
    });

    it('skips recovery files that have a FullPath (saved files)', async () => {
        writeRecoveryFile('tab1.kebak', {
            QueryText: 'query',
            FullPath: 'C:\\Users\\test\\query.kql',
        });

        const mgr = createManager();
        const result = await mgr.importScratchPads();

        expect(result).toBeUndefined();
    });

    it('respects TabOrdinal ordering', async () => {
        writeRecoveryFile('z.kebak', { QueryText: 'third', CustomTitle: 'C', TabOrdinal: 3 });
        writeRecoveryFile('a.kebak', { QueryText: 'first', CustomTitle: 'A', TabOrdinal: 1 });
        writeRecoveryFile('m.kebak', { QueryText: 'second', CustomTitle: 'B', TabOrdinal: 2 });

        const mgr = createManager();
        await mgr.importScratchPads();

        const calls = (scratchPadManager.addScratchPadFile as ReturnType<typeof vi.fn>).mock.calls;
        expect(calls[0]![0]).toBe('A');
        expect(calls[1]![0]).toBe('B');
        expect(calls[2]![0]).toBe('C');
    });

    it('skips malformed .kebak files', async () => {
        fs.writeFileSync(path.join(recoveryDir, 'bad.kebak'), 'not json', 'utf-8');
        writeRecoveryFile('good.kebak', { QueryText: 'valid' });

        const mgr = createManager();
        const result = await mgr.importScratchPads();

        expect(result?.importedCount).toBe(1);
    });
});
