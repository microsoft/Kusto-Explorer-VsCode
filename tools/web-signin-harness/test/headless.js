// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Headless check for @vscode/test-web (see README.md). The workspace folder is a
// temp directory holding `token.txt`, so no token is ever written into the repo.
// Sign-in itself cannot run headless; this covers activation, CORS from the
// worker origin, the query path, and what getSession does without a provider.

const vscode = require('vscode');

function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}: no answer within ${ms} ms`)), ms)),
    ]);
}

async function run() {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folder) {
        throw new Error('Open a folder containing token.txt');
    }
    const token = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, 'token.txt'))).trim();

    const { results } = await vscode.commands.executeCommand('kustoWebHarness.run', {
        cluster: 'https://help.kusto.windows.net',
        database: 'Samples',
        token,
    });
    console.log(`[kusto-web-harness-test] results ${JSON.stringify(results)}`);

    try {
        const session = await withTimeout(
            Promise.resolve(vscode.authentication.getSession('microsoft', ['https://kusto.kusto.windows.net/.default'], { silent: true })),
            10000,
            'getSession(silent)');
        console.log(`[kusto-web-harness-test] getSession(silent) -> ${session ? 'session' : 'undefined'}`);
    } catch (error) {
        console.log(`[kusto-web-harness-test] getSession(silent) threw ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!results.some(r => r.query)) {
        throw new Error('print 1 did not succeed for any scope');
    }
}

module.exports = { run };
