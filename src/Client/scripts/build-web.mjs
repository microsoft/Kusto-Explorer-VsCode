// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Builds the VS Code for the Web bundle (package.json "browser") for the web
// worker extension host, then checks that no Node-only module slipped in.
// Usage: node scripts/build-web.mjs [--watch]

import * as esbuild from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const outfile = `${root}dist/web/extension.js`;
const watch = process.argv.includes('--watch');

/** @type {esbuild.BuildOptions} */
const options = {
    absWorkingDir: root,
    entryPoints: ['extension.web.ts'],
    bundle: true,
    outfile,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    mainFields: ['browser', 'module', 'main'],
    external: ['vscode'],
    sourcemap: true,
    alias: {
        // azure-kusto-data imports credentials the web build never constructs.
        '@azure/identity': './web/azureIdentityStub.ts',
    },
    define: {
        // Workaround for azure-kusto-data 7.2.0, whose clientDetails reads `window`
        // unguarded; a web worker has no window (fix: Azure/azure-kusto-node#437).
        window: 'globalThis',
        'process.env.NODE_ENV': '"production"',
    },
    logLevel: 'info',
};

// Node built-ins have no place in the worker host; a require of one means a
// desktop-only module reached the web entry.
const nodeOnly = /require\(["'](?:node:)?(?:child_process|fs|fs\/promises|os|path|net|tls|http|https|zlib|worker_threads)["']\)/g;

function checkBundle() {
    const text = readFileSync(outfile, 'utf8');
    const found = [...new Set(text.match(nodeOnly) ?? [])];
    if (found.length > 0) {
        throw new Error(`Web bundle requires Node-only modules: ${found.join(', ')}`);
    }
}

if (watch) {
    const context = await esbuild.context({
        ...options,
        plugins: [{ name: 'check-web-bundle', setup: build => build.onEnd(result => {
            if (result.errors.length === 0) {
                try { checkBundle(); } catch (error) { console.error(error.message); }
            }
        }) }],
    });
    await context.watch();
} else {
    await esbuild.build(options);
    checkBundle();
}
