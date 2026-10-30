// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect } from 'vitest';
import {
    buildAdxWebLink,
    decodeDeepLinkQuery,
    encodeDeepLinkQuery,
    MAX_DEEP_LINK_QUERY_LENGTH,
    normalizeDeepLinkCluster,
    parseDeepLink,
} from '../../features/deepLink';

// Produced by Azure Data Explorer web for `StormEvents | take 10` on help/Samples.
const KNOWN_LINK = 'https://dataexplorer.azure.com/clusters/help.kusto.windows.net/databases/Samples?query=H4sIAAAAAAAA%2FwsuyS%2FKdS1LzSspVqhRKEnMTlUwNAAAQ3pCDBUAAAA%3D';

async function gzipBase64(bytes: Uint8Array): Promise<string> {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    return Buffer.from(await new Response(stream).arrayBuffer()).toString('base64');
}

describe('deep links', () => {
    it('decodes a known Azure Data Explorer web link', async () => {
        const url = new URL(KNOWN_LINK);
        expect(await parseDeepLink(url.pathname, url.search)).toEqual({
            cluster: 'help.kusto.windows.net',
            database: 'Samples',
            query: 'StormEvents | take 10',
        });
    });

    it('builds the same link Azure Data Explorer web does', async () => {
        const link = await buildAdxWebLink({ cluster: 'help.kusto.windows.net', database: 'Samples', query: 'StormEvents | take 10' });
        expect(link).toBe(KNOWN_LINK);
    });

    it.each([
        ['multi-line text', 'StormEvents\n| where State == "TEXAS"\r\n| summarize count() by EventType'],
        ['non-ASCII text', 'print s = "Grüße, 東京 😀"'],
        ['URL-significant characters', 'print a = "x+y/z=1&b=2?#%"'],
        ['an empty query', ''],
    ])('round-trips %s', async (_name, query) => {
        const built = new URL(await buildAdxWebLink({ cluster: 'help.kusto.windows.net', database: 'My DB', query }));
        expect(await parseDeepLink(built.pathname, built.search)).toEqual({ cluster: 'help.kusto.windows.net', database: 'My DB', query });
    });

    it('accepts a plain-text query value', async () => {
        expect(await decodeDeepLinkQuery('StormEvents | count')).toBe('StormEvents | count');
    });

    it('rejects a query that expands beyond the size limit', async () => {
        const huge = await gzipBase64(new Uint8Array(MAX_DEEP_LINK_QUERY_LENGTH + 1).fill(0x61));
        await expect(decodeDeepLinkQuery(huge)).rejects.toThrow(/too large/);
    });

    it('rejects gzip content that is not UTF-8', async () => {
        await expect(decodeDeepLinkQuery(await gzipBase64(new Uint8Array([0xff, 0xfe, 0xfd])))).rejects.toThrow();
    });

    it('uses the cloud web host of the cluster', async () => {
        const link = await buildAdxWebLink({ cluster: 'c.kusto.usgovcloudapi.net', database: 'd', query: 'T' });
        expect(link.startsWith('https://dataexplorer.azure.us/clusters/c.kusto.usgovcloudapi.net/databases/d?query=')).toBe(true);
    });

    it.each([
        ['/clusters/help.kusto.windows.net/databases/Samples', ''],
        ['/clusters/help.kusto.windows.net', '?query=StormEvents'],
        ['/databases/Samples', '?query=StormEvents'],
        ['/clusters/help.kusto.windows.net/databases/Samples/extra', '?query=StormEvents'],
        ['/clusters/http%3A%2F%2Fhelp.kusto.windows.net/databases/Samples', '?query=StormEvents'],
        ['/clusters/evil.com%2Fx/databases/Samples', '?query=StormEvents'],
        ['/clusters/help.kusto.windows.net/databases/%0A', '?query=StormEvents'],
        ['/clusters/%E0%A4%A/databases/Samples', '?query=StormEvents'],
    ])('rejects the malformed link %s%s', async (path, search) => {
        await expect(parseDeepLink(path, search)).rejects.toThrow();
    });
});

describe('normalizeDeepLinkCluster', () => {
    it.each([
        ['help.kusto.windows.net', 'help.kusto.windows.net'],
        ['Help.Kusto.Windows.Net', 'help.kusto.windows.net'],
        ['https://help.kusto.windows.net', 'help.kusto.windows.net'],
        ['https://help.kusto.windows.net/', 'help.kusto.windows.net'],
        ['help', 'help.kusto.windows.net'],
        ['trd-abc.z0.kusto.fabric.microsoft.com', 'trd-abc.z0.kusto.fabric.microsoft.com'],
        ['mycluster.kusto.contoso.com:8443', 'mycluster.kusto.contoso.com:8443'],
    ])('%s → %s', (input, expected) => {
        expect(normalizeDeepLinkCluster(input)).toBe(expected);
    });

    it('completes short names with the given default domain', () => {
        expect(normalizeDeepLinkCluster('c', '.kusto.usgovcloudapi.net')).toBe('c.kusto.usgovcloudapi.net');
    });

    it.each(['http://help.kusto.windows.net', 'https://user@help.kusto.windows.net', 'https://help.kusto.windows.net/db', 'a b', '-bad.com', ''])(
        'rejects %s', input => {
            expect(normalizeDeepLinkCluster(input)).toBeUndefined();
        });
});
