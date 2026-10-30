// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Host-independent Kusto REST client for the web build, on top of azure-kusto-data.
 *
 * Each request gets its own KustoClient so a single query can be cancelled
 * without affecting others (KustoClient.close() cancels everything in flight).
 * Responses are returned raw and mapped by kustoResponse.ts.
 */

import { Client as KustoClient, ClientRequestProperties, KustoConnectionStringBuilder } from 'azure-kusto-data';
import { isCommand, kustoStringLiteral, parseJsonPreservingBigInts } from './kustoResponse';

/** Returns an access token for the cluster; throws if the user can't be signed in. */
export type ClusterTokenProvider = (clusterUrl: string) => Promise<string>;

export interface KustoRequestOptions {
    clientRequestId?: string | undefined;
    readOnly?: boolean | undefined;
    maxRows?: number | undefined;
}

/** The minimal KustoClient surface used here; lets tests substitute a fake. */
export interface KustoClientLike {
    executeQuery(db: string, query: string, properties?: ClientRequestProperties): Promise<unknown>;
    executeMgmt(db: string, query: string, properties?: ClientRequestProperties): Promise<unknown>;
    close(): void;
}

export type KustoClientFactory = (clusterUrl: string, getToken: () => Promise<string>) => KustoClientLike;

/** A failed request, carrying the Kusto error body when the service returned one. */
export class KustoRequestError extends Error {
    constructor(message: string, readonly body: unknown, readonly cancelled = false) {
        super(message);
        this.name = 'KustoRequestError';
    }
}

/** KCSB's default database name; the client requires some database for every request. */
const DEFAULT_DATABASE = 'NetDefaultDB';

// -----------------------------------------------------------------------------
// Local workarounds for azure-kusto-data 7.2.0.
// Remove once Azure/azure-kusto-node #437, #439, #441 and #443 are released:
//  - #437: `window` is referenced unguarded in web workers. Handled by the web
//          bundle's `define: { window: 'globalThis' }` (esbuild.web.mjs).
//  - #439: longs above 2^53 lose precision in JSON.parse -> applyBigIntSafeParsing.
//  - #441: no per-request cancellation -> one client per request plus a
//          server-side `.cancel query` (KustoWebClient.cancel).
//  - #443: the OneApiError body is only reachable via error.response.data ->
//          toRequestError.
// -----------------------------------------------------------------------------

function applyBigIntSafeParsing(client: KustoClient): void {
    client.axiosInstance.defaults.transformResponse = [(data: unknown) => {
        if (typeof data !== 'string' || data.length === 0) {
            return data;
        }
        try {
            return parseJsonPreservingBigInts(data);
        } catch {
            return data;
        }
    }];
}

function isCancellation(error: unknown): boolean {
    const e = error as { name?: string; code?: string; __CANCEL__?: boolean } | undefined;
    return !!e && (e.__CANCEL__ === true || e.name === 'CanceledError' || e.code === 'ERR_CANCELED');
}

/** Converts whatever azure-kusto-data/axios threw into a KustoRequestError. */
export function toRequestError(error: unknown): KustoRequestError {
    if (error instanceof KustoRequestError) {
        return error;
    }
    if (isCancellation(error)) {
        return new KustoRequestError('The query was cancelled.', undefined, true);
    }
    // ThrottlingError and KustoAuthenticationError keep the original error in `inner`.
    const inner = (error as { inner?: unknown } | undefined)?.inner;
    const source = (inner && typeof inner === 'object' && 'response' in inner ? inner : error) as
        { message?: string; response?: { status?: number; data?: unknown } } | undefined;
    const message = (error as { message?: string } | undefined)?.message
        ?? source?.message
        ?? String(error);
    return new KustoRequestError(message, source?.response?.data);
}

// -----------------------------------------------------------------------------

export const defaultKustoClientFactory: KustoClientFactory = (clusterUrl, getToken) => {
    const client = new KustoClient(KustoConnectionStringBuilder.withTokenProvider(clusterUrl, getToken));
    applyBigIntSafeParsing(client);
    return client;
};

function newRequestId(): string {
    // Web Crypto exists in browsers, web workers and Node 19+, but isn't in this project's TS lib.
    const crypto = (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto;
    return `KEVSC.execute;${crypto.randomUUID()}`;
}

interface RunningRequest {
    client: KustoClientLike;
    clusterUrl: string;
    database: string;
}

export class KustoWebClient {
    private readonly running = new Map<string, RunningRequest>();

    constructor(
        private readonly getToken: ClusterTokenProvider,
        private readonly createClient: KustoClientFactory = defaultKustoClientFactory,
    ) {}

    /**
     * Runs a query (v2 endpoint) or a management command (v1 endpoint) and
     * returns the raw response. Throws KustoRequestError on failure.
     */
    async execute(clusterUrl: string, database: string | undefined, text: string, options: KustoRequestOptions = {}): Promise<unknown> {
        const clientRequestId = options.clientRequestId ?? newRequestId();
        const db = database || DEFAULT_DATABASE;
        const client = this.createClient(clusterUrl, () => this.getToken(clusterUrl));
        const properties = new ClientRequestProperties(undefined, undefined, clientRequestId, undefined, 'Kusto Explorer for VS Code (web)');
        properties.raw = true;
        if (options.readOnly) {
            properties.setOption('request_readonly', true);
        }
        if (options.maxRows !== undefined) {
            properties.setOption('query_take_max_records', options.maxRows);
        }

        this.running.set(clientRequestId, { client, clusterUrl, database: db });
        try {
            return isCommand(text)
                ? await client.executeMgmt(db, text, properties)
                : await client.executeQuery(db, text, properties);
        } catch (error) {
            throw toRequestError(error);
        } finally {
            this.running.delete(clientRequestId);
            client.close();
        }
    }

    /** True while a request with this client request id is in flight. */
    isRunning(clientRequestId: string): boolean {
        return this.running.has(clientRequestId);
    }

    /**
     * Cancels a running request: aborts the HTTP call and asks the service to stop
     * the query, since closing the connection alone leaves it running server-side.
     */
    async cancel(clientRequestId: string): Promise<boolean> {
        const request = this.running.get(clientRequestId);
        if (!request) {
            return false;
        }
        this.running.delete(clientRequestId);
        request.client.close();
        try {
            await this.execute(request.clusterUrl, request.database, `.cancel query ${kustoStringLiteral(clientRequestId)}`);
        } catch {
            // The query may have finished already, or the user may lack permission to cancel it.
        }
        return true;
    }
}
