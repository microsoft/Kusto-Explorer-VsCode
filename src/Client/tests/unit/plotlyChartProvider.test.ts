// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlotlyChartProvider } from '../../features/plotlyChartProvider';
import { CompositeChartProvider } from '../../features/compositeChartProvider';
import type { IChartView } from '../../features/chartProvider';
import type { IWebView } from '../../features/webview';
import type { ResultTable, ChartOptions } from '../../features/server';

// ─── Mock IWebView ──────────────────────────────────────────────────────────

function createMockWebView(): IWebView & {
    setup: ReturnType<typeof vi.fn>;
    setContent: ReturnType<typeof vi.fn>;
    invoke: ReturnType<typeof vi.fn>;
    /** Simulate a message from the webview. */
    simulateMessage: (message: Record<string, unknown>) => void;
} {
    const handlers: ((message: Record<string, unknown>) => void)[] = [];
    const setup = vi.fn<(headHtml: string, scriptsHtml: string) => void>();
    const setContent = vi.fn<(html: string) => void>();
    const invoke = vi.fn<(command: string, args?: Record<string, unknown>) => void>();
    return {
        setup,
        setContent,
        invoke,
        handle: vi.fn((handler: (message: Record<string, unknown>) => void) => {
            handlers.push(handler);
            return { dispose: () => { const i = handlers.indexOf(handler); if (i >= 0) handlers.splice(i, 1); } };
        }),
        simulateMessage(message: Record<string, unknown>) {
            for (const h of handlers) { h(message); }
        },
    };
}

// ─── Test Data Helpers ──────────────────────────────────────────────────────

/**
 * Evaluates the single-quoted JS string literal that plotlyChartProvider.ts renders
 * inside `JSON.parse('...')`, so tests get back the JSON payload the webview parses.
 */
function decodeJsStringLiteral(encoded: string): string {
    return new Function(`return '${encoded}';`)() as string;
}

function makeTable(columns: { name: string; type: string }[], rows: unknown[][]): ResultTable {
    return { name: 'TestTable', columns, rows };
}

function make2dTable(): ResultTable {
    return makeTable(
        [{ name: 'Category', type: 'string' }, { name: 'Value', type: 'real' }],
        [['A', 10], ['B', 20], ['C', 30]],
    );
}

function makeMultiSeriesTable(): ResultTable {
    return makeTable(
        [
            { name: 'Month', type: 'string' },
            { name: 'Sales', type: 'real' },
            { name: 'Profit', type: 'real' },
        ],
        [['Jan', 100, 40], ['Feb', 150, 60], ['Mar', 120, 50]],
    );
}

function makePieTable(): ResultTable {
    return makeTable(
        [{ name: 'Fruit', type: 'string' }, { name: 'Count', type: 'int' }],
        [['Apple', 5], ['Banana', 3], ['Cherry', 8]],
    );
}

// ─── createView ─────────────────────────────────────────────────────────

describe('CompositeChartProvider', () => {
    let provider: CompositeChartProvider;

    beforeEach(() => {
        provider = new CompositeChartProvider();
    });

    describe('createView', () => {
        it('calls webview.setup() with the bundled Plotly library and scripts', () => {
            const webview = createMockWebView();
            provider.createView(webview);

            // Composite provider sets up both Plotly and TimePivot views
            expect(webview.setup).toHaveBeenCalled();
            // Plotly setup should reference the bundled library
            const plotlyCall = webview.setup.mock.calls.find(
                (args: unknown[]) => typeof args[0] === 'string' && (args[0] as string).includes('plotly')
            );
            expect(plotlyCall).toBeDefined();
            expect(plotlyCall![1]).toContain('<script>');
        });

        it('returns an IChartView', () => {
            const webview = createMockWebView();
            const view = provider.createView(webview);

            expect(view).toBeDefined();
            expect(typeof view.renderChart).toBe('function');
            expect(typeof view.copyChart).toBe('function');
            expect(typeof view.dispose).toBe('function');
        });

        it('subscribes to webview messages', () => {
            const webview = createMockWebView();
            provider.createView(webview);

            expect(webview.handle).toHaveBeenCalled();
        });
    });

    // ─── IChartView behavior ────────────────────────────────────────────

    describe('IChartView', () => {
        let webview: ReturnType<typeof createMockWebView>;
        let view: IChartView;

        beforeEach(() => {
            webview = createMockWebView();
            view = provider.createView(webview);
        });

        describe('copyChart', () => {
            it('invokes copyChart command on the webview', () => {
                view.copyChart();
                expect(webview.invoke).toHaveBeenCalledWith('copyChart');
            });
        });

        describe('onCopyResult', () => {
            it('fires when webview sends copyChartResult message', () => {
                const callback = vi.fn();
                view.onCopyResult = callback;

                webview.simulateMessage({
                    command: 'copyChartResult',
                    pngDataUrl: 'data:image/png;base64,abc',
                    svgDataUrl: 'data:image/svg+xml,<svg/>',
                });

                expect(callback).toHaveBeenCalledWith(
                    'data:image/png;base64,abc',
                    'data:image/svg+xml,<svg/>',
                );
            });

            it('does not fire when pngDataUrl is missing', () => {
                const callback = vi.fn();
                view.onCopyResult = callback;

                webview.simulateMessage({ command: 'copyChartResult' });
                expect(callback).not.toHaveBeenCalled();
            });
        });

        describe('onCopyError', () => {
            it('fires when webview sends copyChartError message', () => {
                const callback = vi.fn();
                view.onCopyError = callback;

                webview.simulateMessage({ command: 'copyChartError', error: 'Export failed' });
                expect(callback).toHaveBeenCalledWith('Export failed');
            });

            it('uses fallback string when error is undefined', () => {
                const callback = vi.fn();
                view.onCopyError = callback;

                webview.simulateMessage({ command: 'copyChartError' });
                expect(callback).toHaveBeenCalledWith('Unknown error');
            });
        });

        describe('dispose', () => {
            it('unsubscribes from webview messages', () => {
                const callback = vi.fn();
                view.onCopyResult = callback;

                view.dispose();

                webview.simulateMessage({
                    command: 'copyChartResult',
                    pngDataUrl: 'data:image/png;base64,abc',
                });
                expect(callback).not.toHaveBeenCalled();
            });
        });

        describe('renderChart', () => {
            it('posts chart content via webview.invoke() with parsed JSON payloads', () => {
                view.renderChart(make2dTable(), { type: 'Column' }, false);
                expect(webview.invoke).toHaveBeenCalledOnce();
                const [command, args] = webview.invoke.mock.calls[0]!;
                expect(command).toBe('setChartContent');
                const payload = args as { divId: string; dataJson: string; layoutJson: string; configJson: string };
                expect(payload.divId).toBe('plotly-chart');
                // dataJson must round-trip via JSON.parse to a non-empty trace array.
                const traces = JSON.parse(payload.dataJson) as unknown[];
                expect(Array.isArray(traces)).toBe(true);
                expect(traces.length).toBeGreaterThan(0);
                // layoutJson and configJson must also be valid JSON.
                expect(() => JSON.parse(payload.layoutJson)).not.toThrow();
                expect(() => JSON.parse(payload.configJson)).not.toThrow();
            });

            it('renders empty traces for table with no rows', () => {
                const emptyTable = makeTable(
                    [{ name: 'X', type: 'string' }, { name: 'Y', type: 'real' }],
                    [],
                );
                view.renderChart(emptyTable, { type: 'Column' }, false);
                expect(webview.invoke).toHaveBeenCalledOnce();
                const [command, args] = webview.invoke.mock.calls[0]!;
                expect(command).toBe('setChartContent');
                const payload = args as { dataJson: string };
                const parsed = JSON.parse(payload.dataJson) as { x: unknown[]; y: unknown[] }[];
                expect(parsed[0]!.x).toEqual([]);
                expect(parsed[0]!.y).toEqual([]);
            });

            it('shows error message for unsupported chart type', () => {
                view.renderChart(make2dTable(), { type: 'UnknownChart' }, false);
                expect(webview.setContent).toHaveBeenCalledOnce();
                const html = webview.setContent.mock.calls[0]![0] as string;
                expect(html).toContain('not currently supported');
            });

            it('replays last setChartContent payload on chartViewReady', () => {
                // Initial render: payload is sent immediately and cached.
                view.renderChart(make2dTable(), { type: 'Column' }, false);
                expect(webview.invoke).toHaveBeenCalledOnce();
                const initial = webview.invoke.mock.calls[0]!;
                expect(initial[0]).toBe('setChartContent');

                // Page reports its message handler is attached. The view should
                // resend the cached payload so initial render survives a missed
                // first message during webview startup or after webview.html
                // rebuild.
                webview.simulateMessage({ command: 'chartViewReady' });
                expect(webview.invoke).toHaveBeenCalledTimes(2);
                expect(webview.invoke.mock.calls[1]![0]).toBe('setChartContent');
                expect(webview.invoke.mock.calls[1]![1]).toEqual(initial[1]);
            });

            it('does not replay setChartContent on chartViewReady when last result was HTML or unsupported', () => {
                // Unsupported chart type: nothing to replay, the cached payload
                // (if any) from a prior structured render must be cleared.
                view.renderChart(make2dTable(), { type: 'UnknownChart' }, false);
                webview.simulateMessage({ command: 'chartViewReady' });
                expect(webview.invoke).not.toHaveBeenCalled();
            });
        });
    });

    // ─── Chart rendering output ─────────────────────────────────────────

    describe('chart rendering', () => {
        let webview: ReturnType<typeof createMockWebView>;
        let view: IChartView;

        beforeEach(() => {
            webview = createMockWebView();
            view = provider.createView(webview);
        });

        /**
         * Renders the chart and returns an HTML-shaped string suitable for the
         * `parseTraces` / `parseLayout` regex helpers. For the normal single-chart
         * path (which now goes through `webview.invoke('setChartContent', ...)`),
         * we synthesize HTML in the same shape `createChartDiv` produces so the
         * existing regex helpers continue to work unchanged. For the raw-Plotly
         * and multi-chart panel paths (which still go through `setContent`),
         * we return the HTML directly.
         *
         * The `escape` function below MUST mirror `escapeForJsStringLiteral` in
         * the production source. Keep them in lockstep.
         */
        function renderAndGetHtml(table: ResultTable, options: ChartOptions, darkMode = false): string | undefined {
            view.renderChart(table, options, darkMode);
            // Structured invoke: synthesize HTML using the same JSON.parse('...') format.
            const invokeCall = webview.invoke.mock.calls.find((c: unknown[]) => c[0] === 'setChartContent');
            if (invokeCall) {
                const p = invokeCall[1] as { divId: string; dataJson: string; layoutJson: string; configJson: string };
                const escape = (j: string) => j
                    .replace(/\\/g, '\\\\')
                    .replace(/'/g, "\\'")
                    .replace(/<\//g, '<\\/')
                    .replace(/\u2028/g, '\\u2028')
                    .replace(/\u2029/g, '\\u2029');
                return `<div id="${p.divId}"></div>\n<script>\nvar data = JSON.parse('${escape(p.dataJson)}');\nvar layout = JSON.parse('${escape(p.layoutJson)}');\nvar config = JSON.parse('${escape(p.configJson)}');\nPlotly.newPlot('${p.divId}', data, layout, config);\n</script>`;
            }
            if (webview.setContent.mock.calls.length === 0) return undefined;
            return webview.setContent.mock.calls[0]![0] as string;
        }

        /** Helper to parse the Plotly data array from the rendered HTML. */
        function parseTraces(html: string): unknown[] {
            const dataMatch = html.match(/var data = JSON\.parse\('([\s\S]*?)'\);\s*var layout/);
            expect(dataMatch).toBeTruthy();
            return JSON.parse(decodeJsStringLiteral(dataMatch![1]!)) as unknown[];
        }

        /** Helper to parse the Plotly layout from the rendered HTML. */
        function parseLayout(html: string): Record<string, unknown> {
            const layoutMatch = html.match(/var layout = JSON\.parse\('([\s\S]*?)'\);\s*var config/);
            expect(layoutMatch).toBeTruthy();
            return JSON.parse(decodeJsStringLiteral(layoutMatch![1]!)) as Record<string, unknown>;
        }

        describe('columnchart', () => {
            it('renders bar traces with vertical orientation', () => {
                const html = renderAndGetHtml(make2dTable(), { type: 'Column' });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                expect(traces.length).toBe(1);
                const trace = traces[0] as Record<string, unknown>;
                expect(trace.type).toBe('bar');
                expect(trace.orientation).toBe('v');
                expect(trace.x).toEqual(['A', 'B', 'C']);
                expect(trace.y).toEqual([10, 20, 30]);
            });

            it('renders multiple series as separate traces', () => {
                const html = renderAndGetHtml(makeMultiSeriesTable(), { type: 'Column' });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                expect(traces.length).toBe(2);
                expect((traces[0] as Record<string, unknown>).name).toBe('Sales');
                expect((traces[1] as Record<string, unknown>).name).toBe('Profit');
            });

            it('respects xColumn and yColumns options', () => {
                const table = makeMultiSeriesTable();
                const html = renderAndGetHtml(table, {
                    type: 'Column',
                    xColumn: 'Month',
                    yColumns: ['Profit'],
                });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                expect(traces.length).toBe(1);
                expect((traces[0] as Record<string, unknown>).name).toBe('Profit');
            });
        });

        describe('barchart', () => {
            it('renders bar traces with horizontal orientation', () => {
                const html = renderAndGetHtml(make2dTable(), { type: 'Bar' });
                expect(html).toBeDefined();
                const trace = parseTraces(html!)[0] as Record<string, unknown>;
                expect(trace.type).toBe('bar');
                expect(trace.orientation).toBe('h');
            });
        });

        describe('linechart', () => {
            it('renders scatter traces with lines mode', () => {
                const html = renderAndGetHtml(make2dTable(), { type: 'Line' });
                expect(html).toBeDefined();
                const trace = parseTraces(html!)[0] as Record<string, unknown>;
                expect(trace.type).toBe('scatter');
                expect(trace.mode).toBe('lines');
            });
        });

        describe('scatterchart', () => {
            it('renders scatter traces with markers mode', () => {
                const html = renderAndGetHtml(make2dTable(), { type: 'Scatter' });
                expect(html).toBeDefined();
                const trace = parseTraces(html!)[0] as Record<string, unknown>;
                expect(trace.type).toBe('scatter');
                expect(trace.mode).toBe('markers');
            });

            it('applies markerShape to all traces when cycleMarkerShapes is off', () => {
                const html = renderAndGetHtml(makeMultiSeriesTable(), { type: 'Scatter', markerShape: 'Diamond' });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                expect(traces.length).toBe(2);
                expect((traces[0] as Record<string, unknown>).marker).toEqual({ symbol: 'diamond' });
                expect((traces[1] as Record<string, unknown>).marker).toEqual({ symbol: 'diamond' });
            });

            it('cycles marker shapes when cycleMarkerShapes is true', () => {
                const html = renderAndGetHtml(makeMultiSeriesTable(), { type: 'Scatter', markerShape: 'Diamond', cycleMarkerShapes: true });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                expect(traces.length).toBe(2);
                expect((traces[0] as Record<string, unknown>).marker).toEqual({ symbol: 'diamond' });
                expect((traces[1] as Record<string, unknown>).marker).toEqual({ symbol: 'square' });
            });

            it('does not set marker when markerShape is not specified', () => {
                const html = renderAndGetHtml(make2dTable(), { type: 'Scatter' });
                expect(html).toBeDefined();
                const trace = parseTraces(html!)[0] as Record<string, unknown>;
                expect(trace.marker).toBeUndefined();
            });

            it('cycles shapes from circle when cycleMarkerShapes is true but no markerShape set', () => {
                const html = renderAndGetHtml(makeMultiSeriesTable(), { type: 'Scatter', cycleMarkerShapes: true });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                expect(traces.length).toBe(2);
                expect((traces[0] as Record<string, unknown>).marker).toEqual({ symbol: 'circle' });
                expect((traces[1] as Record<string, unknown>).marker).toEqual({ symbol: 'diamond' });
            });

            it('applies markerSize preset to scatter traces', () => {
                const html = renderAndGetHtml(makeMultiSeriesTable(), { type: 'Scatter', markerSize: 'Large' });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                expect(traces.length).toBe(2);
                expect((traces[0] as Record<string, unknown>).marker).toEqual({ size: 10 });
                expect((traces[1] as Record<string, unknown>).marker).toEqual({ size: 10 });
            });

            it('applies both markerShape and markerSize', () => {
                const html = renderAndGetHtml(make2dTable(), { type: 'Scatter', markerShape: 'Star', markerSize: 'Medium' });
                expect(html).toBeDefined();
                const trace = parseTraces(html!)[0] as Record<string, unknown>;
                expect(trace.marker).toEqual({ symbol: 'star', size: 8 });
            });

            it('renders anomaly overlays when anomalyColumns are specified', () => {
                const table = makeTable(
                    [
                        { name: 'x', type: 'int' },
                        { name: 'value', type: 'real' },
                        { name: 'anomalies', type: 'real' },
                    ],
                    [
                        [1, 10, 0],
                        [2, 20, 1],
                        [3, 15, 0],
                        [4, 50, -1],
                    ],
                );
                const html = renderAndGetHtml(table, {
                    type: 'Scatter',
                    yColumns: ['value', 'anomalies'],
                    anomalyColumns: ['anomalies'],
                });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                expect(traces.length).toBe(2);
                const base = traces[0] as Record<string, unknown>;
                const anomaly = traces[1] as Record<string, unknown>;
                expect(base.mode).toBe('markers');
                expect(anomaly.mode).toBe('markers');
                expect(anomaly.x).toEqual([2, 4]);
                expect(anomaly.y).toEqual([20, 50]);
            });
        });

        describe('areachart', () => {
            it('renders scatter traces with fill', () => {
                const html = renderAndGetHtml(make2dTable(), { type: 'Area' });
                expect(html).toBeDefined();
                const trace = parseTraces(html!)[0] as Record<string, unknown>;
                expect(trace.type).toBe('scatter');
                expect(trace.fill).toBe('tozeroy');
            });

            it('renders stacked area chart', () => {
                const html = renderAndGetHtml(makeMultiSeriesTable(), { type: 'AreaStacked' });
                expect(html).toBeDefined();
                const trace = parseTraces(html!)[0] as Record<string, unknown>;
                expect(trace.stackgroup).toBe('1');
                expect(trace.fill).toBe('tonexty');
            });

            it('shows markers and value labels on area traces', () => {
                const html = renderAndGetHtml(make2dTable(), {
                    type: 'Area',
                    showMarkers: true,
                    showValues: true,
                    markerShape: 'Star',
                    markerSize: 'Medium',
                    markerOutline: true,
                });
                expect(html).toBeDefined();
                const trace = parseTraces(html!)[0] as Record<string, unknown>;
                expect(trace.mode).toBe('lines+markers+text');
                expect(trace.text).toEqual([10, 20, 30]);
                expect(trace.marker).toEqual({
                    symbol: 'star',
                    size: 8,
                    line: { color: '#333', width: 1.5 },
                });
            });
        });

        describe('stackedareachart', () => {
            it('renders stacked area traces', () => {
                const html = renderAndGetHtml(makeMultiSeriesTable(), { type: 'AreaStacked' });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                for (const t of traces) {
                    expect((t as Record<string, unknown>).stackgroup).toBe('1');
                }
            });
        });

        describe('scattergl threshold', () => {
            // Generates a 2-column (datetime, real) table with `n` rows.
            function makeLargeTimeSeries(n: number): ResultTable {
                const rows: unknown[][] = new Array(n);
                const base = new Date('2025-01-01T00:00:00Z').getTime();
                for (let i = 0; i < n; i++) {
                    rows[i] = [new Date(base + i * 60_000).toISOString(), i];
                }
                return makeTable(
                    [{ name: 'Time', type: 'datetime' }, { name: 'Value', type: 'real' }],
                    rows,
                );
            }

            it('keeps SVG scatter for line charts at or below threshold', () => {
                const html = renderAndGetHtml(makeLargeTimeSeries(1000), { type: 'Line' });
                const trace = parseTraces(html!)[0] as Record<string, unknown>;
                expect(trace.type).toBe('scatter');
            });

            it('switches line charts above threshold to scattergl', () => {
                const html = renderAndGetHtml(makeLargeTimeSeries(1001), { type: 'Line' });
                const trace = parseTraces(html!)[0] as Record<string, unknown>;
                expect(trace.type).toBe('scattergl');
            });

            it('switches scatter charts above threshold to scattergl', () => {
                const html = renderAndGetHtml(makeLargeTimeSeries(2000), { type: 'Scatter' });
                const trace = parseTraces(html!)[0] as Record<string, unknown>;
                expect(trace.type).toBe('scattergl');
            });

            it('switches non-stacked area charts above threshold to scattergl', () => {
                const html = renderAndGetHtml(makeLargeTimeSeries(2000), { type: 'Area' });
                const trace = parseTraces(html!)[0] as Record<string, unknown>;
                expect(trace.type).toBe('scattergl');
                expect(trace.fill).toBe('tozeroy');
            });

            it('keeps stacked area charts on SVG scatter regardless of size (stackgroup is unsupported in scattergl)', () => {
                const html = renderAndGetHtml(makeLargeTimeSeries(5000), { type: 'AreaStacked' });
                const trace = parseTraces(html!)[0] as Record<string, unknown>;
                expect(trace.type).toBe('scatter');
                expect(trace.stackgroup).toBe('1');
            });
        });

        describe('piechart', () => {
            it('renders a pie trace with labels and values', () => {
                const html = renderAndGetHtml(makePieTable(), { type: 'Pie' });
                expect(html).toBeDefined();
                const trace = parseTraces(html!)[0] as Record<string, unknown>;
                expect(trace.type).toBe('pie');
                expect(trace.labels).toEqual(['Apple', 'Banana', 'Cherry']);
                expect(trace.values).toEqual([5, 3, 8]);
            });
        });

        describe('card', () => {
            it('renders an indicator trace with a numeric value', () => {
                const table = makeTable(
                    [{ name: 'Metric', type: 'real' }],
                    [[42]],
                );
                const html = renderAndGetHtml(table, { type: 'Card' });
                expect(html).toBeDefined();
                const trace = parseTraces(html!)[0] as Record<string, unknown>;
                expect(trace.type).toBe('indicator');
                expect(trace.value).toBe(42);
                expect(trace.mode).toBe('number');
            });

            it('shows error for table with no numeric column', () => {
                const table = makeTable(
                    [{ name: 'Name', type: 'string' }],
                    [['hello']],
                );
                const html = renderAndGetHtml(table, { type: 'Card' });
                expect(html).toContain('not currently supported');
            });
        });

        describe('treemap', () => {
            it('renders a treemap trace', () => {
                const table = makeTable(
                    [
                        { name: 'Region', type: 'string' },
                        { name: 'Product', type: 'string' },
                        { name: 'Revenue', type: 'real' },
                    ],
                    [
                        ['North', 'Widget', 100],
                        ['North', 'Gadget', 200],
                        ['South', 'Widget', 150],
                    ],
                );
                const html = renderAndGetHtml(table, { type: 'TreeMap' });
                expect(html).toBeDefined();
                const trace = parseTraces(html!)[0] as Record<string, unknown>;
                expect(trace.type).toBe('treemap');
                expect(trace.labels).toBeDefined();
                expect((trace.labels as unknown[]).length).toBeGreaterThan(0);
            });
        });

        describe('sankey', () => {
            it('renders a sankey trace with nodes and links', () => {
                const table = makeTable(
                    [
                        { name: 'Source', type: 'string' },
                        { name: 'Target', type: 'string' },
                        { name: 'Flow', type: 'real' },
                    ],
                    [
                        ['A', 'B', 10],
                        ['A', 'C', 20],
                        ['B', 'C', 5],
                    ],
                );
                const html = renderAndGetHtml(table, { type: 'Sankey' });
                expect(html).toBeDefined();
                const trace = parseTraces(html!)[0] as Record<string, unknown>;
                expect(trace.type).toBe('sankey');
                const node = trace.node as Record<string, unknown>;
                expect((node.label as string[]).sort()).toEqual(['A', 'B', 'C']);
            });
        });

        describe('anomalychart', () => {
            it('renders line traces with anomaly scatter points', () => {
                const table = makeTable(
                    [
                        { name: 'timestamp', type: 'datetime' },
                        { name: 'value', type: 'real' },
                        { name: 'anomalies', type: 'real' },
                    ],
                    [
                        ['2024-01-01', 10, 0],
                        ['2024-01-02', 20, 1],
                        ['2024-01-03', 15, 0],
                        ['2024-01-04', 50, -1],
                    ],
                );
                const html = renderAndGetHtml(table, {
                    type: 'TimeLineAnomaly',
                    yColumns: ['value', 'anomalies'],
                    anomalyColumns: ['anomalies'],
                });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                // First trace: line for 'value'
                expect(traces.length).toBe(2);
                const line = traces[0] as Record<string, unknown>;
                expect(line.type).toBe('scatter');
                expect(line.mode).toBe('lines');
                // Second trace: scatter for anomaly points
                const anomaly = traces[1] as Record<string, unknown>;
                expect(anomaly.type).toBe('scatter');
                expect(anomaly.mode).toBe('markers');
                expect(anomaly.x).toEqual(['2024-01-02', '2024-01-04']);
                expect(anomaly.y).toEqual([20, 50]);
            });

            it('falls back to line chart when no anomalyColumns specified', () => {
                const table = makeTable(
                    [
                        { name: 'timestamp', type: 'datetime' },
                        { name: 'value', type: 'real' },
                    ],
                    [
                        ['2024-01-01', 10],
                        ['2024-01-02', 20],
                    ],
                );
                const html = renderAndGetHtml(table, { type: 'TimeLineAnomaly' });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                expect(traces.length).toBe(1);
                const trace = traces[0] as Record<string, unknown>;
                expect(trace.type).toBe('scatter');
                expect(trace.mode).toBe('lines');
            });

            it('applies markerShape to anomaly scatter points', () => {
                const table = makeTable(
                    [
                        { name: 'timestamp', type: 'datetime' },
                        { name: 'value', type: 'real' },
                        { name: 'anomalies', type: 'real' },
                    ],
                    [
                        ['2024-01-01', 10, 0],
                        ['2024-01-02', 20, 1],
                    ],
                );
                const html = renderAndGetHtml(table, {
                    type: 'TimeLineAnomaly',
                    yColumns: ['value', 'anomalies'],
                    anomalyColumns: ['anomalies'],
                    markerShape: 'Star',
                });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                const anomaly = traces[1] as Record<string, unknown>;
                expect(anomaly.marker).toEqual({ symbol: 'star' });
            });
            it('renders anomaly traces on linechart when anomalyColumns specified', () => {
                const table = makeTable(
                    [
                        { name: 'timestamp', type: 'datetime' },
                        { name: 'value', type: 'real' },
                        { name: 'anomalies', type: 'real' },
                    ],
                    [
                        ['2024-01-01', 10, 0],
                        ['2024-01-02', 20, 1],
                        ['2024-01-03', 15, 0],
                        ['2024-01-04', 50, -1],
                    ],
                );
                const html = renderAndGetHtml(table, {
                    type: 'Line',
                    yColumns: ['value', 'anomalies'],
                    anomalyColumns: ['anomalies'],
                });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                expect(traces.length).toBe(2);
                const line = traces[0] as Record<string, unknown>;
                expect(line.mode).toBe('lines');
                const anomaly = traces[1] as Record<string, unknown>;
                expect(anomaly.mode).toBe('markers');
                expect(anomaly.x).toEqual(['2024-01-02', '2024-01-04']);
                expect(anomaly.y).toEqual([20, 50]);
            });
        });

        describe('ladderchart', () => {
            const ladderTable = makeTable(
                [
                    { name: 'Task', type: 'string' },
                    { name: 'Start', type: 'datetime' },
                    { name: 'End', type: 'datetime' },
                ],
                [
                    ['Build', '2024-01-01T00:00:00Z', '2024-01-05T00:00:00Z'],
                    ['Test', '2024-01-03T00:00:00Z', '2024-01-08T00:00:00Z'],
                    ['Deploy', '2024-01-07T00:00:00Z', '2024-01-09T00:00:00Z'],
                ],
            );

            it('renders one trace per category with string y-values', () => {
                const html = renderAndGetHtml(ladderTable, { type: 'Ladder' });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                // Traces in data order (order categories first appear)
                expect(traces.length).toBe(3);
                const build = traces[0] as Record<string, unknown>;
                expect(build.type).toBe('bar');
                expect(build.orientation).toBe('h');
                expect(build.name).toBe('Build');
                expect(build.y).toEqual(['Build']);
                expect(build.base).toEqual(['2024-01-01T00:00:00Z']);
                expect((build.x as number[])[0]).toBe(4 * 86400000);

                const test = traces[1] as Record<string, unknown>;
                expect(test.name).toBe('Test');
                expect(test.y).toEqual(['Test']);

                const deploy = traces[2] as Record<string, unknown>;
                expect(deploy.name).toBe('Deploy');
                expect(deploy.y).toEqual(['Deploy']);
            });

            it('shares y-value for duplicate categories', () => {
                const table = makeTable(
                    [
                        { name: 'Task', type: 'string' },
                        { name: 'Start', type: 'datetime' },
                        { name: 'End', type: 'datetime' },
                    ],
                    [
                        ['Build', '2024-01-01T00:00:00Z', '2024-01-03T00:00:00Z'],
                        ['Test', '2024-01-02T00:00:00Z', '2024-01-04T00:00:00Z'],
                        ['Build', '2024-01-05T00:00:00Z', '2024-01-07T00:00:00Z'],
                    ],
                );
                const html = renderAndGetHtml(table, { type: 'Ladder' });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                expect(traces.length).toBe(2);
                const build = traces[0] as Record<string, unknown>;
                expect(build.name).toBe('Build');
                expect(build.y).toEqual(['Build', 'Build']);
                const test = traces[1] as Record<string, unknown>;
                expect(test.name).toBe('Test');
                expect(test.y).toEqual(['Test']);
            });

            it('shows error when fewer than 2 datetime columns', () => {
                const table = makeTable(
                    [
                        { name: 'Task', type: 'string' },
                        { name: 'Start', type: 'datetime' },
                    ],
                    [['A', '2024-01-01']],
                );
                const html = renderAndGetHtml(table, { type: 'Ladder' });
                expect(html).toContain('not currently supported');
            });

            it('uses series key as y-label with single seriesColumn', () => {
                const table = makeTable(
                    [
                        { name: 'Task', type: 'string' },
                        { name: 'Start', type: 'datetime' },
                        { name: 'End', type: 'datetime' },
                        { name: 'Team', type: 'string' },
                    ],
                    [
                        ['Build', '2024-01-01T00:00:00Z', '2024-01-03T00:00:00Z', 'Alpha'],
                        ['Test', '2024-01-02T00:00:00Z', '2024-01-04T00:00:00Z', 'Beta'],
                        ['Deploy', '2024-01-05T00:00:00Z', '2024-01-06T00:00:00Z', 'Alpha'],
                    ],
                );
                const html = renderAndGetHtml(table, { type: 'Ladder', seriesColumns: ['Team'] });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                expect(traces.length).toBe(2);
                const alpha = traces[0] as Record<string, unknown>;
                expect(alpha.name).toBe('Alpha');
                expect(alpha.y).toEqual(['Alpha', 'Alpha']);
                const beta = traces[1] as Record<string, unknown>;
                expect(beta.name).toBe('Beta');
                expect(beta.y).toEqual(['Beta']);
            });

            it('colors by first series column with multiple seriesColumns', () => {
                const table = makeTable(
                    [
                        { name: 'Task', type: 'string' },
                        { name: 'Start', type: 'datetime' },
                        { name: 'End', type: 'datetime' },
                        { name: 'State', type: 'string' },
                        { name: 'EventType', type: 'string' },
                    ],
                    [
                        ['x', '2024-01-01T00:00:00Z', '2024-01-03T00:00:00Z', 'CA', 'Flood'],
                        ['x', '2024-01-04T00:00:00Z', '2024-01-06T00:00:00Z', 'CA', 'Fire'],
                        ['x', '2024-01-02T00:00:00Z', '2024-01-05T00:00:00Z', 'TX', 'Tornado'],
                    ],
                );
                const html = renderAndGetHtml(table, { type: 'Ladder', seriesColumns: ['State', 'EventType'] });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                // 2 color groups (CA, TX)
                expect(traces.length).toBe(2);
                const ca = traces[0] as Record<string, unknown>;
                expect(ca.name).toBe('CA');
                // y-values use <br> for wrapping
                expect(ca.y).toEqual(['CA - Flood', 'CA - Fire']);
                const tx = traces[1] as Record<string, unknown>;
                expect(tx.name).toBe('TX');
                expect(tx.y).toEqual(['TX - Tornado']);
            });

            it('sets x-axis type to date', () => {
                const html = renderAndGetHtml(ladderTable, { type: 'Ladder' });
                expect(html).toBeDefined();
                const layout = parseLayout(html!);
                expect((layout.xaxis as Record<string, unknown>)?.type).toBe('date');
            });
        });

        describe('timepivot', () => {
            it('renders range mode with background bars and segment lines', () => {
                const table = makeTable(
                    [
                        { name: 'State', type: 'string' },
                        { name: 'Start', type: 'datetime' },
                        { name: 'End', type: 'datetime' },
                    ],
                    [
                        ['WA', '2024-01-01T00:00:00Z', '2024-01-03T00:00:00Z'],
                        ['CA', '2024-01-02T00:00:00Z', '2024-01-05T00:00:00Z'],
                    ],
                );
                const html = renderAndGetHtml(table, { type: 'TimePivot' });
                expect(html).toBeDefined();
                // Two detail rows (flat, no nesting)
                expect(html).toContain('tp-container');
                expect(html).toContain('tp-segment');
                expect(html).toContain('tp-bg-bar');
                // Labels for each series value
                expect(html).toContain('>WA<');
                expect(html).toContain('>CA<');
            });

            it('renders point mode with dots when only one datetime column', () => {
                const table = makeTable(
                    [
                        { name: 'State', type: 'string' },
                        { name: 'Timestamp', type: 'datetime' },
                    ],
                    [
                        ['WA', '2024-01-01T00:00:00Z'],
                        ['CA', '2024-01-02T00:00:00Z'],
                    ],
                );
                const html = renderAndGetHtml(table, { type: 'TimePivot' });
                expect(html).toBeDefined();
                expect(html).toContain('tp-dot');
                // No range segments in point mode
                expect(html).not.toContain('class="tp-segment"');
                expect(html).toContain('>WA<');
                expect(html).toContain('>CA<');
            });

            it('creates nested layout with parent rows when multiple series columns', () => {
                const table = makeTable(
                    [
                        { name: 'State', type: 'string' },
                        { name: 'EventType', type: 'string' },
                        { name: 'Start', type: 'datetime' },
                        { name: 'End', type: 'datetime' },
                    ],
                    [
                        ['WA', 'Login', '2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z'],
                        ['WA', 'Purchase', '2024-01-03T00:00:00Z', '2024-01-04T00:00:00Z'],
                        ['CA', 'Login', '2024-01-02T00:00:00Z', '2024-01-05T00:00:00Z'],
                    ],
                );
                const html = renderAndGetHtml(table, { type: 'TimePivot', seriesColumns: ['State', 'EventType'] });
                expect(html).toBeDefined();
                // Group rows
                expect(html).toContain('tp-group');
                expect(html).toContain('data-group="WA"');
                expect(html).toContain('data-group="CA"');
                // Leaf rows with parent reference
                expect(html).toContain('tp-leaf');
                expect(html).toContain('data-parent-group="WA"');
                expect(html).toContain('data-parent-group="CA"');
                // Detail labels
                expect(html).toContain('>Login<');
                expect(html).toContain('>Purchase<');
                // Toggle for collapse
                expect(html).toContain('tp-toggle');
                // Count badge
                expect(html).toContain('(2)');
                expect(html).toContain('(1)');
            });

            it('auto-infers first non-datetime non-numeric column as series', () => {
                const table = makeTable(
                    [
                        { name: 'Start', type: 'datetime' },
                        { name: 'End', type: 'datetime' },
                        { name: 'Region', type: 'string' },
                    ],
                    [
                        ['2024-01-01T00:00:00Z', '2024-01-03T00:00:00Z', 'East'],
                        ['2024-01-02T00:00:00Z', '2024-01-04T00:00:00Z', 'West'],
                    ],
                );
                const html = renderAndGetHtml(table, { type: 'TimePivot' });
                expect(html).toBeDefined();
                expect(html).toContain('>East<');
                expect(html).toContain('>West<');
                expect(html).toContain('tp-segment');
            });

            it('supports 3 levels of nesting', () => {
                const table = makeTable(
                    [
                        { name: 'Country', type: 'string' },
                        { name: 'State', type: 'string' },
                        { name: 'City', type: 'string' },
                        { name: 'Start', type: 'datetime' },
                        { name: 'End', type: 'datetime' },
                    ],
                    [
                        ['US', 'WA', 'Seattle', '2024-01-01T00:00:00Z', '2024-01-03T00:00:00Z'],
                        ['US', 'WA', 'Tacoma', '2024-01-02T00:00:00Z', '2024-01-04T00:00:00Z'],
                        ['US', 'CA', 'LA', '2024-01-05T00:00:00Z', '2024-01-07T00:00:00Z'],
                    ],
                );
                const html = renderAndGetHtml(table, { type: 'TimePivot', seriesColumns: ['Country', 'State', 'City'] });
                expect(html).toBeDefined();
                // Top level group: US
                expect(html).toContain('data-group="US"');
                // Mid level groups: US/WA, US/CA
                expect(html).toContain('data-group="US/WA"');
                expect(html).toContain('data-group="US/CA"');
                // Leaves referencing mid-level parents
                expect(html).toContain('data-parent-group="US/WA"');
                expect(html).toContain('data-parent-group="US/CA"');
                // Labels
                expect(html).toContain('>Seattle<');
                expect(html).toContain('>Tacoma<');
                expect(html).toContain('>LA<');
            });

            it('includes time axis ticks', () => {
                const table = makeTable(
                    [
                        { name: 'State', type: 'string' },
                        { name: 'Start', type: 'datetime' },
                        { name: 'End', type: 'datetime' },
                    ],
                    [['WA', '2024-01-01T00:00:00Z', '2024-01-03T00:00:00Z']],
                );
                const html = renderAndGetHtml(table, { type: 'TimePivot' });
                expect(html).toBeDefined();
                expect(html).toContain('tp-axis');
                expect(html).toContain('tp-tick');
                expect(html).toContain('tp-tick-label');
            });

            it('returns undefined with no datetime columns', () => {
                const table = makeTable(
                    [{ name: 'A', type: 'string' }, { name: 'B', type: 'real' }],
                    [['x', 1]],
                );
                const html = renderAndGetHtml(table, { type: 'TimePivot' });
                expect(html).toBeUndefined();
            });

            it('renders title when specified', () => {
                const table = makeTable(
                    [
                        { name: 'State', type: 'string' },
                        { name: 'Start', type: 'datetime' },
                        { name: 'End', type: 'datetime' },
                    ],
                    [['WA', '2024-01-01T00:00:00Z', '2024-01-03T00:00:00Z']],
                );
                const html = renderAndGetHtml(table, { type: 'TimePivot', title: 'My Pivot' });
                expect(html).toBeDefined();
                expect(html).toContain('tp-title');
                expect(html).toContain('My Pivot');
            });
        });

        describe('plotly (raw)', () => {
            it('renders raw Plotly JSON from first cell', () => {
                const plotlyJson = JSON.stringify({
                    data: [{ type: 'bar', x: [1, 2], y: [3, 4] }],
                    layout: { title: 'Raw' },
                });
                const table = makeTable(
                    [{ name: 'plotly_json', type: 'string' }],
                    [[plotlyJson]],
                );
                const html = renderAndGetHtml(table, { type: 'Plotly' });
                expect(html).toBeDefined();
                expect(html).toContain('Plotly.newPlot');
                const traces = parseTraces(html!);
                expect((traces[0] as Record<string, unknown>).type).toBe('bar');
            });

            it('shows error for invalid JSON', () => {
                const table = makeTable(
                    [{ name: 'plotly_json', type: 'string' }],
                    [['not valid json']],
                );
                const html = renderAndGetHtml(table, { type: 'Plotly' });
                expect(html).toContain('not currently supported');
            });

            it('shows error for JSON without data field', () => {
                const table = makeTable(
                    [{ name: 'plotly_json', type: 'string' }],
                    [[JSON.stringify({ layout: {} })]],
                );
                const html = renderAndGetHtml(table, { type: 'Plotly' });
                expect(html).toContain('not currently supported');
            });

            it('escapes U+2028 / U+2029 line separators in embedded JSON', () => {
                // U+2028 (line separator) and U+2029 (paragraph separator) were
                // illegal inside JS string literals before ES2019 and remain a
                // syntax-error risk on older runtimes. Verify they are escaped
                // out of the embedded `JSON.parse('...')` literal.
                const ls = '\u2028';
                const ps = '\u2029';
                const plotlyJson = JSON.stringify({
                    data: [{ type: 'bar', x: ['ok' + ls + 'next'], y: [1] }],
                    layout: { title: 'pre' + ps + 'post' },
                });
                const table = makeTable(
                    [{ name: 'plotly_json', type: 'string' }],
                    [[plotlyJson]],
                );
                const html = renderAndGetHtml(table, { type: 'Plotly' });
                expect(html).toBeDefined();
                // The literal characters must not appear in the produced script;
                // they must be escape sequences (\u2028 / \u2029) instead.
                expect(html).not.toContain(ls);
                expect(html).not.toContain(ps);
                expect(html).toContain('\\u2028');
                expect(html).toContain('\\u2029');
            });
        });

        // ─── Series columns ────────────────────────────────────────────

        describe('seriesColumns', () => {
            it('pivots data by single series column into separate traces', () => {
                const table = makeTable(
                    [
                        { name: 'timestamp', type: 'datetime' },
                        { name: 'region', type: 'string' },
                        { name: 'count', type: 'int' },
                    ],
                    [
                        ['2024-01-01', 'East', 10],
                        ['2024-01-01', 'West', 20],
                        ['2024-01-02', 'East', 15],
                        ['2024-01-02', 'West', 25],
                    ],
                );
                const html = renderAndGetHtml(table, {
                    type: 'Line',
                    xColumn: 'timestamp',
                    yColumns: ['count'],
                    seriesColumns: ['region'],
                });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                expect(traces.length).toBe(2);

                const east = traces[0] as Record<string, unknown>;
                expect(east.name).toBe('East');
                expect(east.x).toEqual(['2024-01-01', '2024-01-02']);
                expect(east.y).toEqual([10, 15]);

                const west = traces[1] as Record<string, unknown>;
                expect(west.name).toBe('West');
                expect(west.x).toEqual(['2024-01-01', '2024-01-02']);
                expect(west.y).toEqual([20, 25]);
            });

            it('pivots by two series columns using combined key', () => {
                const table = makeTable(
                    [
                        { name: 'timestamp', type: 'datetime' },
                        { name: 'region', type: 'string' },
                        { name: 'product', type: 'string' },
                        { name: 'count', type: 'int' },
                    ],
                    [
                        ['2024-01-01', 'East', 'Widget', 10],
                        ['2024-01-01', 'West', 'Gadget', 20],
                        ['2024-01-02', 'East', 'Widget', 15],
                        ['2024-01-02', 'West', 'Gadget', 25],
                    ],
                );
                const html = renderAndGetHtml(table, {
                    type: 'Line',
                    xColumn: 'timestamp',
                    yColumns: ['count'],
                    seriesColumns: ['region', 'product'],
                });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                expect(traces.length).toBe(2);
                expect((traces[0] as Record<string, unknown>).name).toBe('East - Widget');
                expect((traces[1] as Record<string, unknown>).name).toBe('West - Gadget');
            });

            it('creates series × yColumns traces when both are set', () => {
                const table = makeTable(
                    [
                        { name: 'timestamp', type: 'datetime' },
                        { name: 'region', type: 'string' },
                        { name: 'sales', type: 'int' },
                        { name: 'profit', type: 'int' },
                    ],
                    [
                        ['2024-01-01', 'East', 10, 2],
                        ['2024-01-01', 'West', 20, 5],
                        ['2024-01-02', 'East', 15, 3],
                        ['2024-01-02', 'West', 25, 7],
                    ],
                );
                const html = renderAndGetHtml(table, {
                    type: 'Column',
                    xColumn: 'timestamp',
                    yColumns: ['sales', 'profit'],
                    seriesColumns: ['region'],
                });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                expect(traces.length).toBe(4);
                expect((traces[0] as Record<string, unknown>).name).toBe('East - sales');
                expect((traces[1] as Record<string, unknown>).name).toBe('East - profit');
                expect((traces[2] as Record<string, unknown>).name).toBe('West - sales');
                expect((traces[3] as Record<string, unknown>).name).toBe('West - profit');
            });

            it('auto-excludes series columns from y-columns', () => {
                const table = makeTable(
                    [
                        { name: 'timestamp', type: 'datetime' },
                        { name: 'region', type: 'string' },
                        { name: 'count', type: 'int' },
                    ],
                    [
                        ['2024-01-01', 'East', 10],
                        ['2024-01-01', 'West', 20],
                    ],
                );
                // No explicit yColumns — should auto-detect 'count' only, not 'region'
                const html = renderAndGetHtml(table, {
                    type: 'Line',
                    xColumn: 'timestamp',
                    seriesColumns: ['region'],
                });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                expect(traces.length).toBe(2);
                expect((traces[0] as Record<string, unknown>).name).toBe('East');
                expect((traces[1] as Record<string, unknown>).name).toBe('West');
            });

            it('works with bar chart', () => {
                const table = makeTable(
                    [
                        { name: 'category', type: 'string' },
                        { name: 'group', type: 'string' },
                        { name: 'value', type: 'int' },
                    ],
                    [
                        ['A', 'X', 10],
                        ['A', 'Y', 20],
                        ['B', 'X', 30],
                        ['B', 'Y', 40],
                    ],
                );
                const html = renderAndGetHtml(table, {
                    type: 'Bar',
                    xColumn: 'category',
                    yColumns: ['value'],
                    seriesColumns: ['group'],
                });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                expect(traces.length).toBe(2);
                expect((traces[0] as Record<string, unknown>).name).toBe('X');
                expect((traces[1] as Record<string, unknown>).name).toBe('Y');
            });

            it('sorts data by x-value within each series group', () => {
                const table = makeTable(
                    [
                        { name: 'timestamp', type: 'datetime' },
                        { name: 'region', type: 'string' },
                        { name: 'count', type: 'int' },
                    ],
                    [
                        // Interleaved so East/West x-values are not in order within their groups
                        ['2024-01-02', 'East', 15],
                        ['2024-01-01', 'West', 20],
                        ['2024-01-01', 'East', 10],
                        ['2024-01-02', 'West', 25],
                    ],
                );
                const html = renderAndGetHtml(table, {
                    type: 'Line',
                    xColumn: 'timestamp',
                    yColumns: ['count'],
                    seriesColumns: ['region'],
                });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                const east = traces[0] as Record<string, unknown>;
                expect(east.x).toEqual(['2024-01-01', '2024-01-02']);
                expect(east.y).toEqual([10, 15]);
                const west = traces[1] as Record<string, unknown>;
                expect(west.x).toEqual(['2024-01-01', '2024-01-02']);
                expect(west.y).toEqual([20, 25]);
            });

            it('preserves order when data is already sorted by x (monotonic fast path)', () => {
                // Already-sorted input exercises the no-allocation fast path.
                // Output must still match input order exactly.
                const table = makeTable(
                    [
                        { name: 'timestamp', type: 'datetime' },
                        { name: 'region', type: 'string' },
                        { name: 'count', type: 'int' },
                    ],
                    [
                        ['2024-01-01', 'East', 10],
                        ['2024-01-02', 'East', 15],
                        ['2024-01-03', 'East', 20],
                        ['2024-01-04', 'East', 25],
                    ],
                );
                const html = renderAndGetHtml(table, {
                    type: 'Line',
                    xColumn: 'timestamp',
                    yColumns: ['count'],
                    seriesColumns: ['region'],
                });
                const east = parseTraces(html!)[0] as Record<string, unknown>;
                expect(east.x).toEqual(['2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04']);
                expect(east.y).toEqual([10, 15, 20, 25]);
            });

            it('preserves equal-x runs as stable in already-sorted input', () => {
                // Non-decreasing (with equal x's) is the fast-path predicate; verify ties
                // are kept in input order.
                const table = makeTable(
                    [
                        { name: 'timestamp', type: 'datetime' },
                        { name: 'count', type: 'int' },
                    ],
                    [
                        ['2024-01-01', 1],
                        ['2024-01-01', 2],
                        ['2024-01-02', 3],
                        ['2024-01-02', 4],
                    ],
                );
                const html = renderAndGetHtml(table, {
                    type: 'Line',
                    xColumn: 'timestamp',
                    yColumns: ['count'],
                });
                const trace = parseTraces(html!)[0] as Record<string, unknown>;
                expect(trace.x).toEqual(['2024-01-01', '2024-01-01', '2024-01-02', '2024-01-02']);
                expect(trace.y).toEqual([1, 2, 3, 4]);
            });
        });

        // ─── Auto-inference ─────────────────────────────────────────────

        describe('auto-inference', () => {
            it('infers series column from first non-x string column when seriesColumns is not set', () => {
                const table = makeTable(
                    [
                        { name: 'timestamp', type: 'datetime' },
                        { name: 'region', type: 'string' },
                        { name: 'count', type: 'int' },
                    ],
                    [
                        ['2024-01-01', 'East', 10],
                        ['2024-01-01', 'West', 20],
                        ['2024-01-02', 'East', 15],
                        ['2024-01-02', 'West', 25],
                    ],
                );
                const html = renderAndGetHtml(table, { type: 'TimeLine' });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                expect(traces.length).toBe(2);
                expect((traces[0] as Record<string, unknown>).name).toBe('East');
                expect((traces[1] as Record<string, unknown>).name).toBe('West');
            });

            it('does not infer series column when all non-x columns are numeric', () => {
                const table = makeTable(
                    [
                        { name: 'timestamp', type: 'datetime' },
                        { name: 'sales', type: 'int' },
                        { name: 'profit', type: 'int' },
                    ],
                    [
                        ['2024-01-01', 10, 2],
                        ['2024-01-02', 15, 3],
                    ],
                );
                const html = renderAndGetHtml(table, { type: 'TimeLine' });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                // One trace per numeric column, no series pivoting
                expect(traces.length).toBe(2);
                expect((traces[0] as Record<string, unknown>).name).toBe('sales');
                expect((traces[1] as Record<string, unknown>).name).toBe('profit');
            });

            it('infers series for non-time chart types', () => {
                const table = makeTable(
                    [
                        { name: 'category', type: 'string' },
                        { name: 'region', type: 'string' },
                        { name: 'value', type: 'int' },
                    ],
                    [
                        ['A', 'East', 10],
                        ['A', 'West', 20],
                        ['B', 'East', 30],
                        ['B', 'West', 40],
                    ],
                );
                // x=category (first col), inferred series=region, y=value
                const html = renderAndGetHtml(table, { type: 'Column' });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                expect(traces.length).toBe(2);
                expect((traces[0] as Record<string, unknown>).name).toBe('East');
                expect((traces[1] as Record<string, unknown>).name).toBe('West');
            });

            it('does not override explicitly set seriesColumns', () => {
                const table = makeTable(
                    [
                        { name: 'timestamp', type: 'datetime' },
                        { name: 'region', type: 'string' },
                        { name: 'product', type: 'string' },
                        { name: 'count', type: 'int' },
                    ],
                    [
                        ['2024-01-01', 'East', 'Widget', 10],
                        ['2024-01-01', 'West', 'Gadget', 20],
                    ],
                );
                // Explicitly set product as series, not region
                const html = renderAndGetHtml(table, {
                    type: 'Line',
                    seriesColumns: ['product'],
                });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                expect(traces.length).toBe(2);
                expect((traces[0] as Record<string, unknown>).name).toBe('Widget');
                expect((traces[1] as Record<string, unknown>).name).toBe('Gadget');
            });

            it('renders pivotchart as linechart with auto-inferred series', () => {
                const table = makeTable(
                    [
                        { name: 'category', type: 'string' },
                        { name: 'region', type: 'string' },
                        { name: 'value', type: 'int' },
                    ],
                    [
                        ['A', 'East', 10],
                        ['A', 'West', 20],
                        ['B', 'East', 30],
                    ],
                );
                const html = renderAndGetHtml(table, { type: 'Line' });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                expect(traces.length).toBe(2);
                expect((traces[0] as Record<string, unknown>).name).toBe('East');
                expect((traces[1] as Record<string, unknown>).name).toBe('West');
                // Should render as line traces (scatter with mode lines)
                expect((traces[0] as Record<string, unknown>).mode).toBe('lines');
            });

            it('renders timepivot with HTML time pivot viewer', () => {
                const table = makeTable(
                    [
                        { name: 'start', type: 'datetime' },
                        { name: 'end', type: 'datetime' },
                        { name: 'task', type: 'string' },
                    ],
                    [
                        ['2024-01-01', '2024-01-05', 'Task A'],
                        ['2024-01-03', '2024-01-07', 'Task B'],
                    ],
                );
                const html = renderAndGetHtml(table, { type: 'TimePivot' });
                expect(html).toBeDefined();
                // HTML-based renderer, not Plotly
                expect(html).toContain('tp-container');
                expect(html).toContain('tp-segment');
                expect(html).toContain('>Task A<');
                expect(html).toContain('>Task B<');
            });
        });

        // ─── Binning & Aggregation ──────────────────────────────────────

        describe('binning and aggregation', () => {
            it('bins datetime x-values by day and sums y-values', () => {
                const table = makeTable(
                    [
                        { name: 'timestamp', type: 'datetime' },
                        { name: 'value', type: 'int' },
                    ],
                    [
                        ['2024-01-01T10:00:00Z', 5],
                        ['2024-01-01T14:00:00Z', 3],
                        ['2024-01-02T08:00:00Z', 10],
                        ['2024-01-02T20:00:00Z', 2],
                    ],
                );
                const html = renderAndGetHtml(table, {
                    type: 'TimeLine',
                    binSize: '1d',
                    aggregation: 'Sum',
                });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                expect(traces.length).toBe(1);
                const trace = traces[0] as Record<string, unknown>;
                expect((trace.y as number[]).length).toBe(2);
                expect((trace.y as number[])[0]).toBe(8);  // 5 + 3
                expect((trace.y as number[])[1]).toBe(12); // 10 + 2
            });

            it('bins datetime x-values by hour and counts', () => {
                const table = makeTable(
                    [
                        { name: 'timestamp', type: 'datetime' },
                        { name: 'value', type: 'int' },
                    ],
                    [
                        ['2024-01-01T10:05:00Z', 1],
                        ['2024-01-01T10:30:00Z', 2],
                        ['2024-01-01T10:59:00Z', 3],
                        ['2024-01-01T11:15:00Z', 4],
                    ],
                );
                const html = renderAndGetHtml(table, {
                    type: 'TimeLine',
                    binSize: '1h',
                    aggregation: 'Count',
                });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                const trace = traces[0] as Record<string, unknown>;
                expect((trace.y as number[])[0]).toBe(3); // 3 values in 10:xx
                expect((trace.y as number[])[1]).toBe(1); // 1 value in 11:xx
            });

            it('bins with average aggregation', () => {
                const table = makeTable(
                    [
                        { name: 'timestamp', type: 'datetime' },
                        { name: 'value', type: 'int' },
                    ],
                    [
                        ['2024-01-01T00:00:00Z', 10],
                        ['2024-01-01T12:00:00Z', 20],
                        ['2024-01-02T00:00:00Z', 30],
                    ],
                );
                const html = renderAndGetHtml(table, {
                    type: 'TimeLine',
                    binSize: '1d',
                    aggregation: 'Average',
                });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                const trace = traces[0] as Record<string, unknown>;
                expect((trace.y as number[])[0]).toBe(15); // (10+20)/2
                expect((trace.y as number[])[1]).toBe(30);
            });

            it('bins numeric x-values by width', () => {
                const table = makeTable(
                    [
                        { name: 'x', type: 'real' },
                        { name: 'y', type: 'int' },
                    ],
                    [
                        [1.5, 10],
                        [3.2, 20],
                        [7.8, 15],
                        [8.1, 5],
                    ],
                );
                const html = renderAndGetHtml(table, {
                    type: 'Line',
                    binSize: '5',
                    aggregation: 'Sum',
                });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                const trace = traces[0] as Record<string, unknown>;
                // bin 0: 1.5, 3.2 → sum 30
                // bin 5: 7.8, 8.1 → sum 20
                expect((trace.x as number[])).toEqual([0, 5]);
                expect((trace.y as number[])).toEqual([30, 20]);
            });

            it('applies binning with series columns', () => {
                const table = makeTable(
                    [
                        { name: 'timestamp', type: 'datetime' },
                        { name: 'region', type: 'string' },
                        { name: 'value', type: 'int' },
                    ],
                    [
                        ['2024-01-01T10:00:00Z', 'East', 5],
                        ['2024-01-01T14:00:00Z', 'East', 3],
                        ['2024-01-01T10:00:00Z', 'West', 10],
                        ['2024-01-01T14:00:00Z', 'West', 20],
                    ],
                );
                const html = renderAndGetHtml(table, {
                    type: 'TimeLine',
                    seriesColumns: ['region'],
                    binSize: '1d',
                    aggregation: 'Sum',
                });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                expect(traces.length).toBe(2);
                const east = traces[0] as Record<string, unknown>;
                expect(east.name).toBe('East');
                expect((east.y as number[])[0]).toBe(8); // 5 + 3
                const west = traces[1] as Record<string, unknown>;
                expect(west.name).toBe('West');
                expect((west.y as number[])[0]).toBe(30); // 10 + 20
            });

            it('does not bin when binSize is not set', () => {
                const table = makeTable(
                    [
                        { name: 'timestamp', type: 'datetime' },
                        { name: 'value', type: 'int' },
                    ],
                    [
                        ['2024-01-01T10:00:00Z', 5],
                        ['2024-01-01T14:00:00Z', 3],
                    ],
                );
                const html = renderAndGetHtml(table, { type: 'TimeLine' });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                const trace = traces[0] as Record<string, unknown>;
                expect((trace.y as number[]).length).toBe(2); // no aggregation
            });

            it('parses various KQL timespan suffixes', () => {
                const table = makeTable(
                    [
                        { name: 'timestamp', type: 'datetime' },
                        { name: 'value', type: 'int' },
                    ],
                    [
                        ['2024-01-01T00:00:00Z', 1],
                        ['2024-01-01T00:00:30Z', 2],
                        ['2024-01-01T00:01:00Z', 3],
                        ['2024-01-01T00:01:30Z', 4],
                    ],
                );
                // Bin by 1 minute
                const html = renderAndGetHtml(table, {
                    type: 'TimeLine',
                    binSize: '1minute',
                    aggregation: 'Sum',
                });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                const trace = traces[0] as Record<string, unknown>;
                expect((trace.y as number[])[0]).toBe(3);  // 1 + 2
                expect((trace.y as number[])[1]).toBe(7);  // 3 + 4
            });

            it('supports min aggregation', () => {
                const table = makeTable(
                    [
                        { name: 'timestamp', type: 'datetime' },
                        { name: 'value', type: 'int' },
                    ],
                    [
                        ['2024-01-01T00:00:00Z', 10],
                        ['2024-01-01T12:00:00Z', 20],
                        ['2024-01-01T18:00:00Z', 5],
                    ],
                );
                const html = renderAndGetHtml(table, {
                    type: 'TimeLine',
                    binSize: '1d',
                    aggregation: 'Min',
                });
                expect(html).toBeDefined();
                const trace = parseTraces(html!)[0] as Record<string, unknown>;
                expect((trace.y as number[])[0]).toBe(5);
            });

            it('supports max aggregation', () => {
                const table = makeTable(
                    [
                        { name: 'timestamp', type: 'datetime' },
                        { name: 'value', type: 'int' },
                    ],
                    [
                        ['2024-01-01T00:00:00Z', 10],
                        ['2024-01-01T12:00:00Z', 20],
                        ['2024-01-01T18:00:00Z', 5],
                    ],
                );
                const html = renderAndGetHtml(table, {
                    type: 'TimeLine',
                    binSize: '1d',
                    aggregation: 'Max',
                });
                expect(html).toBeDefined();
                const trace = parseTraces(html!)[0] as Record<string, unknown>;
                expect((trace.y as number[])[0]).toBe(20);
            });
        });

        // ─── Max Series & Max Points ────────────────────────────────────

        describe('max series', () => {
            it('limits to top N series by total y-value', () => {
                const table = makeTable(
                    [
                        { name: 'timestamp', type: 'datetime' },
                        { name: 'region', type: 'string' },
                        { name: 'value', type: 'int' },
                    ],
                    [
                        ['2024-01-01', 'Small', 1],
                        ['2024-01-01', 'Big', 100],
                        ['2024-01-01', 'Medium', 50],
                        ['2024-01-02', 'Small', 2],
                        ['2024-01-02', 'Big', 200],
                        ['2024-01-02', 'Medium', 60],
                    ],
                );
                const html = renderAndGetHtml(table, {
                    type: 'TimeLine',
                    seriesColumns: ['region'],
                    maxSeries: 2,
                });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                expect(traces.length).toBe(2);
                const names = traces.map(t => (t as Record<string, unknown>).name);
                expect(names).toContain('Big');
                expect(names).toContain('Medium');
                expect(names).not.toContain('Small');
            });

            it('does not limit when maxSeries is not set', () => {
                const table = makeTable(
                    [
                        { name: 'timestamp', type: 'datetime' },
                        { name: 'region', type: 'string' },
                        { name: 'value', type: 'int' },
                    ],
                    [
                        ['2024-01-01', 'A', 1],
                        ['2024-01-01', 'B', 2],
                        ['2024-01-01', 'C', 3],
                    ],
                );
                const html = renderAndGetHtml(table, {
                    type: 'TimeLine',
                    seriesColumns: ['region'],
                });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                expect(traces.length).toBe(3);
            });
        });

        describe('max points per series', () => {
            it('downsamples traces that exceed the limit', () => {
                const rows: unknown[][] = [];
                for (let i = 0; i < 100; i++) {
                    rows.push([`2024-01-01T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`, i]);
                }
                const table = makeTable(
                    [
                        { name: 'timestamp', type: 'datetime' },
                        { name: 'value', type: 'int' },
                    ],
                    rows,
                );
                const html = renderAndGetHtml(table, {
                    type: 'TimeLine',
                    maxPointsPerSeries: 10,
                });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                const trace = traces[0] as Record<string, unknown>;
                expect((trace.x as unknown[]).length).toBe(10);
                expect((trace.y as number[]).length).toBe(10);
            });

            it('does not downsample when under the limit', () => {
                const table = makeTable(
                    [
                        { name: 'timestamp', type: 'datetime' },
                        { name: 'value', type: 'int' },
                    ],
                    [
                        ['2024-01-01', 10],
                        ['2024-01-02', 20],
                        ['2024-01-03', 30],
                    ],
                );
                const html = renderAndGetHtml(table, {
                    type: 'TimeLine',
                    maxPointsPerSeries: 100,
                });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                const trace = traces[0] as Record<string, unknown>;
                expect((trace.x as unknown[]).length).toBe(3);
            });

            it('preserves first and last points when downsampling', () => {
                const rows: unknown[][] = [];
                for (let i = 0; i < 50; i++) {
                    rows.push([i, i * 10]);
                }
                const table = makeTable(
                    [
                        { name: 'x', type: 'int' },
                        { name: 'y', type: 'int' },
                    ],
                    rows,
                );
                const html = renderAndGetHtml(table, {
                    type: 'Line',
                    xColumn: 'x',
                    yColumns: ['y'],
                    maxPointsPerSeries: 5,
                });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                const trace = traces[0] as Record<string, unknown>;
                const xVals = trace.x as number[];
                expect(xVals.length).toBe(5);
                expect(xVals[0]).toBe(0);             // first point
                expect(xVals[xVals.length - 1]).toBe(49); // last point
            });

            it('accumulates y-values before downsampling', () => {
                const rows: unknown[][] = [];
                for (let i = 0; i < 5; i++) {
                    rows.push([i, 1]);
                }
                const table = makeTable(
                    [
                        { name: 'x', type: 'int' },
                        { name: 'y', type: 'int' },
                    ],
                    rows,
                );
                const html = renderAndGetHtml(table, {
                    type: 'Line',
                    xColumn: 'x',
                    yColumns: ['y'],
                    accumulate: true,
                    maxPointsPerSeries: 3,
                });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                const trace = traces[0] as Record<string, unknown>;

                expect(trace.x).toEqual([0, 2, 4]);
                expect(trace.y).toEqual([1, 3, 5]);
            });

            it('accumulates separately for each grouped series', () => {
                const table = makeTable(
                    [
                        { name: 'x', type: 'int' },
                        { name: 'region', type: 'string' },
                        { name: 'y', type: 'int' },
                    ],
                    [
                        [2, 'East', 3],
                        [1, 'East', 2],
                        [2, 'West', 7],
                        [1, 'West', 5],
                    ],
                );
                const html = renderAndGetHtml(table, {
                    type: 'Line',
                    xColumn: 'x',
                    yColumns: ['y'],
                    seriesColumns: ['region'],
                    accumulate: true,
                });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                expect(traces.length).toBe(2);

                const east = traces.find(t => (t as Record<string, unknown>).name === 'East') as Record<string, unknown> | undefined;
                const west = traces.find(t => (t as Record<string, unknown>).name === 'West') as Record<string, unknown> | undefined;
                expect(east).toBeDefined();
                expect(west).toBeDefined();
                expect(east!.x).toEqual([1, 2]);
                expect(east!.y).toEqual([2, 5]);
                expect(west!.x).toEqual([1, 2]);
                expect(west!.y).toEqual([5, 12]);
            });

            it('accumulates each y-column independently for multi-y traces', () => {
                const table = makeTable(
                    [
                        { name: 'x', type: 'int' },
                        { name: 'sales', type: 'int' },
                        { name: 'profit', type: 'int' },
                    ],
                    [
                        [3, 4, 40],
                        [1, 2, 10],
                        [2, 3, 20],
                    ],
                );
                const html = renderAndGetHtml(table, {
                    type: 'Line',
                    xColumn: 'x',
                    yColumns: ['sales', 'profit'],
                    accumulate: true,
                });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                expect(traces.length).toBe(2);

                const sales = traces.find(t => (t as Record<string, unknown>).name === 'sales') as Record<string, unknown> | undefined;
                const profit = traces.find(t => (t as Record<string, unknown>).name === 'profit') as Record<string, unknown> | undefined;
                expect(sales).toBeDefined();
                expect(profit).toBeDefined();
                expect(sales!.x).toEqual([1, 2, 3]);
                expect(sales!.y).toEqual([2, 5, 9]);
                expect(profit!.x).toEqual([1, 2, 3]);
                expect(profit!.y).toEqual([10, 30, 70]);
            });

            it('accumulates after binning aggregated values', () => {
                const table = makeTable(
                    [
                        { name: 'timestamp', type: 'datetime' },
                        { name: 'value', type: 'int' },
                    ],
                    [
                        ['2024-01-01T01:00:00Z', 1],
                        ['2024-01-01T12:00:00Z', 2],
                        ['2024-01-02T01:00:00Z', 4],
                        ['2024-01-02T12:00:00Z', 8],
                    ],
                );
                const html = renderAndGetHtml(table, {
                    type: 'TimeLine',
                    binSize: '1d',
                    aggregation: 'Sum',
                    accumulate: true,
                });
                expect(html).toBeDefined();
                const trace = parseTraces(html!)[0] as Record<string, unknown>;

                expect(trace.y).toEqual([3, 15]);
            });
        });

        // ─── Chart options ──────────────────────────────────────────────

        describe('chart options', () => {
            it('includes title in layout', () => {
                const html = renderAndGetHtml(make2dTable(), { type: 'Column', title: 'My Chart' });
                expect(html).toBeDefined();
                const layout = parseLayout(html!);
                expect((layout.title as Record<string, unknown>)?.text).toBe('My Chart');
            });

            it('includes axis titles in layout', () => {
                const html = renderAndGetHtml(make2dTable(), {
                    type: 'Column',
                    xTitle: 'Categories',
                    yTitle: 'Values',
                });
                expect(html).toBeDefined();
                const layout = parseLayout(html!);
                expect((layout.xaxis as Record<string, unknown>)?.title).toEqual(expect.objectContaining({ text: 'Categories' }));
                expect((layout.yaxis as Record<string, unknown>)?.title).toEqual(expect.objectContaining({ text: 'Values' }));
            });

            it('hides legend when legendPosition is None', () => {
                const html = renderAndGetHtml(make2dTable(), { type: 'Column', legendPosition: 'None' });
                expect(html).toBeDefined();
                const layout = parseLayout(html!);
                expect(layout.showlegend).toBe(false);
            });

            it('sets stacked bar mode for ColumnStacked', () => {
                const html = renderAndGetHtml(makeMultiSeriesTable(), { type: 'ColumnStacked' });
                expect(html).toBeDefined();
                const layout = parseLayout(html!);
                expect(layout.barmode).toBe('stack');
            });

            it('sets log scale on x axis', () => {
                const html = renderAndGetHtml(make2dTable(), { type: 'Column', xAxis: 'Log' });
                expect(html).toBeDefined();
                const layout = parseLayout(html!);
                expect((layout.xaxis as Record<string, unknown>)?.type).toBe('log');
            });

            it('sets axis range from xMin/xMax', () => {
                const html = renderAndGetHtml(make2dTable(), {
                    type: 'Column',
                    xMin: 0,
                    xMax: 100,
                });
                expect(html).toBeDefined();
                const layout = parseLayout(html!);
                expect((layout.xaxis as Record<string, unknown>)?.range).toEqual([0, 100]);
            });

            it('sets tick visibility', () => {
                const html = renderAndGetHtml(make2dTable(), {
                    type: 'Column',
                    xShowTicks: true,
                    yShowTicks: false,
                });
                expect(html).toBeDefined();
                const layout = parseLayout(html!);
                expect((layout.xaxis as Record<string, unknown>)?.ticks).toBe('outside');
                expect((layout.yaxis as Record<string, unknown>)?.ticks).toBe('');
            });

            it('sets grid visibility', () => {
                const html = renderAndGetHtml(make2dTable(), {
                    type: 'Column',
                    xShowGrid: false,
                    yShowGrid: true,
                });
                expect(html).toBeDefined();
                const layout = parseLayout(html!);
                expect((layout.xaxis as Record<string, unknown>)?.showgrid).toBe(false);
                expect((layout.yaxis as Record<string, unknown>)?.showgrid).toBe(true);
            });

            it('sets category sort order', () => {
                const html = renderAndGetHtml(make2dTable(), { type: 'Column', sort: 'Ascending' });
                expect(html).toBeDefined();
                const layout = parseLayout(html!);
                expect((layout.xaxis as Record<string, unknown>)?.categoryorder).toBe('total ascending');
            });

            it('does not set category sort order for Auto', () => {
                const html = renderAndGetHtml(make2dTable(), { type: 'Column', sort: 'Auto' });
                expect(html).toBeDefined();
                const layout = parseLayout(html!);
                expect((layout.xaxis as Record<string, unknown>)?.categoryorder).toBeUndefined();
            });

            it('accumulates y-values in x order within a trace', () => {
                const table = makeTable(
                    [
                        { name: 'x', type: 'int' },
                        { name: 'y', type: 'int' },
                    ],
                    [
                        [3, 30],
                        [1, 10],
                        [2, 20],
                    ],
                );
                const html = renderAndGetHtml(table, {
                    type: 'Line',
                    xColumn: 'x',
                    yColumns: ['y'],
                    accumulate: true,
                });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                const trace = traces[0] as Record<string, unknown>;

                expect(trace.x).toEqual([1, 2, 3]);
                expect(trace.y).toEqual([10, 30, 60]);
            });

            it('drops NaN rows before accumulation', () => {
                const table = makeTable(
                    [
                        { name: 'x', type: 'real' },
                        { name: 'y', type: 'real' },
                    ],
                    [
                        [1, 10],
                        [2, Number.NaN],
                        [3, 30],
                    ],
                );
                const html = renderAndGetHtml(table, {
                    type: 'Line',
                    xColumn: 'x',
                    yColumns: ['y'],
                    accumulate: true,
                });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                const trace = traces[0] as Record<string, unknown>;

                expect(trace.x).toEqual([1, 3]);
                expect(trace.y).toEqual([10, 40]);
            });

            it('sets legend position to bottom', () => {
                const html = renderAndGetHtml(make2dTable(), { type: 'Column', legendPosition: 'Bottom' });
                expect(html).toBeDefined();
                const layout = parseLayout(html!);
                const legend = layout.legend as Record<string, unknown>;
                expect(legend?.orientation).toBe('h');
            });

            it('uses a secondary y-axis for DualAxis multi-y charts', () => {
                const html = renderAndGetHtml(makeMultiSeriesTable(), {
                    type: 'Line',
                    xColumn: 'Month',
                    yColumns: ['Sales', 'Profit'],
                    yLayout: 'DualAxis',
                });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                const layout = parseLayout(html!);

                expect((traces[0] as Record<string, unknown>)?.yaxis).toBeUndefined();
                expect((traces[1] as Record<string, unknown>)?.yaxis).toBe('y2');
                expect((layout.yaxis2 as Record<string, unknown>)?.overlaying).toBe('y');
                expect((layout.yaxis2 as Record<string, unknown>)?.side).toBe('right');
                expect((layout.yaxis2 as Record<string, unknown>)?.showgrid).toBe(false);
                const legend = layout.legend as Record<string, unknown>;
                expect(legend?.orientation).toBe('h');
            });

            it('creates subplot axes and domains for SeparatePanels multi-y charts', () => {
                const html = renderAndGetHtml(makeMultiSeriesTable(), {
                    type: 'Line',
                    xColumn: 'Month',
                    yColumns: ['Sales', 'Profit'],
                    yLayout: 'SeparatePanels',
                });
                expect(html).toBeDefined();
                const traces = parseTraces(html!);
                const layout = parseLayout(html!);

                expect((traces[0] as Record<string, unknown>)?.yaxis).toBe('y2');
                expect((traces[0] as Record<string, unknown>)?.xaxis).toBe('x2');
                expect((traces[1] as Record<string, unknown>)?.yaxis).toBe('y3');
                expect((traces[1] as Record<string, unknown>)?.xaxis).toBe('x3');

                expect((layout.yaxis as Record<string, unknown>)?.visible).toBe(false);
                expect((layout.xaxis as Record<string, unknown>)?.visible).toBe(false);
                expect((layout.yaxis2 as Record<string, unknown>)?.domain).toEqual([0.525, 1]);
                expect((layout.yaxis3 as Record<string, unknown>)?.domain).toEqual([0, 0.475]);
                expect((layout.xaxis2 as Record<string, unknown>)?.showticklabels).toBe(false);
                expect((layout.xaxis3 as Record<string, unknown>)?.showticklabels).toBe(true);
            });

            it('mirrors y-axis ticks when yMirror is enabled', () => {
                const html = renderAndGetHtml(make2dTable(), {
                    type: 'Column',
                    yMirror: true,
                });
                expect(html).toBeDefined();
                const layout = parseLayout(html!);

                expect((layout.yaxis as Record<string, unknown>)?.showline).toBe(true);
                expect((layout.yaxis as Record<string, unknown>)?.mirror).toBe('ticks');
            });

            it('mirrors subplot y-axes when yMirror is enabled for separate panels', () => {
                const html = renderAndGetHtml(makeMultiSeriesTable(), {
                    type: 'Line',
                    xColumn: 'Month',
                    yColumns: ['Sales', 'Profit'],
                    yLayout: 'SeparatePanels',
                    yMirror: true,
                });
                expect(html).toBeDefined();
                const layout = parseLayout(html!);

                expect((layout.yaxis2 as Record<string, unknown>)?.showline).toBe(true);
                expect((layout.yaxis2 as Record<string, unknown>)?.mirror).toBe('ticks');
                expect((layout.yaxis3 as Record<string, unknown>)?.showline).toBe(true);
                expect((layout.yaxis3 as Record<string, unknown>)?.mirror).toBe('ticks');
            });

            it('does not apply yMirror in DualAxis mode', () => {
                const html = renderAndGetHtml(makeMultiSeriesTable(), {
                    type: 'Line',
                    xColumn: 'Month',
                    yColumns: ['Sales', 'Profit'],
                    yLayout: 'DualAxis',
                    yMirror: true,
                });
                expect(html).toBeDefined();
                const layout = parseLayout(html!);

                expect((layout.yaxis as Record<string, unknown>)?.mirror).not.toBe('ticks');
                expect((layout.yaxis2 as Record<string, unknown>)?.mirror).toBeUndefined();
            });
        });

        // ─── Dark mode ─────────────────────────────────────────────────

        describe('dark mode', () => {
            it('applies dark mode colors to layout', () => {
                const html = renderAndGetHtml(make2dTable(), { type: 'Column' }, true);
                expect(html).toBeDefined();
                const layout = parseLayout(html!);
                expect(layout.paper_bgcolor).toBe('#1e1e1e');
                expect(layout.plot_bgcolor).toBe('#1e1e1e');
                expect((layout.font as Record<string, unknown>)?.color).toBe('#f2f5fa');
            });

            it('applies dark mode to raw Plotly chart layout', () => {
                const plotlyJson = JSON.stringify({
                    data: [{ type: 'bar', x: [1], y: [2] }],
                    layout: { title: 'Test' },
                });
                const table = makeTable(
                    [{ name: 'json', type: 'string' }],
                    [[plotlyJson]],
                );
                const html = renderAndGetHtml(table, { type: 'Plotly' }, true);
                expect(html).toBeDefined();
                const layout = parseLayout(html!);
                expect(layout.paper_bgcolor).toBe('#1e1e1e');
            });
        });
    });
});
