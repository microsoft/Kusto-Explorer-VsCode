// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect } from 'vitest';
import { getKustoScope } from '../../features/authentication';

// ─── getKustoScope ───────────────────────────────────────────────────────────
//
// Validates the host-to-scope mapping used to bridge AAD token requests from
// the language server through VS Code's Microsoft authentication provider.
// Regressions here would cause unnecessary re-prompts (per-cluster scopes
// instead of the shared cloud-wide resource) or, worse, silent failures.

describe('getKustoScope', () => {
    describe('public clouds', () => {
        it('maps a public Azure cluster to the kusto.windows.net resource', () => {
            expect(getKustoScope('https://help.kusto.windows.net'))
                .toBe('https://kusto.kusto.windows.net/.default');
        });

        it('maps a US Government cluster to the usgovcloudapi.net resource', () => {
            expect(getKustoScope('https://mycluster.kusto.usgovcloudapi.net'))
                .toBe('https://kusto.kusto.usgovcloudapi.net/.default');
        });

        it('maps a China cluster to the chinacloudapi.cn resource', () => {
            expect(getKustoScope('https://mycluster.kusto.chinacloudapi.cn'))
                .toBe('https://kusto.kusto.chinacloudapi.cn/.default');
        });

        it('maps a Germany cluster to the cloudapi.de resource', () => {
            expect(getKustoScope('https://mycluster.kusto.cloudapi.de'))
                .toBe('https://kusto.kusto.cloudapi.de/.default');
        });

        it('returns the same shared scope for every cluster in the same cloud', () => {
            // The whole point of the shared cloud apex resource is that one
            // sign-in covers every cluster a user has configured.
            const a = getKustoScope('https://help.kusto.windows.net');
            const b = getKustoScope('https://other.kusto.windows.net');
            const c = getKustoScope('https://yet-another.kusto.windows.net');
            expect(a).toBe(b);
            expect(b).toBe(c);
        });

        it('lowercases the hostname', () => {
            expect(getKustoScope('https://HELP.KUSTO.WINDOWS.NET'))
                .toBe('https://kusto.kusto.windows.net/.default');
        });

        it('ignores any path on the cluster URI', () => {
            expect(getKustoScope('https://help.kusto.windows.net/v1/rest/query'))
                .toBe('https://kusto.kusto.windows.net/.default');
        });

        it('ignores a port suffix when matching the public-cloud apex', () => {
            // Public-cloud Kusto resources never include a port; the scope
            // must collapse to the shared apex regardless of the cluster URI.
            expect(getKustoScope('https://help.kusto.windows.net:443'))
                .toBe('https://kusto.kusto.windows.net/.default');
        });

        it('handles an ingest- prefixed cluster (still inside the apex)', () => {
            expect(getKustoScope('https://ingest-help.kusto.windows.net'))
                .toBe('https://kusto.kusto.windows.net/.default');
        });

        it('handles a follower / regional cluster suffix inside the apex', () => {
            expect(getKustoScope('https://mycluster.eastus.kusto.windows.net'))
                .toBe('https://kusto.kusto.windows.net/.default');
        });
    });

    describe('custom DNS / non-public hosts', () => {
        it('falls back to a per-cluster scope when the host is not under .kusto.<apex>', () => {
            expect(getKustoScope('https://mycluster.example.com'))
                .toBe('https://mycluster.example.com/.default');
        });

        it('strips the port from the per-cluster fallback scope', () => {
            // AAD resource URIs never include a port; the fallback path must
            // also strip it so the scope is a valid resource identifier.
            expect(getKustoScope('https://mycluster.example.com:8080'))
                .toBe('https://mycluster.example.com/.default');
        });

        it('preserves the URI scheme in the per-cluster fallback', () => {
            expect(getKustoScope('http://mycluster.example.com'))
                .toBe('http://mycluster.example.com/.default');
        });

        it('lowercases the hostname in the per-cluster fallback', () => {
            expect(getKustoScope('https://MyCluster.Example.COM'))
                .toBe('https://mycluster.example.com/.default');
        });

        it('does not match a host that merely contains "kusto" as a label without the .kusto. apex pattern', () => {
            // "kusto-test.example.com" must not be misinterpreted as a public
            // Kusto cloud host.
            expect(getKustoScope('https://kusto-test.example.com'))
                .toBe('https://kusto-test.example.com/.default');
        });

        it('does not match a host whose name starts with "kusto." (no left-side cluster label)', () => {
            // The regex requires ".kusto." (with a leading dot) so a bare
            // "kusto.windows.net" host falls through to the fallback path.
            expect(getKustoScope('https://kusto.windows.net'))
                .toBe('https://kusto.windows.net/.default');
        });
    });

    describe('invalid input', () => {
        it('returns null for a non-URI string', () => {
            expect(getKustoScope('not a uri')).toBeNull();
        });

        it('returns null for an empty string', () => {
            expect(getKustoScope('')).toBeNull();
        });

        it('returns null for a bare hostname without scheme', () => {
            // URL parsing requires a scheme; a bare hostname is rejected
            // rather than silently producing a malformed scope.
            expect(getKustoScope('help.kusto.windows.net')).toBeNull();
        });
    });
});
