// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/*
 * Bridges AAD token requests from the language server to VS Code's built-in
 * Microsoft authentication provider. The server uses this fallback path only
 * when its native Kusto.Data authentication flow cannot complete in-process
 * (e.g. running under Remote-SSH / WSL / Codespaces, or when the local token
 * cache is wedged). Routing sign-in through VS Code lets the user manage
 * accounts via the standard Accounts gear and avoids hosting any sign-in UI
 * in the language-server child process.
 */

import { authentication, AuthenticationSession, Disposable, window } from 'vscode';

/** Parameters for the server's getAuthenticationToken request. */
export interface GetAuthenticationTokenParams {
    clusterUri: string;
}

/** Result of the server's getAuthenticationToken request. */
export interface GetAuthenticationTokenResult {
    accessToken: string | null;
}

/**
 * All Kusto clusters within the same Azure cloud share a single AAD resource
 * (e.g. `https://kusto.kusto.windows.net` for the public cloud). Issuing the
 * token against that shared resource means one sign-in covers every cluster
 * the user has configured, including all the clusters whose schemas are
 * fetched on extension startup. Per-cluster scopes would prompt the user
 * once per cluster.
 *
 * In some environments (notably the Extension Development Host and some
 * remote setups) `getSession({ silent: true })` returns nothing even
 * immediately after a successful `createIfNone`, which would cause every
 * subsequent token request to re-prompt. To stay robust we keep the
 * resolved session in an in-process cache and only re-acquire it when
 * VS Code tells us via `onDidChangeSessions` that it has changed (e.g.
 * the user signed out via the Accounts gear).
 */
const inFlightSessions = new Map<string, Promise<AuthenticationSession | undefined>>();
const cachedSessions = new Map<string, AuthenticationSession>();
let sessionChangeListener: Disposable | undefined;

function ensureSessionChangeListener(): void {
    if (sessionChangeListener) {
        return;
    }
    sessionChangeListener = authentication.onDidChangeSessions(e => {
        if (e.provider.id === 'microsoft') {
            // Any change to Microsoft sessions (sign-in, sign-out, switch account)
            // invalidates our cache; the next token request will re-acquire.
            cachedSessions.clear();
        }
    });
}

/**
 * Returns true if the JWT access token expires within the next 5 minutes,
 * or if its expiry cannot be determined (in which case we err on the side
 * of refreshing). Used to decide when the cached session is no longer safe
 * to reuse and we need to ask VS Code for a fresh token.
 */
function isTokenExpiringSoon(accessToken: string): boolean {
    const refreshSkewSeconds = 5 * 60;
    try {
        const parts = accessToken.split('.');
        if (parts.length < 2 || !parts[1]) {
            return true;
        }
        // base64url -> base64
        const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
        const json = Buffer.from(padded, 'base64').toString('utf8');
        const payload = JSON.parse(json) as { exp?: number };
        if (typeof payload.exp !== 'number') {
            return true;
        }
        const nowSeconds = Math.floor(Date.now() / 1000);
        return payload.exp - nowSeconds <= refreshSkewSeconds;
    } catch {
        return true;
    }
}

/**
 * Returns the AAD resource scope for the cloud that hosts the given Kusto
 * cluster, or null if the URI cannot be parsed. The convention for Kusto
 * first-party AAD resources is `kusto.<cloud-apex>`:
 *
 *   *.kusto.windows.net          → https://kusto.kusto.windows.net/.default
 *   *.kusto.usgovcloudapi.net    → https://kusto.kusto.usgovcloudapi.net/.default
 *   *.kusto.chinacloudapi.cn     → https://kusto.kusto.chinacloudapi.cn/.default
 *   *.kusto.cloudapi.de          → https://kusto.kusto.cloudapi.de/.default
 *
 * For any other host (custom DNS / non-public cluster) we fall back to the
 * cluster's own URI as the scope - that still works for that cluster, the
 * user just may be prompted more than once.
 */
export function getKustoScope(clusterUri: string): string | null {
    let hostname: string;
    try {
        // hostname (not host) deliberately excludes any :port suffix — AAD
        // resource URIs for Kusto never include a port.
        hostname = new URL(clusterUri).hostname.toLowerCase();
    } catch {
        return null;
    }
    // Match the public Kusto host shape "*.kusto.<apex>" (apex may have one
    // or more labels, e.g. "windows.net" or "usgovcloudapi.net").
    const match = hostname.match(/\.kusto\.([^/]+)$/);
    if (match) {
        return `https://kusto.kusto.${match[1]}/.default`;
    }
    // Unknown host shape: fall back to a per-cluster scope (port stripped).
    // Restrict the fallback to https — public Kusto and any sane on-prem /
    // sovereign / private-link deployment is HTTPS, and refusing to derive
    // a scope from an http:// URI prevents a malicious or misconfigured
    // connection string from coaxing AAD into issuing a token bound to a
    // plaintext resource. AAD itself only issues tokens for resources
    // registered in the user's tenant, but blocking http here is a cheap
    // additional guard with no legitimate-user impact.
    try {
        const u = new URL(clusterUri);
        if (u.protocol !== 'https:') {
            return null;
        }
        return `${u.protocol}//${u.hostname}/.default`;
    } catch {
        return null;
    }
}

/**
 * Acquires an AAD access token for a Kusto cluster using VS Code's built-in
 * Microsoft authentication provider. Returns a result whose accessToken is
 * null if the user cancelled or no session could be obtained.
 */
export async function acquireMicrosoftAuthenticationToken(
    clusterUri: string
): Promise<GetAuthenticationTokenResult> {
    const scope = getKustoScope(clusterUri);
    if (!scope) {
        return { accessToken: null };
    }

    ensureSessionChangeListener();

    // Fast path: a cached session whose access token is not yet near expiry.
    // We always prefer reusing the cached token over calling getSession again,
    // because in some environments (notably the Extension Development Host
    // and certain remote configurations) `getSession({ silent: true })` can
    // return null even when a valid session exists, and `createIfNone` would
    // then re-prompt the user. The cache is cleared whenever VS Code reports
    // a session change (sign-out, account switch).
    const cached = cachedSessions.get(scope);
    if (cached && !isTokenExpiringSoon(cached.accessToken)) {
        return { accessToken: cached.accessToken };
    }

    let pending = inFlightSessions.get(scope);
    if (!pending) {
        pending = (async () => {
            // Silent first: returns a fresh access token from VS Code's persistent
            // session cache without showing UI. Survives VS Code restarts.
            let session = await authentication.getSession('microsoft', [scope], { silent: true });
            if (!session && !cached) {
                // First-ever request for this scope and no persisted session:
                // prompt the user via VS Code's Accounts UI.
                session = await authentication.getSession('microsoft', [scope], { createIfNone: true });
            }
            // If silent unexpectedly fails but we still have a cached session
            // whose token has not yet expired, fall back to the cached session.
            if (!session && cached && !isTokenExpiringSoon(cached.accessToken)) {
                session = cached;
            }
            return session;
        })();
        inFlightSessions.set(scope, pending);
        void pending.finally(() => inFlightSessions.delete(scope));
    }

    try {
        const session = await pending;
        if (session) {
            cachedSessions.set(scope, session);
        }
        return { accessToken: session?.accessToken ?? null };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        window.showErrorMessage(`Kusto: failed to acquire Microsoft account token for ${clusterUri}. ${message}`);
        return { accessToken: null };
    }
}
