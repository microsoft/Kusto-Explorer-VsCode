// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Runs the web build in VS Code for the Web (@vscode/test-web, headless Chromium)
// and checks that it activates and runs queries from the web worker extension host.
//
// The live part needs an access token for Kusto. It is taken from the Azure CLI
// (`az login`) and handed to the extension through a temp folder outside the
// repo, so no token is ever written into the workspace. Without a token only
// activation is checked.
//
// Usage (from src/Client): npm run test:web

import { runTests } from '@vscode/test-web';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionDevelopmentPath = fileURLToPath(new URL('../..', import.meta.url));
const extensionTestsPath = fileURLToPath(new URL('./suite.js', import.meta.url));

function getToken() {
    try {
        return execFileSync('az', ['account', 'get-access-token', '--resource', 'https://kusto.kusto.windows.net', '--query', 'accessToken', '-o', 'tsv'],
            { encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        return '';
    }
}

const folderPath = mkdtempSync(join(tmpdir(), 'kusto-web-test-'));
try {
    const token = getToken();
    if (token) {
        writeFileSync(join(folderPath, 'token.txt'), token);
    } else {
        console.log('No Azure CLI token (run `az login`); checking activation only.');
    }
    await runTests({
        browserType: 'chromium',
        headless: true,
        quality: 'stable',
        extensionDevelopmentPath,
        extensionTestsPath,
        folderPath,
    });
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
} finally {
    rmSync(folderPath, { recursive: true, force: true });
}
