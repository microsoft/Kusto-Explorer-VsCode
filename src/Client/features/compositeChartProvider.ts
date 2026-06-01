// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Composite chart provider that delegates to the appropriate
 * provider based on the chart type.
 */

import type { ChartOptions, ResultTable, ResultChartView } from './server';
import { ChartType } from './chartProvider';
import type { IChartView, IWebView, IChartProvider, ChartRenderContext } from './chartProvider';
import { PlotlyChartProvider } from './plotlyChartProvider';
import { TimePivotChartProvider } from './timePivotChartProvider';
import { GraphChartProvider } from './graphChartProvider';

/**
 * A chart view that delegates to one of two underlying views
 * depending on the chart type at render time.
 */
class CompositeChartView implements IChartView {
    onCopyResult: ((pngDataUrl: string, svgDataUrl?: string) => void) | undefined;
    onCopyError: ((error: string) => void) | undefined;

    private activeView: IChartView;

    constructor(
        private readonly plotlyView: IChartView,
        private readonly timePivotView: IChartView,
        private readonly graphView: IChartView,
    ) {
        this.activeView = plotlyView;

        // Wire up copy callbacks from all views
        plotlyView.onCopyResult = (png, svg) => this.onCopyResult?.(png, svg);
        plotlyView.onCopyError = (err) => this.onCopyError?.(err);
        timePivotView.onCopyResult = (png, svg) => this.onCopyResult?.(png, svg);
        timePivotView.onCopyError = (err) => this.onCopyError?.(err);
        graphView.onCopyResult = (png, svg) => this.onCopyResult?.(png, svg);
        graphView.onCopyError = (err) => this.onCopyError?.(err);
    }

    renderChart(data: ResultTable, options: ChartOptions, darkMode: boolean, ctx?: ChartRenderContext, viewState?: ResultChartView): void {
        if (options.type === ChartType.TimePivot) {
            this.activeView = this.timePivotView;
        } else if (options.type === ChartType.Graph) {
            this.activeView = this.graphView;
        } else {
            this.activeView = this.plotlyView;
        }
        // The plotly view caches its last structured payload and replays
        // it on `chartViewReady` after a page rebuild. When we delegate to
        // a non-Plotly view, invalidate that cache so the rebuilt page does
        // not draw the previous Plotly chart over the new HTML content.
        if (this.activeView !== this.plotlyView) {
            const plotly = this.plotlyView as IChartView & { clearReplayState?: () => void };
            plotly.clearReplayState?.();
        }
        this.activeView.renderChart(data, options, darkMode, ctx, viewState);
    }

    copyChart(): void {
        this.activeView.copyChart();
    }

    onDidChangeViewState(listener: (state: ResultChartView) => void): { dispose(): void } {
        // Forward subscriptions to all underlying views; only the graph view
        // currently emits state, but this lets the host subscribe once and
        // receive updates regardless of which delegate is active.
        const subs = [
            this.plotlyView.onDidChangeViewState?.(listener),
            this.timePivotView.onDidChangeViewState?.(listener),
            this.graphView.onDidChangeViewState?.(listener),
        ].filter((s): s is { dispose(): void } => !!s);
        return { dispose() { subs.forEach(s => s.dispose()); } };
    }

    dispose(): void {
        this.plotlyView.dispose();
        this.timePivotView.dispose();
        this.graphView.dispose();
    }
}

/**
 * Chart provider that routes TimePivot charts to the HTML-based
 * TimePivotChartProvider and all other chart types to PlotlyChartProvider.
 */
export class CompositeChartProvider implements IChartProvider {
    private readonly plotlyProvider = new PlotlyChartProvider();
    private readonly timePivotProvider = new TimePivotChartProvider();
    private readonly graphProvider = new GraphChartProvider();

    createView(webview: IWebView): IChartView {
        const plotlyView = this.plotlyProvider.createView(webview);
        const timePivotView = this.timePivotProvider.createView(webview);
        const graphView = this.graphProvider.createView(webview);
        return new CompositeChartView(plotlyView, timePivotView, graphView);
    }
}
