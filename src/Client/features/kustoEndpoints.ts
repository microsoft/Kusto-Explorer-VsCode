// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/*
 * Resolves how to authenticate to a Kusto cluster: which AAD resource (token
 * scope) to request and which VS Code authentication provider signs the user
 * in. The cluster's own auth metadata (`/v1/rest/auth/metadata`) is the source
 * of truth, cached per cluster; a static table of known Kusto domains is the
 * fallback when metadata is unavailable. Also maps a cluster to the Azure Data
 * Explorer web host of its cloud.
 *
 * Pure module (no VS Code APIs) so it runs unchanged on the desktop and web
 * extension hosts and is unit-testable.
 *
 * Trust model: an access token for a cloud-wide audience such as
 * `https://kusto.kusto.windows.net` is accepted by every cluster in that
 * cloud. Metadata is therefore only consulted for hosts under a known Kusto
 * domain, and only an audience of that same cloud (or the cluster's own
 * origin) is accepted from it; otherwise any HTTPS host could ask for, and
 * then replay, a token that works against the user's real clusters.
 */

/** VS Code authentication provider ids. */
export type AuthProviderId = 'microsoft' | 'microsoft-sovereign-cloud';

/** Values of VS Code's `microsoft-sovereign-cloud.environment` setting. */
export type SovereignEnvironment = 'USGovernment' | 'ChinaCloud' | 'custom';

/** A Kusto domain suffix and the AAD audience its clusters accept. */
interface KustoDomain {
    /** Host suffix without a leading dot, e.g. `kusto.windows.net`. */
    readonly suffix: string;
    /** AAD resource id, without a trailing slash. */
    readonly audience: string;
}

/** An Azure cloud that hosts Kusto clusters. */
export interface KustoCloud {
    readonly name: string;
    readonly loginEndpoint: string;
    readonly authProvider: AuthProviderId;
    /** Required `microsoft-sovereign-cloud.environment` value for sovereign clouds. */
    readonly sovereignEnvironment?: SovereignEnvironment;
    /** Azure Data Explorer web UI host, if the cloud has one. */
    readonly webHost?: string;
    readonly domains: readonly KustoDomain[];
}

export const KUSTO_CLOUDS: readonly KustoCloud[] = [
    {
        name: 'Azure',
        loginEndpoint: 'https://login.microsoftonline.com',
        authProvider: 'microsoft',
        webHost: 'dataexplorer.azure.com',
        domains: [
            { suffix: 'kusto.windows.net', audience: 'https://kusto.kusto.windows.net' },
            { suffix: 'kustomfa.windows.net', audience: 'https://kusto.kustomfa.windows.net' },
            // Fabric Eventhouse / KQL databases accept the public Kusto audience.
            { suffix: 'kusto.fabric.microsoft.com', audience: 'https://kusto.kusto.windows.net' },
        ],
    },
    {
        name: 'Azure US Government',
        loginEndpoint: 'https://login.microsoftonline.us',
        authProvider: 'microsoft-sovereign-cloud',
        sovereignEnvironment: 'USGovernment',
        webHost: 'dataexplorer.azure.us',
        domains: [
            { suffix: 'kusto.usgovcloudapi.net', audience: 'https://kusto.kusto.usgovcloudapi.net' },
            { suffix: 'kustomfa.usgovcloudapi.net', audience: 'https://kusto.kustomfa.usgovcloudapi.net' },
        ],
    },
    {
        name: 'Azure China',
        loginEndpoint: 'https://login.chinacloudapi.cn',
        authProvider: 'microsoft-sovereign-cloud',
        sovereignEnvironment: 'ChinaCloud',
        webHost: 'dataexplorer.azure.cn',
        domains: [
            { suffix: 'kusto.chinacloudapi.cn', audience: 'https://kusto.kusto.chinacloudapi.cn' },
            { suffix: 'kustomfa.chinacloudapi.cn', audience: 'https://kusto.kustomfa.chinacloudapi.cn' },
        ],
    },
    {
        name: 'Azure Germany',
        loginEndpoint: 'https://login.microsoftonline.de',
        authProvider: 'microsoft-sovereign-cloud',
        sovereignEnvironment: 'custom',
        domains: [
            { suffix: 'kusto.cloudapi.de', audience: 'https://kusto.kusto.cloudapi.de' },
        ],
    },
];

/** Azure Data Explorer web hosts across all clouds. */
export const ADX_WEB_HOSTS: readonly string[] = KUSTO_CLOUDS.flatMap(c => (c.webHost ? [c.webHost] : []));

const PUBLIC_CLOUD = KUSTO_CLOUDS[0]!;

/** How to obtain a token for a cluster. */
export interface KustoAuthTarget {
    /** OAuth scope to request, e.g. `https://kusto.kusto.windows.net/.default`. */
    readonly scope: string;
    readonly authProvider: AuthProviderId;
    readonly sovereignEnvironment?: SovereignEnvironment;
    /** Display name of the cloud, when known. */
    readonly cloudName?: string;
    /**
     * Where the scope came from: the cluster's auth metadata, the known-domain
     * table, the generic `*.kusto.<apex>` host shape, or the cluster host itself.
     */
    readonly source: 'metadata' | 'table' | 'pattern' | 'host';
}

/** The `AzureAD` section of a cluster's `/v1/rest/auth/metadata` response. */
export interface KustoAuthMetadata {
    readonly LoginEndpoint?: string;
    readonly LoginMfaRequired?: boolean;
    readonly KustoServiceResourceId?: string;
}

/** Returns the lowercased hostname of an https URI, or undefined. */
function httpsHostname(clusterUri: string): string | undefined {
    try {
        const url = new URL(clusterUri);
        // Never derive a token scope for plaintext http.
        return url.protocol === 'https:' ? url.hostname.toLowerCase() : undefined;
    } catch {
        return undefined;
    }
}

/** Finds the known Kusto domain (longest matching suffix) that hosts the given hostname. */
export function findKustoDomain(hostname: string): { cloud: KustoCloud; domain: KustoDomain } | undefined {
    const host = hostname.toLowerCase();
    let best: { cloud: KustoCloud; domain: KustoDomain } | undefined;
    for (const cloud of KUSTO_CLOUDS) {
        for (const domain of cloud.domains) {
            // Require a cluster label in front of the suffix.
            if (host.endsWith('.' + domain.suffix) && (!best || domain.suffix.length > best.domain.suffix.length)) {
                best = { cloud, domain };
            }
        }
    }
    return best;
}

function normalizeOrigin(value: string | undefined): string | undefined {
    if (!value) {
        return undefined;
    }
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
            return undefined;
        }
        return `https://${url.host.toLowerCase()}`;
    } catch {
        return undefined;
    }
}

/** Returns the cloud whose login endpoint matches the given URL, if any. */
function cloudForLoginEndpoint(loginEndpoint: string | undefined): KustoCloud | undefined {
    const origin = normalizeOrigin(loginEndpoint);
    return origin ? KUSTO_CLOUDS.find(c => c.loginEndpoint === origin) : undefined;
}

function targetFor(cloud: KustoCloud, audience: string, source: KustoAuthTarget['source']): KustoAuthTarget {
    return {
        scope: `${audience}/.default`,
        authProvider: cloud.authProvider,
        ...(cloud.sovereignEnvironment ? { sovereignEnvironment: cloud.sovereignEnvironment } : {}),
        cloudName: cloud.name,
        source,
    };
}

/**
 * Resolves the auth target from the static table alone (no network). Returns
 * null for non-https or unparsable URIs.
 *
 *   *.kusto.windows.net / *.kusto.fabric.microsoft.com → https://kusto.kusto.windows.net
 *   *.kusto.usgovcloudapi.net                         → https://kusto.kusto.usgovcloudapi.net (sovereign)
 *   *.kusto.chinacloudapi.cn                          → https://kusto.kusto.chinacloudapi.cn (sovereign)
 *   other *.kusto.<apex>                              → https://kusto.kusto.<apex>
 *   anything else (custom DNS)                        → the cluster's own origin
 */
export function resolveKustoAuthTargetFromTable(clusterUri: string): KustoAuthTarget | null {
    const host = httpsHostname(clusterUri);
    if (!host) {
        return null;
    }
    const known = findKustoDomain(host);
    if (known) {
        return targetFor(known.cloud, known.domain.audience, 'table');
    }
    const match = host.match(/\.kusto\.([^/]+)$/);
    if (match) {
        return { scope: `https://kusto.kusto.${match[1]}/.default`, authProvider: 'microsoft', source: 'pattern' };
    }
    // Per-cluster scope: works for that cluster, at the cost of a sign-in per cluster.
    return { scope: `https://${host}/.default`, authProvider: 'microsoft', source: 'host' };
}

/**
 * Resolves the auth target, preferring the cluster's auth metadata when the
 * host is under a known Kusto domain and the metadata names an audience of
 * that cloud (or the cluster's own origin) and no other cloud's login
 * endpoint. Falls back to the static table.
 */
export function resolveKustoAuthTarget(clusterUri: string, metadata: KustoAuthMetadata | undefined): KustoAuthTarget | null {
    const fallback = resolveKustoAuthTargetFromTable(clusterUri);
    const host = httpsHostname(clusterUri);
    const known = host ? findKustoDomain(host) : undefined;
    if (!fallback || !host || !known || !metadata) {
        return fallback;
    }

    let audience = normalizeOrigin(metadata.KustoServiceResourceId);
    if (audience && metadata.LoginMfaRequired === true) {
        audience = audience.replace('.kusto.', '.kustomfa.');
    }
    const allowed = new Set([...known.cloud.domains.map(d => d.audience), `https://${host}`]);
    if (!audience || !allowed.has(audience)) {
        return fallback;
    }
    // A login endpoint of a different known cloud contradicts the host's domain.
    const loginCloud = cloudForLoginEndpoint(metadata.LoginEndpoint);
    if (loginCloud && loginCloud !== known.cloud) {
        return fallback;
    }
    return targetFor(known.cloud, audience, 'metadata');
}

/** Returns the Azure Data Explorer web host for the cloud that hosts the given cluster host. */
export function getAdxWebHost(clusterHost: string): string {
    return findKustoDomain(clusterHost)?.cloud.webHost ?? PUBLIC_CLOUD.webHost!;
}

// =============================================================================
// Metadata fetching
// =============================================================================

/** Minimal subset of the WHATWG fetch API used here (injectable for tests). */
export type FetchLike = (url: string, init: {
    method: 'GET';
    redirect: 'error';
    headers: Record<string, string>;
    signal?: AbortSignal;
}) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Fetches and caches each cluster's auth metadata, keyed by cluster origin. */
export class KustoAuthMetadataCache {
    private readonly entries = new Map<string, { expires: number; value: Promise<KustoAuthMetadata | undefined> }>();

    constructor(
        private readonly fetchFn: FetchLike = (url, init) => fetch(url, init),
        private readonly now: () => number = Date.now,
        private readonly timeoutMs = 10_000,
        /** How long a failed lookup is remembered before retrying. */
        private readonly failureTtlMs = 60_000,
    ) {}

    /**
     * Returns the cluster's `AzureAD` auth metadata, or undefined if the host
     * is not a known Kusto domain or the metadata cannot be fetched.
     */
    get(clusterUri: string): Promise<KustoAuthMetadata | undefined> {
        const host = httpsHostname(clusterUri);
        if (!host || !findKustoDomain(host)) {
            return Promise.resolve(undefined);
        }
        const origin = `https://${new URL(clusterUri).host.toLowerCase()}`;
        const cached = this.entries.get(origin);
        if (cached && cached.expires > this.now()) {
            return cached.value;
        }
        const value = this.fetchMetadata(origin);
        const entry = { expires: Number.POSITIVE_INFINITY, value };
        this.entries.set(origin, entry);
        void value.then(result => {
            if (!result) {
                entry.expires = this.now() + this.failureTtlMs;
            }
        });
        return value;
    }

    /** Resolves the auth target for a cluster, using cached metadata when available. */
    async resolve(clusterUri: string): Promise<KustoAuthTarget | null> {
        return resolveKustoAuthTarget(clusterUri, await this.get(clusterUri));
    }

    private async fetchMetadata(origin: string): Promise<KustoAuthMetadata | undefined> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await this.fetchFn(`${origin}/v1/rest/auth/metadata`, {
                method: 'GET',
                // A redirect could hand the lookup to another host.
                redirect: 'error',
                headers: { Accept: 'application/json' },
                signal: controller.signal,
            });
            if (!response.ok) {
                return undefined;
            }
            const body = await response.json() as { AzureAD?: unknown } | null;
            const azureAd = body?.AzureAD;
            return azureAd && typeof azureAd === 'object' ? azureAd as KustoAuthMetadata : undefined;
        } catch {
            return undefined;
        } finally {
            clearTimeout(timer);
        }
    }
}
