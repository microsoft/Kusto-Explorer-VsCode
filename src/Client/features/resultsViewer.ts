// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/*
*   This module implements ResultsViewer class that handles UI for displaying query results (data and charts) 
*   inside webviews.
*/

import * as vscode from 'vscode';
import type { IServer } from './server';
import * as server from './server';
import type { IClipboard } from './clipboard';
import type { ClipboardItem } from './clipboard';
import type { IChartProvider, IChartView } from './chartProvider';
import { ChartAspectRatio } from './chartProvider';
import type { IChartEditorProvider, IChartEditorView } from './chartEditorProvider';
import type { IDataTableProvider, IDataTableView } from './dataTableProvider';
import type { IWebView } from './webview';
import { escapeHtml } from './html';

/** The view type used for the custom results viewer. */
const resultViewerViewType = 'msKustoExplorer_resultViewer';

/**
 * Controls which content sections are shown in a result view.
 * - 'chart': Only the chart, no tabs.
 * - 'data': Only data tables. Tabs shown only if multiple tables.
 * - 'all': Chart, data tables, and query tabs — all visible.
 */
export type ResultViewMode = 'chart' | 'data' | 'detail' | 'all';

/**
 * Adapts a VS Code `Webview` to the `IWebView` interface for a named region.
 * Stores page-level setup content (headHtml, scriptsHtml) for the page builder to read.
 * `setContent()` posts the given `contentCommand` message to the page handler.
 */
export class WebViewAdapter implements IWebView {
    private readonly webview: vscode.Webview;
    private readonly contentCommand: string;
    private readonly headFragments = new Set<string>();
    private readonly scriptFragments = new Set<string>();
    headHtml = '';
    scriptsHtml = '';
    contentHtml = '';
    /**
     * When true, `setContent` still updates `contentHtml` (so a subsequent
     * page rebuild embeds it inline) but no `postMessage` is sent, and
     * `invoke` is a no-op. The host sets this while preparing chart/table
     * state for an imminent `webview.html = …` reassignment so the
     * about-to-be-replaced page doesn't briefly redraw the new chart
     * before the rebuild causes another redraw via `chartViewReady`.
     */
    suppressMessages = false;

    constructor(webview: vscode.Webview, contentCommand = 'setChartHtml') {
        this.webview = webview;
        this.contentCommand = contentCommand;
    }

    setup(headHtml: string, scriptsHtml: string): void {
        this.headHtml = this.appendSetupFragment(this.headHtml, this.headFragments, headHtml);
        this.scriptsHtml = this.appendSetupFragment(this.scriptsHtml, this.scriptFragments, scriptsHtml);
    }

    private appendSetupFragment(current: string, fragments: Set<string>, fragment: string): string {
        if (!fragment || fragments.has(fragment)) {
            return current;
        }
        fragments.add(fragment);
        return current ? `${current}\n${fragment}` : fragment;
    }

    setContent(html: string): void {
        this.contentHtml = html;
        if (this.suppressMessages) { return; }
        this.webview.postMessage({ command: this.contentCommand, html });
    }

    invoke(command: string, args?: Record<string, unknown>): void {
        if (this.suppressMessages) { return; }
        this.webview.postMessage({ command, ...args });
    }

    handle(handler: (message: Record<string, unknown>) => void): vscode.Disposable {
        return this.webview.onDidReceiveMessage(handler);
    }
}

/** Per-viewer state for results viewer webviews. */
interface ResultViewerState {
    resultData: server.ResultData;
    tableNames: string[];
    activeView: string; // 'chart', 'table-0', 'table-1', etc.
    chartOptionsOverride?: server.ChartOptions;
}

/**
 * Determines if VS Code is currently using a dark color theme.
 */
function isDarkMode(): boolean {
    const colorTheme = vscode.window.activeColorTheme;
    return colorTheme.kind === vscode.ColorThemeKind.Dark ||
           colorTheme.kind === vscode.ColorThemeKind.HighContrast;
}

/**
 * Reads chart default settings from VS Code configuration and returns
 * a partial ChartOptions with only the configured defaults.
 */
function getChartDefaults(): Partial<server.ChartOptions> {
    const config = vscode.workspace.getConfiguration('msKustoExplorer.chart');
    const defaults: Record<string, unknown> = {};

    function setBool(key: string, prop: string): void {
        const val = config.get<string>(key);
        if (val === 'yes') { defaults[prop] = true; }
        else if (val === 'no') { defaults[prop] = false; }
    }

    function setString(key: string, prop: string): void {
        const val = config.get<string>(key);
        if (val) { defaults[prop] = val; }
    }

    function setNumber(key: string, prop: string): void {
        const val = config.get<string>(key);
        if (val) { defaults[prop] = Number(val); }
    }

    setString('legendPosition', 'legendPosition');
    setString('sort', 'sort');
    setBool('xShowTicks', 'xShowTicks');
    setBool('yShowTicks', 'yShowTicks');
    setBool('xShowGrid', 'xShowGrid');
    setBool('yShowGrid', 'yShowGrid');
    setBool('showValues', 'showValues');
    setString('textSize', 'textSize');
    setString('aspectRatio', 'aspectRatio');
    setNumber('xTickAngle', 'xTickAngle');
    setNumber('yTickAngle', 'yTickAngle');
    setBool('showMarkers', 'showMarkers');
    setBool('markerOutline', 'markerOutline');
    setString('markerShape', 'markerShape');
    setBool('markerShapesCycle', 'cycleMarkerShapes');
    setString('markerSize', 'markerSize');

    return defaults as Partial<server.ChartOptions>;
}

/**
 * Returns a new ChartOptions with unset properties filled in from configuration defaults.
 */
function applyChartDefaults(options: server.ChartOptions): server.ChartOptions {
    const defaults = getChartDefaults();
    return { ...defaults, ...options };
}

function getResultCharts(resultData: server.ResultData | undefined): server.ResultChart[] {
    if (!resultData) {
        return [];
    }
    return resultData.charts ?? [];
}

function getPrimaryChart(resultData: server.ResultData | undefined): server.ResultChart | undefined {
    return getResultCharts(resultData)[0];
}

function getPrimaryChartOptions(resultData: server.ResultData | undefined, override?: server.ChartOptions): server.ChartOptions | undefined {
    return override ?? getPrimaryChart(resultData)?.options;
}

function getPrimaryChartTable(resultData: server.ResultData | undefined, chart?: server.ResultChart): server.ResultTable | undefined {
    if (!resultData?.tables?.length) {
        return undefined;
    }
    if (chart?.tableName) {
        return resultData.tables.find(t => t.name === chart.tableName) ?? resultData.tables[0];
    }
    return resultData.tables[0];
}

function withPrimaryChartOptions(resultData: server.ResultData, options: server.ChartOptions | undefined): server.ResultData {
    const charts = getResultCharts(resultData);
    let updatedCharts: server.ResultChart[] | undefined;
    if (options) {
        if (charts.length > 0) {
            updatedCharts = [{ ...charts[0]!, options }, ...charts.slice(1)];
        } else {
            updatedCharts = [{ options }];
        }
    } else if (charts.length > 1) {
        updatedCharts = charts.slice(1);
    }

    const updated: server.ResultData = { ...resultData };
    if (updatedCharts && updatedCharts.length > 0) {
        updated.charts = updatedCharts;
    } else {
        delete updated.charts;
    }
    return updated;
}

/** Base script injected into all result webviews for core message handling. */
const webviewMessageHandlerScript = `
<script>
    (function() {
        const vscodeApi = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : null;
        if (!vscodeApi) return;
        // Expose for edit panel script
        window._vscodeApi = vscodeApi;

        // Notify the extension when the active view tab changes
        document.addEventListener('click', function(e) {
            const btn = e.target.closest ? e.target.closest('.view-toggle button[data-view]') : null;
            if (btn) {
                vscodeApi.postMessage({ command: 'viewChanged', viewId: btn.getAttribute('data-view') });
            }
        });
    })();
</script>`;



/**
 * Injects the base webview message handler script into result HTML content.
 * Also adds data-vscode-context to suppress default context menu items.
 */
function injectMessageHandlerScripts(html: string): string {
    // Add data-vscode-context to suppress default Cut/Copy/Paste context menu items
    let result = html;
    const contextAttr = ` data-vscode-context='{"preventDefaultContextMenuItems": true}'`;
    if (result.includes('<body')) {
        result = result.replace('<body', '<body' + contextAttr);
    } else if (result.includes('<html')) {
        result = result.replace('<html>', '<html><body' + contextAttr + '>');
        if (result.includes('</html>')) {
            result = result.replace('</html>', '</body></html>');
        }
    }

    if (result.includes('</html>')) {
        return result.replace('</html>', webviewMessageHandlerScript + '</html>');
    }
    if (result.includes('</body>')) {
        return result.replace('</body>', webviewMessageHandlerScript + '</body>');
    }
    return result + webviewMessageHandlerScript;
}

/**
 * Saves result data to a .kqr file.
 * Returns the saved URI, or undefined if cancelled or failed.
 */
async function saveResults(source: { data: server.ResultData }): Promise<{ uri: vscode.Uri; alreadyOpen: boolean } | undefined> {
    const resultData = source.data;

    const saveUri = await vscode.window.showSaveDialog({
        filters: { 'Kusto Query Results': ['kqr'] },
        defaultUri: vscode.Uri.file('results.kqr')
    });

    if (!saveUri) {
        return undefined;
    }

    // Ensure the file has the .kqr extension
    const finalUri = saveUri.path.endsWith('.kqr')
        ? saveUri
        : saveUri.with({ path: saveUri.path + '.kqr' });

    const content = JSON.stringify(resultData, null, 2);

    // If the file is already open in an editor, update its content via WorkspaceEdit
    // so the custom editor re-renders automatically.
    const openDoc = vscode.workspace.textDocuments.find(
        doc => doc.uri.fsPath.toLowerCase() === finalUri.fsPath.toLowerCase()
    );

    if (openDoc) {
        const fullRange = new vscode.Range(
            openDoc.positionAt(0),
            openDoc.positionAt(openDoc.getText().length)
        );
        const edit = new vscode.WorkspaceEdit();
        edit.replace(openDoc.uri, fullRange, content);
        await vscode.workspace.applyEdit(edit);
        await openDoc.save();
        return { uri: finalUri, alreadyOpen: true };
    }

    await vscode.workspace.fs.writeFile(finalUri, Buffer.from(content, 'utf-8'));
    return { uri: finalUri, alreadyOpen: false };
}

/**
 * Stores a per-table view state into `resultData.tableViews`, looked up by
 * `state.name`. Existing entries with the same name are replaced; otherwise
 * the new entry is appended. Mutates `resultData` in place; callers rely on
 * the same object reference being picked up by the eventual save.
 */
function storeTableView(resultData: server.ResultData, state: server.ResultTableView): void {
    if (!resultData.tableViews) {
        resultData.tableViews = [];
    }
    const idx = resultData.tableViews.findIndex(v => v.name === state.name);
    if (idx >= 0) {
        resultData.tableViews[idx] = state;
    } else {
        resultData.tableViews.push(state);
    }
}

/**
 * Finds the saved view for a table by name. Returns `undefined` if no
 * matching entry exists in `resultData.tableViews`.
 */
function findTableView(resultData: server.ResultData, tableName: string): server.ResultTableView | undefined {
    return resultData.tableViews?.find(v => v.name === tableName);
}

/**
 * Stores per-chart presentation state into `resultData.chartViews`. Looked
 * up by matching `name` (when set) or `tableName`. Mutates in place.
 */
function storeChartView(resultData: server.ResultData, state: server.ResultChartView): void {
    if (!resultData.chartViews) {
        resultData.chartViews = [];
    }
    const idx = resultData.chartViews.findIndex(v => chartViewKeyMatches(v, state));
    if (idx >= 0) {
        resultData.chartViews[idx] = state;
    } else {
        resultData.chartViews.push(state);
    }
}

/** Find a previously-saved chart view by name/tableName. */
function findChartView(resultData: server.ResultData, chart: server.ResultChart | undefined): server.ResultChartView | undefined {
    if (!chart || !resultData.chartViews) return undefined;
    return resultData.chartViews.find(v => chartViewKeyMatches(v, chart));
}

function chartViewKeyMatches(a: { name?: string; tableName?: string }, b: { name?: string; tableName?: string }): boolean {
    if (a.name && b.name) return a.name === b.name;
    if (a.tableName && b.tableName) return a.tableName === b.tableName;
    return !a.name && !b.name && !a.tableName && !b.tableName;
}

/**
 * Writes the current `resultData` JSON back into the backing text document
 * and saves it. .kqr documents are not user-authored — there is no UI
 * affordance for "dirty" on the bottom results panel or singleton view —
 * so any in-grid edit (chart options, column resize/reorder) must persist
 * automatically. Callers must wrap this in `runSelfEdit` (or otherwise
 * guard with the self-edit ref-count) so the resulting
 * `onDidChangeTextDocument` event does not trigger a full re-render of
 * the panel that originated the edit.
 */
async function persistResultDataToDocument(document: vscode.TextDocument, resultData: server.ResultData): Promise<void> {
    const content = JSON.stringify(resultData, null, 2);
    const current = document.getText();
    if (current === content) return;
    const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(current.length)
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, fullRange, content);
    try {
        await vscode.workspace.applyEdit(edit);
        await document.save();
    } catch {
        /* best-effort — if the edit cannot be applied (doc closed, etc.) we silently drop */
    }
}

// =============================================================================
// ResultsViewer — main class
// =============================================================================

/**
*   The ResultsViewer class handles UI for multiple query results that can each show a combination of data tables, charts, and query text in a variety of locations:
* 
*   - Bottom view - results shown in the bottom panel
*   - Singleton view - a tab view not associated with a file backed document, typically used to show just charts
*   - Document view - a tab view for results saved to a .kqr file that may include data, charts and query
*
*   More than one view can exist at the same time, but only one is the active view
*/

/**
 * Internal interface for DocumentViewProvider to access per-panel state
 * on ResultsViewer. Not exported — only used within this file.
 */
interface IViewerPanelState {
    readonly viewerStates: Map<vscode.WebviewPanel, ResultViewerState>;
    readonly webviewDocuments: Map<vscode.WebviewPanel, vscode.Uri>;
    readonly chartViews: Map<vscode.WebviewPanel, IChartView>;
    readonly chartWebViews: Map<vscode.WebviewPanel, WebViewAdapter>;
    readonly editorViews: Map<vscode.WebviewPanel, IChartEditorView>;
    readonly editorWebViews: Map<vscode.WebviewPanel, WebViewAdapter>;
    readonly dataTableViews: Map<vscode.WebviewPanel, IDataTableView[]>;
    readonly dataTableWebViews: Map<vscode.WebviewPanel, WebViewAdapter[]>;
    registerResultWebview(webview: vscode.WebviewPanel): void;
    wireChartView(view: IChartView): void;
}

export class ResultsViewer {

    private readonly server: IServer;
    private readonly clipboard: IClipboard;
    private readonly chartProvider: IChartProvider;
    private readonly chartEditorProvider: IChartEditorProvider;
    private readonly dataTableProvider: IDataTableProvider;
    private readonly htmlBuilder: DocumentViewProvider;

    // ─── Per-panel state (exposed to DocumentViewProvider via IViewerPanelState) ─
    /** Map from webview to its viewer state. */
    private readonly viewerStates = new Map<vscode.WebviewPanel, ResultViewerState>();

    /** Map from document-view webview to its backing document URI. */
    private readonly webviewDocuments = new Map<vscode.WebviewPanel, vscode.Uri>();

    /** Set of all result webviews (singleton + results viewer tabs). */
    private readonly resultWebviews = new Set<vscode.WebviewPanel>();

    /** The most recently focused result webview. */
    private activeResultWebview: vscode.WebviewPanel | undefined;

    // ─── Bottom view state ──────────────────────────────────────────────
    private resultsPanel: vscode.WebviewView | undefined;
    private lastPanelResultData: server.ResultData | undefined;
    private panelActiveTabIndex = 0;
    private panelActiveView: string = 'table-0';
    private panelHasChart = false;
    private waitForPanelReady: (() => Promise<void>) | undefined;
    private panelChartView: IChartView | undefined;
    private panelWebView: WebViewAdapter | undefined;
    private panelEditorView: IChartEditorView | undefined;
    private panelEditorWebView: WebViewAdapter | undefined;
    private panelTableViews: IDataTableView[] = [];
    private panelTableWebViews: WebViewAdapter[] = [];

    // ─── Singleton view state ───────────────────────────────────────────
    private singletonView: vscode.WebviewPanel | undefined;
    private singletonResultData: server.ResultData | undefined;
    private singletonChartOptionsOverride: server.ChartOptions | undefined;
    private singletonChartOptionsTimer: ReturnType<typeof setTimeout> | undefined;
    private singletonBackingUri: vscode.Uri | undefined;
    private singletonWriteBackTimer: ReturnType<typeof setTimeout> | undefined;
    private singletonMode: ResultViewMode | undefined;
    private singletonChartView: IChartView | undefined;
    private singletonWebView: WebViewAdapter | undefined;
    private singletonEditorView: IChartEditorView | undefined;
    private singletonEditorWebView: WebViewAdapter | undefined;
    private singletonTableViews: IDataTableView[] = [];
    private singletonTableWebViews: WebViewAdapter[] = [];

    // ─── Per-panel view maps (exposed to DocumentViewProvider via IViewerPanelState) ─
    private readonly chartViews = new Map<vscode.WebviewPanel, IChartView>();
    private readonly chartWebViews = new Map<vscode.WebviewPanel, WebViewAdapter>();
    private readonly editorViews = new Map<vscode.WebviewPanel, IChartEditorView>();
    private readonly editorWebViews = new Map<vscode.WebviewPanel, WebViewAdapter>();
    private readonly dataTableViews = new Map<vscode.WebviewPanel, IDataTableView[]>();
    private readonly dataTableWebViews = new Map<vscode.WebviewPanel, WebViewAdapter[]>();

    /** Creates an adapter that exposes private per-panel state to DocumentViewProvider. */
    private createPanelStateAccessor(): IViewerPanelState {
        return {
            viewerStates: this.viewerStates,
            webviewDocuments: this.webviewDocuments,
            chartViews: this.chartViews,
            chartWebViews: this.chartWebViews,
            editorViews: this.editorViews,
            editorWebViews: this.editorWebViews,
            dataTableViews: this.dataTableViews,
            dataTableWebViews: this.dataTableWebViews,
            registerResultWebview: (webview) => this.registerResultWebview(webview),
            wireChartView: (view) => this.wireChartView(view),
        };
    }

    constructor(context: vscode.ExtensionContext, server: IServer, clipboard: IClipboard, chartProvider: IChartProvider, chartEditorProvider: IChartEditorProvider, dataTableProvider: IDataTableProvider) {
        this.server = server;
        this.clipboard = clipboard;
        this.chartProvider = chartProvider;
        this.chartEditorProvider = chartEditorProvider;
        this.dataTableProvider = dataTableProvider;
        this.htmlBuilder = new DocumentViewProvider(this.createPanelStateAccessor(), chartProvider, chartEditorProvider, dataTableProvider);

        context.subscriptions.push(
            vscode.window.registerCustomEditorProvider(
                resultViewerViewType,
                this.htmlBuilder,
                {
                    supportsMultipleEditorsPerDocument: false,
                    webviewOptions: { retainContextWhenHidden: true }
                }
            )
        );

        // Register the bottom-panel WebviewView provider
        let resolvePanelReady: (() => void) | undefined;
        let panelReadyPromise: Promise<void> | undefined;

        const createPanelReadyPromise = (): Promise<void> => {
            if (!panelReadyPromise) {
                panelReadyPromise = new Promise<void>(resolve => {
                    resolvePanelReady = resolve;
                });
            }
            return panelReadyPromise;
        };

        // Expose a function for showPanelHtml to wait on
        this.waitForPanelReady = async () => {
            await vscode.commands.executeCommand('msKustoExplorer_resultsView.focus');
            await createPanelReadyPromise();
        };

        vscode.window.registerWebviewViewProvider('msKustoExplorer_resultsView', {
            resolveWebviewView: (webviewView) => {
                this.resultsPanel = webviewView;
                if (resolvePanelReady) {
                    resolvePanelReady();
                    resolvePanelReady = undefined;
                    panelReadyPromise = undefined;
                }
                webviewView.webview.options = {
                    enableScripts: true,
                    enableForms: false
                };

                // Create chart view for the bottom panel
                const panelAdapter = new WebViewAdapter(webviewView.webview);
                this.panelChartView = this.chartProvider.createView(panelAdapter);
                this.panelWebView = panelAdapter;
                this.wireChartView(this.panelChartView);
                this.panelChartView.onDidChangeViewState?.((state) => {
                    if (!this.lastPanelResultData) return;
                    const raw = getPrimaryChart(this.lastPanelResultData);
                    storeChartView(this.lastPanelResultData, {
                        ...state,
                        ...(raw?.name ? { name: raw.name } : {}),
                        ...(raw?.tableName ? { tableName: raw.tableName } : {}),
                    });
                });

                // Create chart editor view for the bottom panel
                const panelEditorAdapter = new WebViewAdapter(webviewView.webview, 'setEditPanelContent');
                this.panelEditorView = this.chartEditorProvider.createView(panelEditorAdapter);
                this.panelEditorWebView = panelEditorAdapter;
                this.panelEditorView.onOptionsChanged = (options) => {
                    if (this.lastPanelResultData) {
                        this.lastPanelResultData = withPrimaryChartOptions(this.lastPanelResultData, options);
                    }
                    this.updateChartInPanel();
                };

                webviewView.onDidDispose(() => {
                    this.panelChartView?.dispose();
                    this.panelChartView = undefined;
                    this.panelWebView = undefined;
                    this.panelEditorView?.dispose();
                    this.panelEditorView = undefined;
                    this.panelEditorWebView = undefined;
                    this.panelTableViews.forEach(v => v.dispose());
                    this.panelTableViews = [];
                    this.panelTableWebViews = [];
                    this.resultsPanel = undefined;
                });
                webviewView.webview.onDidReceiveMessage((message) => {
                    if (message.command === 'viewChanged' && typeof message.viewId === 'string') {
                        const match = message.viewId.match(/^table-(\d+)$/);
                        if (match) {
                            this.panelActiveTabIndex = parseInt(match[1]!, 10);
                        }
                        this.panelActiveView = message.viewId;
                        vscode.commands.executeCommand('setContext', 'msKustoExplorer.panelShowingData', message.viewId !== 'query');
                        vscode.commands.executeCommand('setContext', 'msKustoExplorer.panelChartActive', message.viewId === 'chart');
                    }
                });
                webviewView.webview.html = '<html>no results</html>';
            }
        }, {
            webviewOptions: {
                retainContextWhenHidden: true
            }
        });

        // Open the results view on start up when in panel mode
        if (getResultsDisplayLocation() === 'panel') {
            vscode.commands.executeCommand('msKustoExplorer_resultsView.focus');
        }
    }

    // ─── Public API ─────────────────────────────────────────────────────

    /**
     * Returns whether the singleton view currently exists.
     */
    hasSingletonView(): boolean {
        return this.singletonView !== undefined;
    }

    /**
     * Sets the backing file URI for the singleton view.
     * Flushes any pending write-back to the previous URI before switching.
     */
    setSingletonViewBackingUri(uri: vscode.Uri | undefined): void {
        // Flush pending writes to the OLD backing file before switching
        this.flushSingletonWriteBack();
        this.singletonBackingUri = uri;
    }

    /**
     * Registers a result webview for copy command targeting.
     * Tracks focus and removes on dispose.
     */
    registerResultWebview(webview: vscode.WebviewPanel): void {
        this.resultWebviews.add(webview);
        this.activeResultWebview = webview;

        webview.onDidChangeViewState(() => {
            if (webview.active) {
                this.activeResultWebview = webview;
            }
        });

        webview.onDidDispose(() => {
            this.resultWebviews.delete(webview);
            if (this.activeResultWebview === webview) {
                this.activeResultWebview = undefined;
            }
        });
    }

    /**
     * Wires up the copy result/error callbacks on a chart view.
     */
    wireChartView(view: IChartView): void {
        view.onCopyResult = (pngDataUrl, svgDataUrl) => this.onCopyChartMessage(pngDataUrl, svgDataUrl);
        view.onCopyError = (error) => vscode.window.showErrorMessage(`Chart copy failed in webview: ${error}`);
    }

    /**
     * Displays result data in the bottom view.
     */
    async displayResultsInBottomPanel(
        resultData: server.ResultData | undefined,
        mode: ResultViewMode
    ): Promise<void> {
        if (!resultData?.tables?.length) {
            this.clearResultsPanel();
            return;
        }

        this.lastPanelResultData = resultData;
        this.panelActiveTabIndex = 0;
        // Default to showing data (first tab is always a data tab, not query)
        vscode.commands.executeCommand('setContext', 'msKustoExplorer.panelShowingData', true);

        const darkMode = isDarkMode();

        const hasChart = !!((mode === 'chart' || mode === 'all') && getPrimaryChart(resultData));
        this.panelHasChart = hasChart;
        this.panelActiveView = hasChart ? 'chart' : 'table-0';
        vscode.commands.executeCommand('setContext', 'msKustoExplorer.panelHasChart', hasChart);
        vscode.commands.executeCommand('setContext', 'msKustoExplorer.panelChartActive', hasChart);
        const hasTable = !!resultData.tables.length;

        if (!hasTable && !hasChart) {
            await this.showPanelHtml('<html><body>no results</body></html>');
            return;
        }

        const rawChart = getPrimaryChart(resultData);
        const rawChartOptions = rawChart?.options;
        const chartOptions = rawChartOptions ? applyChartDefaults(rawChartOptions) : undefined;
        const chartDefaults = getChartDefaults();
        const chartTable = getPrimaryChartTable(resultData, rawChart);
        const columnNames = chartTable?.columns?.map(c => c.name) ?? [];

        // Ensure the panel is ready before creating table adapters that need panel.webview
        if (!this.resultsPanel) {
            const isSingletonMode = getResultsDisplayLocation() !== 'panel';
            if (isSingletonMode) {
                // In beside/main mode, don't force the panel open
            } else if (this.waitForPanelReady) {
                await this.waitForPanelReady();
            } else {
                await vscode.commands.executeCommand('msKustoExplorer_resultsView.focus');
            }
        }

        // Create table views for each result table (dispose previous ones first)
        this.panelTableViews.forEach(v => v.dispose());
        this.panelTableViews = [];
        this.panelTableWebViews = [];
        if (hasTable && this.resultsPanel) {
            for (let i = 0; i < resultData.tables.length; i++) {
                const adapter = new WebViewAdapter(this.resultsPanel.webview, `setTableContent-${i}`);
                const table = resultData.tables[i]!;
                const view = this.dataTableProvider.createView(adapter, table, findTableView(resultData, table.name));
                this.panelTableViews.push(view);
                this.panelTableWebViews.push(adapter);
                // Mirror webview-side resize/reorder back into the in-memory
                // ResultData so the next save serializes the updated layout.
                view.onDidChangeViewState((state) => {
                    storeTableView(resultData, state);
                });
            }
        }

        // Render chart and editor content into adapters BEFORE building HTML
        // so their contentHtml is embedded inline in the page.
        if (hasChart && chartOptions) {
            const table = chartTable;
            if (table) {
                this.panelChartView?.renderChart(table, chartOptions, darkMode, { tables: resultData.tables }, findChartView(resultData, rawChart));
            }
            this.panelEditorView?.setOptions(rawChartOptions, columnNames, chartDefaults, resultData.tables.map(t => ({ name: t.name, columns: t.columns.map(c => c.name) })), chartTable?.name);
        }

        const html = this.htmlBuilder.BuildMultiTabbedHtml(hasChart, mode, this.panelWebView, this.panelEditorWebView, chartOptions,
            resultData.query, resultData.cluster, resultData.database, resultData.tables, this.panelTableWebViews);

        const totalRows = resultData.tables.reduce((sum, t) => sum + t.rows.length, 0);
        await this.showPanelHtml(injectMessageHandlerScripts(html), totalRows);
    }

    /**
     * Orchestrates display of query results and charts based on user settings.
     * - Results go to the bottom panel or a singleton view depending on msKustoExplorer.results.display.
     * - Charts go inline with results or to a singleton view depending on msKustoExplorer.results.chartDisplay.
     * - When results are in beside/main, charts are shown as a tab in the same singleton.
     */
    async displayResults(resultData: server.ResultData | undefined): Promise<void> {
        const resultsLocation = getResultsDisplayLocation();
        const hasChart = !!getPrimaryChart(resultData);

        if (resultsLocation === 'panel') {
            // Results in bottom panel
            const chartLocation = getChartDisplayLocation();

            if (hasChart && chartLocation === 'results') {
                // Chart shown inline with results in bottom panel
                await this.displayResultsInBottomPanel(resultData, 'all');
                this.disposeSingletonView();
            } else {
                // Data in bottom panel, chart (if any) in singleton
                await this.displayResultsInBottomPanel(resultData, 'data');
                if (hasChart) {
                    await this.displayResultsInSingletonView(resultData, 'chart');
                } else {
                    this.disposeSingletonView();
                }
            }
        } else {
            // Results in singleton view (beside or main) — chart is just another tab
            if (hasChart) {
                await this.displayResultsInSingletonView(resultData, 'all');
            } else {
                await this.displayResultsInSingletonView(resultData, 'data');
            }
        }
    }

    /**
     * Displays a query error in the bottom view and closes any singleton view.
     */
    async displayErrorInBottomView(error: server.QueryDiagnostic): Promise<void> {
        this.disposeSingletonView();

        const htmlMessage = `<html><body><table><tr><td>\u274C</td><td><pre>${escapeHtml(error.message)}</pre></td></tr><tr><td></td><td><pre>${escapeHtml(error.details || '')}</pre></td></tr></table></body></html>`;

        await this.showPanelHtml(htmlMessage, undefined, true);
    }

    /**
     * Displays the result data in the singleton view.
     * The view column (beside or main) is resolved from settings.
     */
    async displayResultsInSingletonView(
        resultData: server.ResultData | undefined,
        mode: ResultViewMode,
        locationOverride?: 'beside' | 'main'
    ): Promise<void> {
        // Always update result data before any early-return dispose paths,
        // so that a write-back in disposeSingletonView won't write stale
        // data from a previous result to the current backing file.
        this.singletonResultData = resultData;
        this.singletonChartOptionsOverride = undefined;

        if (!resultData?.tables?.length) {
            this.disposeSingletonView();
            return;
        }

        if (mode === 'chart' && !getPrimaryChart(resultData)) {
            this.disposeSingletonView();
            return;
        }

        const darkMode = isDarkMode();
        const rawChart = getPrimaryChart(resultData);
        const rawChartOptions = rawChart?.options;
        const chartOptions = rawChartOptions ? applyChartDefaults(rawChartOptions) : undefined;
        const chartDefaults = getChartDefaults();

        // Resolve where the singleton should appear.
        // For chart mode, use chart display setting; otherwise use results display setting.
        // If location resolves to 'panel' or 'results' (bottom panel), default to 'beside'
        // since this method always creates a singleton editor panel.
        let singletonLocation: 'beside' | 'main';
        if (locationOverride) {
            singletonLocation = locationOverride;
        } else {
            const rawLocation = mode === 'chart' ? getChartDisplayLocation() : getResultsDisplayLocation();
            singletonLocation = (rawLocation === 'beside' || rawLocation === 'main') ? rawLocation : 'beside';
        }

        // Ensure the singleton view (and its chart adapter) exist before building
        // HTML so that BuildMultiTabbedHtml can read the adapter's headHtml/scriptsHtml.
        this.ensureSingletonView(singletonLocation, mode);

        // Create table views for each result table (dispose previous ones first)
        this.singletonTableViews.forEach(v => v.dispose());
        this.singletonTableViews = [];
        this.singletonTableWebViews = [];
        if (this.singletonView) {
            for (let i = 0; i < resultData.tables.length; i++) {
                const adapter = new WebViewAdapter(this.singletonView.webview, `setTableContent-${i}`);
                const table = resultData.tables[i]!;
                const view = this.dataTableProvider.createView(adapter, table, findTableView(resultData, table.name));
                this.singletonTableViews.push(view);
                this.singletonTableWebViews.push(adapter);
                view.onDidChangeViewState((state) => {
                    storeTableView(resultData, state);
                    // Singleton views are backed by a .kqr file (history
                    // entry or .kqr document opened-as-singleton). Persist
                    // the layout change back to disk so it survives
                    // switching to another history item and back.
                    this.scheduleSingletonWriteBack();
                });
            }
        }

        const hasChart = !!chartOptions;
        const chartTable = getPrimaryChartTable(resultData, rawChart);
        const columnNames = chartTable?.columns?.map(c => c.name) ?? [];

        // Render chart and editor content into adapters BEFORE building HTML
        // so their contentHtml is embedded inline in the page. Suppress
        // postMessage during this prep — the page is about to be replaced
        // by `webview.html = …`, so any messages would only cause the
        // outgoing page to briefly redraw the new chart (a visible flash)
        // before the new page rebuilds and the `chartViewReady` handshake
        // replays state cleanly on the fresh page.
        const chartAdapter = this.singletonWebView;
        const editorAdapter = this.singletonEditorWebView;
        const priorChartSuppress = chartAdapter?.suppressMessages ?? false;
        const priorEditorSuppress = editorAdapter?.suppressMessages ?? false;
        if (chartAdapter) { chartAdapter.suppressMessages = true; }
        if (editorAdapter) { editorAdapter.suppressMessages = true; }
        try {
            if (hasChart && chartOptions) {
                const table = chartTable;
                if (table) {
                    this.singletonChartView?.renderChart(table, chartOptions, darkMode, { tables: resultData.tables }, findChartView(resultData, rawChart));
                }
                this.singletonEditorView?.setOptions(rawChartOptions, columnNames, chartDefaults, resultData.tables.map(t => ({ name: t.name, columns: t.columns.map(c => c.name) })), chartTable?.name);
            }
        } finally {
            if (chartAdapter) { chartAdapter.suppressMessages = priorChartSuppress; }
            if (editorAdapter) { editorAdapter.suppressMessages = priorEditorSuppress; }
        }

        const html = this.htmlBuilder.BuildMultiTabbedHtml(hasChart, mode, this.singletonWebView, this.singletonEditorWebView, chartOptions,
            resultData.query, resultData.cluster, resultData.database, resultData.tables, this.singletonTableWebViews);

        this.showSingletonView(injectMessageHandlerScripts(html), resultData, resultData.tables.map(t => t.name), singletonLocation, mode);
    }


    // ─── Private methods ────────────────────────────────────────────────

    private onCopyChartMessage(pngDataUrl: string, svgDataUrl?: string): void {
        try {
            const pngBase64 = pngDataUrl.split(',')[1] ?? '';

            const items: ClipboardItem[] = [
                { format: 'PNG', data: pngBase64, encoding: 'base64' }
            ];

            if (svgDataUrl) {
                // SVG data URL is: data:image/svg+xml,<svg>...</svg>
                const svgPart = svgDataUrl.split(',').slice(1).join(',');
                const svgText = decodeURIComponent(svgPart);
                items.push({ format: 'image/svg+xml', data: svgText });
            }

            this.clipboard.copyItems(items).catch(error => {
                vscode.window.showErrorMessage(`Failed to copy chart to clipboard: ${error}`);
            });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to copy chart: ${error}`);
        }
    }

    /**
     * Copies the active chart in the active results viewer to the clipboard.
     * Targets whichever view (singleton, document, or bottom panel) has a chart.
     */
    copyChart(): void {
        const view = this.getActiveChartView();
        if (view) {
            view.copyChart();
        } else if (this.panelHasChart && this.panelActiveView === 'chart') {
            this.panelChartView?.copyChart();
        }
    }

    /**
     * Toggles the chart edit panel in the active tab view or bottom panel.
     */
    toggleChartEditor(): void {
        if (this.activeResultWebview?.active) {
            this.activeResultWebview.webview.postMessage({ command: 'toggleEditPanel' });
        } else if (this.resultsPanel && this.panelHasChart) {
            this.resultsPanel.webview.postMessage({ command: 'toggleEditPanel' });
        }
    }

    /**
     * Toggles the search box visibility in the active results view.
     */
    toggleSearch(): void {
        if (this.activeResultWebview?.active) {
            const state = this.viewerStates.get(this.activeResultWebview);
            if (state) {
                const tableIndex = this.getActiveTableIndex(state);
                const views = this.getTableViewsForWebview(this.activeResultWebview);
                views?.[tableIndex]?.toggleSearch();
            }
        } else {
            this.panelTableViews[this.panelActiveTabIndex]?.toggleSearch();
        }
    }

    private async showPanelHtml(html: string, rowCount?: number, hasError?: boolean): Promise<void> {
        const isSingletonMode = getResultsDisplayLocation() !== 'panel';

        if (!this.resultsPanel) {
            // In beside/main mode, don't force the panel open — just update if it exists
            if (isSingletonMode) {
                return;
            }
            if (this.waitForPanelReady) {
                await this.waitForPanelReady();
            } else {
                await vscode.commands.executeCommand('msKustoExplorer_resultsView.focus');
            }
        }

        if (!this.resultsPanel) {
            return;
        }

        try {
            this.resultsPanel.webview.html = html;

            if (rowCount) {
                this.resultsPanel.badge = { tooltip: `${rowCount} rows`, value: rowCount };
            } else if (hasError) {
                this.resultsPanel.badge = { tooltip: 'Error', value: 1 };
            } else {
                this.resultsPanel.badge = undefined;
            }

            // Only auto-show the panel in panel mode
            if (!isSingletonMode) {
                this.resultsPanel.show(true);
            }
        } catch {
            if (isSingletonMode) {
                return;
            }
            await vscode.commands.executeCommand('msKustoExplorer_resultsView.focus');
            if (this.resultsPanel) {
                try {
                    this.resultsPanel.webview.html = html;
                    if (rowCount) {
                        this.resultsPanel.badge = { tooltip: `${rowCount} rows`, value: rowCount };
                    }
                    this.resultsPanel.show(true);
                } catch (retryError) {
                    vscode.window.showErrorMessage(`Failed to display results: ${retryError}`);
                }
            }
        }
    }

    private clearResultsPanel(): void {
        if (this.resultsPanel) {
            this.resultsPanel.webview.html = '<html>no results</html>';
            this.resultsPanel.badge = undefined;
        }
        this.lastPanelResultData = undefined;
        this.panelHasChart = false;
        this.panelActiveView = 'table-0';
        vscode.commands.executeCommand('setContext', 'msKustoExplorer.panelHasChart', false);
        vscode.commands.executeCommand('setContext', 'msKustoExplorer.panelChartActive', false);
    }

    /** Ensures the singleton webview panel exists, creating it (with chart adapter) if needed. */
    private ensureSingletonView(location: 'beside' | 'main', mode: ResultViewMode): void {
        if (this.singletonView) { return; }

        const viewColumn = getSingletonViewColumn(location);
        const title = singletonTitleForMode(mode);
        this.singletonMode = mode;

        this.singletonView = vscode.window.createWebviewPanel(
            'msKustoExplorer_singletonView',
            title,
            { viewColumn, preserveFocus: true },
            { enableScripts: true, retainContextWhenHidden: true }
        );

        vscode.commands.executeCommand('msKustoExplorer.singletonViewStateChanged');
        this.registerResultWebview(this.singletonView);

        // Create chart view for the singleton view
        const singletonAdapter = new WebViewAdapter(this.singletonView.webview);
        this.singletonChartView = this.chartProvider.createView(singletonAdapter);
        this.singletonWebView = singletonAdapter;
        this.wireChartView(this.singletonChartView);
        this.singletonChartView.onDidChangeViewState?.((state) => {
            if (!this.singletonResultData) return;
            const raw = getPrimaryChart(this.singletonResultData);
            storeChartView(this.singletonResultData, {
                ...state,
                ...(raw?.name ? { name: raw.name } : {}),
                ...(raw?.tableName ? { tableName: raw.tableName } : {}),
            });
            this.scheduleSingletonWriteBack();
        });

        // Create chart editor view for the singleton view
        const singletonEditorAdapter = new WebViewAdapter(this.singletonView.webview, 'setEditPanelContent');
        this.singletonEditorView = this.chartEditorProvider.createView(singletonEditorAdapter);
        this.singletonEditorWebView = singletonEditorAdapter;
        this.singletonEditorView.onOptionsChanged = (options) => {
            this.singletonChartOptionsOverride = options;
            if (this.singletonResultData) {
                this.singletonResultData = withPrimaryChartOptions(this.singletonResultData, this.singletonChartOptionsOverride);
            }
            const state = this.viewerStates.get(this.singletonView!);
            if (state) {
                state.chartOptionsOverride = this.singletonChartOptionsOverride;
                state.resultData = this.singletonResultData ?? state.resultData;
            }
            if (this.singletonChartOptionsTimer) { clearTimeout(this.singletonChartOptionsTimer); }
            this.singletonChartOptionsTimer = setTimeout(() => this.updateChartInSingletonView(), 600);
            this.scheduleSingletonWriteBack();
        };

        this.singletonView.onDidChangeViewState(() => {
            if (this.singletonView?.active) {
                const state = this.viewerStates.get(this.singletonView);
                const hasChart = !!getPrimaryChart(state?.resultData);
                vscode.commands.executeCommand('setContext', 'msKustoExplorer.resultViewerHasChart', hasChart);
                vscode.commands.executeCommand('setContext', 'msKustoExplorer.resultViewerChartActive', state?.activeView === 'chart');
                vscode.commands.executeCommand('setContext', 'msKustoExplorer.resultViewerShowingData', state?.activeView !== 'query');
            }
        });

        this.singletonView.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'viewChanged' && typeof message.viewId === 'string') {
                const state = this.viewerStates.get(this.singletonView!);
                if (state) { state.activeView = message.viewId; }
                vscode.commands.executeCommand('setContext', 'msKustoExplorer.resultViewerChartActive', message.viewId === 'chart');
                vscode.commands.executeCommand('setContext', 'msKustoExplorer.resultViewerShowingData', message.viewId !== 'query');
                return;
            }
            if (message.command === 'editPanelToggled' && typeof message.visible === 'boolean') {
                if (message.visible) {
                    this.singletonView?.reveal(vscode.ViewColumn.One, false);
                } else {
                    const chartLoc = getChartDisplayLocation();
                    this.singletonView?.reveal(getSingletonViewColumn(chartLoc === 'results' ? 'beside' : chartLoc), false);
                }
                return;
            }
        });

        this.singletonView.onDidDispose(() => {
            if (this.singletonChartOptionsTimer) { clearTimeout(this.singletonChartOptionsTimer); }
            this.flushSingletonWriteBack();
            this.singletonChartView?.dispose();
            this.singletonChartView = undefined;
            this.singletonWebView = undefined;
            this.singletonEditorView?.dispose();
            this.singletonEditorView = undefined;
            this.singletonEditorWebView = undefined;
            this.singletonTableViews.forEach(v => v.dispose());
            this.singletonTableViews = [];
            this.singletonTableWebViews = [];
            this.viewerStates.delete(this.singletonView!);
            this.singletonView = undefined;
            this.singletonResultData = undefined;
            this.singletonChartOptionsOverride = undefined;
            this.singletonBackingUri = undefined;
            vscode.commands.executeCommand('setContext', 'msKustoExplorer.resultViewerHasChart', false);
            vscode.commands.executeCommand('setContext', 'msKustoExplorer.resultViewerChartActive', false);
            vscode.commands.executeCommand('setContext', 'msKustoExplorer.resultViewerShowingData', false);
            vscode.commands.executeCommand('msKustoExplorer.singletonViewStateChanged');
        });
    }

    private showSingletonView(html: string, resultData: server.ResultData, tableNames: string[], location: 'beside' | 'main', mode: ResultViewMode): void {
        const viewColumn = getSingletonViewColumn(location);
        const title = singletonTitleForMode(mode);
        this.singletonMode = mode;

        this.ensureSingletonView(location, mode);

        // Track state for copy commands
        const hasChart = !!getPrimaryChart(resultData);
        this.viewerStates.set(this.singletonView!, {
            resultData,
            tableNames,
            activeView: hasChart ? 'chart' : 'table-0'
        });

        vscode.commands.executeCommand('setContext', 'msKustoExplorer.resultViewerHasChart', hasChart);
        vscode.commands.executeCommand('setContext', 'msKustoExplorer.resultViewerChartActive', hasChart);
        vscode.commands.executeCommand('setContext', 'msKustoExplorer.resultViewerShowingData', !hasChart);

        this.singletonView!.title = title;
        this.singletonView!.webview.html = html;
        // In beside mode, keep focus on the query editor; in main mode, activate the panel
        // so that activeWebviewPanelId is set and toolbar commands become available.
        this.singletonView!.reveal(viewColumn, /*preserveFocus*/ location === 'beside');
    }

    private async updateChartInSingletonView(): Promise<void> {
        if (!this.singletonView || !this.singletonResultData) { return; }
        const rawChart = getPrimaryChart(this.singletonResultData);
        const rawChartOptions = getPrimaryChartOptions(this.singletonResultData, this.singletonChartOptionsOverride);
        if (!rawChartOptions) { return; }
        const chartOptions = applyChartDefaults(rawChartOptions);

        const state = this.viewerStates.get(this.singletonView);
        if (state && this.singletonChartOptionsOverride) { state.chartOptionsOverride = this.singletonChartOptionsOverride; }

        // Persist the override into the backing data so that if the webview is
        // reconstructed (e.g. on column change), it uses the latest options.
        this.singletonResultData = withPrimaryChartOptions(this.singletonResultData, chartOptions);
        if (state) { state.resultData = this.singletonResultData; }

        const modifiedData = this.singletonResultData;
        const darkMode = isDarkMode();
        const table = getPrimaryChartTable(modifiedData, rawChart);
        if (table && chartOptions) {
            this.singletonChartView?.renderChart(table, chartOptions, darkMode, { tables: modifiedData.tables }, findChartView(modifiedData, rawChart));
        }
    }

    private updateChartInPanel(): void {
        if (!this.lastPanelResultData) { return; }
        const rawChart = getPrimaryChart(this.lastPanelResultData);
        const chartOptions = rawChart?.options ? applyChartDefaults(rawChart.options) : undefined;
        if (!chartOptions) { return; }
        const table = getPrimaryChartTable(this.lastPanelResultData, rawChart);
        if (table) {
            this.panelChartView?.renderChart(table, chartOptions, isDarkMode(), { tables: this.lastPanelResultData.tables }, findChartView(this.lastPanelResultData, rawChart));
        }
    }

    private scheduleSingletonWriteBack(): void {
        if (!this.singletonBackingUri || !this.singletonResultData) { return; }
        if (this.singletonWriteBackTimer) { clearTimeout(this.singletonWriteBackTimer); }
        this.singletonWriteBackTimer = setTimeout(() => {
            this.singletonWriteBackTimer = undefined;
            if (this.singletonBackingUri && this.singletonResultData) {
                const content = JSON.stringify(this.singletonResultData, null, 2);
                vscode.workspace.fs.writeFile(this.singletonBackingUri, Buffer.from(content, 'utf-8'))
                    .then(undefined, error => console.error('Failed to write back result data:', error));
            }
        }, 1000);
    }

    private flushSingletonWriteBack(): void {
        if (this.singletonWriteBackTimer) {
            clearTimeout(this.singletonWriteBackTimer);
            this.singletonWriteBackTimer = undefined;
        }
        if (this.singletonBackingUri && this.singletonResultData) {
            const content = JSON.stringify(this.singletonResultData, null, 2);
            vscode.workspace.fs.writeFile(this.singletonBackingUri, Buffer.from(content, 'utf-8'))
                .then(undefined, error => console.error('Failed to write back result data:', error));
        }
    }

    /**
     * Removes the active chart from the active tab view.
     */
    async removeChart(): Promise<void> {
        if (!this.activeResultWebview?.active) { return; }

        if (this.activeResultWebview === this.singletonView) {
            // Singleton view: remove chart from the in-memory data
            if (!this.singletonResultData) { return; }
            const updated = withPrimaryChartOptions(this.singletonResultData, undefined);
            this.singletonResultData = updated;
            this.singletonChartOptionsOverride = undefined;

            // Write the update to the backing file
            this.scheduleSingletonWriteBack();

            if (this.singletonMode === 'chart') {
                // Was showing chart-only — close the singleton
                this.disposeSingletonView();
            } else {
                // Re-render without the chart
                const tableNames = updated.tables.map(t => t.name);
                const html = this.htmlBuilder.BuildMultiTabbedHtml(false, this.singletonMode ?? 'all', this.singletonWebView, this.singletonEditorWebView, undefined,
                    updated.query, updated.cluster, updated.database, updated.tables, this.singletonTableWebViews);
                this.singletonView!.webview.html = injectMessageHandlerScripts(html);

                this.viewerStates.set(this.singletonView!, {
                    resultData: updated,
                    tableNames,
                    activeView: 'table-0'
                });
                vscode.commands.executeCommand('setContext', 'msKustoExplorer.resultViewerHasChart', false);
                vscode.commands.executeCommand('setContext', 'msKustoExplorer.resultViewerChartActive', false);
                vscode.commands.executeCommand('setContext', 'msKustoExplorer.resultViewerShowingData', true);
            }
        } else {
            // Document view: remove chart from the data and update the document
            const state = this.viewerStates.get(this.activeResultWebview);
            if (!state) { return; }
            const updated = withPrimaryChartOptions(state.resultData, undefined);
            state.resultData = updated;
            delete state.chartOptionsOverride;

            // Find the backing document and update it
            for (const doc of vscode.workspace.textDocuments) {
                try {
                    const parsed = JSON.parse(doc.getText()) as server.ResultData;
                    if (parsed && this.viewerStates.get(this.activeResultWebview)?.resultData === updated) {
                        const content = JSON.stringify(updated, null, 2);
                        const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
                        const edit = new vscode.WorkspaceEdit();
                        edit.replace(doc.uri, fullRange, content);
                        await vscode.workspace.applyEdit(edit);
                        await doc.save();
                        break;
                    }
                } catch { /* not a result document */ }
            }
        }
    }

    private disposeSingletonView(): void {
        if (this.singletonView) {
            // Flush any pending write-back before disposing
            this.flushSingletonWriteBack();
            try { this.singletonView.dispose(); } catch { /* ignore */ }
            this.singletonView = undefined;
            this.singletonResultData = undefined;
            this.singletonChartOptionsOverride = undefined;
            this.singletonBackingUri = undefined;
            this.singletonMode = undefined;
            vscode.commands.executeCommand('msKustoExplorer.singletonViewStateChanged');
        }
    }

    private getActiveViewerState(): ResultViewerState | undefined {
        if (!this.activeResultWebview?.active) {
            return undefined;
        }
        return this.viewerStates.get(this.activeResultWebview);
    }

    private getActiveChartView(): IChartView | undefined {
        if (!this.activeResultWebview?.active) {
            return undefined;
        }
        if (this.activeResultWebview === this.singletonView) {
            return this.singletonChartView;
        }
        return this.chartViews.get(this.activeResultWebview);
    }

    private getActiveTableIndex(state: ResultViewerState): number {
        const match = state.activeView.match(/^table-(\d+)$/);
        return match ? parseInt(match[1]!, 10) : 0;
    }

    private getTableViewsForWebview(panel: vscode.WebviewPanel): IDataTableView[] | undefined {
        if (panel === this.singletonView) return this.singletonTableViews;
        return this.dataTableViews.get(panel);
    }


    /**
     * Default \"Copy\" / Ctrl+C: TSV plain text + CF_HTML rich text.
     */
    async copyData(): Promise<void> {
        const view = this.getActiveDataTableView();
        await view?.copyTableAsText();
    }

    /**
     * Copies the active table (or selection) as a KQL `datatable()` expression.
     */
    async copyTableAsDatatable(): Promise<void> {
        const view = this.getActiveDataTableView();
        await view?.copyTableAsDatatable();
    }

    /**
     * Copies the active table (or selection) as markdown source.
     */
    async copyDataAsMarkdown(): Promise<void> {
        const view = this.getActiveDataTableView();
        await view?.copyTableAsMarkdown();
    }

    /**
     * Copies the active table (or selection) as HTML source + CF_HTML.
     */
    async copyDataAsHtml(): Promise<void> {
        const view = this.getActiveDataTableView();
        await view?.copyTableAsHtml();
    }

    /** Resolves the data table view currently driving the user's view. */
    private getActiveDataTableView(): IDataTableView | undefined {
        const state = this.getActiveViewerState();
        if (state && this.activeResultWebview) {
            const tableIndex = this.getActiveTableIndex(state);
            const views = this.getTableViewsForWebview(this.activeResultWebview);
            return views?.[tableIndex];
        }
        return this.panelTableViews[this.panelActiveTabIndex];
    }

    /**
     * Saves the current result data to a .kqr file and opens it in a document view.
     */
    async saveCurrentResults(): Promise<void> {
        const isSingleton = this.activeResultWebview === this.singletonView && this.singletonView?.active;

        const rawData = isSingleton ? this.singletonResultData : this.lastPanelResultData;
        if (!rawData) {
            vscode.window.showWarningMessage('No result data available to save.');
            return;
        }

        const data = this.singletonChartOptionsOverride && isSingleton
            ? withPrimaryChartOptions(rawData, this.singletonChartOptionsOverride)
            : rawData;

        const viewColumn = isSingleton
            ? this.singletonView?.viewColumn ?? vscode.ViewColumn.One
            : vscode.ViewColumn.One;

        const result = await saveResults({ data });
        if (result) {
            // Open saved file as a document view, but keep the singleton alive
            // (history entry remains; singleton will be reused on next query or history click)
            await vscode.commands.executeCommand('vscode.openWith', result.uri, 'msKustoExplorer_resultViewer', viewColumn);
        }
    }

    /**
     * Opens a chart from the bottom view results in the singleton view.
     */
    async openChartFromBottomView(): Promise<void> {
        if (!this.lastPanelResultData) {
            vscode.window.showWarningMessage('No result data available to chart.');
            return;
        }
        const hadChartOptions = !!getPrimaryChart(this.lastPanelResultData);
        const chartData = withPrimaryChartOptions(this.lastPanelResultData, getPrimaryChart(this.lastPanelResultData)?.options ?? { type: 'Column' });
        await this.displayResultsInSingletonView(chartData, 'chart');

        // When there was no render operator specifying a chart type, automatically
        // open the chart editor so the user can pick the visualization they want.
        if (!hadChartOptions && this.singletonView) {
            this.singletonView.webview.postMessage({ command: 'setEditPanelVisible', visible: true });
        }
    }

    /**
     * Moves the results tab between main and beside editor columns.
     */
    async moveResultsTabToMain(): Promise<void> {
        const webview = this.activeResultWebview;
        if (!webview) { return; }
        const isMain = webview.viewColumn === vscode.ViewColumn.One;
        if (webview === this.singletonView) {
            // Dispose and recreate at the target column to avoid broken webview state.
            const resultData = this.singletonResultData;
            const mode = this.singletonMode ?? 'all';
            const chartOptionsOverride = this.singletonChartOptionsOverride;
            const backingUri = this.singletonBackingUri;
            this.disposeSingletonView();
            // Restore state that disposeSingletonView clears
            this.singletonResultData = resultData;
            this.singletonChartOptionsOverride = chartOptionsOverride;
            this.singletonBackingUri = backingUri;
            if (resultData) {
                // Apply override so the recreated view uses the latest editor options
                if (chartOptionsOverride) {
                    this.singletonResultData = withPrimaryChartOptions(resultData, chartOptionsOverride);
                }
                const targetLocation: 'beside' | 'main' = isMain ? 'beside' : 'main';
                await this.displayResultsInSingletonView(this.singletonResultData, mode as ResultViewMode, targetLocation);
                // Always focus the recreated panel since the user explicitly toggled
                this.singletonView?.reveal(undefined, false);
            }
        } else {
            // Custom editors must be moved via workbench commands; reveal() creates duplicates.
            await vscode.commands.executeCommand(
                isMain ? 'workbench.action.moveEditorToNextGroup' : 'workbench.action.moveEditorToFirstGroup'
            );
        }
    }

    /**
     * Re-runs the query stored in the active document-view result and updates the document in-place.
     * Does not add history or display results in the bottom panel or singleton view.
     */
    async rerunQuery(): Promise<void> {
        const webview = this.activeResultWebview;
        if (!webview) { return; }

        const documentUri = this.webviewDocuments.get(webview);
        if (!documentUri) { return; }

        const state = this.viewerStates.get(webview);
        if (!state?.resultData?.query) {
            vscode.window.showWarningMessage('No query found in result data.');
            return;
        }

        const { query, cluster, database } = state.resultData;
        const chartOptions = getPrimaryChartOptions(state.resultData);

        try {
            const runResult = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Rerunning query...' },
                () => this.server.runQuery(query, cluster, database, true)
            );

            if (runResult?.error) {
                vscode.window.showErrorMessage(runResult.error.message);
                return;
            }

            if (!runResult?.data) { return; }

            // Preserve existing chart options; fall back to server-returned options
            const effectiveChartOptions = chartOptions ?? getPrimaryChartOptions(runResult.data);
            const updatedData = effectiveChartOptions
                ? withPrimaryChartOptions(runResult.data, effectiveChartOptions)
                : runResult.data;

            // Update the backing document (the change listener will re-render the webview)
            const document = vscode.workspace.textDocuments.find(
                doc => doc.uri.toString() === documentUri.toString()
            );
            if (!document) { return; }

            const content = JSON.stringify(updatedData, null, 2);
            const fullRange = new vscode.Range(
                document.positionAt(0),
                document.positionAt(document.getText().length)
            );
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, fullRange, content);
            await vscode.workspace.applyEdit(edit);
            await document.save();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to rerun query: ${error}`);
        }
    }
}

// =============================================================================
// Module-level helpers
// =============================================================================

function getResultsDisplayLocation(): 'panel' | 'beside' | 'main' {
    const value = vscode.workspace.getConfiguration('msKustoExplorer.results').get<string>('display', 'panel');
    if (value === 'beside') return 'beside';
    if (value === 'main') return 'main';
    return 'panel';
}

/**
 * Returns the effective chart display location.
 * When results are in beside/main, chart is always in the same singleton (returns the results location).
 * When results are in the bottom panel, uses the msKustoExplorer.results.chartDisplay setting.
 */
function getChartDisplayLocation(): 'beside' | 'main' | 'results' {
    const resultsLocation = getResultsDisplayLocation();
    if (resultsLocation !== 'panel') return resultsLocation;
    const value = vscode.workspace.getConfiguration('msKustoExplorer.results').get<string>('chartDisplay', 'beside');
    if (value === 'main') return 'main';
    if (value === 'results') return 'results';
    return 'beside';
}

function getSingletonViewColumn(location: 'beside' | 'main'): vscode.ViewColumn {
    return location === 'main' ? vscode.ViewColumn.One : vscode.ViewColumn.Beside;
}

function singletonTitleForMode(mode: ResultViewMode): string {
    switch (mode) {
        case 'chart': return 'Chart';
        case 'data': return 'Data';
        case 'detail': return 'Results';
        case 'all': return 'Results';
    }
}

// =============================================================================
// DocumentViewProvider — document view provider for .kqr files
// =============================================================================

/**
 * Document view provider for .kqr files.
 * The file contains ResultData JSON (tables + chart options + query).
 * Can show chart, data tables and query in different tabs.
 */
class DocumentViewProvider implements vscode.CustomTextEditorProvider {
    /**
     * Per-panel ref-count of in-flight self-applied edits to the backing
     * document. The `onDidChangeTextDocument` listener consults this map
     * to skip re-rendering on self-triggered edits (chart options, column
     * resize/reorder) which would otherwise dispose+recreate all data
     * table views and lose in-flight UI state.
     *
     * A count (rather than a boolean) is required because multiple
     * persists can overlap — e.g., a quick succession of resize/reorder
     * actions, or a chart-options change whose deferred `document.save()`
     * lands while a later persist is still pending. With a boolean, the
     * first completion would clear the flag while a later edit was still
     * in flight, allowing the text-change listener to fire mid-write.
     */
    private readonly selfEditDepth = new Map<vscode.WebviewPanel, number>();

    /**
     * Per-panel serialization tail for self-applied edits. Each
     * `runSelfEdit` call chains onto this promise, guaranteeing that
     * `applyEdit`/`save` calls for a panel never overlap on the document.
     */
    private readonly selfEditQueue = new Map<vscode.WebviewPanel, Promise<void>>();

    /**
     * Returns true while at least one self-applied edit is in flight
     * for the given panel — callers in the `onDidChangeTextDocument`
     * listener use this to suppress re-render on our own edits.
     */
    private isSelfEditInFlight(panel: vscode.WebviewPanel): boolean {
        return (this.selfEditDepth.get(panel) ?? 0) > 0;
    }

    /**
     * Run `work` as a self-applied edit on `panel`'s backing document.
     * Increments the ref-count for the duration of `work` and serializes
     * `work` after any previously-queued self-edit for the same panel
     * so overlapping edits can't interleave on the document.
     */
    private runSelfEdit(panel: vscode.WebviewPanel, work: () => Promise<void>): Promise<void> {
        const prev = this.selfEditQueue.get(panel) ?? Promise.resolve();
        // Pre-increment the depth synchronously so the change listener
        // immediately sees a self-edit in flight, even before this task
        // reaches the head of the queue and starts mutating the document.
        this.selfEditDepth.set(panel, (this.selfEditDepth.get(panel) ?? 0) + 1);
        const next = prev.then(work, work).finally(() => {
            const remaining = (this.selfEditDepth.get(panel) ?? 1) - 1;
            if (remaining <= 0) {
                this.selfEditDepth.delete(panel);
            } else {
                this.selfEditDepth.set(panel, remaining);
            }
            // Only clear the queue tail when this task was the last one
            // queued, so subsequent chains don't get stranded.
            if (this.selfEditQueue.get(panel) === next) {
                this.selfEditQueue.delete(panel);
            }
        });
        this.selfEditQueue.set(panel, next);
        return next;
    }

    constructor(private readonly viewer: IViewerPanelState, private readonly chartProvider: IChartProvider, private readonly chartEditorProvider: IChartEditorProvider, private readonly dataTableProvider: IDataTableProvider) {
    }

    async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true
        };

        // Track this results viewer webview for copy commands
        this.viewer.registerResultWebview(webviewPanel);

        // Track document association for rerun support
        this.viewer.webviewDocuments.set(webviewPanel, document.uri);

        // Create chart view for this document view
        const docAdapter = new WebViewAdapter(webviewPanel.webview);
        const docChartView = this.chartProvider.createView(docAdapter);
        this.viewer.wireChartView(docChartView);
        this.viewer.chartViews.set(webviewPanel, docChartView);
        this.viewer.chartWebViews.set(webviewPanel, docAdapter);
        docChartView.onDidChangeViewState?.((state) => {
            const docState = this.viewer.viewerStates.get(webviewPanel);
            if (!docState?.resultData) return;
            const raw = getPrimaryChart(docState.resultData);
            storeChartView(docState.resultData, {
                ...state,
                ...(raw?.name ? { name: raw.name } : {}),
                ...(raw?.tableName ? { tableName: raw.tableName } : {}),
            });
            // Document-backed views write through their text document on save;
            // mutating in place is sufficient for the next save to capture it.
        });

        // Create chart editor view for this document view
        const docEditorAdapter = new WebViewAdapter(webviewPanel.webview, 'setEditPanelContent');
        const docEditorView = this.chartEditorProvider.createView(docEditorAdapter);
        this.viewer.editorViews.set(webviewPanel, docEditorView);
        this.viewer.editorWebViews.set(webviewPanel, docEditorAdapter);

        // Update context key when this panel gains/loses focus
        const updateChartContext = () => {
            if (webviewPanel.active) {
                const state = this.viewer.viewerStates.get(webviewPanel);
                const hasChart = !!getPrimaryChart(state?.resultData);
                vscode.commands.executeCommand('setContext', 'msKustoExplorer.resultViewerHasChart', hasChart);
                vscode.commands.executeCommand('setContext', 'msKustoExplorer.resultViewerChartActive', state?.activeView === 'chart');
                vscode.commands.executeCommand('setContext', 'msKustoExplorer.resultViewerShowingData', state?.activeView !== 'query');
                vscode.commands.executeCommand('setContext', 'msKustoExplorer.resultViewerHasQuery', !!state?.resultData?.query);
            }
        };
        webviewPanel.onDidChangeViewState(() => updateChartContext());

        // Debounce timer for chart options updates
        let chartOptionsTimer: ReturnType<typeof setTimeout> | undefined;

        // Wire chart editor options callback
        docEditorView.onOptionsChanged = async (options) => {
            const state = this.viewer.viewerStates.get(webviewPanel);
            if (!state) { return; }
            state.chartOptionsOverride = options;
            state.resultData = withPrimaryChartOptions(state.resultData, state.chartOptionsOverride);
            const content = JSON.stringify(state.resultData, null, 2);
            const fullRange = new vscode.Range(
                document.positionAt(0),
                document.positionAt(document.getText().length)
            );
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, fullRange, content);
            await this.runSelfEdit(webviewPanel, async () => {
                await vscode.workspace.applyEdit(edit);
            });
            if (chartOptionsTimer) { clearTimeout(chartOptionsTimer); }
            chartOptionsTimer = setTimeout(async () => {
                await this.updateChartOnly(state, webviewPanel);
                await this.runSelfEdit(webviewPanel, async () => {
                    await document.save();
                });
            }, 600);
        };

        // Track whether the editor was in beside mode before the edit panel was opened,
        // so we only move it back when closing the edit panel if it was beside originally.
        let wasInBesideBeforeEditPanel = false;

        // Listen for messages from the webview
        webviewPanel.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'viewChanged' && typeof message.viewId === 'string') {
                const state = this.viewer.viewerStates.get(webviewPanel);
                if (state) {
                    state.activeView = message.viewId;
                }
                vscode.commands.executeCommand('setContext', 'msKustoExplorer.resultViewerChartActive', message.viewId === 'chart');
                vscode.commands.executeCommand('setContext', 'msKustoExplorer.resultViewerShowingData', message.viewId !== 'query');
                return;
            }
            if (message.command === 'editPanelToggled' && typeof message.visible === 'boolean') {
                if (message.visible) {
                    // Opening edit panel: remember if we were in beside mode, then move to main.
                    wasInBesideBeforeEditPanel = webviewPanel.viewColumn !== vscode.ViewColumn.One;
                    if (wasInBesideBeforeEditPanel) {
                        await vscode.commands.executeCommand('workbench.action.moveEditorToFirstGroup');
                    }
                    webviewPanel.webview.postMessage({ command: 'setEditPanelVisible', visible: true });
                } else {
                    // Closing edit panel: only move back to beside if it was beside before.
                    if (wasInBesideBeforeEditPanel) {
                        await vscode.commands.executeCommand('workbench.action.moveEditorToNextGroup');
                        webviewPanel.webview.postMessage({ command: 'setEditPanelVisible', visible: false });
                    }
                    wasInBesideBeforeEditPanel = false;
                }
                return;
            }
        });

        // Render from the document content
        await this.updateWebview(document, webviewPanel);

        // Re-render when the document content changes (e.g. external edit)
        const changeSubscription = vscode.workspace.onDidChangeTextDocument(async e => {
            if (e.document.uri.toString() === document.uri.toString()) {
                if (this.isSelfEditInFlight(webviewPanel)) {
                    return;
                }
                await this.updateWebview(document, webviewPanel);
            }
        });

        // Re-render when the color theme changes
        const themeSubscription = vscode.window.onDidChangeActiveColorTheme(async () => {
            await this.updateWebview(document, webviewPanel);
        });

        webviewPanel.onDidDispose(() => {
            if (chartOptionsTimer) { clearTimeout(chartOptionsTimer); }
            docChartView.dispose();
            docEditorView.dispose();
            const tableViews = this.viewer.dataTableViews.get(webviewPanel);
            tableViews?.forEach(v => v.dispose());
            this.viewer.chartViews.delete(webviewPanel);
            this.viewer.chartWebViews.delete(webviewPanel);
            this.viewer.editorViews.delete(webviewPanel);
            this.viewer.editorWebViews.delete(webviewPanel);
            this.viewer.dataTableViews.delete(webviewPanel);
            this.viewer.dataTableWebViews.delete(webviewPanel);
            this.viewer.viewerStates.delete(webviewPanel);
            this.viewer.webviewDocuments.delete(webviewPanel);
            this.selfEditDepth.delete(webviewPanel);
            this.selfEditQueue.delete(webviewPanel);
            vscode.commands.executeCommand('setContext', 'msKustoExplorer.resultViewerHasChart', false);
            vscode.commands.executeCommand('setContext', 'msKustoExplorer.resultViewerChartActive', false);
            vscode.commands.executeCommand('setContext', 'msKustoExplorer.resultViewerShowingData', false);
            vscode.commands.executeCommand('setContext', 'msKustoExplorer.resultViewerHasQuery', false);
            changeSubscription.dispose();
            themeSubscription.dispose();
        });
    }

    private async updateWebview(document: vscode.TextDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
        const text = document.getText();

        let resultData: server.ResultData | undefined;
        try {
            resultData = JSON.parse(text) as server.ResultData;
        } catch {
            webviewPanel.webview.html = '<html><body><p>Invalid result file.</p></body></html>';
            return;
        }

        if (!resultData?.tables?.length) {
            webviewPanel.webview.html = '<html><body><p>No result data found.</p></body></html>';
            return;
        }

        const darkMode = isDarkMode();

        const hasChart = !!getPrimaryChart(resultData);
        const hasTable = !!resultData.tables.length;

        if (!hasTable && !hasChart) {
            webviewPanel.webview.html = '<html><body><p>Failed to render results.</p></body></html>';
            return;
        }

        // Track viewer state for copy commands
        const tableNames = resultData.tables.map(t => t.name);
        const firstActiveView = hasChart ? 'chart' : 'table-0';
        const existingState = this.viewer.viewerStates.get(webviewPanel);
        this.viewer.viewerStates.set(webviewPanel, {
            resultData,
            tableNames,
            activeView: firstActiveView,
            ...(existingState?.chartOptionsOverride && { chartOptionsOverride: existingState.chartOptionsOverride })
        });

        // Update context keys after state is set (HTML rebuild always resets to firstActiveView)
        if (webviewPanel.active) {
            vscode.commands.executeCommand('setContext', 'msKustoExplorer.resultViewerHasChart', hasChart);
            vscode.commands.executeCommand('setContext', 'msKustoExplorer.resultViewerChartActive', firstActiveView === 'chart');
            // showingData is unconditionally true here because firstActiveView is only ever
            // 'chart' or 'table-0' — the rebuild discards any prior 'query' tab selection.
            // If updateWebview is ever changed to preserve the user's active tab across
            // re-renders, this should become `existingState?.activeView !== 'query'`.
            vscode.commands.executeCommand('setContext', 'msKustoExplorer.resultViewerShowingData', true);
            vscode.commands.executeCommand('setContext', 'msKustoExplorer.resultViewerHasQuery', !!resultData?.query);
        }

        const rawChart = getPrimaryChart(resultData);
        const rawChartOptions = getPrimaryChartOptions(resultData, existingState?.chartOptionsOverride);
        const chartOptions = rawChartOptions ? applyChartDefaults(rawChartOptions) : undefined;
        const chartDefaults = getChartDefaults();
        const chartTable = getPrimaryChartTable(resultData, rawChart);
        const columnNames = chartTable?.columns?.map(c => c.name) ?? [];
        const docWebView = this.viewer.chartWebViews.get(webviewPanel);
        const docEditorWebView = this.viewer.editorWebViews.get(webviewPanel);

        // Create table views for each result table (dispose previous ones first)
        const prevTableViews = this.viewer.dataTableViews.get(webviewPanel);
        prevTableViews?.forEach(v => v.dispose());
        const docTableViews: IDataTableView[] = [];
        const docTableWebViews: WebViewAdapter[] = [];
        for (let i = 0; i < resultData.tables.length; i++) {
            const adapter = new WebViewAdapter(webviewPanel.webview, `setTableContent-${i}`);
            const table = resultData.tables[i]!;
            const view = this.dataTableProvider.createView(adapter, table, findTableView(resultData, table.name));
            docTableViews.push(view);
            docTableWebViews.push(adapter);
            view.onDidChangeViewState((state) => {
                storeTableView(resultData, state);
                // Persist to the backing document immediately. .kqr docs
                // have no Ctrl+S affordance from the webview side, so we
                // auto-save (same model the chart editor uses for options).
                void this.runSelfEdit(webviewPanel, () =>
                    persistResultDataToDocument(document, resultData));
            });
        }
        this.viewer.dataTableViews.set(webviewPanel, docTableViews);
        this.viewer.dataTableWebViews.set(webviewPanel, docTableWebViews);

        // Render chart and editor content into adapters BEFORE building HTML
        // so their contentHtml is embedded inline in the page.
        if (hasChart && chartOptions) {
            const table = chartTable;
            if (table) {
                const controller = this.viewer.chartViews.get(webviewPanel);
                controller?.renderChart(table, chartOptions, darkMode, { tables: resultData.tables }, findChartView(resultData, rawChart));
            }
            const editorView = this.viewer.editorViews.get(webviewPanel);
            editorView?.setOptions(rawChartOptions, columnNames, chartDefaults, resultData.tables.map(t => ({ name: t.name, columns: t.columns.map(c => c.name) })), chartTable?.name);
        }

        const html = this.BuildMultiTabbedHtml(hasChart, 'all', docWebView, docEditorWebView, chartOptions,
            resultData.query, resultData.cluster, resultData.database, resultData.tables, docTableWebViews);
        webviewPanel.webview.html = injectMessageHandlerScripts(html);
    }

    private async updateChartOnly(state: ResultViewerState, webviewPanel: vscode.WebviewPanel): Promise<void> {
        const rawChart = getPrimaryChart(state.resultData);
        const rawChartOptions = getPrimaryChartOptions(state.resultData, state.chartOptionsOverride);
        if (!rawChartOptions) { return; }
        const chartOptions = applyChartDefaults(rawChartOptions);
        const modifiedData = withPrimaryChartOptions(state.resultData, chartOptions);
        const darkMode = isDarkMode();
        const table = getPrimaryChartTable(modifiedData, rawChart);
        if (table) {
            const controller = this.viewer.chartViews.get(webviewPanel);
            controller?.renderChart(table, chartOptions, darkMode, { tables: modifiedData.tables }, findChartView(modifiedData, rawChart));
        }
    }

    /*
    * Builds the HTML for a multi-tabbed view showing chart, data tables, and query, with toggle buttons.   
    */
    BuildMultiTabbedHtml(
        hasChart: boolean,
        mode: ResultViewMode,
        webview: WebViewAdapter | undefined,
        editorWebView: WebViewAdapter | undefined,
        chartOptions?: server.ChartOptions,
        queryText?: string,
        cluster?: string,
        database?: string,
        resultTables?: server.ResultTable[],
        tableWebViews?: WebViewAdapter[]
    ): string {
        const tables = resultTables ?? [];

        const showChart = hasChart && (mode === 'chart' || mode === 'all');
        const showTables = mode === 'data' || mode === 'detail' || mode === 'all';
        const showQuery = !!queryText && (mode === 'detail' || mode === 'all');

        // Determine whether to show the tab bar
        const visibleTabCount =
            (showChart ? 1 : 0) +
            (showTables ? tables.length : 0) +
            (showQuery ? 1 : 0);
        const showTabs = visibleTabCount > 1;

        // Build individual table divs with inline content from DataTableView
        const tableContents = showTables
            ? tables.map((_t, i) =>
                `<div id="table-${i}" class="view-content" data-vscode-context='{"chartVisible": false, "queryVisible": false, "preventDefaultContextMenuItems": true}'>${tableWebViews?.[i]?.contentHtml ?? ''}</div>`
            ).join('')
            : '';

        // Get chart page dependencies from the webview adapter
        const chartHead = showChart ? (webview?.headHtml ?? '') : '';
        const chartScripts = showChart ? (webview?.scriptsHtml ?? '') : '';

        // Determine first active view
        const firstActiveView = showChart ? 'chart' : 'table-0';

        // Build the toggle buttons (only used when showTabs is true)
        let tabButtons = '';
        if (showTabs) {
            const chartButton = showChart
                ? `<button class="active" data-view="chart" onclick="switchView('chart')">Chart</button>`
                : '';

            let tableButtonsHtml = '';
            if (showTables) {
                if (tables.length === 1) {
                    tableButtonsHtml = `<button${showChart ? '' : ' class="active"'} data-view="table-0" onclick="switchView('table-0')">Data</button>`;
                } else {
                    tableButtonsHtml = tables.map((t, i) =>
                        `<button${!showChart && i === 0 ? ' class="active"' : ''} data-view="table-${i}" onclick="switchView('table-${i}')">${this.escapeHtml(t.name)} (${t.rows.length})</button>`
                    ).join('');
                }
            }

            const queryButton = showQuery
                ? `<button data-view="query" onclick="switchView('query')">Query</button>`
                : '';

            tabButtons = chartButton + tableButtonsHtml + queryButton;
        }

        // Build chart options edit panel placeholder (populated by editor controller)
        const editPanelHtml = showChart ? `<div id=\"edit-panel\" class=\"edit-panel\">${editorWebView?.contentHtml ?? ''}</div>` : '';

        // Get editor page dependencies from the editor adapter
        const editorHead = showChart ? (editorWebView?.headHtml ?? '') : '';
        const editorScripts = showChart ? (editorWebView?.scriptsHtml ?? '') : '';

        // Aspect ratio support
        const aspectRatio = chartOptions?.aspectRatio;
        const hasExplicitAspectRatio = !!aspectRatio && aspectRatio !== ChartAspectRatio.Fill;
        const chartAspectClass = hasExplicitAspectRatio ? ' has-aspect-ratio' : '';
        const textSize = chartOptions?.textSize === 'Auto' ? '' : (chartOptions?.textSize ?? '');
        const chartStyleParts: string[] = [];
        if (hasExplicitAspectRatio) { chartStyleParts.push(`--chart-aspect-ratio: ${aspectRatio.replace(':', '/')}`); }
        const chartStyle = chartStyleParts.length ? ` style="${chartStyleParts.join('; ')}"` : '';
        const chartDataAttrs = textSize ? ` data-text-size="${textSize}"` : '';



        // When only a single item is visible, mark it active and use full height
        const mainAreaHeight = showTabs ? 'calc(100vh - 33px)' : '100vh';

        // Get data table page dependencies from the first table adapter
        const tableHead = showTables && tableWebViews?.length ? (tableWebViews[0]!.headHtml ?? '') : '';

        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    ${chartHead}
    ${editorHead}
    ${tableHead}
    <style>
        body {
            margin: 0;
            padding: 0;
            font-family: var(--vscode-font-family, sans-serif);
            font-size: var(--vscode-font-size, 13px);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
        }
        .view-toggle {
            display: flex;
            align-items: center;
            border-bottom: 1px solid var(--vscode-panel-border, #444);
            background: var(--vscode-editor-background);
            position: sticky;
            top: 0;
            z-index: 100;
        }
        .view-toggle button {
            padding: 6px 16px;
            border: none;
            background: transparent;
            color: var(--vscode-foreground);
            cursor: pointer;
            border-bottom: 2px solid transparent;
            font-family: inherit;
            font-size: inherit;
        }
        .view-toggle button:hover {
            background: var(--vscode-list-hoverBackground, #2a2d2e);
        }
        .view-toggle button.active {
            border-bottom-color: var(--vscode-focusBorder, #007acc);
            color: var(--vscode-foreground);
        }
        .view-toggle .spacer { flex: 1; }
        .main-area {
            display: flex;
            height: ${mainAreaHeight};
        }
        .content-area {
            flex: 1;
            overflow: hidden;
            min-width: 0;
        }
        .view-content { display: none; height: 100%; overflow: hidden; }
        .view-content.active { display: flex; flex-direction: column; }
        #chart.active {
            /* Always provide a containing block so the absolutely-positioned
             * wrapper inside can't escape and so layout changes inside the
             * wrapper don't bubble up to #chart and trigger ResizeObserver loops. */
            position: relative;
        }
        #chart.has-aspect-ratio > :first-child {
            visibility: hidden;
        }
        #chart-view { padding: 0; }
        /* Query tab styles */
        .query-info {
            padding: 8px 12px;
            display: flex;
            gap: 16px;
            border-bottom: 1px solid var(--vscode-panel-border, #444);
            background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
        }
        .query-meta {
            font-size: 12px;
            color: var(--vscode-descriptionForeground, var(--vscode-foreground));
        }
        .query-content {
            margin: 0;
            padding: 4px 12px;
            overflow: auto;
            font-family: var(--vscode-editor-font-family, 'Consolas', 'Courier New', monospace);
            font-size: var(--vscode-editor-font-size, 13px);
            white-space: pre-wrap;
            color: var(--vscode-descriptionForeground, grey);
        }
    </style>
</head>
<body>
    ${showTabs ? `<div class="view-toggle">
        ${tabButtons}
    </div>` : ''}
    <div class="main-area">
        <div class="content-area">
            ${showChart ? `<div id="chart" class="view-content${chartAspectClass}${firstActiveView === 'chart' ? ' active' : ''}"${chartStyle}${chartDataAttrs} data-vscode-context='{"chartVisible": true, "queryVisible": false, "preventDefaultContextMenuItems": true}'>${webview?.contentHtml ?? ''}</div>` : ''}
            ${tableContents}
            ${showQuery ? `<div id="query" class="view-content" data-vscode-context='{"chartVisible": false, "queryVisible": true, "preventDefaultContextMenuItems": true}'>
                <div class="query-info">
                    ${cluster ? `<span class="query-meta"><strong>Cluster:</strong> ${this.escapeHtml(cluster)}</span>` : ''}
                    ${database ? `<span class="query-meta"><strong>Database:</strong> ${this.escapeHtml(database)}</span>` : ''}
                </div>
                <pre class="query-content">${this.escapeHtml(queryText!)}</pre>
            </div>` : ''}
        </div>
        ${editPanelHtml}
    </div>
    <script>
        // Set initial active table view
        (function() {
            var first = document.getElementById('${firstActiveView}');
            if (first) first.classList.add('active');
        })();

        // Track whether the user wants the edit panel open
        var editPanelUserVisible = false;

        function switchView(viewId) {
            document.querySelectorAll('.view-content').forEach(function(el) { el.classList.remove('active'); });
            document.querySelectorAll('.view-toggle button[data-view]').forEach(function(el) { el.classList.remove('active'); });
            var target = document.getElementById(viewId);
            if (target) target.classList.add('active');
            var btn = document.querySelector('.view-toggle button[data-view="' + viewId + '"]');
            if (btn) btn.classList.add('active');
            // Hide/restore edit panel based on view and user preference
            var editPanel = document.getElementById('edit-panel');
            if (editPanel) {
                if (viewId.startsWith('table-') || viewId === 'query') {
                    editPanel.classList.remove('visible');
                } else if (editPanelUserVisible) {
                    editPanel.classList.add('visible');
                }
            }
            // Trigger chart resize when switching to chart. Use rAF (one frame,
            // ~16ms) instead of a fixed 50ms timeout so the resize happens as
            // soon as the browser has applied the new layout.
            if (viewId === 'chart') {
                requestAnimationFrame(function() {
                    if (window._chartResize) window._chartResize();
                });
            }
        }

        function toggleEditPanel() {
            var panel = document.getElementById('edit-panel');
            if (!panel) return;
            editPanelUserVisible = !editPanelUserVisible;
            panel.classList.toggle('visible', editPanelUserVisible);

            // Notify extension host so it can move the panel if needed
            if (window._vscodeApi) {
                window._vscodeApi.postMessage({ command: 'editPanelToggled', visible: editPanelUserVisible });
            }

            // Resize chart when panel toggles. Use rAF (one frame, ~16ms)
            // instead of a fixed 50ms timeout so the resize happens as soon as
            // the browser has applied the panel's display change.
            requestAnimationFrame(function() {
                if (window._chartResize) window._chartResize();
            });
        }

        // Listen for messages from the extension
        window.addEventListener('message', function(event) {
            var msg = event.data;
            if (!msg) return;

            // ── Chart content dispatch ──
            if (msg.command === 'setChartHtml' && typeof msg.html === 'string') {
                var chartDiv = document.getElementById('chart');
                if (!chartDiv) return;
                chartDiv.innerHTML = msg.html;
                // Re-execute inline scripts (innerHTML doesn't execute them)
                chartDiv.querySelectorAll('script').forEach(function(oldScript) {
                    var newScript = document.createElement('script');
                    if (oldScript.src) { newScript.src = oldScript.src; }
                    else { newScript.textContent = oldScript.textContent; }
                    oldScript.parentNode.replaceChild(newScript, oldScript);
                });
                // Notify chart engine scripts to apply post-insertion overrides
                if (window._chartUpdated) window._chartUpdated();
                return;
            }

            if (msg.command === 'toggleEditPanel') {
                toggleEditPanel();
                return;
            }
            if (msg.command === 'setEditPanelVisible') {
                var panel = document.getElementById('edit-panel');
                if (panel) {
                    editPanelUserVisible = msg.visible;
                    panel.classList.toggle('visible', msg.visible);
                }
                return;
            }
        });
    </script>
    ${editorScripts}
    ${chartScripts}
</body>
</html>`;
    }

    escapeHtml(text: string): string {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
}
