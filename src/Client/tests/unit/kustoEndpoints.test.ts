// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect, vi } from 'vitest';
import {
    FetchLike,
    getAdxWebHost,
    KustoAuthMetadata,
    KustoAuthMetadataCache,
    resolveKustoAuthTarget,
    resolveKustoAuthTargetFromTable,
} from '../../features/kustoEndpoints';

const PUBLIC = 'https://kusto.kusto.windows.net/.default';
const USGOV = 'https://kusto.kusto.usgovcloudapi.net/.default';
const CHINA = 'https://kusto.kusto.chinacloudapi.cn/.default';

describe('resolveKustoAuthTargetFromTable', () => {
    it.each([
        ['public', 'https://help.kusto.windows.net', PUBLIC, 'microsoft', undefined],
        ['public regional', 'https://mycluster.eastus.kusto.windows.net', PUBLIC, 'microsoft', undefined],
        ['private link', 'https://mycluster.privatelink.eastus.kusto.windows.net', PUBLIC, 'microsoft', undefined],
        ['Fabric Eventhouse', 'https://trd-abc123.z0.kusto.fabric.microsoft.com', PUBLIC, 'microsoft', undefined],
        ['public MFA', 'https://secure.kustomfa.windows.net', 'https://kusto.kustomfa.windows.net/.default', 'microsoft', undefined],
        ['US Gov', 'https://mycluster.eastus.kusto.usgovcloudapi.net', USGOV, 'microsoft-sovereign-cloud', 'USGovernment'],
        ['China', 'https://mycluster.chinaeast2.kusto.chinacloudapi.cn', CHINA, 'microsoft-sovereign-cloud', 'ChinaCloud'],
    ])('%s', (_name, uri, scope, provider, env) => {
        const target = resolveKustoAuthTargetFromTable(uri);
        expect(target).toMatchObject({ scope, authProvider: provider, source: 'table' });
        expect(target?.sovereignEnvironment).toBe(env);
    });

    it('uses the generic *.kusto.<apex> shape for unknown Kusto domains', () => {
        expect(resolveKustoAuthTargetFromTable('https://mycluster.kusto.azuresynapse.net')).toEqual({
            scope: 'https://kusto.kusto.azuresynapse.net/.default', authProvider: 'microsoft', source: 'pattern',
        });
    });

    it('uses a per-cluster scope for custom DNS names', () => {
        expect(resolveKustoAuthTargetFromTable('https://kusto.contoso.com:8080/db')).toEqual({
            scope: 'https://kusto.contoso.com/.default', authProvider: 'microsoft', source: 'host',
        });
    });

    it('refuses http and unparsable URIs', () => {
        expect(resolveKustoAuthTargetFromTable('http://help.kusto.windows.net')).toBeNull();
        expect(resolveKustoAuthTargetFromTable('not a uri')).toBeNull();
    });

    it('does not treat a lookalike host as a known domain', () => {
        expect(resolveKustoAuthTargetFromTable('https://evilkusto.windows.net')?.source).toBe('host');
        expect(resolveKustoAuthTargetFromTable('https://kusto.fabric.microsoft.com.evil.com')?.source).toBe('host');
    });
});

describe('resolveKustoAuthTarget', () => {
    const helpMetadata: KustoAuthMetadata = {
        LoginEndpoint: 'https://login.microsoftonline.com',
        LoginMfaRequired: false,
        KustoServiceResourceId: 'https://kusto.kusto.windows.net',
    };

    it('takes the scope from metadata for a known domain', () => {
        expect(resolveKustoAuthTarget('https://help.kusto.windows.net', helpMetadata)).toMatchObject({
            scope: PUBLIC, authProvider: 'microsoft', source: 'metadata',
        });
    });

    it('takes the Fabric audience from metadata', () => {
        const target = resolveKustoAuthTarget('https://trd-abc.z0.kusto.fabric.microsoft.com', helpMetadata);
        expect(target).toMatchObject({ scope: PUBLIC, source: 'metadata' });
    });

    it('accepts the cluster origin as audience', () => {
        const target = resolveKustoAuthTarget('https://mycluster.eastus.kusto.windows.net', {
            ...helpMetadata, KustoServiceResourceId: 'https://MyCluster.eastus.kusto.windows.net/',
        });
        expect(target).toMatchObject({ scope: 'https://mycluster.eastus.kusto.windows.net/.default', source: 'metadata' });
    });

    it('applies the MFA audience when metadata requires MFA', () => {
        const target = resolveKustoAuthTarget('https://help.kusto.windows.net', { ...helpMetadata, LoginMfaRequired: true });
        expect(target).toMatchObject({ scope: 'https://kusto.kustomfa.windows.net/.default', source: 'metadata' });
    });

    it('uses the sovereign provider for a US Gov cluster', () => {
        const target = resolveKustoAuthTarget('https://c.kusto.usgovcloudapi.net', {
            LoginEndpoint: 'https://login.microsoftonline.us',
            KustoServiceResourceId: 'https://kusto.kusto.usgovcloudapi.net',
        });
        expect(target).toMatchObject({
            scope: USGOV, authProvider: 'microsoft-sovereign-cloud', sovereignEnvironment: 'USGovernment', source: 'metadata',
        });
    });

    it.each([
        ['another cloud audience', { ...helpMetadata, KustoServiceResourceId: 'https://kusto.kusto.chinacloudapi.cn' }],
        ['an arbitrary audience', { ...helpMetadata, KustoServiceResourceId: 'https://graph.microsoft.com' }],
        ['an audience with a path', { ...helpMetadata, KustoServiceResourceId: 'https://kusto.kusto.windows.net/x' }],
        ['an http audience', { ...helpMetadata, KustoServiceResourceId: 'http://kusto.kusto.windows.net' }],
        ['another cloud login endpoint', { ...helpMetadata, LoginEndpoint: 'https://login.chinacloudapi.cn' }],
        ['a missing audience', { LoginEndpoint: 'https://login.microsoftonline.com' }],
    ])('ignores metadata naming %s', (_name, metadata) => {
        expect(resolveKustoAuthTarget('https://help.kusto.windows.net', metadata)).toMatchObject({
            scope: PUBLIC, source: 'table',
        });
    });

    it('ignores metadata for custom DNS hosts', () => {
        const target = resolveKustoAuthTarget('https://kusto.contoso.com', helpMetadata);
        expect(target).toMatchObject({ scope: 'https://kusto.contoso.com/.default', source: 'host' });
    });

    it('falls back to the table without metadata', () => {
        expect(resolveKustoAuthTarget('https://help.kusto.windows.net', undefined)?.source).toBe('table');
    });
});

describe('getAdxWebHost', () => {
    it.each([
        ['help.kusto.windows.net', 'dataexplorer.azure.com'],
        ['x.z0.kusto.fabric.microsoft.com', 'dataexplorer.azure.com'],
        ['c.kusto.usgovcloudapi.net', 'dataexplorer.azure.us'],
        ['c.kusto.chinacloudapi.cn', 'dataexplorer.azure.cn'],
        ['kusto.contoso.com', 'dataexplorer.azure.com'],
    ])('%s → %s', (host, web) => {
        expect(getAdxWebHost(host)).toBe(web);
    });
});

describe('KustoAuthMetadataCache', () => {
    function okFetch(body: unknown): FetchLike & ReturnType<typeof vi.fn> {
        return vi.fn(async () => ({ ok: true, status: 200, json: async () => body })) as never;
    }

    it('fetches the metadata endpoint without following redirects', async () => {
        const fetchFn = okFetch({ AzureAD: { KustoServiceResourceId: 'https://kusto.kusto.windows.net' } });
        const cache = new KustoAuthMetadataCache(fetchFn);
        const target = await cache.resolve('https://Help.kusto.windows.net/Samples');
        expect(target).toMatchObject({ scope: PUBLIC, source: 'metadata' });
        expect(fetchFn).toHaveBeenCalledTimes(1);
        const [url, init] = fetchFn.mock.calls[0]!;
        expect(url).toBe('https://help.kusto.windows.net/v1/rest/auth/metadata');
        expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
    });

    it('caches successful lookups per cluster and shares in-flight requests', async () => {
        const fetchFn = okFetch({ AzureAD: { KustoServiceResourceId: 'https://kusto.kusto.windows.net' } });
        const cache = new KustoAuthMetadataCache(fetchFn);
        await Promise.all([cache.get('https://help.kusto.windows.net'), cache.get('https://help.kusto.windows.net/db')]);
        await cache.get('https://help.kusto.windows.net');
        expect(fetchFn).toHaveBeenCalledTimes(1);
        await cache.get('https://other.kusto.windows.net');
        expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('does not fetch for custom DNS or http hosts', async () => {
        const fetchFn = okFetch({});
        const cache = new KustoAuthMetadataCache(fetchFn);
        expect(await cache.get('https://kusto.contoso.com')).toBeUndefined();
        expect(await cache.get('http://help.kusto.windows.net')).toBeUndefined();
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it.each([
        ['a non-OK status', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }))],
        ['a network or redirect error', vi.fn(async () => { throw new TypeError('fetch failed'); })],
        ['a body without AzureAD', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ x: 1 }) }))],
        ['a non-JSON body', vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } }))],
    ])('falls back to the table on %s and retries after the failure TTL', async (_name, fetchFn) => {
        let now = 1000;
        const cache = new KustoAuthMetadataCache(fetchFn as unknown as FetchLike, () => now, 10_000, 60_000);
        expect(await cache.resolve('https://help.kusto.windows.net')).toMatchObject({ scope: PUBLIC, source: 'table' });
        await cache.get('https://help.kusto.windows.net');
        expect(fetchFn).toHaveBeenCalledTimes(1);
        now += 60_001;
        await cache.get('https://help.kusto.windows.net');
        expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('aborts a lookup that exceeds the timeout', async () => {
        vi.useFakeTimers();
        try {
            const fetchFn: FetchLike = (_url, init) => new Promise((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            });
            const cache = new KustoAuthMetadataCache(fetchFn, Date.now, 5_000);
            const pending = cache.resolve('https://help.kusto.windows.net');
            await vi.advanceTimersByTimeAsync(5_000);
            expect(await pending).toMatchObject({ scope: PUBLIC, source: 'table' });
        } finally {
            vi.useRealTimers();
        }
    });
});
