// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Copies the third-party libraries used by result webviews into dist/media, which
// the webviews load through `webview.asWebviewUri` (see features/webviewHtml.ts).
// node_modules is excluded from the VSIX, so the copies are what ships.
// Usage: node scripts/copy-media.mjs

import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(`${root}package.json`);
const outDir = `${root}dist/media`;

const files = {
    'plotly-strict.min.js': 'plotly.js-strict-dist-min/plotly-strict.min.js',
    'cytoscape.min.js': 'cytoscape/dist/cytoscape.min.js',
    'simple-datatables.js': 'simple-datatables/dist/umd/simple-datatables.js',
    'simple-datatables.css': 'simple-datatables/dist/style.css',
};

mkdirSync(outDir, { recursive: true });
for (const [name, source] of Object.entries(files)) {
    copyFileSync(`${root}node_modules/${source}`, `${outDir}/${name}`);
}
console.log(`Copied ${Object.keys(files).length} webview libraries to dist/media`);
