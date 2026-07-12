// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { GraphChartProvider } from '../../features/graphChartProvider';
import type { IWebView } from '../../features/webview';
import type { ResultTable, ChartOptions, ResultChartView } from '../../features/server';
import type { ChartRenderContext } from '../../features/chartProvider';

// ─── Mock IWebView ──────────────────────────────────────────────────────────

interface MockWebView {
    webview: IWebView & {
        setup: ReturnType<typeof vi.fn>;
        setContent: ReturnType<typeof vi.fn>;
        invoke: ReturnType<typeof vi.fn>;
    };
    /** Simulate a message coming back from the page to the host. */
    send(message: Record<string, unknown>): void;
    /** The HTML of the most recent setContent call (or undefined). */
    lastHtml(): string | undefined;
}

function createMockWebView(): MockWebView {
    let handler: ((message: Record<string, unknown>) => void) | undefined;
    const setContent = vi.fn<IWebView['setContent']>();
    const webview = {
        setup: vi.fn<IWebView['setup']>(),
        setContent,
        invoke: vi.fn<IWebView['invoke']>(),
        handle: vi.fn((h: (message: Record<string, unknown>) => void) => {
            handler = h;
            return { dispose: () => { } };
        }),
    } as MockWebView['webview'];
    return {
        webview,
        send: (message) => handler?.(message),
        lastHtml: () => {
            const calls = setContent.mock.calls;
            return calls.length ? (calls[calls.length - 1]?.[0] as string) : undefined;
        },
    };
}

// ─── Test Data Helpers ──────────────────────────────────────────────────────

function makeTable(name: string, columns: { name: string; type: string }[], rows: unknown[][]): ResultTable {
    return { name, columns, rows };
}

function edgesTable(rows: unknown[][], cols?: { name: string; type: string }[]): ResultTable {
    return makeTable('Edges', cols ?? [{ name: 'Source', type: 'string' }, { name: 'Target', type: 'string' }], rows);
}

function defaultOptions(): ChartOptions {
    return { type: 'Graph' };
}

/** Extract the deterministic layout seed embedded in the page script. */
function extractSeed(html: string): number | undefined {
    const m = html.match(/var layoutSeed = \((\d+) >>> 0\)/);
    return m ? Number(m[1]) : undefined;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('GraphChartProvider', () => {
    let provider: GraphChartProvider;

    beforeEach(() => {
        provider = new GraphChartProvider();
    });

    describe('createView', () => {
        it('returns a view with renderChart and dispose', () => {
            const m = createMockWebView();
            const view = provider.createView(m.webview);

            expect(view).toBeDefined();
            expect(typeof view.renderChart).toBe('function');
            expect(typeof view.dispose).toBe('function');

            view.dispose();
        });

        it('calls webview.setup with the Cytoscape script dependency', () => {
            const m = createMockWebView();
            provider.createView(m.webview);

            expect(m.webview.setup).toHaveBeenCalledTimes(1);
            const head = m.webview.setup.mock.calls[0]?.[0] as string;
            expect(head).toContain('cytoscape');
            expect(head).toContain('defer');
        });
    });

    describe('renderChart — validation', () => {
        it('renders an error fallback when the table has fewer than 2 columns', () => {
            const m = createMockWebView();
            const view = provider.createView(m.webview);

            const table = makeTable('Edges', [{ name: 'Source', type: 'string' }], [['A']]);
            view.renderChart(table, defaultOptions(), false);

            expect(m.webview.setContent).toHaveBeenCalledTimes(1);
            expect(m.lastHtml()).toContain('at least two columns');
            view.dispose();
        });

        it('renders an error fallback when the table has no rows', () => {
            const m = createMockWebView();
            const view = provider.createView(m.webview);

            view.renderChart(edgesTable([]), defaultOptions(), false);

            expect(m.lastHtml()).toContain('at least two columns');
            view.dispose();
        });

        it('renders an error fallback when every edge row has a null endpoint', () => {
            const m = createMockWebView();
            const view = provider.createView(m.webview);

            view.renderChart(edgesTable([[null, null], ['A', null]]), defaultOptions(), false);

            // No nodes were produced → error fallback.
            expect(m.lastHtml()).toContain('at least two columns');
            view.dispose();
        });
    });

    describe('renderChart — edges-only mode', () => {
        it('synthesizes nodes from edge endpoints and embeds them in the page', () => {
            const m = createMockWebView();
            const view = provider.createView(m.webview);

            view.renderChart(edgesTable([['Alice', 'Bob'], ['Bob', 'Carol']]), defaultOptions(), false);

            const html = m.lastHtml() ?? '';
            expect(html).toContain('Alice');
            expect(html).toContain('Bob');
            expect(html).toContain('Carol');
            expect(html).toContain('gc-cy'); // graph container
            view.dispose();
        });

        it('honors explicit source/target column overrides', () => {
            const m = createMockWebView();
            const view = provider.createView(m.webview);

            const table = makeTable('Edges',
                [{ name: 'From', type: 'string' }, { name: 'Ignored', type: 'string' }, { name: 'To', type: 'string' }],
                [['X', 'junk', 'Y']],
            );
            const options: ChartOptions = { type: 'Graph', xColumn: 'From', yColumns: ['To'] };
            view.renderChart(table, options, false);

            const html = m.lastHtml() ?? '';
            expect(html).toContain('"source":"X"');
            expect(html).toContain('"target":"Y"');
            view.dispose();
        });
    });

    describe('renderChart — nodes table auto-detection', () => {
        it('uses a sibling table named "nodes" and detects id/label/kind columns by name', () => {
            const m = createMockWebView();
            const view = provider.createView(m.webview);

            const edges = edgesTable([['n1', 'n2']]);
            const nodes = makeTable('Nodes',
                [
                    { name: 'Id', type: 'string' },
                    { name: 'Label', type: 'string' },
                    { name: 'Kind', type: 'string' },
                ],
                [
                    ['n1', 'First Node', 'server'],
                    ['n2', 'Second Node', 'client'],
                ],
            );
            const ctx: ChartRenderContext = { tables: [edges, nodes] };
            view.renderChart(edges, defaultOptions(), false, ctx);

            const html = m.lastHtml() ?? '';
            expect(html).toContain('First Node');
            expect(html).toContain('Second Node');
            // Kinds drive the legend and per-kind styling.
            expect(html).toContain('server');
            expect(html).toContain('client');
            view.dispose();
        });

        it('stays edges-only when multiple ambiguous sibling tables exist', () => {
            const m = createMockWebView();
            const view = provider.createView(m.webview);

            const edges = edgesTable([['a', 'b']]);
            const t1 = makeTable('Extra1', [{ name: 'x', type: 'string' }], [['p']]);
            const t2 = makeTable('Extra2', [{ name: 'y', type: 'string' }], [['q']]);
            const ctx: ChartRenderContext = { tables: [edges, t1, t2] };
            view.renderChart(edges, defaultOptions(), false, ctx);

            const html = m.lastHtml() ?? '';
            // Nodes synthesized from edges only; the ambiguous tables aren't used.
            expect(html).toContain('"id":"a"');
            expect(html).toContain('"id":"b"');
            expect(html).not.toContain('"p"');
            view.dispose();
        });

        it('does NOT auto-pick a single unrelated sibling table (only one named "nodes")', () => {
            const m = createMockWebView();
            const view = provider.createView(m.webview);

            const edges = edgesTable([['a', 'b']]);
            // A lone sibling NOT named "nodes" must not be adopted.
            const unrelated = makeTable('Lookup',
                [{ name: 'id', type: 'string' }, { name: 'label', type: 'string' }],
                [['a', 'Should Not Appear']],
            );
            const ctx: ChartRenderContext = { tables: [edges, unrelated] };
            view.renderChart(edges, defaultOptions(), false, ctx);

            const html = m.lastHtml() ?? '';
            expect(html).not.toContain('Should Not Appear');
            expect(html).toContain('"id":"a"');
            view.dispose();
        });
    });

    describe('deterministic seeding', () => {
        it('produces the same seed for identical data across renders', () => {
            const m1 = createMockWebView();
            const v1 = provider.createView(m1.webview);
            const m2 = createMockWebView();
            const v2 = provider.createView(m2.webview);

            v1.renderChart(edgesTable([['A', 'B'], ['B', 'C']]), defaultOptions(), false);
            v2.renderChart(edgesTable([['A', 'B'], ['B', 'C']]), defaultOptions(), false);

            const s1 = extractSeed(m1.lastHtml() ?? '');
            const s2 = extractSeed(m2.lastHtml() ?? '');
            expect(s1).toBeDefined();
            expect(s1).toBe(s2);
            v1.dispose();
            v2.dispose();
        });

        it('produces the same seed regardless of edge row order', () => {
            const m1 = createMockWebView();
            const v1 = provider.createView(m1.webview);
            const m2 = createMockWebView();
            const v2 = provider.createView(m2.webview);

            v1.renderChart(edgesTable([['A', 'B'], ['B', 'C'], ['C', 'D']]), defaultOptions(), false);
            v2.renderChart(edgesTable([['C', 'D'], ['A', 'B'], ['B', 'C']]), defaultOptions(), false);

            expect(extractSeed(m1.lastHtml() ?? '')).toBe(extractSeed(m2.lastHtml() ?? ''));
            v1.dispose();
            v2.dispose();
        });

        it('produces different seeds for different graphs', () => {
            const m1 = createMockWebView();
            const v1 = provider.createView(m1.webview);
            const m2 = createMockWebView();
            const v2 = provider.createView(m2.webview);

            v1.renderChart(edgesTable([['A', 'B']]), defaultOptions(), false);
            v2.renderChart(edgesTable([['X', 'Y']]), defaultOptions(), false);

            expect(extractSeed(m1.lastHtml() ?? '')).not.toBe(extractSeed(m2.lastHtml() ?? ''));
            v1.dispose();
            v2.dispose();
        });

        it('uses the seed from persisted view state when provided', () => {
            const m = createMockWebView();
            const view = provider.createView(m.webview);

            const viewState: ResultChartView = { graph: { seed: 123456 } };
            view.renderChart(edgesTable([['A', 'B']]), defaultOptions(), false, undefined, viewState);

            expect(extractSeed(m.lastHtml() ?? '')).toBe(123456);
            view.dispose();
        });
    });

    describe('persisted view state (positions)', () => {
        it('adopts saved positions and pins them via a preset layout', () => {
            const m = createMockWebView();
            const view = provider.createView(m.webview);

            const viewState: ResultChartView = {
                graph: { positions: { A: { x: 10, y: 20 }, B: { x: 30, y: 40 } } },
            };
            view.renderChart(edgesTable([['A', 'B']]), defaultOptions(), false, undefined, viewState);

            const html = m.lastHtml() ?? '';
            expect(html).toContain('preset');
            expect(html).toContain('"A":{"x":10,"y":20}');
            view.dispose();
        });

        it('emits view state when the page reports new node positions', () => {
            const m = createMockWebView();
            const view = provider.createView(m.webview);
            const listener = vi.fn();
            view.onDidChangeViewState?.(listener);

            view.renderChart(edgesTable([['A', 'B']]), defaultOptions(), false);
            m.send({ command: 'graphChartPositions', positions: { A: { x: 1, y: 2 } }, seed: 7, manual: true });

            expect(listener).toHaveBeenCalledTimes(1);
            const state = listener.mock.calls[0]?.[0] as ResultChartView;
            expect(state.graph?.positions).toMatchObject({ A: { x: 1, y: 2 } });
            expect(state.graph?.seed).toBe(7);
            expect(state.graph?.manual).toBe(true);
            view.dispose();
        });

        it('does not re-emit identical position reports (no needless write-back)', () => {
            const m = createMockWebView();
            const view = provider.createView(m.webview);
            const listener = vi.fn();
            view.onDidChangeViewState?.(listener);

            view.renderChart(edgesTable([['A', 'B']]), defaultOptions(), false);
            const msg = { command: 'graphChartPositions', positions: { A: { x: 1, y: 2 } } };
            m.send(msg);
            m.send({ ...msg, positions: { A: { x: 1, y: 2 } } });

            expect(listener).toHaveBeenCalledTimes(1);
            view.dispose();
        });

        it('ignores position reports from a superseded render token', () => {
            const m = createMockWebView();
            const view = provider.createView(m.webview);
            const listener = vi.fn();
            view.onDidChangeViewState?.(listener);

            view.renderChart(edgesTable([['A', 'B']]), defaultOptions(), false);
            // renderToken is 1 after the first render; a stale token must be ignored.
            m.send({ command: 'graphChartPositions', positions: { A: { x: 9, y: 9 } }, token: 0 });

            expect(listener).not.toHaveBeenCalled();
            view.dispose();
        });
    });

    describe('reroll (regenerate layout)', () => {
        it('re-renders with an incremented seed when not manually adjusted', () => {
            const m = createMockWebView();
            const view = provider.createView(m.webview);

            const viewState: ResultChartView = { graph: { seed: 100 } };
            view.renderChart(edgesTable([['A', 'B']]), defaultOptions(), false, undefined, viewState);
            const before = m.webview.setContent.mock.calls.length;

            m.send({ command: 'graphChartReroll', token: 1 });

            expect(m.webview.setContent.mock.calls.length).toBe(before + 1);
            expect(extractSeed(m.lastHtml() ?? '')).toBe(101);
            view.dispose();
        });

        it('prompts for confirmation and aborts when the layout was manually adjusted', async () => {
            const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
            const m = createMockWebView();
            const view = provider.createView(m.webview);

            view.renderChart(edgesTable([['A', 'B']]), defaultOptions(), false);
            // Mark as manually adjusted.
            m.send({ command: 'graphChartPositions', positions: { A: { x: 1, y: 2 } }, manual: true });
            const before = m.webview.setContent.mock.calls.length;

            m.send({ command: 'graphChartReroll', token: 1 });
            await Promise.resolve();

            expect(warn).toHaveBeenCalledOnce();
            // User dismissed the dialog → no re-render.
            expect(m.webview.setContent.mock.calls.length).toBe(before);
            warn.mockRestore();
            view.dispose();
        });

        it('re-rolls after the user confirms the manual-discard prompt', async () => {
            const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Regenerate' as never);
            const m = createMockWebView();
            const view = provider.createView(m.webview);

            view.renderChart(edgesTable([['A', 'B']]), defaultOptions(), false);
            m.send({ command: 'graphChartPositions', positions: { A: { x: 1, y: 2 } }, manual: true });
            const before = m.webview.setContent.mock.calls.length;

            m.send({ command: 'graphChartReroll', token: 1 });
            await Promise.resolve();
            await Promise.resolve();

            expect(warn).toHaveBeenCalledOnce();
            expect(m.webview.setContent.mock.calls.length).toBe(before + 1);
            warn.mockRestore();
            view.dispose();
        });
    });
});
