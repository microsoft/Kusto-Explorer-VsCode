// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { workspace, ExtensionContext, window } from 'vscode';
import { ConnectionsPanel } from './features/connectionsPanel'
import { ConnectionManager } from './features/connectionManager'
import { QueryEditor } from './features/queryEditor'
import { ResultsViewer } from './features/resultsViewer'
import { CompositeChartProvider } from './features/compositeChartProvider'
import { ChartEditorProvider } from './features/chartEditorProvider'
import { DataTableProvider } from './features/dataTableProvider'
import * as copilot from './features/copilot'
import { ConnectionStatusBar } from './features/connectionStatusBar'
import * as dotnet from './features/dotnet'
import { Clipboard } from './features/clipboard'
import { ScratchPadManager, SCRATCH_PAD_SCHEME } from './features/scratchPadManager'
import { ScratchPadPanel } from './features/scratchPadPanel'
import { HistoryManager } from './features/historyManager'
import { HistoryPanel } from './features/historyPanel'
import { Importer } from './features/importer'
import { ImportManager } from './features/importManager'
import { EntityDefinitionProvider, ENTITY_DEFINITION_SCHEME } from './features/entityDefinitionProvider'
import { Server, NullServer } from './features/server'
import type { IServer } from './features/server'
import
    {
        LanguageClient,
        LanguageClientOptions,
        ServerOptions,
        Executable
    } from 'vscode-languageclient/node';

let client: LanguageClient;

export async function activate(context: ExtensionContext)
{
    // Create output channel early so dotnet activation can log to it
    const outputChannel = window.createOutputChannel('Kusto');

    // ─── Language server (optional — requires .NET and Server.dll) ───

    let server: IServer = new NullServer();
    const serverDll = path.join(context.extensionPath, 'server', 'Server.dll');
    const dotnetPath = fs.existsSync(serverDll) ? await dotnet.activate(outputChannel) : undefined;

    if (dotnetPath) {
        const serverExecutable: Executable = {
            command: dotnetPath,
            args: [serverDll, "vscode"]
        };

        const serverOptions: ServerOptions = {
            run: serverExecutable,
            debug: serverExecutable
        };

        const clientOptions: LanguageClientOptions = {
            documentSelector: [
                { scheme: 'file', language: 'kusto' },
                { scheme: ENTITY_DEFINITION_SCHEME, language: 'kusto' },
                { scheme: SCRATCH_PAD_SCHEME, language: 'kusto' }
            ],
            synchronize: { 
                fileEvents: workspace.createFileSystemWatcher('**/*.{kql,csl,kusto}')
            },
            outputChannel: outputChannel,
            middleware: {
                provideCompletionItem: async (document, position, context, token, next) => {
                    const result = await next(document, position, context, token);
                    const globalCommitChars = client?.initializeResult?.capabilities
                        ?.completionProvider?.allCommitCharacters ?? [];
                    return fixCompletionCommit(result, globalCommitChars);
                }
            }
        };

        client = new LanguageClient(
            'kustoLanguageServer',
            'Kusto Language Server',
            serverOptions,
            clientOptions
        );

        try {
            await client.start();
            server = new Server(client, context);
        } catch (error) {
            outputChannel.appendLine(`Failed to start language server: ${error instanceof Error ? error.message : String(error)}`);
            window.showErrorMessage('Kusto language server failed to start. Language features will be unavailable.');
        }
    }

    // ─── UI features (always registered so integration tests will run) ────────────────────

    const clipboard = new Clipboard();
    const scratchPadManager = new ScratchPadManager(context);

    // Register "Go to Definition" provider for kusto-entity:// URIs
    const entityDefinitionProvider = new EntityDefinitionProvider(server);
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(ENTITY_DEFINITION_SCHEME, entityDefinitionProvider),
        entityDefinitionProvider
    );

    // Register command to fix doubled commit characters after completion acceptance
    context.subscriptions.push(
        vscode.commands.registerCommand('msKustoExplorer.fixCommitCharDoubling', fixCommitCharDoubling)
    );

    // activate results viewer
    const chartProvider = new CompositeChartProvider();
    const chartEditorProvider = new ChartEditorProvider();
    const dataTableProvider = new DataTableProvider(server, clipboard);
    const resultsViewer = new ResultsViewer(context, server, clipboard, chartProvider, chartEditorProvider, dataTableProvider);
    context.subscriptions.push(
        vscode.commands.registerCommand('msKustoExplorer.copyChart', () => resultsViewer.copyChart()),
        vscode.commands.registerCommand('msKustoExplorer.toggleChartEditor', () => resultsViewer.toggleChartEditor()),
        vscode.commands.registerCommand('msKustoExplorer.saveSingletonResults', () => resultsViewer.saveCurrentResults()),
        vscode.commands.registerCommand('msKustoExplorer.moveViewToMain', () => resultsViewer.moveResultsTabToMain()),
        vscode.commands.registerCommand('msKustoExplorer.toggleSearch', () => resultsViewer.toggleSearch()),
        vscode.commands.registerCommand('msKustoExplorer.removeChart', () => resultsViewer.removeChart()),
        vscode.commands.registerCommand('msKustoExplorer.copyData', () => resultsViewer.copyData()),
        vscode.commands.registerCommand('msKustoExplorer.copyDataAsMarkdown', () => resultsViewer.copyDataAsMarkdown()),
        vscode.commands.registerCommand('msKustoExplorer.copyDataAsHtml', () => resultsViewer.copyDataAsHtml()),
        vscode.commands.registerCommand('msKustoExplorer.copyTableAsDatatable', () => resultsViewer.copyTableAsDatatable()),
        vscode.commands.registerCommand('msKustoExplorer.savePanelResults', () => resultsViewer.saveCurrentResults()),
        vscode.commands.registerCommand('msKustoExplorer.chartPanelResults', () => resultsViewer.openChartFromBottomView()),
        vscode.commands.registerCommand('msKustoExplorer.rerunQuery', () => resultsViewer.rerunQuery()),
    );

    // Track Kusto session state
    const updateKustoContextFn = () => {
        const hasKustoDocument = vscode.workspace.textDocuments.some(doc => doc.languageId === 'kusto');
        const hasSingletonView = resultsViewer.hasSingletonView();
        const isKustoActive = hasKustoDocument || hasSingletonView;
        vscode.commands.executeCommand('setContext', 'msKustoExplorer.hasActiveDocument', isKustoActive);
        vscode.commands.executeCommand('setContext', 'msKustoExplorer.hasSingletonView', hasSingletonView);

        const activeEditor = vscode.window.activeTextEditor;
        vscode.commands.executeCommand('setContext', 'msKustoExplorer.isEntityDefinition', activeEditor?.document.uri.scheme === ENTITY_DEFINITION_SCHEME);
        vscode.commands.executeCommand('setContext', 'msKustoExplorer.isScratchPad', activeEditor?.document.uri.scheme === SCRATCH_PAD_SCHEME);
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('msKustoExplorer.singletonViewStateChanged', () => updateKustoContextFn())
    );
    updateKustoContextFn();
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(() => updateKustoContextFn()),
        vscode.workspace.onDidCloseTextDocument(() => updateKustoContextFn()),
        vscode.window.onDidChangeActiveTextEditor(() => updateKustoContextFn())
    );

    // activate connections data layer
    const connectionManager = new ConnectionManager(context, server);

    // activate scratch pad documents
    const scratchPadPanel = new ScratchPadPanel(context, scratchPadManager, connectionManager);
    context.subscriptions.push(
        vscode.commands.registerCommand('msKustoExplorer.newScratchPad', () => scratchPadPanel.createScratchPad()),
        vscode.commands.registerCommand('msKustoExplorer.openScratchPad', (item) => scratchPadPanel.openScratchPad(item)),
        vscode.commands.registerCommand('msKustoExplorer.deleteScratchPad', (item) => scratchPadPanel.deleteScratchPad(item)),
        vscode.commands.registerCommand('msKustoExplorer.renameScratchPad', (item) => scratchPadPanel.renameScratchPad(item)),
        vscode.commands.registerCommand('msKustoExplorer.saveScratchPadAs', () => scratchPadPanel.saveScratchPadAs()),
    );

    // Register Kusto Explorer import commands
    const importManager = new ImportManager(scratchPadManager, connectionManager);
    const importer = new Importer(importManager, connectionManager);
    context.subscriptions.push(
        vscode.commands.registerCommand('msKustoExplorer.importConnectionsFromKustoExplorer', () => importer.importConnections()),
        vscode.commands.registerCommand('msKustoExplorer.importScratchPadsFromKustoExplorer', () => importer.importScratchPads()),
    );

    // activate connections panel and related features
    const connectionsPanel = new ConnectionsPanel(context, server, clipboard, importer, connectionManager);
    await connectionsPanel.initialize();
    // No-op commands assigned to tree items to suppress auto-expand on click
    context.subscriptions.push(
        vscode.commands.registerCommand('msKustoExplorer.selectServer', () => {}),
        vscode.commands.registerCommand('msKustoExplorer.selectDatabase', () => {}),
        vscode.commands.registerCommand('msKustoExplorer.selectEntity', () => {}),  
        vscode.commands.registerCommand('msKustoExplorer.addServer', () => connectionsPanel.addServer()),
        vscode.commands.registerCommand('msKustoExplorer.addServerToGroup', (item) => connectionsPanel.addServerToGroup(item)),
        vscode.commands.registerCommand('msKustoExplorer.addServerGroup', () => connectionsPanel.addServerGroup()),
        vscode.commands.registerCommand('msKustoExplorer.removeServer', (item) => connectionsPanel.removeServer(item)),
        vscode.commands.registerCommand('msKustoExplorer.removeServerGroup', (item) => connectionsPanel.removeServerGroup(item)),
        vscode.commands.registerCommand('msKustoExplorer.moveServer', (item) => connectionsPanel.moveServer(item)),
        vscode.commands.registerCommand('msKustoExplorer.editServer', (item) => connectionsPanel.editServer(item)),
        vscode.commands.registerCommand('msKustoExplorer.renameServer', (item) => connectionsPanel.renameServer(item)),
        vscode.commands.registerCommand('msKustoExplorer.renameServerGroup', (item) => connectionsPanel.renameServerGroup(item)),
        vscode.commands.registerCommand('msKustoExplorer.refreshServer', (item) => connectionsPanel.refreshServer(item)),
        vscode.commands.registerCommand('msKustoExplorer.refreshDatabase', (item) => connectionsPanel.refreshDatabase(item)),
        vscode.commands.registerCommand('msKustoExplorer.copyEntityAsCommand', (item) => connectionsPanel.copyEntityAsCommand(item)),
        vscode.commands.registerCommand('msKustoExplorer.copyEntityAsExpression', (item) => connectionsPanel.copyEntityAsExpression(item)),
        vscode.commands.registerCommand('msKustoExplorer.viewEntityDefinition', (item) => connectionsPanel.viewEntityDefinition(item)),
    );

    // Create status bar item showing the active document's cluster and database connection.
    new ConnectionStatusBar(context, connectionManager);

    // activate query history
    const historyManager = new HistoryManager(context, server);

    // activate query execution features
    const historyPanel = new HistoryPanel(context, historyManager, resultsViewer);
    context.subscriptions.push(
        vscode.commands.registerCommand('msKustoExplorer.openHistoryItem', (item) => historyPanel.openHistoryItem(item)),
        vscode.commands.registerCommand('msKustoExplorer.deleteHistoryItem', (item) => historyPanel.deleteHistoryItem(item)),
        vscode.commands.registerCommand('msKustoExplorer.clearHistory', () => historyPanel.clearHistory()),
    );
    const queryEditor = new QueryEditor(context, server, clipboard, historyManager, connectionManager, resultsViewer, historyPanel);
    context.subscriptions.push(
        vscode.commands.registerCommand('msKustoExplorer.noop', () => {}),
        vscode.commands.registerCommand('msKustoExplorer.runQuery', (startLine?: number, startChar?: number, endLine?: number, endChar?: number) => queryEditor.runQuery(startLine, startChar, endLine, endChar)),
        vscode.commands.registerCommand('msKustoExplorer.runQuery.running', () => {}),
        vscode.commands.registerCommand('msKustoExplorer.copyClientRequestId', (clientRequestId?: string) => queryEditor.copyClientRequestId(clientRequestId)),
        vscode.commands.registerCommand('msKustoExplorer.copyQuery', (startLine?: number, startChar?: number, endLine?: number, endChar?: number) => queryEditor.copyQuery(startLine, startChar, endLine, endChar)),
        vscode.commands.registerCommand('msKustoExplorer.copyQueryTransparent', (startLine?: number, startChar?: number, endLine?: number, endChar?: number) => queryEditor.copyQuery(startLine, startChar, endLine, endChar, true)),
        vscode.commands.registerCommand('msKustoExplorer.formatQuery', (startLine?: number, startChar?: number, endLine?: number, endChar?: number) => queryEditor.formatQuery(startLine, startChar, endLine, endChar)),
        vscode.commands.registerCommand('msKustoExplorer.selectQuery', (startLine: number, startChar: number, endLine: number, endChar: number) => queryEditor.selectRange(startLine, startChar, endLine, endChar)),
        vscode.commands.registerCommand('msKustoExplorer.showResults', (startLine: number, startChar: number) => queryEditor.showHistoryResults(startLine, startChar)),
        vscode.commands.registerCommand('msKustoExplorer.refreshDocumentSchema', () => queryEditor.refreshDocumentSchema()),
    );

    // activate copilot hooks
    copilot.activate(context, server, connectionManager, resultsViewer);

    // Expose internal components for integration tests
    return { historyManager, connectionManager, resultsViewer, server };
}

export function deactivate(): Thenable<void> | undefined
{
    if (!client)
    {
        return undefined;
    }
    return client.stop();
}

/**
 * Identifies completion items where a commit character also appears in the insertText,
 * which would cause the character to be doubled when used to commit the completion.
 * Attaches a post-completion command that detects and removes the duplicate.
 * @param globalCommitChars Commit characters defined in server capabilities (apply to all items)
 */
function fixCompletionCommit(
    result: vscode.CompletionItem[] | vscode.CompletionList | null | undefined,
    globalCommitChars: string[]
): vscode.CompletionItem[] | vscode.CompletionList | null | undefined {
    if (!result) {
        return result;
    }

    const items = Array.isArray(result) ? result : result.items;

    for (const item of items) {
        // Use per-item commit characters if set, otherwise fall back to global
        const commitChars = (item.commitCharacters && item.commitCharacters.length > 0)
            ? item.commitCharacters
            : globalCommitChars;

        if (commitChars.length === 0) {
            continue;
        }

        const insertText = typeof item.insertText === 'string'
            ? item.insertText
            : item.insertText instanceof vscode.SnippetString
                ? item.insertText.value
                : undefined;

        if (!insertText) {
            continue;
        }

        // Find commit characters that appear in the insert text and could be doubled
        const conflicting = commitChars.filter(ch => insertText.includes(ch));
        if (conflicting.length > 0) {
            // Attach a command that runs after the completion is accepted.
            // It checks if the typed commit character was doubled and removes the duplicate.
            item.command = {
                title: '',
                command: 'msKustoExplorer.fixCommitCharDoubling',
                arguments: [conflicting, item.command]
            };
        }
    }

    return result;
}

/**
 * Handles the post-completion fix for doubled commit characters.
 * The command fires before the commit character is inserted into the document,
 * so we listen for the next document change and use the change event to find
 * where the commit character was inserted, then check if it caused a doubling.
 */
async function fixCommitCharDoubling(commitChars: string[], originalCommand?: vscode.Command): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === 'kusto') {
        const disposable = vscode.workspace.onDidChangeTextDocument(async (e) => {
            if (e.document !== editor.document) {
                return;
            }
            disposable.dispose();

            // Find a single-character insertion that matches a conflicting commit char
            for (const change of e.contentChanges) {
                if (change.text.length === 1 && commitChars.includes(change.text)) {
                    // The commit char was inserted at change.range.start
                    // Check if the character just before it is the same
                    const insertPos = change.range.start;
                    if (insertPos.character >= 1) {
                        const charBefore = e.document.getText(
                            new vscode.Range(insertPos.translate(0, -1), insertPos)
                        );
                        if (charBefore === change.text) {
                            // Delete the duplicate (the newly inserted one, now at insertPos)
                            await editor.edit(eb => {
                                eb.delete(new vscode.Range(insertPos, insertPos.translate(0, 1)));
                            }, { undoStopBefore: false, undoStopAfter: false });
                        }
                    }
                    break;
                }
            }
        });

        // Safety: dispose the listener if no change comes within 1 second.
        // Note: dispose() is idempotent, so calling it from both the handler and
        // this timeout is harmless. JS is single-threaded, so there is no race.
        setTimeout(() => disposable.dispose(), 1000);
    }

    // Preserve any original command from the server
    if (originalCommand) {
        await vscode.commands.executeCommand(originalCommand.command, ...(originalCommand.arguments ?? []));
    }
}
