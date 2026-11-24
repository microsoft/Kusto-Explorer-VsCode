// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Host-independent Kusto REST client for the web build, on top of azure-kusto-data.
 *
 * Clients are shared per cluster; each request has its own abort signal.
 * Responses are returned raw and mapped by kustoResponse.ts.
 */

import { Client as KustoClient, ClientRequestProperties, KustoConnectionStringBuilder } from 'azure-kusto-data';
import { isCommand } from './kustoResponse';

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
    // KustoApiError exposes response directly; throttling and auth errors still wrap it in inner.
    const inner = (error as { inner?: unknown } | undefined)?.inner;
    const source = (inner && typeof inner === 'object' && 'response' in inner ? inner : error) as
        { message?: string; response?: { status?: number; data?: unknown } } | undefined;
    const message = (error as { message?: string } | undefined)?.message
        ?? source?.message
        ?? String(error);
    return new KustoRequestError(message, source?.response?.data);
}

// -----------------------------------------------------------------------------

export const defaultKustoClientFactory: KustoClientFactory = (clusterUrl, getToken) =>
    new KustoClient(KustoConnectionStringBuilder.withTokenProvider(clusterUrl, getToken));

function newRequestId(): string {
    // Web Crypto exists in browsers, web workers and Node 19+, but isn't in this project's TS lib.
    const crypto = (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto;
    return `KEVSC.execute;${crypto.randomUUID()}`;
}

export class KustoWebClient {
    private readonly clients = new Map<string, KustoClientLike>();
    private readonly running = new Map<string, AbortController>();

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
        let client = this.clients.get(clusterUrl);
        if (!client) {
            client = this.createClient(clusterUrl, () => this.getToken(clusterUrl));
            this.clients.set(clusterUrl, client);
        }
        const controller = new AbortController();
        const properties = new ClientRequestProperties(undefined, undefined, clientRequestId, undefined, 'Kusto Explorer for VS Code (web)');
        properties.raw = true;
        properties.largeIntegersAsStrings = true;
        properties.abortSignal = controller.signal;
        if (options.readOnly) {
            properties.setOption('request_readonly', true);
        }
        if (options.maxRows !== undefined) {
            properties.setOption('query_take_max_records', options.maxRows);
        }

        this.running.set(clientRequestId, controller);
        try {
            return isCommand(text)
                ? await client.executeMgmt(db, text, properties)
                : await client.executeQuery(db, text, properties);
        } catch (error) {
            throw toRequestError(error);
        } finally {
            this.running.delete(clientRequestId);
        }
    }

    /** True while a request with this client request id is in flight. */
    isRunning(clientRequestId: string): boolean {
        return this.running.has(clientRequestId);
    }

    /**
     * Aborts this HTTP request. The SDK also cancels queries on the service;
     * management commands cannot be cancelled server-side this way.
     */
    async cancel(clientRequestId: string): Promise<boolean> {
        const request = this.running.get(clientRequestId);
        if (!request) {
            return false;
        }
        this.running.delete(clientRequestId);
        request.abort();
        return true;
    }
}
