// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/*
 * UI for deep links (see deepLink.ts): the URI handler that opens a linked
 * query for review, and the command that copies an Azure Data Explorer web
 * link for the current query.
 *
 * A link never runs its query: it opens in a new scratch pad after the user
 * confirms the target cluster and database.
 */

import * as vscode from 'vscode';
import { buildAdxWebLink, parseDeepLink } from './deepLink';
import { findKustoDomain } from './kustoEndpoints';
import { sanitizeFileName } from './importManager';
import { SCRATCH_PAD_SCHEME, type ScratchPadManager } from './scratchPadManager';
import type { ConnectionManager } from './connectionManager';
import type { IServer } from './server';

export class DeepLinkHandler implements vscode.UriHandler {
    constructor(
        private readonly server: IServer,
        private readonly connections: ConnectionManager,
        private readonly scratchPads: ScratchPadManager,
    ) {}

    /** Opens `/clusters/<cluster>/databases/<database>?query=<query>` links. */
    async handleUri(uri: vscode.Uri): Promise<void> {
        const defaultDomain = vscode.workspace.getConfiguration('msKustoExplorer').get<string>('defaultDomain');
        let link;
        try {
            link = await parseDeepLink(uri.path, uri.query, defaultDomain || undefined);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`Kusto: cannot open the link. ${message}`);
            return;
        }

        const cluster = await this.connections.getHostName(`https://${link.cluster}`);
        const isNewCluster = !this.connections.findServerInfo(cluster);
        const detail = [
            `Cluster: ${link.cluster}`,
            `Database: ${link.database}`,
            '',
            'The query opens in a new scratch pad for you to review. It does not run.',
            ...(isNewCluster ? [`${link.cluster} is not in your connections. Opening the query adds it.`] : []),
            ...(findKustoDomain(link.cluster.replace(/:\d+$/, ''))
                ? []
                : ['This is not a known Azure Data Explorer or Fabric host. Open it only if you trust it.']),
        ].join('\n');
        const open = 'Open Query';
        const choice = await vscode.window.showWarningMessage('Open a Kusto query from a link?', { modal: true, detail }, open);
        if (choice !== open) {
            return;
        }

        if (isNewCluster) {
            await this.connections.ensureServer(`https://${link.cluster}`);
        }
        const displayName = this.connections.findServerInfo(cluster)?.displayName ?? cluster;
        const fileName = await this.scratchPads.addScratchPadFile(sanitizeFileName(`${displayName}.${link.database}`), link.query);
        const documentUri = vscode.Uri.parse(`${SCRATCH_PAD_SCHEME}:/${fileName}`);
        await this.connections.setDocumentConnection(documentUri.toString(), cluster, link.database);
        const document = await vscode.workspace.openTextDocument(documentUri);
        await vscode.window.showTextDocument(document);
    }

    /** Copies an Azure Data Explorer web link for the selection, or the query at the cursor. */
    async copyLinkToAdxWeb(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'kusto') {
            return;
        }
        const uri = editor.document.uri.toString();
        let range: vscode.Range = editor.selection;
        if (editor.selection.isEmpty) {
            const position = editor.selection.active;
            const queryRange = await this.server.getQueryRange(uri, { line: position.line, character: position.character });
            if (!queryRange) {
                void vscode.window.showInformationMessage('Kusto: place the cursor in a query or select the text to link to.');
                return;
            }
            range = new vscode.Range(queryRange.start.line, queryRange.start.character, queryRange.end.line, queryRange.end.character);
        }
        const query = editor.document.getText(range).trim();
        if (!query) {
            return;
        }
        const connection = await this.connections.getDocumentConnection(uri);
        if (!connection?.cluster || !connection.database) {
            void vscode.window.showErrorMessage('Kusto: connect this document to a cluster and database to copy a link.');
            return;
        }
        const link = await buildAdxWebLink({ cluster: connection.cluster, database: connection.database, query });
        await vscode.env.clipboard.writeText(link);
        vscode.window.setStatusBarMessage('Copied link to Azure Data Explorer web', 3000);
    }
}
