// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Test suite loaded by @vscode/test-web into the web worker extension host
// (see runTest.mjs). Plain CommonJS so it runs without a build step.

const vscode = require('vscode');

const EXTENSION_ID = 'ms-kusto.kusto-explorer-vscode';
const CLUSTER = 'https://help.kusto.windows.net';
const HOST = 'help.kusto.windows.net';
const DATABASE = 'Samples';

function log(message) {
    console.log(`[kusto-web-test] ${message}`);
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(`Assertion failed: ${message}`);
    }
}

async function readToken() {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folder) {
        return '';
    }
    try {
        return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, 'token.txt'))).trim();
    } catch {
        return '';
    }
}

async function waitFor(condition, ms, label) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        const value = await condition();
        if (value) {
            return value;
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`Timed out after ${ms} ms waiting for ${label}`);
}

async function run() {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert(extension, `${EXTENSION_ID} is loaded`);
    const api = await extension.activate();
    assert(api && api.server && api.connectionManager && api.historyManager, 'activate returns the features');
    log('activated');

    const commands = await vscode.commands.getCommands(true);
    for (const command of ['msKustoExplorer.runQuery', 'msKustoExplorer.importFromFile', 'msKustoExplorer.exportConnections']) {
        assert(commands.includes(command), `${command} is registered`);
    }

    const token = await readToken();
    if (!token) {
        log('no token: skipped live queries');
        return;
    }
    await vscode.commands.executeCommand('msKustoExplorer.test.setAccessToken', token);

    // Query client straight through the server seam.
    const direct = await api.server.runQuery('print x=1', CLUSTER, DATABASE);
    assert(!direct?.error, `print x=1 succeeds: ${JSON.stringify(direct?.error)}`);
    const primary = direct.data.tables[0];
    assert(primary.rows[0][0] === 1, `print x=1 returns 1: ${JSON.stringify(primary.rows)}`);
    log(`server.runQuery print x=1 -> ${JSON.stringify(primary.rows)}`);

    const failed = await api.server.runQuery('print x=1\n| tkae 1', CLUSTER, DATABASE);
    assert(failed?.error?.range, `syntax error has a range: ${JSON.stringify(failed)}`);
    log(`syntax error -> ${failed.error.message} at ${JSON.stringify(failed.error.range)}`);

    const schema = await api.server.getDatabaseInfo(HOST, DATABASE);
    assert(schema && schema.tables.length > 0, 'Samples schema loads');
    log(`schema -> ${schema.tables.length} tables, ${schema.functions?.length ?? 0} functions`);

    // The editor path: connection, query document, run command, results in history.
    await api.connectionManager.ensureServer(CLUSTER);
    const document = await vscode.workspace.openTextDocument({ language: 'kusto', content: 'print web=1' });
    await vscode.window.showTextDocument(document);
    await api.connectionManager.setDocumentConnection(document.uri.toString(), HOST, DATABASE);
    const before = api.historyManager.getEntries().length;
    await vscode.commands.executeCommand('msKustoExplorer.runQuery');
    await waitFor(() => api.historyManager.getEntries().length > before, 30000, 'a history entry');
    const entry = api.historyManager.getEntries()[0];
    const data = await api.historyManager.getEntryData(entry);
    assert(data?.tables?.[0]?.rows?.[0]?.[0] === 1, `runQuery command result: ${JSON.stringify(data?.tables?.[0]?.rows)}`);
    log(`msKustoExplorer.runQuery print web=1 -> ${JSON.stringify(data.tables[0].rows)}`);
}

module.exports = { run };
