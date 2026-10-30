// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Phase 0 harness for VS Code for the Web. It answers one question by hand:
// does the host's built-in `microsoft` auth provider mint a token that a Kusto
// cluster accepts? For each candidate scope it signs in, decodes the token's
// non-secret claims, and runs `print 1`. Everything is logged to the
// "Kusto Web Harness" output channel; the token itself is never logged.
//
// Plain CommonJS with no dependencies, so it can be served as-is to vscode.dev.

const vscode = require('vscode');

const GENERIC_SCOPE = 'https://kusto.kusto.windows.net/.default';

/** @type {vscode.OutputChannel} */
let output;

function log(line) {
    output.appendLine(line);
    console.log(`[kusto-web-harness] ${line}`);
}

function describeError(error) {
    if (error instanceof Error) {
        return `${error.name}: ${error.message}`;
    }
    return String(error);
}

/** Decodes the JWT payload and keeps only claims useful for diagnosis. */
function tokenClaims(token) {
    try {
        const part = token.split('.')[1];
        const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
        const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
        const bytes = Uint8Array.from(atob(padded), c => c.charCodeAt(0));
        const claims = JSON.parse(new TextDecoder().decode(bytes));
        return {
            aud: claims.aud,
            tid: claims.tid,
            appid: claims.appid ?? claims.azp,
            app_displayname: claims.app_displayname,
            scp: claims.scp,
            upn: claims.upn ?? claims.preferred_username ?? claims.unique_name,
            expiresAt: typeof claims.exp === 'number' ? new Date(claims.exp * 1000).toISOString() : undefined,
        };
    } catch (error) {
        return { decodeError: describeError(error) };
    }
}

/** Mirrors getKustoScope in src/Client/features/authentication.ts, for comparison only. */
function extensionDerivedScope(clusterUri) {
    const host = new URL(clusterUri).hostname.toLowerCase();
    const match = host.match(/\.kusto\.([^/]+)$/);
    return match ? `https://kusto.kusto.${match[1]}/.default` : `https://${host}/.default`;
}

async function fetchAuthMetadata(clusterUri) {
    const url = `${clusterUri}/v1/rest/auth/metadata`;
    try {
        const response = await fetch(url);
        const text = await response.text();
        if (!response.ok) {
            log(`  auth metadata: HTTP ${response.status} ${text.slice(0, 500)}`);
            return undefined;
        }
        const resource = JSON.parse(text)?.AzureAD?.KustoServiceResourceId;
        log(`  auth metadata: KustoServiceResourceId = ${resource}`);
        return resource;
    } catch (error) {
        log(`  auth metadata: FAILED ${describeError(error)}`);
        return undefined;
    }
}

async function runPrint1(clusterUri, database, accessToken) {
    const clientRequestId = `KEVSC.WebHarness;${crypto.randomUUID()}`;
    const started = Date.now();
    const response = await fetch(`${clusterUri}/v2/rest/query`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json; charset=utf-8',
            'Accept': 'application/json',
            'x-ms-client-request-id': clientRequestId,
            'x-ms-app': 'KustoExplorerVSCode.WebHarness',
        },
        body: JSON.stringify({ db: database, csl: 'print one = 1' }),
    });
    const text = await response.text();
    const elapsed = Date.now() - started;
    if (!response.ok) {
        return { ok: false, summary: `HTTP ${response.status} in ${elapsed} ms, client request id ${clientRequestId}: ${text.slice(0, 2000)}` };
    }
    const frames = JSON.parse(text);
    const primary = frames.find(f => f.FrameType === 'DataTable' && f.TableKind === 'PrimaryResult');
    const value = primary?.Rows?.[0]?.[0];
    return { ok: value === 1, summary: `HTTP ${response.status} in ${elapsed} ms, print one = ${JSON.stringify(value)}` };
}

/**
 * @param {{ cluster?: string, database?: string, token?: string }} [args]
 *   Automation only: `token` skips sign-in so a headless test can exercise the query path.
 */
async function run(args) {
    output.show(true);
    log('────────────────────────────────────────');
    log(`Host: uiKind=${vscode.env.uiKind === vscode.UIKind.Web ? 'Web' : 'Desktop'}, appHost=${vscode.env.appHost}, appName=${vscode.env.appName}, version=${vscode.version}`);
    log(`Worker origin: ${globalThis.location?.origin ?? '(none)'}`);

    let cluster = args?.cluster;
    if (!cluster) {
        cluster = await vscode.window.showInputBox({
            title: 'Kusto Web Harness (1/2): cluster URI',
            prompt: 'ADX cluster or Fabric Eventhouse query URI',
            value: 'https://help.kusto.windows.net',
            ignoreFocusOut: true,
        });
    }
    if (!cluster) {
        return { results: [] };
    }
    cluster = cluster.trim().replace(/\/+$/, '');

    let database = args?.database;
    if (!database) {
        database = await vscode.window.showInputBox({
            title: 'Kusto Web Harness (2/2): database',
            prompt: 'Any database you can read on that cluster',
            value: cluster.includes('help.kusto.windows.net') ? 'Samples' : '',
            ignoreFocusOut: true,
        });
    }
    if (!database) {
        return { results: [] };
    }

    log(`Cluster: ${cluster}   Database: ${database}`);
    const resource = await fetchAuthMetadata(cluster);
    const derived = extensionDerivedScope(cluster);
    const metadataScope = resource ? `${resource.replace(/\/+$/, '')}/.default` : undefined;
    log(`  scope the desktop extension would derive today: ${derived}${metadataScope && metadataScope !== derived ? '   <-- DIFFERS from auth metadata' : ''}`);

    const scopes = [...new Set([metadataScope, GENERIC_SCOPE, `https://${new URL(cluster).hostname}/.default`, derived].filter(Boolean))];
    const results = [];

    for (const scope of scopes) {
        log('');
        log(`Scope ${scope}`);
        let accessToken = args?.token;
        if (accessToken) {
            log('  sign-in: skipped (token supplied by automation)');
        } else {
            try {
                const session = await vscode.authentication.getSession('microsoft', [scope], { createIfNone: true });
                accessToken = session.accessToken;
                log(`  sign-in: OK as "${session.account.label}" (session scopes: ${session.scopes.join(' ')})`);
            } catch (error) {
                log(`  sign-in: FAILED ${describeError(error)}`);
                results.push({ scope, signIn: false, query: false, detail: describeError(error) });
                continue;
            }
        }
        log(`  token claims: ${JSON.stringify(tokenClaims(accessToken))}`);

        try {
            const query = await runPrint1(cluster, database, accessToken);
            log(`  print 1: ${query.ok ? 'OK' : 'FAILED'} ${query.summary}`);
            results.push({ scope, signIn: true, query: query.ok, detail: query.summary });
        } catch (error) {
            // A TypeError "Failed to fetch" here usually means CORS or network, not auth.
            log(`  print 1: FAILED ${describeError(error)}`);
            results.push({ scope, signIn: true, query: false, detail: describeError(error) });
        }
    }

    log('');
    log('Summary:');
    for (const r of results) {
        log(`  ${r.query ? 'PASS' : 'FAIL'}  sign-in=${r.signIn ? 'ok' : 'failed'}  query=${r.query ? 'ok' : 'failed'}  ${r.scope}`);
    }
    const passed = results.filter(r => r.query).length;
    void vscode.window.showInformationMessage(`Kusto Web Harness: ${passed}/${results.length} scopes ran print 1. See the "Kusto Web Harness" output.`);
    return { results };
}

function activate(context) {
    output = vscode.window.createOutputChannel('Kusto Web Harness');
    context.subscriptions.push(output, vscode.commands.registerCommand('kustoWebHarness.run', run));
}

function deactivate() {}

module.exports = { activate, deactivate };
