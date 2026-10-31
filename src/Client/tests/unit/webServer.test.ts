// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect, vi } from 'vitest';
import { WebServer } from '../../features/webServer';
import { KustoWebClient, toRequestError, KustoRequestError } from '../../features/kustoWebClient';
import type { KustoClientLike } from '../../features/kustoWebClient';
import type { ClientRequestProperties } from 'azure-kusto-data';

interface Call {
    endpoint: 'query' | 'mgmt';
    clusterUrl: string;
    db: string;
    text: string;
    properties: ClientRequestProperties | undefined;
}

function v1(columns: string[], rows: unknown[][]): unknown {
    return { Tables: [{ TableName: 'Table_0', Columns: columns.map(c => ({ ColumnName: c, ColumnType: 'string' })), Rows: rows }] };
}

const PRINT_ONE = [
    { FrameType: 'DataSetHeader' },
    { FrameType: 'DataTable', TableId: 1, TableKind: 'PrimaryResult', TableName: 'PrimaryResult', Columns: [{ ColumnName: 'print_0', ColumnType: 'long' }], Rows: [[1]] },
    { FrameType: 'DataSetCompletion', HasErrors: false },
];

/** A fake KustoClient that answers from a handler and records each call. */
function fakeFactory(handler: (call: Call) => unknown | Promise<unknown>) {
    const calls: Call[] = [];
    const closed: string[] = [];
    const factory = (clusterUrl: string, getToken: () => Promise<string>): KustoClientLike => {
        const run = async (endpoint: 'query' | 'mgmt', db: string, text: string, properties?: ClientRequestProperties) => {
            await getToken();
            const call: Call = { endpoint, clusterUrl, db, text, properties };
            calls.push(call);
            return handler(call);
        };
        return {
            executeQuery: (db, text, properties) => run('query', db, text, properties),
            executeMgmt: (db, text, properties) => run('mgmt', db, text, properties),
            close: () => { closed.push(clusterUrl); },
        };
    };
    return { factory, calls, closed };
}

function createServer(handler: (call: Call) => unknown | Promise<unknown>, documents: Record<string, string> = {}) {
    const fake = fakeFactory(handler);
    const getToken = vi.fn(async () => 'token');
    const server = new WebServer(getToken, { clientFactory: fake.factory, getDocumentText: uri => documents[uri] });
    return { server, getToken, ...fake };
}

describe('WebServer.runQuery', () => {
    it('runs queries against the v2 endpoint with request options', async () => {
        const { server, calls, closed, getToken } = createServer(() => PRINT_ONE);
        const result = await server.runQuery('print 1', 'help.kusto.windows.net', 'Samples', true, 100, 'crid-1');

        expect(result).toEqual({
            data: {
                query: 'print 1', cluster: 'help.kusto.windows.net', database: 'Samples',
                tables: [{ name: 'PrimaryResult', columns: [{ name: 'print_0', type: 'long' }], rows: [[1]] }],
            },
        });
        expect(getToken).toHaveBeenCalledWith('https://help.kusto.windows.net');
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ endpoint: 'query', clusterUrl: 'https://help.kusto.windows.net', db: 'Samples', text: 'print 1' });
        expect(calls[0]!.properties?.clientRequestId).toBe('crid-1');
        expect(calls[0]!.properties?.raw).toBe(true);
        expect(calls[0]!.properties?.getOption('request_readonly')).toBe(true);
        expect(calls[0]!.properties?.getOption('query_take_max_records')).toBe(100);
        expect(closed).toHaveLength(1);
    });

    it('sends commands to the mgmt endpoint and uses the default database when none is set', async () => {
        const { server, calls } = createServer(() => v1(['Version'], [['1.0']]));
        const result = await server.runQuery('// comment\n.show version', 'Data Source=https://help.kusto.windows.net');
        expect(calls[0]).toMatchObject({ endpoint: 'mgmt', db: 'NetDefaultDB' });
        expect(result?.data?.tables[0]?.rows).toEqual([['1.0']]);
        expect(result?.data?.database).toBeUndefined();
    });

    it('rejects empty queries, missing connections and client directives without calling the service', async () => {
        const { server, calls } = createServer(() => PRINT_ONE);
        expect((await server.runQuery('  ', 'c'))?.error?.message).toBe('No query');
        expect((await server.runQuery('print 1'))?.error?.message).toMatch(/No connection/);
        expect((await server.runQuery('#connect cluster("x")', 'c'))?.error?.message).toMatch(/not supported/);
        expect(calls).toHaveLength(0);
    });

    it('maps HTTP error bodies to diagnostics', async () => {
        const { server } = createServer(() => {
            throw Object.assign(new Error('Request failed with status code 400'), {
                response: { status: 400, data: { error: { message: 'Bad', '@message': 'Syntax error', '@permanent': true, innererror: { '@line': '1', '@pos': '7', '@token': 'x' } } } },
            });
        });
        const result = await server.runQuery('print x', 'help.kusto.windows.net', 'Samples');
        expect(result?.error).toEqual({
            message: 'Syntax error',
            details: 'Error is permanent, retrying will not help',
            range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
        });
    });

    it('maps in-band errors and network failures', async () => {
        const inBand = createServer(() => [{ FrameType: 'DataSetCompletion', HasErrors: true, OneApiErrors: [{ error: { '@message': 'Partial query failure' } }] }]);
        expect((await inBand.server.runQuery('print 1', 'c.kusto.windows.net'))?.error?.message).toBe('Partial query failure');

        const network = createServer(() => { throw new Error('Network Error'); });
        expect((await network.server.runQuery('print 1', 'c.kusto.windows.net'))?.error).toEqual({ message: 'Network Error' });
    });

    it('reports token failures as errors', async () => {
        const fake = fakeFactory(() => PRINT_ONE);
        const server = new WebServer(async () => { throw new Error('Not signed in'); }, { clientFactory: fake.factory });
        expect((await server.runQuery('print 1', 'c.kusto.windows.net'))?.error?.message).toBe('Not signed in');
    });
});

describe('WebServer cancellation', () => {
    it('closes the request and asks the service to cancel it', async () => {
        let release: (v: unknown) => void = () => {};
        const { server, calls, closed } = createServer(call => call.text.startsWith('.cancel')
            ? v1(['RunningQueryCanceled'], [['True']])
            : new Promise(resolve => { release = resolve; }));

        const running = server.runQuery('print 1', 'help.kusto.windows.net', 'Samples', true, undefined, 'crid-2');
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        await expect(server.cancelQuery('crid-2')).resolves.toBe(true);
        expect(calls[1]).toMatchObject({ endpoint: 'mgmt', db: 'Samples', text: '.cancel query "crid-2"' });
        expect(closed.length).toBeGreaterThanOrEqual(2);

        release(PRINT_ONE);
        await running;
        await expect(server.cancelQuery('crid-2')).resolves.toBe(false);
    });

    it('maps axios cancellation to a cancelled request error', () => {
        const error = toRequestError(Object.assign(new Error('Client Closed'), { __CANCEL__: true }));
        expect(error).toBeInstanceOf(KustoRequestError);
        expect(error.cancelled).toBe(true);
        expect(error.message).toBe('The query was cancelled.');
    });

    it('unwraps errors that keep the axios error in inner', () => {
        const error = toRequestError({ message: 'POST request failed with status 429', inner: { response: { status: 429, data: { error: { message: 'throttled' } } } } });
        expect(error.message).toBe('POST request failed with status 429');
        expect(error.body).toEqual({ error: { message: 'throttled' } });
    });

    it('generates a request id when none is given', async () => {
        const fake = fakeFactory(() => PRINT_ONE);
        const client = new KustoWebClient(async () => 't', fake.factory);
        await client.execute('https://c.kusto.windows.net', 'db', 'print 1');
        expect(fake.calls[0]!.properties?.clientRequestId).toMatch(/^KEVSC\.execute;[0-9a-f-]{36}$/);
    });
});

describe('WebServer schema and connections', () => {
    it('decodes connection strings', async () => {
        const { server } = createServer(() => PRINT_ONE);
        await expect(server.decodeConnectionString('Data Source=https://help.kusto.windows.net;Initial Catalog=Samples'))
            .resolves.toEqual({ cluster: 'help.kusto.windows.net', database: 'Samples' });
        await expect(server.decodeConnectionString('Initial Catalog=x')).resolves.toBeNull();
    });

    it('reads the server kind from .show version', async () => {
        const { server } = createServer(() => v1(['BuildVersion', 'ServiceType'], [['1.0', 'Engine']]));
        await expect(server.getServerKind('help.kusto.windows.net')).resolves.toEqual({ serverKind: 'Engine' });
        const unknown = createServer(() => v1(['BuildVersion'], [['1.0']]));
        await expect(unknown.server.getServerKind('help.kusto.windows.net')).resolves.toEqual({ serverKind: 'Unknown' });
    });

    it('lists databases with pretty names', async () => {
        const { server, calls } = createServer(() => v1(['DatabaseName', 'PrettyName'], [['Samples', ''], ['db2', 'Pretty']]));
        await expect(server.getServerInfo('help.kusto.windows.net', null)).resolves.toEqual({
            cluster: 'help.kusto.windows.net',
            databases: [{ name: 'Samples' }, { name: 'db2', alternateName: 'Pretty' }],
        });
        expect(calls[0]?.text).toBe('.show databases | project DatabaseName, PrettyName');
    });

    it('loads database schema and only queries views and graphs when present', async () => {
        const { server, calls } = createServer(call => {
            if (call.text.startsWith('.show database identity')) {
                return v1(['DatabaseName', 'PrettyName'], [['Samples', '']]);
            }
            if (call.text.startsWith('.show databases')) {
                return v1(['DatabaseName', 'EntityType', 'EntityName', 'DocString', 'Folder', 'CslInputSchema', 'Content', 'CslOutputSchema', 'Properties'],
                    [['Samples', 'Table', 'StormEvents', '', '', '', '', 'State:string', '']]);
            }
            throw new Error(`unexpected ${call.text}`);
        });
        await expect(server.getDatabaseInfo('help.kusto.windows.net', "it's")).resolves.toMatchObject({
            name: 'Samples',
            tables: [{ name: 'StormEvents', columns: [{ name: 'State', type: 'string' }] }],
        });
        expect(calls.map(c => c.text).sort()).toEqual([
            '.show database identity | project DatabaseName, PrettyName',
            ".show databases (['it\\'s']) entities",
        ]);
        expect(calls.every(c => c.db === "it's")).toBe(true);
    });

    it('propagates schema failures so callers can report them', async () => {
        const { server } = createServer(() => { throw new Error('Forbidden'); });
        await expect(server.getServerInfo('help.kusto.windows.net', null)).rejects.toThrow('Forbidden');
    });

    it('remembers cluster URLs with ports for bare host names', async () => {
        const { server, calls } = createServer(() => PRINT_ONE);
        server.sendConnectionsUpdated(['Data Source=https://localhost:8080;Initial Catalog=db', 'not a ; = valid']);
        await server.runQuery('print 1', 'localhost', 'db');
        expect(calls[0]?.clusterUrl).toBe('https://localhost:8080');
    });
});

describe('WebServer query ranges', () => {
    it('uses the open document text', async () => {
        const { server } = createServer(() => PRINT_ONE, { 'file:///a.kql': 'print 1\n\nprint 2' });
        await expect(server.getQueryRanges('file:///a.kql')).resolves.toEqual({
            uri: 'file:///a.kql',
            ranges: [
                { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } },
                { start: { line: 2, character: 0 }, end: { line: 2, character: 7 } },
            ],
        });
        await expect(server.getQueryRange('file:///a.kql', { line: 2, character: 3 })).resolves.toEqual({
            start: { line: 2, character: 0 }, end: { line: 2, character: 7 },
        });
        await expect(server.getQueryRange('file:///missing.kql', { line: 0, character: 0 })).resolves.toBeNull();
    });
});
