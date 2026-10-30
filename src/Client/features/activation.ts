// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/*
 * Host-independent activation of the extension's UI features, shared by the desktop
 * entry point (extension.ts) and the web entry point (extension.web.ts). Each entry
 * point supplies its IServer and the host-specific services in HostServices.
 */

import * as vscode from 'vscode';
import { ConnectionsPanel } from './connectionsPanel';
import { ConnectionManager } from './connectionManager';
import { QueryEditor } from './queryEditor';
import { ResultsViewer } from './resultsViewer';
import { CompositeChartProvider } from './compositeChartProvider';
import { ChartEditorProvider } from './chartEditorProvider';
import { DataTableProvider } from './dataTableProvider';
import * as copilot from './copilot';
import { ConnectionStatusBar } from './connectionStatusBar';
import { Clipboard, type MultiFormatCopier } from './clipboard';
import { ScratchPadManager, SCRATCH_PAD_SCHEME } from './scratchPadManager';
import { ScratchPadPanel } from './scratchPadPanel';
import { HistoryManager } from './historyManager';
import { HistoryPanel } from './historyPanel';
import { Importer } from './importer';
import { ImportManager, type IKustoExplorerLocalData } from './importManager';
import { EntityDefinitionProvider, ENTITY_DEFINITION_SCHEME } from './entityDefinitionProvider';
import type { IFileStore } from './fileStore';
import type { IServer } from './server';

/** Services whose implementation depends on the extension host (desktop or web). */
export interface HostServices {
    /** Storage for scratch pad documents. */
    scratchPadStore: IFileStore;
    /** Storage for query history. */
    historyStore: IFileStore;
    /** Access to a local Kusto Explorer installation, where the host can read it. */
    kustoExplorerLocalData?: IKustoExplorerLocalData | undefined;
    /** Rich (multi-format) clipboard support, where the host has it. */
    multiFormatCopier?: MultiFormatCopier | undefined;
}

/** Internal components exposed for integration tests. */
export interface ActivatedFeatures {
    historyManager: HistoryManager;
    connectionManager: ConnectionManager;
    resultsViewer: ResultsViewer;
    server: IServer;
}

/** Creates and registers the extension's UI features. */
export async function activateFeatures(context: vscode.ExtensionContext, server: IServer, host: HostServices): Promise<ActivatedFeatures> {
    const clipboard = new Clipboard(host.multiFormatCopier);
    const scratchPadManager = new ScratchPadManager(context, host.scratchPadStore);

    // Register "Go to Definition" provider for kusto-entity:// URIs
    const entityDefinitionProvider = new EntityDefinitionProvider(server);
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(ENTITY_DEFINITION_SCHEME, entityDefinitionProvider),
        entityDefinitionProvider
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
        vscode.commands.registerCommand('msKustoExplorer.exportDataAsCsv', () => resultsViewer.exportDataAsCsv()),
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

    // Register import and export commands
    const importManager = new ImportManager(scratchPadManager, connectionManager, host.kustoExplorerLocalData);
    const importer = new Importer(importManager, connectionManager);
    context.subscriptions.push(
        vscode.commands.registerCommand('msKustoExplorer.importConnectionsFromKustoExplorer', () => importer.importConnections()),
        vscode.commands.registerCommand('msKustoExplorer.importScratchPadsFromKustoExplorer', () => importer.importScratchPads()),
        vscode.commands.registerCommand('msKustoExplorer.importFromFile', () => importer.importFromFile()),
        vscode.commands.registerCommand('msKustoExplorer.exportConnections', () => importer.exportConnections()),
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
    const historyManager = new HistoryManager(server, host.historyStore);

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

    return { historyManager, connectionManager, resultsViewer, server };
}
