// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/*
 * Azure Data Explorer web deep links:
 *
 *   https://dataexplorer.azure.com/clusters/<cluster>/databases/<database>?query=<base64 gzip>
 *
 * The extension's URI handler accepts the same path and query
 * (vscode://ms-kusto.kusto-explorer-vscode/clusters/<cluster>/databases/<database>?query=...),
 * so a web link converts by swapping the origin.
 *
 * Pure module (no VS Code APIs) so it runs unchanged on the desktop and web
 * extension hosts and is unit-testable.
 */

import { getAdxWebHost } from './kustoEndpoints';

/** Largest query text a link may expand to; bounds a malicious compressed payload. */
export const MAX_DEEP_LINK_QUERY_LENGTH = 1024 * 1024;

/** A query opened from or copied to a deep link. */
export interface DeepLink {
    /** Cluster hostname, lowercased (e.g. `help.kusto.windows.net`). */
    readonly cluster: string;
    readonly database: string;
    readonly query: string;
}

// A DNS hostname with an optional port.
const HOSTNAME = /^(?=.{1,253}(:|$))[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:\d{1,5})?$/;
const GZIP_OS_BYTE = 9;
const GZIP_OS_UNKNOWN = 0xff;

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array | undefined {
    try {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    } catch {
        return undefined;
    }
}

/** Encodes query text as the base64 of its gzip, the form Azure Data Explorer web uses (not URI-escaped). */
export async function encodeDeepLinkQuery(query: string): Promise<string> {
    const stream = new Blob([new TextEncoder().encode(query)]).stream().pipeThrough(new CompressionStream('gzip'));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    // The gzip header's OS byte varies by platform; use "unknown" as the web app does so links are identical everywhere.
    if (bytes.length > GZIP_OS_BYTE) {
        bytes[GZIP_OS_BYTE] = GZIP_OS_UNKNOWN;
    }
    return bytesToBase64(bytes);
}

/**
 * Decodes a deep link's `query` value: base64 of gzip, or plain query text.
 * Throws if the text expands beyond {@link MAX_DEEP_LINK_QUERY_LENGTH}.
 */
export async function decodeDeepLinkQuery(value: string): Promise<string> {
    const bytes = base64ToBytes(value.trim());
    if (!bytes || bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
        return value;
    }
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '';
    let total = 0;
    for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) {
            break;
        }
        total += chunk.byteLength;
        if (total > MAX_DEEP_LINK_QUERY_LENGTH * 4) {
            await reader.cancel();
            throw new Error('The query in the link is too large.');
        }
        text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
    if (text.length > MAX_DEEP_LINK_QUERY_LENGTH) {
        throw new Error('The query in the link is too large.');
    }
    return text;
}

/**
 * Normalizes a cluster from a link to a hostname: accepts a hostname, an
 * https URL, or a short name (completed with `defaultDomain`). Returns
 * undefined for anything else, including http URLs.
 */
export function normalizeDeepLinkCluster(cluster: string, defaultDomain = '.kusto.windows.net'): string | undefined {
    let value = cluster.trim().toLowerCase();
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(value)) {
        let url: URL;
        try {
            url = new URL(value);
        } catch {
            return undefined;
        }
        if (url.protocol !== 'https:' || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
            return undefined;
        }
        value = url.host;
    }
    if (value && !value.includes('.')) {
        value += defaultDomain.startsWith('.') ? defaultDomain.toLowerCase() : `.${defaultDomain.toLowerCase()}`;
    }
    return HOSTNAME.test(value) ? value : undefined;
}

function decodeSegment(segment: string): string | undefined {
    try {
        return decodeURIComponent(segment);
    } catch {
        return undefined;
    }
}

/**
 * Parses the path and query string of a deep link
 * (`/clusters/<cluster>/databases/<database>`, `query=<value>`).
 * Throws an Error describing what is wrong with an unusable link.
 */
export async function parseDeepLink(path: string, queryString: string, defaultDomain?: string): Promise<DeepLink> {
    const segments = path.split('/').filter(s => s.length > 0);
    if (segments.length !== 4 || segments[0]!.toLowerCase() !== 'clusters' || segments[2]!.toLowerCase() !== 'databases') {
        throw new Error('The link must have the form /clusters/<cluster>/databases/<database>?query=<query>.');
    }
    const rawCluster = decodeSegment(segments[1]!);
    const cluster = rawCluster === undefined ? undefined : normalizeDeepLinkCluster(rawCluster, defaultDomain);
    if (!cluster) {
        throw new Error(`The link names an invalid cluster: ${rawCluster ?? segments[1]}`);
    }
    const database = decodeSegment(segments[3]!)?.trim();
    if (!database || database.length > 260 || [...database].some(c => c.charCodeAt(0) < 0x20)) {
        throw new Error('The link names an invalid database.');
    }
    const params = new URLSearchParams(queryString.startsWith('?') ? queryString.slice(1) : queryString);
    const rawQuery = params.get('query');
    if (rawQuery === null || rawQuery.length === 0) {
        throw new Error('The link has no query.');
    }
    const query = await decodeDeepLinkQuery(rawQuery);
    return { cluster, database, query };
}

/** Builds an Azure Data Explorer web link for a query, on the web host of the cluster's cloud. */
export async function buildAdxWebLink(link: DeepLink): Promise<string> {
    const host = getAdxWebHost(link.cluster.replace(/:\d+$/, ''));
    const query = encodeURIComponent(await encodeDeepLinkQuery(link.query));
    return `https://${host}/clusters/${encodeURIComponent(link.cluster)}/databases/${encodeURIComponent(link.database)}?query=${query}`;
}
