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

import { authentication, AuthenticationSession, commands, Disposable, window, workspace } from 'vscode';
import { KustoAuthMetadataCache, resolveKustoAuthTargetFromTable } from './kustoEndpoints';
import type { KustoAuthTarget } from './kustoEndpoints';

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
        if (e.provider.id === 'microsoft' || e.provider.id === 'microsoft-sovereign-cloud') {
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
        const json = new TextDecoder().decode(Uint8Array.from(atob(padded), c => c.charCodeAt(0)));
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
 * Returns the AAD scope for a Kusto cluster from the static table of known
 * Kusto domains (no network), or null for a non-https or unparsable URI. All
 * clusters of a cloud share one resource, so one sign-in covers them all:
 *
 *   *.kusto.windows.net, *.kusto.fabric.microsoft.com → https://kusto.kusto.windows.net/.default
 *   *.kusto.usgovcloudapi.net    → https://kusto.kusto.usgovcloudapi.net/.default
 *   *.kusto.chinacloudapi.cn     → https://kusto.kusto.chinacloudapi.cn/.default
 *
 * Any other host (custom DNS) gets a per-cluster scope. Token requests prefer
 * the cluster's auth metadata over this table; see kustoEndpoints.ts.
 */
export function getKustoScope(clusterUri: string): string | null {
    return resolveKustoAuthTargetFromTable(clusterUri)?.scope ?? null;
}

const SOVEREIGN_ENVIRONMENT_SETTING = 'microsoft-sovereign-cloud.environment';

const authMetadata = new KustoAuthMetadataCache();

/**
 * Returns false, after telling the user which setting to change, when a
 * sovereign-cloud cluster needs VS Code's Microsoft Sovereign Cloud sign-in
 * set to a different environment than the configured one.
 */
function checkSovereignEnvironment(target: KustoAuthTarget, clusterUri: string): boolean {
    if (target.authProvider !== 'microsoft-sovereign-cloud' || !target.sovereignEnvironment) {
        return true;
    }
    const configured = workspace.getConfiguration().get<string>(SOVEREIGN_ENVIRONMENT_SETTING);
    if (configured === target.sovereignEnvironment) {
        return true;
    }
    const openSettings = 'Open Settings';
    void window.showErrorMessage(
        `Kusto: ${clusterUri} is in ${target.cloudName ?? 'a sovereign cloud'}. To sign in, set "${SOVEREIGN_ENVIRONMENT_SETTING}" to "${target.sovereignEnvironment}".`,
        openSettings,
    ).then(choice => {
        if (choice === openSettings) {
            void commands.executeCommand('workbench.action.openSettings', SOVEREIGN_ENVIRONMENT_SETTING);
        }
    });
    return false;
}

/**
 * Acquires an AAD access token for a Kusto cluster using VS Code's built-in
 * Microsoft (or Microsoft Sovereign Cloud) authentication provider. Returns a result whose accessToken is
 * null if the user cancelled or no session could be obtained.
 */
export async function acquireMicrosoftAuthenticationToken(
    clusterUri: string
): Promise<GetAuthenticationTokenResult> {
    const target = await authMetadata.resolve(clusterUri);
    if (!target || !checkSovereignEnvironment(target, clusterUri)) {
        return { accessToken: null };
    }
    const { scope, authProvider } = target;
    const cacheKey = `${authProvider} ${scope}`;

    ensureSessionChangeListener();

    // Fast path: a cached session whose access token is not yet near expiry.
    // We always prefer reusing the cached token over calling getSession again,
    // because in some environments (notably the Extension Development Host
    // and certain remote configurations) `getSession({ silent: true })` can
    // return null even when a valid session exists, and `createIfNone` would
    // then re-prompt the user. The cache is cleared whenever VS Code reports
    // a session change (sign-out, account switch).
    const cached = cachedSessions.get(cacheKey);
    if (cached && !isTokenExpiringSoon(cached.accessToken)) {
        return { accessToken: cached.accessToken };
    }

    let pending = inFlightSessions.get(cacheKey);
    if (!pending) {
        pending = (async () => {
            // Silent first: returns a fresh access token from VS Code's persistent
            // session cache without showing UI. Survives VS Code restarts.
            let session = await authentication.getSession(authProvider, [scope], { silent: true });
            if (!session && !cached) {
                // First-ever request for this scope and no persisted session:
                // prompt the user via VS Code's Accounts UI.
                session = await authentication.getSession(authProvider, [scope], { createIfNone: true });
            }
            // If silent unexpectedly fails but we still have a cached session
            // whose token has not yet expired, fall back to the cached session.
            if (!session && cached && !isTokenExpiringSoon(cached.accessToken)) {
                session = cached;
            }
            return session;
        })();
        inFlightSessions.set(cacheKey, pending);
        void pending.finally(() => inFlightSessions.delete(cacheKey));
    }

    try {
        const session = await pending;
        if (session) {
            cachedSessions.set(cacheKey, session);
        }
        return { accessToken: session?.accessToken ?? null };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        window.showErrorMessage(`Kusto: failed to acquire Microsoft account token for ${clusterUri}. ${message}`);
        return { accessToken: null };
    }
}
