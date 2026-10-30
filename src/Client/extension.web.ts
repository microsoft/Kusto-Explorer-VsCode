// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Entry point for VS Code for the Web (vscode.dev, github.dev, Codespaces in the
 * browser), running in the web worker extension host. There is no C# language
 * server here: WebServer runs queries and loads schema straight from the Kusto
 * REST API, and language features fall back to NullServer defaults.
 *
 * Must not import Node-only modules; scripts/build-web.mjs enforces this.
 */

import * as vscode from 'vscode';
import { activateFeatures } from './features/activation';
import type { ActivatedFeatures } from './features/activation';
import { acquireMicrosoftAuthenticationToken } from './features/authentication';
import { WorkspaceFileStore } from './features/fileStore';
import { HISTORY_INDEX_FILE } from './features/historyManager';
import { WebServer } from './features/webServer';

/** Test-only command that makes every request use the given access token instead of signing in. */
const SET_TEST_TOKEN_COMMAND = 'msKustoExplorer.test.setAccessToken';

export interface WebActivatedFeatures extends ActivatedFeatures {
    server: WebServer;
}

export async function activate(context: vscode.ExtensionContext): Promise<WebActivatedFeatures> {
    const outputChannel = vscode.window.createOutputChannel('Kusto');
    outputChannel.appendLine('Running in VS Code for the Web (experimental): queries run directly against Kusto; '
        + 'IntelliSense, diagnostics and formatting need the desktop extension.');

    let testToken: string | undefined;
    if (context.extensionMode === vscode.ExtensionMode.Test) {
        context.subscriptions.push(vscode.commands.registerCommand(SET_TEST_TOKEN_COMMAND, (token: string | undefined) => {
            testToken = token;
        }));
    }

    const server = new WebServer(async clusterUrl => {
        if (testToken) {
            return testToken;
        }
        const { accessToken } = await acquireMicrosoftAuthenticationToken(clusterUrl);
        if (!accessToken) {
            throw new Error(`Sign in with a Microsoft account to connect to ${clusterUrl}.`);
        }
        return accessToken;
    });

    const storage = context.globalStorageUri;
    const [scratchPadStore, historyStore] = await Promise.all([
        WorkspaceFileStore.open(vscode.Uri.joinPath(storage, 'scratchpads'), () => true),
        WorkspaceFileStore.open(vscode.Uri.joinPath(storage, 'history'), name => name === HISTORY_INDEX_FILE),
    ]);

    const features = await activateFeatures(context, server, { scratchPadStore, historyStore });
    return { ...features, server };
}

export function deactivate(): void {}
