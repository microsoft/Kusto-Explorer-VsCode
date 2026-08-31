// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/*
 * This module implements the QueryEditor class, which handles UI display and interactions for query set documents.
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import type { IServer, SelectionRange, Range, QueryRangesResult } from './server';
import type { ConnectionManager } from './connectionManager';
import { ResultsViewer } from './resultsViewer';
import { HistoryManager } from './historyManager';
import type { HistoryEntry } from './historyManager';
import type { HistoryPanel } from './historyPanel';
import { formatCfHtml, type ClipboardItem, type IClipboard } from './clipboard';
import { ENTITY_DEFINITION_SCHEME } from './entityDefinitionProvider';
import { getQueryLensVisibility } from './queryRangeScope';

const PASTE_KIND = vscode.DocumentDropOrPasteEditKind.Text.append('kusto');
const QUERY_RUNNING_CONTEXT_KEY = 'msKustoExplorer.queryRunning';
const MIN_QUERY_RUNNING_INDICATOR_MS = 500;
const CODE_LENS_SCOPE_SETTING = 'editor.showCodeLensForActiveQueryOnly';

/** Query ranges cached for one document version. */
interface CachedQueryRanges {
    version: number;
    result: Promise<QueryRangesResult | null>;
}

/** True when query action CodeLens entries should be limited to the query holding the cursor. */
function isCodeLensScopedToActiveQuery(): boolean {
    return vscode.workspace.getConfiguration('msKustoExplorer').get<boolean>(CODE_LENS_SCOPE_SETTING, false);
}

/**
 * Builds a SelectionRange from optional CodeLens arguments.
 * Returns undefined when no arguments are provided (cursor-based fallback).
 */
function rangeFromArgs(startLine?: number, startChar?: number, endLine?: number, endChar?: number): SelectionRange | undefined {
    if (startLine !== undefined && startChar !== undefined && endLine !== undefined && endChar !== undefined) {
        return { start: { line: startLine, character: startChar }, end: { line: endLine, character: endChar } };
    }
    return undefined;
}

function createClientRequestId(): string {
    return `KustoExplorerVsCode;${crypto.randomUUID()}`;
}

function formatRunTimestamp(timestamp: string): string {
    const date = new Date(timestamp);
    if (Number.isNaN(date.valueOf())) {
        return timestamp;
    }

    return date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit'
    });
}

function formatDuration(durationMs: number): string {
    if (durationMs < 1000) {
        return `${Math.max(0, Math.round(durationMs))}ms`;
    }

    const seconds = durationMs / 1000;
    if (seconds < 60) {
        return `${seconds >= 10 ? Math.round(seconds).toString() : seconds.toFixed(1)}s`;
    }

    const roundedSeconds = Math.round(seconds);
    const minutes = Math.floor(roundedSeconds / 60);
    const remainingSeconds = roundedSeconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
}

function getLastRunTitle(entry: HistoryEntry): string | undefined {
    const timestamp = entry.executionStartedAt ?? entry.timestamp;
    const parts = [`Last run: ${formatRunTimestamp(timestamp)}`];
    if (entry.executionDurationMs !== undefined) {
        parts.push(`took: ${formatDuration(entry.executionDurationMs)}`);
    }

    return parts.join(', ');
}

function getQueryRangeKey(uri: string, range: Range): string {
    return `${uri}:${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
}

interface QueryRunIndicator {
    key: string;
    generation: number;
}

interface RunningQueryRangeState {
    count: number;
    startedAt: number;
    generation: number;
}

// =============================================================================
// Query Editor
// =============================================================================

/**
 * Handles UI display and interactions for query set documents,
 * such as CodeLens for running/formatting/copying queries, 
 * decorations for query separators and error highlighting, 
 * and commands for running queries, showing results, and refreshing schema.
 */
export class QueryEditor {

    private readonly codeLensProvider: KustoCodeLensProvider;
    private readonly server: IServer;
    private readonly clipboard: IClipboard;
    private readonly history: HistoryManager;
    private readonly connections: ConnectionManager;
    private readonly resultsViewer: ResultsViewer;
    private readonly historyPanel: HistoryPanel;
    private readonly errorRangeDecoration: vscode.TextEditorDecorationType;
    private readonly queryRunningStatusBarItem: vscode.StatusBarItem;
    private runningQueryCount = 0;
    private isQueryRunning = false;
    private queryRunningStartedAt = 0;
    private queryRunningGeneration = 0;
    private queryRangeRunningGeneration = 0;
    private readonly runningQueryRanges = new Map<string, RunningQueryRangeState>();

    constructor(
        context: vscode.ExtensionContext, 
        server: IServer, 
        clipboard: IClipboard, 
        historyManager: HistoryManager, 
        connectionManager: ConnectionManager, 
        resultsViewer: ResultsViewer,
        historyPanel: HistoryPanel) {

        this.server = server;
        this.clipboard = clipboard;
        this.history = historyManager;
        this.connections = connectionManager;
        this.resultsViewer = resultsViewer;
        this.historyPanel = historyPanel;

        this.errorRangeDecoration = vscode.window.createTextEditorDecorationType({
            before: {
                contentText: '\u274C',
                margin: '0 4px 0 0'
            }
        });

        this.queryRunningStatusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            1
        );
        this.queryRunningStatusBarItem.text = '$(sync~spin) Running Kusto query';
        this.queryRunningStatusBarItem.tooltip = 'A Kusto query is running';
        context.subscriptions.push(this.queryRunningStatusBarItem);
        void vscode.commands.executeCommand('setContext', QUERY_RUNNING_CONTEXT_KEY, false);

        // Register CodeLens provider for queries
        this.codeLensProvider = new KustoCodeLensProvider(this.server, this.history);
        context.subscriptions.push(
            this.codeLensProvider,
            vscode.languages.registerCodeLensProvider(
                { language: 'kusto' },
                this.codeLensProvider
            )
        );

        // When the CodeLens is scoped to the active query, the lenses depend on the cursor, so
        // refresh them as the cursor or active editor moves. The refresh is immediate: query ranges
        // are cached per document version, so this is local work rather than a server round-trip.
        const refreshCodeLensForActiveQuery = () => {
            if (!isCodeLensScopedToActiveQuery()) {
                return;
            }

            this.codeLensProvider.refresh();
        };

        context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(() => {
                // Refresh on every active editor change, including moving away from a Kusto
                // document, so a still-visible query set doesn't keep stale scoped lenses.
                refreshCodeLensForActiveQuery();
            }),
            vscode.window.onDidChangeTextEditorSelection(event => {
                if (event.textEditor.document.languageId === 'kusto') {
                    refreshCodeLensForActiveQuery();
                }
            }),
            // Applying the setting takes effect immediately; no window reload required.
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration(`msKustoExplorer.${CODE_LENS_SCOPE_SETTING}`)) {
                    this.codeLensProvider.refresh();
                }
            })
        );

        // Register paste provider for clipboard context
        context.subscriptions.push(
            vscode.languages.registerDocumentPasteEditProvider(
                { language: 'kusto' },
                new KustoPasteEditProvider(this.server, this.clipboard),
                {
                    providedPasteEditKinds: [PASTE_KIND],
                    pasteMimeTypes: ['text/plain']
                }
            )
        );

        // Set up query separator decorations
        activateQuerySeparators(context, this.server, this.errorRangeDecoration);

        // Set up semantic token coloring
        activateSemanticColoring(context, this.server);
    }

    /**
     * Runs the query in the active document at the current cursor position or within the specified range.
     */
    async runQuery(startLine?: number, startChar?: number, endLine?: number, endChar?: number): Promise<void> {
        const queryRange = rangeFromArgs(startLine, startChar, endLine, endChar);
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'kusto') {
            return;
        }

        // Entity definition documents are read-only metadata views; don't allow running queries
        if (editor.document.uri.scheme === ENTITY_DEFINITION_SCHEME) {
            return;
        }

        let queryRunIndicator: QueryRunIndicator | undefined;
        try {
            const uri = editor.document.uri.toString();
            const selection = queryRange ?? {
                start: { line: editor.selection.start.line, character: editor.selection.start.character },
                end: { line: editor.selection.end.line, character: editor.selection.end.character }
            };

            // If the selection is zero-length (cursor position), resolve the enclosing query range
            const isZeroLength = selection.start.line === selection.end.line && selection.start.character === selection.end.character;
            const resolvedRange = isZeroLength
                ? await this.server.getQueryRange(uri, selection.start)
                : selection;
            if (!resolvedRange) {
                return;
            }

            queryRunIndicator = await this.beginQueryRun(uri, resolvedRange);

            // Extract the query text from the document
            const queryText = editor.document.getText(new vscode.Range(
                resolvedRange.start.line, resolvedRange.start.character,
                resolvedRange.end.line, resolvedRange.end.character
            ));

            // Get the document's connection (cluster/database)
            const connection = await this.connections.getDocumentConnection(uri);

            // Run the query via server.runQuery (text-based, returns ResultData)
            const executionStartedAt = new Date().toISOString();
            const startedAtMs = Date.now();
            const clientRequestId = createClientRequestId();
            const runResult = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Window,
                    title: 'Running Kusto query...'
                },
                () => this.server.runQuery(queryText, connection?.cluster, connection?.database, true, undefined, clientRequestId)
            );
            const executionDurationMs = Date.now() - startedAtMs;

            // If the result includes a connection string for an unknown cluster, add it as a server
            if (runResult?.connection || runResult?.cluster) {
                await this.connections.ensureServer(runResult.connection ?? runResult.cluster!);
            }

            // If query changed cluster/database, update document connection
            if (runResult && runResult.cluster) {
                await this.connections.setDocumentConnection(uri, runResult.cluster, runResult.database);
            }
            
            // Clear any previous error decoration
            editor.setDecorations(this.errorRangeDecoration, []);

            if (runResult && runResult.error)
            {
                // display error and highlight error range
                await this.resultsViewer.displayErrorInBottomView(runResult.error);

                if (runResult.error.range) {
                    const r = runResult.error.range;
                    const range = new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
                    editor.setDecorations(this.errorRangeDecoration, [range]);
                }
            }
            else if (runResult?.data)
            {
                runResult.data.executionStartedAt = executionStartedAt;
                runResult.data.executionDurationMs = executionDurationMs;
                runResult.data.clientRequestId = clientRequestId;

                // Add to history and use the history file as backing for the singleton view
                const historyUri = await this.history.addHistoryEntry(runResult.data);
                this.resultsViewer.setSingletonViewBackingUri(historyUri);

                // Display result tables and chart from ResultData
                await this.resultsViewer.displayResults(runResult.data);
            }

            // Refresh CodeLens to show/hide Results lens
            this.codeLensProvider.refresh();
        } 
        catch (error) 
        {
            vscode.window.showErrorMessage(`Failed to execute query: ${error}`);
        } 
        finally
        {
            if (queryRunIndicator) {
                await this.endQueryRun(queryRunIndicator);
            }
        }
    }

    private async beginQueryRun(uri: string, range: Range): Promise<QueryRunIndicator> {
        const startedAt = Date.now();
        const key = getQueryRangeKey(uri, range);
        let rangeState = this.runningQueryRanges.get(key);
        if (!rangeState || rangeState.count === 0) {
            rangeState = {
                count: 0,
                startedAt,
                generation: ++this.queryRangeRunningGeneration
            };
            this.runningQueryRanges.set(key, rangeState);
            this.codeLensProvider.setQueryRangeRunning(key, true);
        }

        rangeState.count++;

        if (this.runningQueryCount === 0) {
            this.queryRunningStartedAt = startedAt;
            this.queryRunningGeneration++;
        }

        this.runningQueryCount++;
        await this.setQueryRunning(this.runningQueryCount > 0);

        return {
            key,
            generation: rangeState.generation
        };
    }

    private async endQueryRun(indicator: QueryRunIndicator): Promise<void> {
        this.endQueryRangeRun(indicator);

        this.runningQueryCount = Math.max(0, this.runningQueryCount - 1);
        if (this.runningQueryCount > 0) {
            await this.setQueryRunning(true);
            return;
        }

        const generation = this.queryRunningGeneration;
        const elapsedMs = Date.now() - this.queryRunningStartedAt;
        const delayMs = Math.max(0, MIN_QUERY_RUNNING_INDICATOR_MS - elapsedMs);
        if (delayMs === 0) {
            await this.setQueryRunning(false);
            return;
        }

        setTimeout(() => {
            if (this.runningQueryCount === 0 && this.queryRunningGeneration === generation) {
                void this.setQueryRunning(false);
            }
        }, delayMs);
    }

    private endQueryRangeRun(indicator: QueryRunIndicator): void {
        const rangeState = this.runningQueryRanges.get(indicator.key);
        if (!rangeState || rangeState.generation !== indicator.generation) {
            return;
        }

        rangeState.count = Math.max(0, rangeState.count - 1);
        if (rangeState.count > 0) {
            return;
        }

        const elapsedMs = Date.now() - rangeState.startedAt;
        const delayMs = Math.max(0, MIN_QUERY_RUNNING_INDICATOR_MS - elapsedMs);
        const clearRunningRange = () => {
            const currentState = this.runningQueryRanges.get(indicator.key);
            if (currentState?.count === 0 && currentState.generation === indicator.generation) {
                this.runningQueryRanges.delete(indicator.key);
                this.codeLensProvider.setQueryRangeRunning(indicator.key, false);
            }
        };

        if (delayMs === 0) {
            clearRunningRange();
            return;
        }

        setTimeout(clearRunningRange, delayMs);
    }

    private async setQueryRunning(isRunning: boolean): Promise<void> {
        if (this.isQueryRunning === isRunning) {
            return;
        }

        this.isQueryRunning = isRunning;
        if (isRunning) {
            this.queryRunningStatusBarItem.show();
        } else {
            this.queryRunningStatusBarItem.hide();
        }

        await vscode.commands.executeCommand('setContext', QUERY_RUNNING_CONTEXT_KEY, isRunning);
    }

    async copyClientRequestId(clientRequestId?: string): Promise<void> {
        if (!clientRequestId) {
            vscode.window.showWarningMessage('No client request id available to copy.');
            return;
        }

        await this.clipboard.copyText(clientRequestId);
    }

    /**
     * Shows history results for the query at the given position in the active document.
     * Uses the query hash to find a matching history entry, then verifies the full query.
     */
    async showHistoryResults(startLine: number, startChar: number): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'kusto') {
            return;
        }

        try {
            // Resolve the query range for this position
            const queryRange = await this.server.getQueryRange(editor.document.uri.toString(), { line: startLine, character: startChar });
            if (!queryRange) {
                return;
            }

            const queryText = editor.document.getText(new vscode.Range(
                queryRange.start.line, queryRange.start.character,
                queryRange.end.line, queryRange.end.character
            ));

            const entry = await this.history.getMatchingEntry(queryText);
            if (!entry) {
                await this.resultsViewer.displayErrorInBottomView({
                    message: 'No saved results were found for this query.',
                    details: 'Run the query again to generate results.'
                });
                return;
            }

            const data = await this.history.getEntryData(entry);
            if (data) {
                await this.resultsViewer.displayResults(data);
                this.historyPanel.revealEntry(entry);
            } else {
                await this.resultsViewer.displayErrorInBottomView({
                    message: 'This query has changed since it was last run.',
                    details: 'Run the query again to update the results.'
                });
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to show results: ${error}`);
        }
    }

    /**
     * Selects the range in the active document.
     * @param startLine The start line of the range
     * @param startChar The start character of query range
     * @param endLine The end line of the range
     * @param endChar The end character of query range
     */
    selectRange(startLine: number, startChar: number, endLine: number, endChar: number): void {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'kusto') {
            return;
        }

        const start = new vscode.Position(startLine, startChar);
        let end = new vscode.Position(endLine, endChar);

        // If the end is at column 0, the selection visually wraps to that line;
        // move it back to the end of the previous line instead.
        if (endLine > startLine && endChar === 0) {
            end = editor.document.lineAt(endLine - 1).range.end;
        }

        editor.selection = new vscode.Selection(start, end);
        editor.revealRange(new vscode.Range(start, end));
    }

    /**
     * Copies the query in the active document at the current cursor position or within the specified range.
     * When transparent is true, uses the server to generate light-mode HTML with a transparent
     * background suitable for pasting into documents, rather than the editor's current theme.
     */
    async copyQuery(startLine?: number, startChar?: number, endLine?: number, endChar?: number, transparent?: boolean): Promise<void> {
        const codeLensRange = rangeFromArgs(startLine, startChar, endLine, endChar);
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'kusto') {
            return;
        }

        try {
            const uri = editor.document.uri.toString();

            // Use the CodeLens range if provided, otherwise resolve from cursor position
            let queryRange: Range | undefined | null = codeLensRange;
            if (!queryRange) {
                const cursorPos = editor.selection.active;
                queryRange = await this.server.getQueryRange(
                    uri,
                    { line: cursorPos.line, character: cursorPos.character }
                );
            }

            if (!queryRange) {
                return;
            }

            const range = new vscode.Range(
                queryRange.start.line, queryRange.start.character,
                queryRange.end.line, queryRange.end.character
            );

            if (transparent) {
                // Get plain text of the query
                const plainText = editor.document.getText(range);

                // Request light-mode HTML from the server (darkMode = false)
                const connection = await this.connections.getDocumentConnection(uri);
                const result = await this.server.getQueryAsHtml(plainText, connection?.cluster, connection?.database, false);
                if (!result?.html) {
                    return;
                }

                // Place both HTML and plain text on the clipboard
                const items: ClipboardItem[] = [
                    { format: 'HTML Format', data: formatCfHtml(result.html) },
                    { format: 'Text', data: plainText, encoding: 'text' }
                ];

                await this.clipboard.copyItems(items);
            } else {
                // Save the current selection
                const previousSelection = editor.selection;

                // Select the query range and copy with editor syntax highlighting
                editor.selection = new vscode.Selection(range.start, range.end);
                await vscode.commands.executeCommand('editor.action.clipboardCopyWithSyntaxHighlightingAction');

                // Restore the previous selection
                editor.selection = previousSelection;
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to copy query: ${error}`);
        }
    }

    /**
     * Formats the query in the active document at the current cursor position or within the specified range.
     * @param startLine The start line of the query position
     * @param startChar The start character of the query position
     * @param endLine The end line of the query position
     * @param endChar The end character of the query position
     */
    async formatQuery(startLine?: number, startChar?: number, endLine?: number, endChar?: number): Promise<void> {
        const codeLensRange = rangeFromArgs(startLine, startChar, endLine, endChar);
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'kusto') {
            return;
        }

        try {
            // Use the CodeLens range if provided, otherwise resolve from cursor position
            let queryRange: Range | undefined | null = codeLensRange;
            if (!queryRange) {
                const cursorPos = editor.selection.active;
                queryRange = await this.server.getQueryRange(
                    editor.document.uri.toString(),
                    { line: cursorPos.line, character: cursorPos.character }
                );
            }

            if (!queryRange) {
                return;
            }

            const range = new vscode.Range(
                queryRange.start.line, queryRange.start.character,
                queryRange.end.line, queryRange.end.character
            );

            // Invoke the LSP document range formatting
            const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
                'vscode.executeFormatRangeProvider',
                editor.document.uri,
                range,
                editor.options
            );

            if (edits && edits.length > 0) {
                await editor.edit(editBuilder => {
                    for (const edit of edits) {
                        editBuilder.replace(edit.range, edit.newText);
                    }
                });
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to format query: ${error}`);
        }
    }

    /**
     * Refreshes the schema for all databases referenced in all the queries in the active document.
     * This includes databases accessed via cluster() and database() functions.
     */
    async refreshDocumentSchema(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'kusto') {
            return;
        }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Refreshing schema for referenced databases...',
                cancellable: false
            },
            async () => {
                try {
                    const uri = editor.document.uri.toString();
                    await this.server.refreshDocumentSchema(uri);
                } catch (error) {
                    vscode.window.showErrorMessage(`Failed to refresh schema: ${error}`);
                }
            }
        );
    }
}

// =============================================================================
// CodeLens Provider
// =============================================================================

/**
 * Provides the query action CodeLens entries for query set documents.
 * Exported for unit testing.
 */
export class KustoCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
    private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
    private readonly runningQueryRangeKeys = new Set<string>();
    private readonly queryRangesCache = new Map<string, CachedQueryRanges>();
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly server: IServer, private readonly history: HistoryManager) {
        this.disposables.push(
            vscode.workspace.onDidCloseTextDocument(document => {
                this.queryRangesCache.delete(document.uri.toString());
            })
        );
    }

    dispose(): void {
        this.queryRangesCache.clear();
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables.length = 0;
        this._onDidChangeCodeLenses.dispose();
    }

    refresh(): void {
        this._onDidChangeCodeLenses.fire();
    }

    setQueryRangeRunning(key: string, isRunning: boolean): void {
        if (this.runningQueryRangeKeys.has(key) === isRunning) {
            return;
        }

        if (isRunning) {
            this.runningQueryRangeKeys.add(key);
        } else {
            this.runningQueryRangeKeys.delete(key);
        }

        this.refresh();
    }

    /**
     * Gets the document's query ranges, reusing the cached result while the document version
     * is unchanged.
     *
     * Query ranges are a pure function of document content, so they cannot change without the
     * version changing. Caching keeps the cross-process call off the cursor-movement path, which
     * matters when the CodeLens is scoped to the active query and every cursor move re-provides.
     */
    private getQueryRanges(document: vscode.TextDocument): Promise<QueryRangesResult | null> {
        // The URI string carries the scheme, so entity definition documents get their own entries.
        const uri = document.uri.toString();
        const version = document.version;

        const cached = this.queryRangesCache.get(uri);
        if (cached && cached.version === version) {
            return cached.result;
        }

        // Setting the entry also drops the now-stale one for the previous version.
        const result = this.server.getQueryRanges(uri);
        const entry: CachedQueryRanges = { version, result };
        this.queryRangesCache.set(uri, entry);

        result.catch(() => {
            // Never leave a rejected request cached; the next request should retry.
            if (this.queryRangesCache.get(uri) === entry) {
                this.queryRangesCache.delete(uri);
            }
        });

        return result;
    }

    async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
        const isEntityDefinition = document.uri.scheme === ENTITY_DEFINITION_SCHEME;

        const result = await this.getQueryRanges(document);
        if (!result || !result.ranges.length) {
            return [];
        }

        const scopeToActiveQuery = isCodeLensScopedToActiveQuery();
        const activeSelections = scopeToActiveQuery ? getActiveSelectionRanges(document) : [];
        const lenses: vscode.CodeLens[] = [];

        for (const range of result.ranges) {
            const vsRange = new vscode.Range(
                range.start.line, range.start.character,
                range.end.line, range.end.character
            );

            const isQueryRangeRunning = !isEntityDefinition
                && this.runningQueryRangeKeys.has(getQueryRangeKey(document.uri.toString(), range));
            const visibility = getQueryLensVisibility(range, activeSelections, {
                scopeToActiveQuery,
                isRunning: isQueryRangeRunning
            });

            if (visibility.showRunningLens) {
                // The cursor moved away from a query that is still running; keep just the indicator
                // so the user doesn't lose sight of the running query.
                lenses.push(new vscode.CodeLens(vsRange, createRunLensCommand(range, true)));
                continue;
            }

            if (!visibility.showQueryLenses) {
                continue;
            }

            const queryText = document.getText(vsRange);

            // Skip empty or whitespace-only query ranges
            if (queryText.trim().length === 0) {
                continue;
            }

            lenses.push(new vscode.CodeLens(vsRange, {
                title: '⬚ Select',
                command: 'msKustoExplorer.selectQuery',
                tooltip: 'Select this query',
                arguments: [range.start.line, range.start.character, range.end.line, range.end.character]
            }));

            // Hide Run, Format, and Results lenses in entity definition documents
            if (!isEntityDefinition) {
                lenses.push(new vscode.CodeLens(vsRange, createRunLensCommand(range, isQueryRangeRunning)));
            }

            lenses.push(new vscode.CodeLens(vsRange, {
                title: '📋 Copy',
                command: 'msKustoExplorer.copyQueryTransparent',
                tooltip: 'Copy this query with syntax highlighting',
                arguments: [range.start.line, range.start.character, range.end.line, range.end.character]
            }));

            if (!isEntityDefinition) {
                lenses.push(new vscode.CodeLens(vsRange, {
                    title: '✎ Format',
                    command: 'msKustoExplorer.formatQuery',
                    tooltip: 'Format this query',
                    arguments: [range.start.line, range.start.character, range.end.line, range.end.character]
                }));

                const lastRun = await this.history.getMatchingEntry(queryText);

                // Only show Results lens if there is a history entry for this query
                if (lastRun) {
                    lenses.push(new vscode.CodeLens(vsRange, {
                        title: '📊 Results',
                        command: 'msKustoExplorer.showResults',
                        tooltip: 'Show results from history for this query',
                        arguments: [range.start.line, range.start.character]
                    }));

                    lenses.push(new vscode.CodeLens(vsRange, {
                        title: getLastRunTitle(lastRun) ?? 'Last run',
                        command: 'msKustoExplorer.noop',
                        tooltip: lastRun.clientRequestId
                            ? `Client request id: ${lastRun.clientRequestId}`
                            : 'Last query execution details'
                    }));

                    if (lastRun.clientRequestId) {
                        lenses.push(new vscode.CodeLens(vsRange, {
                            title: '$(copy) Copy CID',
                            command: 'msKustoExplorer.copyClientRequestId',
                            tooltip: 'Copy the last run client request id',
                            arguments: [lastRun.clientRequestId]
                        }));
                    }
                }
            }
        }

        return lenses;
    }
}

/** Builds the Run / Running indicator lens command for a query range. */
function createRunLensCommand(range: Range, isRunning: boolean): vscode.Command {
    return {
        title: isRunning ? '$(sync~spin) Running' : '▶ Run',
        command: isRunning ? 'msKustoExplorer.runQuery.running' : 'msKustoExplorer.runQuery',
        tooltip: isRunning ? 'This Kusto query is running' : 'Run this query',
        arguments: [range.start.line, range.start.character, range.end.line, range.end.character]
    };
}

/** Cursors and selections in the active editor, or none when the document isn't the active one. */
function getActiveSelectionRanges(document: vscode.TextDocument): SelectionRange[] {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor || activeEditor.document.uri.toString() !== document.uri.toString()) {
        return [];
    }

    return activeEditor.selections.map(selection => ({
        start: { line: selection.start.line, character: selection.start.character },
        end: { line: selection.end.line, character: selection.end.character }
    }));
}

// =============================================================================
// Paste Edit Provider
// =============================================================================

class KustoPasteEditProvider implements vscode.DocumentPasteEditProvider {

    constructor(private readonly server: IServer, private readonly clipboard: IClipboard) {
    }

    async provideDocumentPasteEdits(
        document: vscode.TextDocument,
        ranges: readonly vscode.Range[],
        dataTransfer: vscode.DataTransfer,
        _context: vscode.DocumentPasteEditContext,
        _token: vscode.CancellationToken
    ): Promise<vscode.DocumentPasteEdit[] | undefined> {
        const clipboardContext = this.clipboard.getContext();
        if (!clipboardContext) {
            return undefined;
        }

        // Check that the clipboard text matches the stored context
        const textItem = dataTransfer.get('text/plain');
        if (!textItem) {
            return undefined;
        }
        const clipboardText = await textItem.asString();
        if (clipboardText !== clipboardContext.text) {
            // Clipboard has changed since the contextual copy, let default paste handle it
            this.clipboard.clearContext();
            return undefined;
        }

        // Get the insertion position (first range's start)
        const insertPosition = ranges[0]?.start;
        if (!insertPosition) {
            return undefined;
        }

        // Ask the server to transform the paste
        const result = await this.server.transformPaste(
            clipboardContext.text,
            clipboardContext.kind,
            document.uri.toString(),
            { line: insertPosition.line, character: insertPosition.character },
            clipboardContext.entityCluster,
            clipboardContext.entityDatabase,
            clipboardContext.entityType,
            clipboardContext.entityName,
        );

        if (!result || result === clipboardContext.text) {
            // Server returned no change, let default paste handle it
            return undefined;
        }

        const edit = new vscode.DocumentPasteEdit(
            result,
            'Paste with connection context',
            PASTE_KIND
        );

        return [edit];
    }
}

// =============================================================================
// Query Separator Decorations
// =============================================================================

/**
 * Activates editor decoration features like query separators.
 */
function activateQuerySeparators(context: vscode.ExtensionContext, server: IServer, errorRangeDecoration: vscode.TextEditorDecorationType): void {

    // Decoration for separator line between queries
    const querySeparatorDecoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        borderWidth: '0 0 3px 0',
        borderStyle: 'solid',
        borderColor: 'rgba(128, 128, 128, 0.25)',
    });

    // Map to track debounce timers per document URI
    const debounceTimers = new Map<string, NodeJS.Timeout>();

    /**
     * Requests query boundaries from the server and updates decorations.
     */
    async function updateQuerySeparators(uri: string): Promise<void> {
        try {
            const result = await server.getQueryRanges(uri);

            if (!result) {
                return;
            }

            // Apply to all visible editors for this document (handles split views)
            const editors = vscode.window.visibleTextEditors.filter(
                e => e.document.uri.toString() === result.uri
            );

            const config = vscode.workspace.getConfiguration('msKustoExplorer');
            const enableSeparators = config.get<boolean>('editor.showQuerySeparators', true);

            const firstEditor = editors[0];
            if (!firstEditor) {
                return;
            }

            const doc = firstEditor.document;

            // Create separator lines between queries (skip the first range)
            // Find the last non-empty line for each query
            const ranges = result.ranges
                // skip the first query range since there should be no separator before it
                .slice(1, result.ranges.length)
                // filter out query blocks that are just one empty lines
                .filter(r => doc.getText(new vscode.Range(r.start.line, 0, r.end.line, 0)).trim().length > 0)
                // filter out any block with a start line that is out of range
                .filter(r => r.start.line > 0 && r.start.line < doc.lineCount)
                // put decoration on line before start of the range
                .map(r => new vscode.Range(r.start.line - 1, 0, r.start.line - 1, 0));

            // Clear and set decorations on all editors showing this document
            for (const editor of editors) {
                editor.setDecorations(querySeparatorDecoration, []);  // clear first
                if (enableSeparators) {
                    editor.setDecorations(querySeparatorDecoration, ranges);
                }
            }
        } catch (error) {
            console.error(`Failed to get query ranges for ${uri}:`, error);
        }
    }

    // Update decorations when document opens
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(async (document) => {
            if (document.languageId === 'kusto') {
                await updateQuerySeparators(document.uri.toString());
            }
        })
    );

    // Update decorations when document changes (debounced to avoid race conditions and improve performance)
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((event) => {
            if (event.document.languageId === 'kusto') {
                // Clear error range decoration on any edit
                const errorEditor = vscode.window.visibleTextEditors.find(
                    e => e.document.uri.toString() === event.document.uri.toString()
                );
                if (errorEditor) {
                    errorEditor.setDecorations(errorRangeDecoration, []);
                }

                const uri = event.document.uri.toString();
                
                // Clear existing timer for this document
                const existingTimer = debounceTimers.get(uri);
                if (existingTimer) {
                    clearTimeout(existingTimer);
                }
                
                // Set new timer - waits for typing to stop before requesting boundaries
                // This ensures didChange notifications are sent to the server first
                const timer = setTimeout(() => {
                    void updateQuerySeparators(uri);
                    debounceTimers.delete(uri);
                }, 300); // 300ms after last change
                
                debounceTimers.set(uri, timer);
            }
        })
    );

    // Update decorations for already open documents
    for (const document of vscode.workspace.textDocuments) {
        if (document.languageId === 'kusto') {
            void updateQuerySeparators(document.uri.toString());
        }
    }
}

// =============================================================================
// Semantic Token Coloring
// =============================================================================

/**
 * Activates semantic token coloring features.
 */
function activateSemanticColoring(context: vscode.ExtensionContext, server: IServer): void {
    // Handle workspace/semanticTokens/refresh notification from server
    // VS Code does not automatically redraw with new semantic tokens when this notification is received,
    // so we need to force it manually
    server.onSemanticTokensRefresh(forceRefreshSemanticTokens);

    // Force establishing semantic token provider for documents already open
    const serverCapabilities = server.initializeResult?.capabilities;
    if (serverCapabilities?.semanticTokensProvider) {
        // Small delay to ensure server is fully ready
        setTimeout(() => {
            vscode.workspace.textDocuments.forEach(doc => {
                if (doc.languageId === 'kusto') {
                    // Find visible editor for this document and trigger refresh
                    const editor = vscode.window.visibleTextEditors.find(e => e.document === doc);
                    if (editor) {
                        requestSemanticTokens(doc);
                    }
                }
            });
        }, 100);
    }

    // Also establish semantic token provider for new documents as they are opened
    if (serverCapabilities?.semanticTokensProvider) {
        context.subscriptions.push(
            vscode.workspace.onDidOpenTextDocument(doc => {
                if (doc.languageId === 'kusto') {
                    // Small delay to ensure document is fully loaded
                    setTimeout(() => {
                        requestSemanticTokens(doc);
                    }, 100);
                }
            })
        );
    }
}

function requestSemanticTokens(document: vscode.TextDocument): void {
    void Promise.resolve(
        vscode.commands.executeCommand('vscode.executeDocumentSemanticTokensProvider', document.uri)
    ).catch(() => undefined);
}


/**
 * Forces VS Code to invalidate semantic token cache by making a real edit on all visible Kusto editors.
 */
async function forceRefreshSemanticTokens(): Promise<void> {
    for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document.languageId === 'kusto') {
            try {
                // Get position at end of document
                const lastLine = Math.max(0, editor.document.lineCount - 1);
                const charOffset = editor.document.lineAt(lastLine).text.length;
                const endPos = new vscode.Position(lastLine, charOffset);

                // Insert a space at end (this changes document version)
                await editor.edit((editBuilder) => {
                    editBuilder.insert(endPos, ' ');
                }, {
                    undoStopBefore: false,
                    undoStopAfter: false
                });

                // Immediately delete it (restores original content)
                await editor.edit((editBuilder) => {
                    editBuilder.delete(new vscode.Range(endPos, endPos.translate(0, 1)));
                }, {
                    undoStopBefore: false,
                    undoStopAfter: false
                });
            } catch (e) {
            }
        }
    }
}
