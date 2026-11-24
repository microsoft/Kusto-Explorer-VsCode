// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, ClientRequestProperties, CloudSettings, KustoConnectionStringBuilder, KustoDataErrors } from 'azure-kusto-data';
import { KustoWebClient, toRequestError } from '../../features/kustoWebClient';
import { mapResponse } from '../../features/kustoResponse';
import { WebServer } from '../../features/webServer';
import { formatCellValue } from '../../features/tsv';

interface Request {
    text: string;
    id: string;
    path: string;
}

const requests: Request[] = [];
const clients: Client[] = [];
const pending = new Map<string, ServerResponse>();
let cluster: string;
let status = 200;
let body = '';
const frames = (rows = '[[1]]', columns = '[{"ColumnName":"x","ColumnType":"long"}]') =>
    `[{"FrameType":"DataTable","TableId":0,"TableKind":"PrimaryResult","TableName":"PrimaryResult","Columns":${columns},"Rows":${rows}},{"FrameType":"DataSetCompletion","HasErrors":false}]`;

const service = createServer(async (request, response) => {
    let data = '';
    for await (const chunk of request) data += chunk;
    const payload = JSON.parse(data) as { csl: string };
    requests.push({ text: payload.csl, id: String(request.headers['x-ms-client-request-id']), path: request.url! });
    response.setHeader('Content-Type', 'application/json');
    if (payload.csl.startsWith('wait') || payload.csl === '.wait') {
        pending.set(payload.csl, response);
        return;
    }
    response.statusCode = status;
    response.end(payload.csl.startsWith('.cancel query') ? '{"Tables":[]}' : body);
});

function sdkClient(url = cluster, getToken = async () => 'token'): Client {
    const client = new Client(KustoConnectionStringBuilder.withTokenProvider(url, getToken));
    clients.push(client);
    return client;
}

beforeAll(async () => {
    service.listen(0, '127.0.0.1');
    await once(service, 'listening');
    const address = service.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    cluster = `http://127.0.0.1:${address.port}`;
    CloudSettings.writeToCache(cluster);
});

beforeEach(() => {
    requests.length = 0;
    pending.clear();
    status = 200;
    body = frames();
});

afterAll(async () => {
    for (const client of clients) client.close();
    service.closeAllConnections();
    await new Promise<void>((resolve, reject) => service.close(error => error ? reject(error) : resolve()));
});

describe('SDK raw responses', () => {
    it.each(['query', 'command'])('preserves integer boundaries and nested dynamic values in a raw %s result', async kind => {
        const columns = '[{"ColumnName":"min","ColumnType":"long"},{"ColumnName":"max","ColumnType":"long"},{"ColumnName":"safe","ColumnType":"long"},{"ColumnName":"dynamic","ColumnType":"dynamic"},{"ColumnName":"date","ColumnType":"datetime"},{"ColumnName":"real","ColumnType":"real"}]';
        const rows = '[[-9223372036854775808,9223372036854775807,9007199254740991,{"nested":[9007199254740992,-9007199254740992,{"n":9007199254740993,"text":"9223372036854775807","escaped":"quote\\"12345678901234567"}]},"2020-01-01T00:00:00.123Z",1.5e30]]';
        body = kind === 'query' ? frames(rows, columns)
            : `{"Tables":[{"TableName":"PrimaryResult","Columns":${columns},"Rows":${rows}}]}`;
        const client = new KustoWebClient(async () => 'token', sdkClient);
        const raw = await client.execute(cluster, 'db', kind === 'query' ? 'print values' : '.show values');
        expect(mapResponse(raw).tables[0]?.rows[0]).toEqual([
            '-9223372036854775808', '9223372036854775807', 9007199254740991,
            { nested: ['9007199254740992', '-9007199254740992', { n: '9007199254740993', text: '9223372036854775807', escaped: 'quote"12345678901234567' }] },
            '2020-01-01T00:00:00.1230000Z', 1.5e30,
        ]);
        const saved = JSON.stringify(mapResponse(raw));
        expect(JSON.parse(saved).tables[0].rows[0][0]).toBe('-9223372036854775808');
        expect(saved).not.toContain('9223372036854776000');
        expect(formatCellValue(mapResponse(raw).tables[0]!.rows[0]![0])).toBe('-9223372036854775808');
        expect(formatCellValue(mapResponse(raw).tables[0]!.rows[0]![3]))
            .toBe('{"nested":["9007199254740992","-9007199254740992",{"n":"9007199254740993","text":"9223372036854775807","escaped":"quote\\"12345678901234567"}]}');
    });
});

describe('SDK per-request cancellation', () => {
    it('shares a client without aborting concurrent requests and sends the matching service cancellation', async () => {
        const factory = vi.fn(sdkClient);
        const client = new KustoWebClient(async () => 'token', factory);
        const first = client.execute(cluster, 'db', 'wait first', { clientRequestId: 'first' });
        const firstResult = first.then(value => ({ value }), error => ({ error }));
        const second = client.execute(cluster, 'db', 'wait second', { clientRequestId: 'second' });
        const secondResult = second.then(value => ({ value }), error => ({ error }));
        await vi.waitFor(() => expect(pending.size).toBe(2));
        expect(factory).toHaveBeenCalledTimes(1);
        await expect(client.cancel('first')).resolves.toBe(true);
        expect(await firstResult).toMatchObject({ error: { cancelled: true } });
        await vi.waitFor(() => expect(requests.some(r => r.text === '.cancel query "first"' && r.path === '/v1/rest/mgmt')).toBe(true));
        expect(requests.filter(r => r.text.startsWith('.cancel'))).toHaveLength(1);
        expect(client.isRunning('second')).toBe(true);
        pending.get('wait second')!.end(frames());
        const secondOutcome = await secondResult;
        expect(secondOutcome).toHaveProperty('value');
        expect(mapResponse(secondOutcome.value).tables[0]?.rows).toEqual([[1]]);
        await expect(client.cancel('first')).resolves.toBe(false);
    });

    it('rejects a pre-aborted SDK request before authentication or HTTP', async () => {
        const token = vi.fn(async () => 'token');
        const client = sdkClient(cluster, token);
        const properties = new ClientRequestProperties();
        const controller = new AbortController();
        controller.abort();
        properties.abortSignal = controller.signal;
        await expect(client.executeQuery('db', 'print 1', properties)).rejects.toMatchObject({ code: 'ERR_CANCELED' });
        expect(token).not.toHaveBeenCalled();
        expect(requests).toEqual([]);
    });

    it('cancels while authentication is pending without sending a query or a service cancellation', async () => {
        let release!: (token: string) => void;
        const token = vi.fn(() => new Promise<string>(resolve => { release = resolve; }));
        const client = new KustoWebClient(token, sdkClient);
        const running = client.execute(cluster, 'db', 'print 1', { clientRequestId: 'auth-wait' });
        const result = running.then(value => ({ value }), error => ({ error }));
        await vi.waitFor(() => expect(token).toHaveBeenCalled());
        await client.cancel('auth-wait');
        expect(await result).toMatchObject({ error: { cancelled: true } });
        release('token');
        expect(requests).toEqual([]);
    });

    it('aborts an in-flight command HTTP request without issuing .cancel query', async () => {
        const client = new KustoWebClient(async () => 'token', sdkClient);
        const running = client.execute(cluster, 'db', '.wait', { clientRequestId: 'command' });
        const result = running.then(value => ({ value }), error => ({ error }));
        await vi.waitFor(() => expect(pending.has('.wait')).toBe(true));
        await client.cancel('command');
        expect(await result).toMatchObject({ error: { cancelled: true } });
        expect(requests).toEqual([{ text: '.wait', id: 'command', path: '/v1/rest/mgmt' }]);
    });
});

describe('SDK error mapping', () => {
    const nestedError = {
        code: 'BadRequest', message: 'outer', '@permanent': true,
        innererror: { code: 'Syntax', '@message': 'Syntax error', '@line': '1', '@pos': '7', '@token': 'x' },
    };

    it('retains the SDK KustoApiError response and maps the deepest diagnostic', async () => {
        status = 400;
        body = JSON.stringify({ error: nestedError });
        const properties = new ClientRequestProperties();
        properties.raw = true;
        let caught: unknown;
        try {
            await sdkClient().executeQuery('db', 'print x', properties);
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(KustoDataErrors.KustoApiError);
        if (!(caught instanceof KustoDataErrors.KustoApiError)) throw new Error('Expected KustoApiError');
        expect(caught.isPermanent).toBe(true);
        expect(caught.response?.status).toBe(400);
        expect(caught.error).toEqual(nestedError);
        expect(toRequestError(caught).body).toEqual({ error: nestedError });
        const server = new WebServer(async () => 'token', { clientFactory: sdkClient });
        expect((await server.runQuery('print x', cluster, 'db'))?.error).toEqual({
            message: 'Syntax error', details: 'Error is permanent, retrying will not help',
            range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
        });
    });

    it('keeps throttling bodies even though 429 still uses ThrottlingError', async () => {
        status = 429;
        body = '{"error":{"code":"TooManyRequests","@message":"Slow down"}}';
        await expect(sdkClient().executeQuery('db', 'print 1')).rejects.toBeInstanceOf(KustoDataErrors.ThrottlingError);
        const server = new WebServer(async () => 'token', { clientFactory: sdkClient });
        expect((await server.runQuery('print 1', cluster, 'db'))?.error?.message).toBe('Slow down');
    });

    it.each([401, 403, 502])('maps HTTP %s without assuming a OneApiError body', async code => {
        status = code;
        body = code === 502 ? '<html>Bad gateway</html>' : '';
        const server = new WebServer(async () => 'token', { clientFactory: sdkClient });
        expect((await server.runQuery('print 1', cluster, 'db'))?.error?.message)
            .toBe(code === 502 ? body : `Request failed with status code ${code}`);
    });

    it('maps token-provider errors without sending HTTP', async () => {
        const server = new WebServer(async () => { throw new Error('Sign-in required'); }, { clientFactory: sdkClient });
        expect((await server.runQuery('print 1', cluster, 'db'))?.error?.message).toContain('Sign-in required');
        expect(requests).toEqual([]);
    });

    it('still decodes in-band failures when raw results bypass SDK response parsing', async () => {
        body = JSON.stringify([{ FrameType: 'DataSetCompletion', HasErrors: true, OneApiErrors: [{ error: nestedError }] }]);
        const server = new WebServer(async () => 'token', { clientFactory: sdkClient });
        expect((await server.runQuery('print x', cluster, 'db'))?.error?.message).toBe('Syntax error');
    });
});
