// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Composite chart provider that delegates to the appropriate
 * provider based on the chart type.
 */

import type { ChartOptions, ResultTable } from './server';
import { ChartType } from './chartProvider';
import type { IChartView, IWebView, IChartProvider } from './chartProvider';
import { PlotlyChartProvider } from './plotlyChartProvider';
import { TimePivotChartProvider } from './timePivotChartProvider';

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
    ) {
        this.activeView = plotlyView;

        // Wire up copy callbacks from both views
        plotlyView.onCopyResult = (png, svg) => this.onCopyResult?.(png, svg);
        plotlyView.onCopyError = (err) => this.onCopyError?.(err);
        timePivotView.onCopyResult = (png, svg) => this.onCopyResult?.(png, svg);
        timePivotView.onCopyError = (err) => this.onCopyError?.(err);
    }

    renderChart(data: ResultTable, options: ChartOptions, darkMode: boolean): void {
        if (options.type === ChartType.TimePivot) {
            this.activeView = this.timePivotView;
            // The plotly view caches its last structured payload and replays
            // it on `chartViewReady` after a page rebuild. When we delegate
            // to TimePivot, we must invalidate that cache so the rebuilt
            // page does not draw the previous plotly chart over the new
            // TimePivot HTML.
            const plotly = this.plotlyView as IChartView & { clearReplayState?: () => void };
            plotly.clearReplayState?.();
        } else {
            this.activeView = this.plotlyView;
        }
        this.activeView.renderChart(data, options, darkMode);
    }

    copyChart(): void {
        this.activeView.copyChart();
    }

    dispose(): void {
        this.plotlyView.dispose();
        this.timePivotView.dispose();
    }
}

/**
 * Chart provider that routes TimePivot charts to the HTML-based
 * TimePivotChartProvider and all other chart types to PlotlyChartProvider.
 */
export class CompositeChartProvider implements IChartProvider {
    private readonly plotlyProvider = new PlotlyChartProvider();
    private readonly timePivotProvider = new TimePivotChartProvider();

    createView(webview: IWebView): IChartView {
        const plotlyView = this.plotlyProvider.createView(webview);
        const timePivotView = this.timePivotProvider.createView(webview);
        return new CompositeChartView(plotlyView, timePivotView);
    }
}
