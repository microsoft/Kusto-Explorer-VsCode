// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    ConnectionManager,
    isServer,
    isServerGroup,
    getDisplayName,
} from '../../features/connectionManager';
import type {
    ServerInfo,
    ServerGroupInfo,
    DocumentConnection,
} from '../../features/connectionManager';
import type { Server, DatabaseInfo } from '../../features/server';
import type * as vscode from 'vscode';

// ─── Mock Helpers ────────────────────────────────────────────────────────────

function createMockMemento(): vscode.Memento {
    const store = new Map<string, unknown>();
    return {
        get: (key: string, defaultValue?: unknown) => store.has(key) ? store.get(key) : defaultValue,
        update: vi.fn(async (key: string, value: unknown) => { store.set(key, value); }),
        keys: () => [...store.keys()],
    } as unknown as vscode.Memento;
}

function createMockContext(): vscode.ExtensionContext {
    return {
        globalState: createMockMemento(),
        workspaceState: createMockMemento(),
    } as unknown as vscode.ExtensionContext;
}

function createMockServer(overrides?: Partial<Server>): Server {
    return {
        decodeConnectionString: vi.fn(async (conn: string) => {
            // Mirrors the real language server: the host name identifies an ordinary
            // cluster, but a resource-scoped proxy URI keeps its whole path.
            try {
                const url = new URL(conn.startsWith('https://') ? conn : `https://${conn}`);
                const path = url.pathname.replace(/^\/+|\/+$/g, '');
                return { cluster: path.includes('/') ? `${url.protocol}//${url.host}/${path}` : url.hostname };
            } catch {
                return { cluster: conn };
            }
        }),
        sendConnectionsUpdated: vi.fn(),
        sendDocumentConnectionChanged: vi.fn(),
        inferDocumentConnection: vi.fn(async () => null),
        getServerInfo: vi.fn(async () => null),
        getDatabaseInfo: vi.fn(async () => null),
        refreshSchema: vi.fn(async () => {}),
        getServerKind: vi.fn(async () => null),
        ...overrides,
    } as unknown as Server;
}

function makeServer(cluster: string, connection?: string): ServerInfo {
    return { cluster, connection: connection ?? `https://${cluster}` };
}

function makeGroup(name: string, servers: ServerInfo[]): ServerGroupInfo {
    return { name, servers };
}

// ─── Type Guards ─────────────────────────────────────────────────────────────

describe('type guards', () => {
    it('isServer returns true for ServerInfo', () => {
        expect(isServer(makeServer('a.kusto.windows.net'))).toBe(true);
    });

    it('isServer returns false for ServerGroupInfo', () => {
        expect(isServer(makeGroup('g', []))).toBe(false);
    });

    it('isServerGroup returns true for ServerGroupInfo', () => {
        expect(isServerGroup(makeGroup('g', []))).toBe(true);
    });

    it('isServerGroup returns false for ServerInfo', () => {
        expect(isServerGroup(makeServer('a.kusto.windows.net'))).toBe(false);
    });
});

// ─── getDisplayName ──────────────────────────────────────────────────────────

describe('getDisplayName', () => {
    it('returns short name when cluster ends with default domain', () => {
        expect(getDisplayName('mycluster.kusto.windows.net')).toBe('mycluster');
    });

    it('returns undefined when cluster does not end with default domain', () => {
        expect(getDisplayName('standalone-cluster')).toBeUndefined();
    });

    it('returns undefined when cluster is just the domain', () => {
        expect(getDisplayName('.kusto.windows.net')).toBeUndefined();
    });

    it('returns the workspace name for a Log Analytics cluster URI', () => {
        expect(getDisplayName('https://ade.loganalytics.io/subscriptions/sub-1/resourcegroups/rg-1/providers/microsoft.operationalinsights/workspaces/my-workspace'))
            .toBe('my-workspace');
    });

    it('returns the component name for an Application Insights cluster URI', () => {
        expect(getDisplayName('https://ade.applicationinsights.io/subscriptions/sub-1/resourcegroups/rg-1/providers/microsoft.insights/components/my-app'))
            .toBe('my-app');
    });
});

// ─── ConnectionManager ──────────────────────────────────────────────────────

describe('ConnectionManager', () => {
    let context: vscode.ExtensionContext;
    let server: Server;
    let mgr: ConnectionManager;

    beforeEach(() => {
        context = createMockContext();
        server = createMockServer();
        mgr = new ConnectionManager(context, server);
    });

    // ─── Servers and Groups ──────────────────────────────────────────

    describe('servers and groups', () => {
        it('starts with empty servers and groups', () => {
            const data = mgr.getServersAndGroups();
            expect(data.items).toEqual([]);
        });

        it('addServer adds a root-level server', async () => {
            await mgr.addServer(makeServer('cluster1.kusto.windows.net'));

            const data = mgr.getServersAndGroups();
            expect(data.items).toHaveLength(1);
            expect(isServer(data.items[0]!)).toBe(true);
        });

        it('addServer adds to a specific group', async () => {
            await mgr.addServerGroup(makeGroup('MyGroup', []));
            await mgr.addServer(makeServer('cluster1.kusto.windows.net'), 'MyGroup');

            const data = mgr.getServersAndGroups();
            const group = data.items.find(i => isServerGroup(i)) as ServerGroupInfo;
            expect(group.servers).toHaveLength(1);
            expect(group.servers[0]!.cluster).toBe('cluster1.kusto.windows.net');
        });

        it('addServer persists to globalState', async () => {
            await mgr.addServer(makeServer('cluster1.kusto.windows.net'));
            expect(context.globalState.update).toHaveBeenCalled();
        });

        it('addServer notifies the language server', async () => {
            await mgr.addServer(makeServer('cluster1.kusto.windows.net'));
            expect(server.sendConnectionsUpdated).toHaveBeenCalled();
        });

        it('addServerGroup adds a group', async () => {
            await mgr.addServerGroup(makeGroup('Group1', []));

            const data = mgr.getServersAndGroups();
            expect(data.items).toHaveLength(1);
            expect(isServerGroup(data.items[0]!)).toBe(true);
            expect((data.items[0] as ServerGroupInfo).name).toBe('Group1');
        });

        it('removeServer removes a root-level server', async () => {
            await mgr.addServer(makeServer('c1.kusto.windows.net'));
            await mgr.addServer(makeServer('c2.kusto.windows.net'));

            await mgr.removeServer('c1.kusto.windows.net');

            const data = mgr.getServersAndGroups();
            const clusters = data.items.filter(isServer).map(s => s.cluster);
            expect(clusters).not.toContain('c1.kusto.windows.net');
            expect(clusters).toContain('c2.kusto.windows.net');
        });

        it('removeServer removes from a specific group', async () => {
            const s = makeServer('c1.kusto.windows.net');
            await mgr.addServerGroup(makeGroup('G', [s]));

            await mgr.removeServer('c1.kusto.windows.net', 'G');

            const group = mgr.getServersAndGroups().items.find(isServerGroup) as ServerGroupInfo;
            expect(group.servers).toHaveLength(0);
        });

        it('removeServerGroup removes group and all its servers', async () => {
            await mgr.addServerGroup(makeGroup('ToDelete', [makeServer('c1.kusto.windows.net')]));

            await mgr.removeServerGroup('ToDelete');

            expect(mgr.getServersAndGroups().items).toHaveLength(0);
        });

        it('renameServerGroup updates the group name', async () => {
            await mgr.addServerGroup(makeGroup('Old', []));

            await mgr.renameServerGroup('Old', 'New');

            const group = mgr.getServersAndGroups().items.find(isServerGroup) as ServerGroupInfo;
            expect(group.name).toBe('New');
        });

        it('moveServer moves from root to group', async () => {
            await mgr.addServer(makeServer('c1.kusto.windows.net'));
            await mgr.addServerGroup(makeGroup('G', []));

            await mgr.moveServer('c1.kusto.windows.net', undefined, 'G');

            const rootServers = mgr.getServersAndGroups().items.filter(isServer);
            expect(rootServers).toHaveLength(0);

            const group = mgr.getServersAndGroups().items.find(isServerGroup) as ServerGroupInfo;
            expect(group.servers).toHaveLength(1);
        });

        it('moveServer moves from group to root', async () => {
            const s = makeServer('c1.kusto.windows.net');
            await mgr.addServerGroup(makeGroup('G', [s]));

            await mgr.moveServer('c1.kusto.windows.net', 'G', undefined);

            const group = mgr.getServersAndGroups().items.find(isServerGroup) as ServerGroupInfo;
            expect(group.servers).toHaveLength(0);

            const rootServers = mgr.getServersAndGroups().items.filter(isServer);
            expect(rootServers.some(s => s.cluster === 'c1.kusto.windows.net')).toBe(true);
        });

        it('sorts servers and groups after add', async () => {
            await mgr.addServer(makeServer('z-cluster.kusto.windows.net'));
            await mgr.addServer(makeServer('a-cluster.kusto.windows.net'));

            const items = mgr.getServersAndGroups().items.filter(isServer);
            expect(items[0]!.cluster).toBe('a-cluster.kusto.windows.net');
            expect(items[1]!.cluster).toBe('z-cluster.kusto.windows.net');
        });
    });

    // ─── loadServersAndGroups ────────────────────────────────────────

    describe('loadServersAndGroups', () => {
        it('loads persisted data from globalState', async () => {
            await context.globalState.update('kusto.serversAndGroups', {
                items: [makeServer('loaded.kusto.windows.net')],
            });

            mgr.loadServersAndGroups();

            const data = mgr.getServersAndGroups();
            expect(data.items).toHaveLength(1);
            expect((data.items[0] as ServerInfo).cluster).toBe('loaded.kusto.windows.net');
        });

        it('defaults to empty when no persisted data', () => {
            mgr.loadServersAndGroups();
            expect(mgr.getServersAndGroups().items).toEqual([]);
        });
    });

    // ─── findServerInfo ──────────────────────────────────────────────

    describe('findServerInfo', () => {
        it('finds root-level server', async () => {
            await mgr.addServer(makeServer('c1.kusto.windows.net'));
            expect(mgr.findServerInfo('c1.kusto.windows.net')).toBeDefined();
        });

        it('finds server inside a group', async () => {
            await mgr.addServerGroup(makeGroup('G', [makeServer('c2.kusto.windows.net')]));
            expect(mgr.findServerInfo('c2.kusto.windows.net')).toBeDefined();
        });

        it('returns undefined for non-existent server', () => {
            expect(mgr.findServerInfo('not.there')).toBeUndefined();
        });
    });

    // ─── getConfiguredConnections ────────────────────────────────────

    describe('getConfiguredConnections', () => {
        it('returns clusters from both root and groups', async () => {
            await mgr.addServer(makeServer('root.kusto.windows.net'));
            await mgr.addServerGroup(makeGroup('G', [makeServer('grouped.kusto.windows.net')]));

            const connections = mgr.getConfiguredConnections();
            expect(connections).toContain('root.kusto.windows.net');
            expect(connections).toContain('grouped.kusto.windows.net');
        });
    });

    // ─── Database Cache ──────────────────────────────────────────────

    describe('database cache', () => {
        it('setClusterDatabases / getClusterDatabases round-trips', async () => {
            await mgr.addServer(makeServer('c.kusto.windows.net'));
            const dbs: DatabaseInfo[] = [{ name: 'db1' }, { name: 'db2' }];

            mgr.setClusterDatabases('c.kusto.windows.net', dbs);

            expect(mgr.getClusterDatabases('c.kusto.windows.net')).toEqual(dbs);
        });

        it('getClusterDatabases returns undefined for unknown cluster', () => {
            expect(mgr.getClusterDatabases('unknown')).toBeUndefined();
        });

        it('setDatabaseInfo adds new database info', async () => {
            await mgr.addServer(makeServer('c.kusto.windows.net'));
            mgr.setClusterDatabases('c.kusto.windows.net', [{ name: 'db1' }]);

            mgr.setDatabaseInfo('c.kusto.windows.net', { name: 'db2', tables: [] });

            const dbs = mgr.getClusterDatabases('c.kusto.windows.net');
            expect(dbs).toHaveLength(2);
        });

        it('setDatabaseInfo updates existing database info', async () => {
            await mgr.addServer(makeServer('c.kusto.windows.net'));
            mgr.setClusterDatabases('c.kusto.windows.net', [{ name: 'db1' }]);

            mgr.setDatabaseInfo('c.kusto.windows.net', { name: 'db1', tables: [{ name: 'T1', columns: [] }] } as DatabaseInfo);

            const db = mgr.getDatabaseInfo('c.kusto.windows.net', 'db1');
            expect(db?.tables).toHaveLength(1);
        });

        it('getDatabaseInfo returns undefined for unknown database', async () => {
            await mgr.addServer(makeServer('c.kusto.windows.net'));
            expect(mgr.getDatabaseInfo('c.kusto.windows.net', 'nope')).toBeUndefined();
        });
    });

    // ─── Document Connections ────────────────────────────────────────

    describe('document connections', () => {
        it('hasSavedDocumentConnection returns false initially', () => {
            expect(mgr.hasSavedDocumentConnection('file:///doc.kql')).toBe(false);
        });

        it('setDocumentConnection saves and retrieves a connection', async () => {
            await mgr.setDocumentConnection('file:///doc.kql', 'c.kusto.windows.net', 'mydb');

            const saved = mgr.getSavedDocumentConnection('file:///doc.kql');
            expect(saved).toBeDefined();
            expect(saved!.cluster).toBe('c.kusto.windows.net');
            expect(saved!.database).toBe('mydb');
        });

        it('setDocumentConnection persists to workspaceState', async () => {
            await mgr.setDocumentConnection('file:///doc.kql', 'c.kusto.windows.net', 'db');
            expect(context.workspaceState.update).toHaveBeenCalled();
        });

        it('setDocumentConnection notifies the language server', async () => {
            await mgr.setDocumentConnection('file:///doc.kql', 'c.kusto.windows.net', 'db');
            expect(server.sendDocumentConnectionChanged).toHaveBeenCalledWith(
                'file:///doc.kql', 'c.kusto.windows.net', 'db', null,
            );
        });

        it('setDocumentConnection with undefined cluster saves "no connection"', async () => {
            await mgr.setDocumentConnection('file:///doc.kql', undefined, undefined);

            expect(mgr.hasSavedDocumentConnection('file:///doc.kql')).toBe(true);
            const saved = mgr.getSavedDocumentConnection('file:///doc.kql');
            expect(saved!.cluster).toBeUndefined();
        });

        it('loadDocumentConnections restores from workspaceState', async () => {
            const connections: DocumentConnection[] = [
                { uri: 'file:///a.kql', cluster: 'c1', database: 'db1' },
                { uri: 'file:///b.kql', cluster: 'c2', database: 'db2' },
            ];
            await context.workspaceState.update('kusto.documentConnections', connections);

            await mgr.loadDocumentConnections();

            expect(mgr.getSavedDocumentConnection('file:///a.kql')?.cluster).toBe('c1');
            expect(mgr.getSavedDocumentConnection('file:///b.kql')?.cluster).toBe('c2');
        });
    });

    // ─── Event Registration ──────────────────────────────────────────

    describe('events', () => {
        it('fires serversAndGroupsChanged when server is added', async () => {
            let fired = 0;
            mgr.registerOnServersAndGroupsChanged(() => fired++);

            await mgr.addServer(makeServer('c.kusto.windows.net'));
            expect(fired).toBe(1);
        });

        it('fires serversAndGroupsChanged when server is removed', async () => {
            await mgr.addServer(makeServer('c.kusto.windows.net'));

            let fired = 0;
            mgr.registerOnServersAndGroupsChanged(() => fired++);

            await mgr.removeServer('c.kusto.windows.net');
            expect(fired).toBe(1);
        });

        it('fires documentConnectionChanged when connection is set', async () => {
            let changedUri: string | undefined;
            mgr.registerOnDocumentConnectionChanged(async (uri) => { changedUri = uri; });

            await mgr.setDocumentConnection('file:///doc.kql', 'c', 'db');
            expect(changedUri).toBe('file:///doc.kql');
        });

        it('disposes listener registration', async () => {
            let fired = 0;
            const disposable = mgr.registerOnServersAndGroupsChanged(() => fired++);
            disposable.dispose();

            await mgr.addServer(makeServer('c.kusto.windows.net'));
            expect(fired).toBe(0);
        });
    });

    // ─── Hostname Resolution ─────────────────────────────────────────

    describe('getHostName', () => {
        it('uses server to decode connection string', async () => {
            const name = await mgr.getHostName('https://mycluster.kusto.windows.net');
            expect(name).toBe('mycluster.kusto.windows.net');
        });

        it('falls back to simple parsing when server fails', async () => {
            const failServer = createMockServer({
                decodeConnectionString: vi.fn(async () => { throw new Error('fail'); }),
            });
            const failMgr = new ConnectionManager(createMockContext(), failServer);

            const name = await failMgr.getHostName('https://fallback.kusto.windows.net');
            expect(name).toBe('fallback.kusto.windows.net');
        });
    });

    // ─── Resource-scoped proxy cluster URIs (issue #139) ─────────────
    //
    // These exercise the simple-parsing fallback directly, because it is the path
    // that truncated the proxy URI to its front-door host name.

    describe('getHostName simple parsing', () => {
        const workspaceUri = 'https://ade.loganalytics.io/subscriptions/sub-1/resourcegroups/rg-1/providers/microsoft.operationalinsights/workspaces/my-workspace';
        let fallbackMgr: ConnectionManager;

        beforeEach(() => {
            fallbackMgr = new ConnectionManager(createMockContext(), createMockServer({
                decodeConnectionString: vi.fn(async () => { throw new Error('no server'); }),
            }));
        });

        it('preserves the full Log Analytics workspace URI', async () => {
            expect(await fallbackMgr.getHostName(workspaceUri)).toBe(workspaceUri);
        });

        it('preserves the full Application Insights component URI', async () => {
            const uri = 'https://ade.applicationinsights.io/subscriptions/sub-1/resourcegroups/rg-1/providers/microsoft.insights/components/my-app';
            expect(await fallbackMgr.getHostName(uri)).toBe(uri);
        });

        it('reduces a plain cluster URI to its hostname', async () => {
            expect(await fallbackMgr.getHostName('https://mycluster.kusto.windows.net')).toBe('mycluster.kusto.windows.net');
        });

        it('treats a single path segment as a database, not a resource path', async () => {
            expect(await fallbackMgr.getHostName('https://help.kusto.windows.net/Samples')).toBe('help.kusto.windows.net');
        });

        it('handles a bare hostname with no scheme', async () => {
            expect(await fallbackMgr.getHostName('mycluster.kusto.windows.net')).toBe('mycluster.kusto.windows.net');
        });

        it('extracts the data source from a connection string', async () => {
            expect(await fallbackMgr.getHostName('Data Source=https://mycluster.kusto.windows.net;Initial Catalog=mydb'))
                .toBe('mycluster.kusto.windows.net');
        });

        it('preserves a resource-scoped data source in a connection string', async () => {
            expect(await fallbackMgr.getHostName(`Data Source=${workspaceUri};Initial Catalog=my-workspace`)).toBe(workspaceUri);
        });

        it('adds a resource-scoped URI as a first-class connection', async () => {
            await fallbackMgr.ensureServer(workspaceUri);

            const info = fallbackMgr.findServerInfo(workspaceUri);
            expect(info).toBeDefined();
            expect(info!.connection).toBe(workspaceUri);
            expect(info!.displayName).toBe('my-workspace');
            expect(fallbackMgr.getConfiguredConnections()).toContain(workspaceUri);
        });

        it('keeps two workspaces behind the same proxy host as separate connections', async () => {
            const otherUri = workspaceUri.replace('my-workspace', 'other-workspace');
            await fallbackMgr.ensureServer(workspaceUri);
            await fallbackMgr.ensureServer(otherUri);

            expect(fallbackMgr.findServerInfo(workspaceUri)?.displayName).toBe('my-workspace');
            expect(fallbackMgr.findServerInfo(otherUri)?.displayName).toBe('other-workspace');
            expect(fallbackMgr.getConfiguredConnections()).toEqual(
                expect.arrayContaining([workspaceUri, otherUri])
            );
        });
    });

    // ─── Edit / Rename Server ────────────────────────────────────────

    describe('editServer', () => {
        it('updates connection and cluster', async () => {
            await mgr.addServer(makeServer('old.kusto.windows.net', 'https://old.kusto.windows.net'));

            await mgr.editServer('old.kusto.windows.net', 'https://new.kusto.windows.net');

            const info = mgr.findServerInfo('new.kusto.windows.net');
            expect(info).toBeDefined();
            expect(info!.connection).toBe('https://new.kusto.windows.net');
        });

        it('sets display name when different from cluster', async () => {
            await mgr.addServer(makeServer('c.kusto.windows.net'));

            await mgr.editServer('c.kusto.windows.net', 'https://c.kusto.windows.net', 'My Cluster');

            const info = mgr.findServerInfo('c.kusto.windows.net');
            expect(info!.displayName).toBe('My Cluster');
        });

        it('clears display name when same as cluster', async () => {
            await mgr.addServer({ ...makeServer('c.kusto.windows.net'), displayName: 'Old Name' });

            await mgr.editServer('c.kusto.windows.net', 'https://c.kusto.windows.net', 'c.kusto.windows.net');

            const info = mgr.findServerInfo('c.kusto.windows.net');
            expect(info!.displayName).toBeUndefined();
        });
    });

    describe('renameServer', () => {
        it('sets display name', async () => {
            await mgr.addServer(makeServer('c.kusto.windows.net'));

            await mgr.renameServer('c.kusto.windows.net', 'Friendly Name');

            const info = mgr.findServerInfo('c.kusto.windows.net');
            expect(info!.displayName).toBe('Friendly Name');
        });

        it('clears display name when set to cluster name', async () => {
            await mgr.addServer({ ...makeServer('c.kusto.windows.net'), displayName: 'Old' });

            await mgr.renameServer('c.kusto.windows.net', 'c.kusto.windows.net');

            const info = mgr.findServerInfo('c.kusto.windows.net');
            expect(info!.displayName).toBeUndefined();
        });
    });
});
