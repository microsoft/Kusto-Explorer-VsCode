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
    parseRecoveryFile,
    classifyImportFile,
    removeConnectionStringSecrets,
    ImportManager,
    CONNECTIONS_EXPORT_FORMAT,
} from '../../features/importManager';
import type { KustoExplorerRecoveryFile, ImportFile } from '../../features/importManager';
import { KustoExplorerLocalData } from '../../features/kustoExplorerLocalData';
import type { ConnectionManager, ServerInfo } from '../../features/connectionManager';
import type { ScratchPadManager } from '../../features/scratchPadManager';

// ─── Mock Helpers ────────────────────────────────────────────────────────────

function createMockConnectionManager(overrides?: Partial<ConnectionManager>): ConnectionManager {
    return {
        getHostName: vi.fn(async (conn: string) => {
            try {
                const url = new URL(conn.startsWith('https://') ? conn : `https://${conn}`);
                return url.hostname;
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
        return new ImportManager(scratchPadManager, connections, new KustoExplorerLocalData());
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
        const mgr = new ImportManager(scratchPadManager, connWithHostName, new KustoExplorerLocalData());
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
        const mgr = new ImportManager(scratchPadManager, connWithServer, new KustoExplorerLocalData());
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

// ─── Without local Kusto Explorer data (web) ─────────────────────────────────

describe('ImportManager without local Kusto Explorer data', () => {
    it('reports nothing to import and cannot read Kusto Explorer data', async () => {
        const mgr = new ImportManager(createMockScratchPadManager(), createMockConnectionManager());

        expect(mgr.canReadKustoExplorerData).toBe(false);
        expect(mgr.hasConnectionsToImport()).toBe(false);
        expect(mgr.hasScratchPadsToImport()).toBe(false);
        expect(mgr.getScratchPadsToImportCount()).toBe(0);
        expect(await mgr.importConnections()).toBeUndefined();
        expect(await mgr.importScratchPads()).toBeUndefined();
    });
});

// ─── Import from Files ───────────────────────────────────────────────────────

const USER_CONNECTIONS_XML = `<?xml version="1.0" encoding="utf-8"?>
<ArrayOfServerDescriptionBase xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <ServerDescriptionBase>
        <ConnectionString>https://help.kusto.windows.net</ConnectionString>
        <Name>Help</Name>
    </ServerDescriptionBase>
</ArrayOfServerDescriptionBase>`;

const TEAM_CONNECTIONS_XML = `<ArrayOfServerDescriptionBase>
    <ServerDescriptionBase>
        <ConnectionString>https://team.kusto.windows.net</ConnectionString>
    </ServerDescriptionBase>
</ArrayOfServerDescriptionBase>`;

const GROUPS_XML = `<?xml version="1.0" encoding="utf-8"?>
<ArrayOfServerGroupDescription>
    <ServerGroupDescription>
        <Name>Connections</Name>
        <Details>C:\\Users\\me\\AppData\\Local\\Kusto.Explorer\\UserConnections.xml</Details>
    </ServerGroupDescription>
    <ServerGroupDescription>
        <Name>Team</Name>
        <Details>C:\\Users\\me\\AppData\\Local\\Kusto.Explorer\\Team.xml</Details>
    </ServerGroupDescription>
</ArrayOfServerGroupDescription>`;

describe('classifyImportFile', () => {
    it('recognizes each supported kind', () => {
        expect(classifyImportFile(USER_CONNECTIONS_XML)).toBe('connectionsXml');
        expect(classifyImportFile(GROUPS_XML)).toBe('groupsXml');
        expect(classifyImportFile('\uFEFF{"QueryText":"T | take 1"}')).toBe('recovery');
        expect(classifyImportFile(JSON.stringify({ format: CONNECTIONS_EXPORT_FORMAT, version: 1, items: [] }))).toBe('connectionsExport');
    });

    it('returns unknown for other content', () => {
        expect(classifyImportFile('')).toBe('unknown');
        expect(classifyImportFile('{ not json')).toBe('unknown');
        expect(classifyImportFile('{"foo":1}')).toBe('unknown');
        expect(classifyImportFile('<root/>')).toBe('unknown');
        expect(classifyImportFile('print 1')).toBe('unknown');
    });
});

describe('parseRecoveryFile', () => {
    it('returns scratch pad documents', () => {
        expect(parseRecoveryFile('{"QueryText":"T","TabOrdinal":2}')).toEqual({ QueryText: 'T', TabOrdinal: 2 });
    });

    it('skips saved documents, empty queries and malformed files', () => {
        expect(parseRecoveryFile('{"QueryText":"T","FullPath":"C:\\\\q.kql"}')).toBeUndefined();
        expect(parseRecoveryFile('{"QueryText":"  "}')).toBeUndefined();
        expect(parseRecoveryFile('not json')).toBeUndefined();
    });
});

describe('ImportManager.importFiles', () => {
    function file(name: string, text: string, referenced?: Record<string, string>): ImportFile {
        return {
            name,
            text,
            ...(referenced ? { readReferencedFile: async (p: string) => referenced[p.split('\\').pop()!] } : {}),
        };
    }

    it('imports a UserConnections.xml at the root level', async () => {
        const connections = createMockConnectionManager();
        const mgr = new ImportManager(createMockScratchPadManager(), connections);

        const result = await mgr.importFiles([file('UserConnections.xml', USER_CONNECTIONS_XML)]);

        expect(result.importedConnections).toBe(1);
        expect(connections.addServer).toHaveBeenCalledWith(expect.objectContaining({ cluster: 'help.kusto.windows.net', displayName: 'Help' }), undefined);
    });

    it('imports the groups of a UserConnectionGroups.xml, once per group file', async () => {
        const connections = createMockConnectionManager();
        const mgr = new ImportManager(createMockScratchPadManager(), connections);
        const referenced = { 'UserConnections.xml': USER_CONNECTIONS_XML, 'Team.xml': TEAM_CONNECTIONS_XML };

        // The group files are picked too; they must not be imported again at the root level.
        const result = await mgr.importFiles([
            file('UserConnections.xml', USER_CONNECTIONS_XML),
            file('Team.xml', TEAM_CONNECTIONS_XML),
            file('UserConnectionGroups.xml', GROUPS_XML, referenced),
        ]);

        expect(result.importedConnections).toBe(2);
        expect(result.missingGroupFiles).toEqual([]);
        expect(connections.addServerGroup).toHaveBeenCalledWith({ name: 'Team', servers: [] });
        expect(connections.addServer).toHaveBeenCalledTimes(2);
        expect(connections.addServer).toHaveBeenCalledWith(expect.objectContaining({ cluster: 'help.kusto.windows.net' }), undefined);
        expect(connections.addServer).toHaveBeenCalledWith(expect.objectContaining({ cluster: 'team.kusto.windows.net' }), 'Team');
    });

    it('reports group files it cannot read', async () => {
        const mgr = new ImportManager(createMockScratchPadManager(), createMockConnectionManager());

        const result = await mgr.importFiles([file('UserConnectionGroups.xml', GROUPS_XML, { 'UserConnections.xml': USER_CONNECTIONS_XML })]);

        expect(result.importedConnections).toBe(1);
        expect(result.missingGroupFiles).toEqual(['C:\\Users\\me\\AppData\\Local\\Kusto.Explorer\\Team.xml']);
    });

    it('imports .kebak files as scratch pads in tab order', async () => {
        const scratchPads = createMockScratchPadManager();
        const mgr = new ImportManager(scratchPads, createMockConnectionManager());

        const result = await mgr.importFiles([
            file('b.kebak', JSON.stringify({ CustomTitle: 'B', QueryText: 'b', TabOrdinal: 2 })),
            file('a.kebak', JSON.stringify({ CustomTitle: 'A', QueryText: 'a', TabOrdinal: 1 })),
        ]);

        expect(result.importedScratchPads).toBe(2);
        const calls = (scratchPads.addScratchPadFile as ReturnType<typeof vi.fn>).mock.calls;
        expect(calls.map(c => c[0])).toEqual(['A', 'B']);
    });

    it('reports unrecognized files and skips duplicates', async () => {
        const connections = createMockConnectionManager({
            findServerInfo: vi.fn(() => ({ connection: 'x', cluster: 'help.kusto.windows.net' })),
        });
        const mgr = new ImportManager(createMockScratchPadManager(), connections);

        const result = await mgr.importFiles([
            file('notes.txt', 'hello'),
            file('UserConnections.xml', USER_CONNECTIONS_XML),
        ]);

        expect(result.unrecognizedFiles).toEqual(['notes.txt']);
        expect(result.importedConnections).toBe(0);
        expect(result.skippedConnections).toBe(1);
    });
});

// ─── Export Connections ──────────────────────────────────────────────────────

describe('ImportManager connections export', () => {
    const items = [
        { connection: 'https://a.kusto.windows.net', cluster: 'a.kusto.windows.net', displayName: 'A' },
        { name: 'G', servers: [{ connection: 'https://b.kusto.windows.net', cluster: 'b.kusto.windows.net', serverKind: 'Engine' }] },
    ];

    it('exports servers and groups in a versioned format', () => {
        const mgr = new ImportManager(createMockScratchPadManager(), createMockConnectionManager({
            getServersAndGroups: vi.fn(() => ({ items })),
        }));

        expect(JSON.parse(mgr.exportConnections())).toEqual({ format: CONNECTIONS_EXPORT_FORMAT, version: 1, items });
    });

    it('round-trips an export through importFiles, dropping malformed entries and unknown fields', async () => {
        const exported = new ImportManager(createMockScratchPadManager(), createMockConnectionManager({
            getServersAndGroups: vi.fn(() => ({ items })),
        })).exportConnections();
        const data = JSON.parse(exported);
        data.items.push({ cluster: 'no-connection' }, 42, null);
        data.items[0].extra = 'ignored';

        const connections = createMockConnectionManager();
        const mgr = new ImportManager(createMockScratchPadManager(), connections);
        const result = await mgr.importFiles([{ name: 'kusto-connections.json', text: JSON.stringify(data) }]);

        expect(result.importedConnections).toBe(2);
        const added = (connections.addServer as ReturnType<typeof vi.fn>).mock.calls as [ServerInfo, string | undefined][];
        expect(added).toEqual([
            [{ connection: 'https://a.kusto.windows.net', cluster: 'a.kusto.windows.net', displayName: 'A' }, undefined],
            [{ connection: 'https://b.kusto.windows.net', cluster: 'b.kusto.windows.net', serverKind: 'Engine' }, 'G'],
        ]);
        expect(connections.addServerGroup).toHaveBeenCalledWith({ name: 'G', servers: [] });
    });

    it('removes secrets from servers and grouped servers, keeping other fields', () => {
        const base = 'Data Source=https://a.kusto.windows.net;Initial Catalog=Db;AAD Federated Security=True;Application Client Id=app-id';
        const mgr = new ImportManager(createMockScratchPadManager(), createMockConnectionManager({
            getServersAndGroups: vi.fn(() => ({
                items: [
                    { connection: `${base};Application Key=fake-value`, cluster: 'a.kusto.windows.net', displayName: 'A', serverKind: 'Engine' },
                    { name: 'G', servers: [{ connection: `${base};User Token=fake-value`, cluster: 'a.kusto.windows.net' }] },
                ],
            })),
        }));

        const exported = mgr.exportConnections();

        expect(exported).not.toContain('fake-value');
        expect(JSON.parse(exported).items).toEqual([
            { connection: base, cluster: 'a.kusto.windows.net', displayName: 'A', serverKind: 'Engine' },
            { name: 'G', servers: [{ connection: base, cluster: 'a.kusto.windows.net' }] },
        ]);
    });

    it('round-trips a connection whose secret was removed by the export', async () => {
        const exported = new ImportManager(createMockScratchPadManager(), createMockConnectionManager({
            getServersAndGroups: vi.fn(() => ({
                items: [{ connection: 'Data Source=https://a.kusto.windows.net;Initial Catalog=Db;AppClientId=app-id;AppKey=fake-value', cluster: 'a.kusto.windows.net' }],
            })),
        })).exportConnections();

        const connections = createMockConnectionManager();
        const result = await new ImportManager(createMockScratchPadManager(), connections)
            .importFiles([{ name: 'kusto-connections.json', text: exported }]);

        expect(result.importedConnections).toBe(1);
        expect(result.importedConnectionsExport).toBe(true);
        expect(connections.addServer).toHaveBeenCalledWith(
            { connection: 'Data Source=https://a.kusto.windows.net;Initial Catalog=Db;AppClientId=app-id', cluster: 'a.kusto.windows.net' },
            undefined,
        );
    });

    it('does not flag Kusto Explorer XML imports as connections exports', async () => {
        const result = await new ImportManager(createMockScratchPadManager(), createMockConnectionManager())
            .importFiles([{ name: 'UserConnections.xml', text: USER_CONNECTIONS_XML }]);

        expect(result.importedConnectionsExport).toBe(false);
    });
});

describe('removeConnectionStringSecrets', () => {
    const keep = 'Data Source=https://a.kusto.windows.net;Initial Catalog=Db';

    it.each([
        'Password', 'PWD',
        'Application Key', 'AppKey',
        'Application Token', 'AppToken',
        'User Token', 'UserToken', 'UsrToken',
        'Application Certificate PrivateKey',
    ])('removes %s in any case and spacing', keyword => {
        for (const variant of [keyword, keyword.toLowerCase(), keyword.toUpperCase(), `  ${keyword} `, keyword.replace(/ /g, '')]) {
            expect(removeConnectionStringSecrets(`${keep};${variant}=fake-value;Fed=True`)).toBe(`${keep};Fed=True`);
            expect(removeConnectionStringSecrets(`${variant} = fake-value;${keep}`)).toBe(keep);
        }
    });

    it('removes quoted secret values containing separators and escaped quotes', () => {
        expect(removeConnectionStringSecrets(`${keep};Password="fake;value""with=quote";Fed=True`)).toBe(`${keep};Fed=True`);
        expect(removeConnectionStringSecrets(`${keep};AppKey='fake;''value';Fed=True`)).toBe(`${keep};Fed=True`);
        expect(removeConnectionStringSecrets(`${keep};Password= "fake;value" ;Fed=True`)).toBe(`${keep};Fed=True`);
    });

    it('removes the rest of the string after an unterminated quoted secret', () => {
        expect(removeConnectionStringSecrets(`${keep};Password="fake;Fed=True`)).toBe(keep);
    });

    it('removes every secret in a connection string', () => {
        expect(removeConnectionStringSecrets(`${keep};PWD=fake-value;AppKey=fake-value;UsrToken=fake-value;AppToken=fake-value`)).toBe(keep);
    });

    it('preserves non-secret fields verbatim', () => {
        const connection = [
            'Data Source=https://a.kusto.windows.net:443',
            'Initial Catalog=Db',
            'AAD Federated Security=True',
            'Application Client Id=app-id',
            'Authority Id=tenant-id',
            'Application Certificate Thumbprint=ABCDEF',
            'Application Certificate Subject Distinguished Name=CN=app',
            'User ID=someone@contoso.com',
            'dSTS Federated Security=False',
            'Description="quoted; value"',
        ].join(';');

        expect(removeConnectionStringSecrets(connection)).toBe(connection);
    });

    it('keeps a bare URL or host unchanged', () => {
        expect(removeConnectionStringSecrets('https://a.kusto.windows.net/Db')).toBe('https://a.kusto.windows.net/Db');
        expect(removeConnectionStringSecrets('a.kusto.windows.net;Fed=True')).toBe('a.kusto.windows.net;Fed=True');
        expect(removeConnectionStringSecrets('https://a.kusto.windows.net;Password=fake-value')).toBe('https://a.kusto.windows.net');
        expect(removeConnectionStringSecrets('')).toBe('');
    });

    it('does not treat keywords that merely contain a secret keyword as secrets', () => {
        const connection = `${keep};Password Hint=x;Pwd2=y;My AppKey=z`;
        expect(removeConnectionStringSecrets(connection)).toBe(connection);
    });
});
