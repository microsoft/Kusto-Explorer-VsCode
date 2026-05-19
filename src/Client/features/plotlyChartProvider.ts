// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Plotly.js chart rendering implementation.
 * Ported from Server/Charting C# implementation.
 */

import type { ChartOptions, ResultTable } from './server';
import { ChartType, ChartAxis, ChartSortOrder, ChartLegendPosition, ChartColorways, ChartYLayout, ChartMode, hexToRgba, isNumericType, isDateTimeType, getColumnRef, getColumnRefByIndex } from './chartProvider';
import type { IChartView, IWebView, IChartProvider, ColumnRef } from './chartProvider';
import { escapeHtml } from './html';

// ─── Plotly Constants ───────────────────────────────────────────────────────

const PlotlyHoverModes = {
    Closest: 'closest',
} as const;

const PlotlyBarModes = {
    Group: 'group',
    Stack: 'stack',
    Relative: 'relative',
} as const;

const PlotlyOrientations = {
    Vertical: 'v',
    Horizontal: 'h',
} as const;

const PlotlyScatterModes = {
    Lines: 'lines',
    Markers: 'markers',
    LinesAndMarkers: 'lines+markers',
} as const;

/**
 * Per-trace point count above which we switch from Plotly's SVG `scatter` trace
 * to its WebGL `scattergl` trace. SVG renders one DOM node per marker/segment,
 * so it becomes unresponsive in the low thousands of points; `scattergl` draws
 * the whole trace into a single canvas and stays interactive into the millions.
 *
 * `scattergl` does NOT support `stackgroup`/`groupnorm`, so stacked area charts
 * always stay on `scatter` regardless of point count.
 */
const WebGlPointThreshold = 1000;

/** Returns 'scattergl' when the trace exceeds the WebGL threshold and is GL-compatible, else 'scatter'. */
function pickScatterType(pointCount: number, glCompatible = true): 'scatter' | 'scattergl' {
    return glCompatible && pointCount > WebGlPointThreshold ? 'scattergl' : 'scatter';
}

const PlotlyFillModes = {
    ToZeroY: 'tozeroy',
    ToNextY: 'tonexty',
} as const;

const PlotlyIndicatorModes = {
    Number: 'number',
} as const;

const PlotlyAxisTypes = {
    Log: 'log',
} as const;

const PlotlyTickPositions = {
    Outside: 'outside',
} as const;

const PlotlyCategoryOrders = {
    TotalAscending: 'total ascending',
    TotalDescending: 'total descending',
} as const;

const PlotlyAxisSides = {
    Right: 'right',
} as const;

const PlotlyColorways = ChartColorways;

// Set Font family so a font is picked that has good Unicode support.
const PlotlyFontFamily =
    "'Segoe UI', system-ui, -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif";

const SankeyDefaultNodeColors: readonly string[] = [
    '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
    '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf',
];

// ─── Plotly Data Types ──────────────────────────────────────────────────────

interface PlotlyFont {
    family?: string | undefined;
    size?: number | undefined;
    color?: string | undefined;
}

interface PlotlyTitle {
    text?: string | undefined;
    font?: PlotlyFont | undefined;
    x?: number | undefined;
    y?: number | undefined;
    yanchor?: string | undefined;
    yref?: string | undefined;
    pad?: PlotlyTitlePad | undefined;
}

interface PlotlyTitlePad {
    b?: number | undefined;
    l?: number | undefined;
    r?: number | undefined;
    t?: number | undefined;
}

interface PlotlyMarker {
    color?: string | undefined;
    size?: number | undefined;
    opacity?: number | undefined;
    symbol?: string | undefined;
    line?: { color?: string; width?: number } | undefined;
}

interface PlotlyLine {
    color?: string | undefined;
    width?: number | undefined;
    dash?: string | undefined;
}

interface PlotlyAxis {
    title?: PlotlyTitle | undefined;
    type?: string | undefined;
    side?: string | undefined;
    overlaying?: string | undefined;
    range?: unknown[] | undefined;
    autorange?: boolean | undefined;
    color?: string | undefined;
    gridcolor?: string | undefined;
    linecolor?: string | undefined;
    zerolinecolor?: string | undefined;
    automargin?: boolean | undefined;
    fixedrange?: boolean | undefined;
    tickmode?: string | undefined;
    nticks?: number | undefined;
    tick0?: unknown | undefined;
    dtick?: unknown | undefined;
    tickvals?: unknown[] | undefined;
    ticktext?: string[] | undefined;
    tickangle?: number | undefined;
    tickformat?: string | undefined;
    tickprefix?: string | undefined;
    ticksuffix?: string | undefined;
    showticklabels?: boolean | undefined;
    ticks?: string | undefined;
    ticklen?: number | undefined;
    tickwidth?: number | undefined;
    tickcolor?: string | undefined;
    tickfont?: PlotlyFont | undefined;
    ticklabelstep?: number | undefined;
    visible?: boolean | undefined;
    showgrid?: boolean | undefined;
    showline?: boolean | undefined;
    zeroline?: boolean | undefined;
    linewidth?: number | undefined;
    gridwidth?: number | undefined;
    zerolinewidth?: number | undefined;
    mirror?: unknown | undefined;
    categoryorder?: string | undefined;
    categoryarray?: unknown[] | undefined;
    hoverformat?: string | undefined;
    separatethousands?: boolean | undefined;
    exponentformat?: string | undefined;
    showexponent?: string | undefined;
    domain?: number[] | undefined;
    anchor?: string | undefined;
    position?: number | undefined;
    constrain?: string | undefined;
    constraintoward?: string | undefined;
    scaleanchor?: string | undefined;
    scaleratio?: number | undefined;
    matches?: string | undefined;
    showspikes?: boolean | undefined;
    spikecolor?: string | undefined;
    spikethickness?: number | undefined;
    spikedash?: string | undefined;
    spikemode?: string | undefined;
    minallowed?: unknown | undefined;
    maxallowed?: unknown | undefined;
    rangeslider?: unknown | undefined;
    rangeselector?: unknown | undefined;
}

interface PlotlyScene {
    xaxis?: PlotlyAxis | undefined;
    yaxis?: PlotlyAxis | undefined;
    zaxis?: PlotlyAxis | undefined;
    camera?: unknown | undefined;
    aspectratio?: unknown | undefined;
    aspectmode?: string | undefined;
}

interface PlotlyLegend {
    x?: number | undefined;
    y?: number | undefined;
    xref?: string | undefined;
    yref?: string | undefined;
    xanchor?: string | undefined;
    yanchor?: string | undefined;
    orientation?: string | undefined;
    font?: PlotlyFont | undefined;
    bgcolor?: string | undefined;
    bordercolor?: string | undefined;
    borderwidth?: number | undefined;
    title?: PlotlyTitle | undefined;
    traceorder?: string | undefined;
    itemwidth?: number | undefined;
}

interface PlotlyMargin {
    l?: number | undefined;
    r?: number | undefined;
    t?: number | undefined;
    b?: number | undefined;
    pad?: number | undefined;
    autoexpand?: boolean | undefined;
}

interface PlotlyHoverLabel {
    bgcolor?: string | undefined;
    bordercolor?: string | undefined;
    font?: PlotlyFont | undefined;
    align?: string | undefined;
    namelength?: number | undefined;
}

interface PlotlyLayout {
    title?: PlotlyTitle | undefined;
    xaxis?: PlotlyAxis | undefined;
    yaxis?: PlotlyAxis | undefined;
    barmode?: string | undefined;
    showlegend?: boolean | undefined;
    plot_bgcolor?: string | undefined;
    paper_bgcolor?: string | undefined;
    font?: PlotlyFont | undefined;
    hovermode?: string | undefined;
    scene?: PlotlyScene | undefined;
    colorway?: string[] | undefined;
    width?: number | undefined;
    height?: number | undefined;
    autosize?: boolean | undefined;
    margin?: PlotlyMargin | undefined;
    legend?: PlotlyLegend | undefined;
    hoverlabel?: PlotlyHoverLabel | undefined;
    hoverdistance?: number | undefined;
    spikedistance?: number | undefined;
    dragmode?: unknown | undefined;
    selectdirection?: string | undefined;
    clickmode?: string | undefined;
    bargap?: number | undefined;
    bargroupgap?: number | undefined;
    boxmode?: string | undefined;
    violinmode?: string | undefined;
    annotations?: unknown[] | undefined;
    shapes?: unknown[] | undefined;
    grid?: unknown | undefined;
    uniformtext?: unknown | undefined;
    transition?: unknown | undefined;
    // additional axes like yaxis2, yaxis3, etc.
    [key: string]: unknown;
}

interface PlotlyConfig {
    responsive: boolean;
    displayModeBar: boolean;
    displaylogo: boolean;
    staticPlot: boolean;
    scrollZoom: boolean;
    doubleClick: unknown;
    toImageButtonOptions?: unknown | undefined;
}

// ─── Plotly Trace Types ─────────────────────────────────────────────────────

interface PlotlyTraceBase {
    type: string;
    name?: string | undefined;
    xaxis?: string | undefined;
    yaxis?: string | undefined;
    showlegend?: boolean | undefined;
    legendgroup?: string | undefined;
    hoverinfo?: string | undefined;
}

interface BarTrace extends PlotlyTraceBase {
    type: 'bar';
    x: unknown[];
    y: unknown[];
    base?: unknown[] | undefined;
    orientation: string;
    offsetgroup?: string | undefined;
    marker?: PlotlyMarker | undefined;
    text?: unknown[] | undefined;
    textposition?: string | undefined;
    width?: number | number[] | undefined;
}

interface ScatterTrace extends PlotlyTraceBase {
    type: 'scatter' | 'scattergl';
    x: unknown[];
    y: unknown[];
    mode: string;
    fill?: string | undefined;
    stackgroup?: string | undefined;
    groupnorm?: string | undefined;
    line?: PlotlyLine | undefined;
    marker?: PlotlyMarker | undefined;
    text?: unknown[] | undefined;
    textposition?: string | undefined;
}

interface PieTrace extends PlotlyTraceBase {
    type: 'pie';
    labels: unknown[];
    values: unknown[];
    hole?: number | undefined;
    marker?: PlotlyMarker | undefined;
    hoverinfo?: string | undefined;
    textinfo?: string | undefined;
}

interface IndicatorTrace extends PlotlyTraceBase {
    type: 'indicator';
    value: number;
    mode: string;
    title?: PlotlyTitle | undefined;
    number?: {
        prefix?: string | undefined;
        suffix?: string | undefined;
        font?: PlotlyFont | undefined;
        valueformat?: string | undefined;
    } | undefined;
    delta?: unknown | undefined;
    gauge?: unknown | undefined;
    domain?: unknown | undefined;
}

interface SurfaceTrace extends PlotlyTraceBase {
    type: 'surface';
    x?: unknown[] | undefined;
    y?: unknown[] | undefined;
    z: unknown[][];
    colorscale?: string | undefined;
    showscale?: boolean | undefined;
    opacity?: number | undefined;
    surfacecolor?: unknown[][] | undefined;
    contours?: unknown | undefined;
}

interface TreeMapTrace extends PlotlyTraceBase {
    type: 'treemap';
    labels: unknown[];
    parents: unknown[];
    values?: unknown[] | undefined;
    ids?: unknown[] | undefined;
    text?: unknown[] | undefined;
    texttemplate?: string | undefined;
    textinfo?: string | undefined;
    hovertemplate?: string | undefined;
    marker?: {
        colors?: unknown[] | undefined;
        colorscale?: string | undefined;
        showscale?: boolean | undefined;
        line?: PlotlyLine | undefined;
    } | undefined;
    maxdepth?: number | undefined;
    level?: string | undefined;
    branchvalues?: string | undefined;
    pathbar?: { visible?: boolean | undefined; side?: string | undefined; textfont?: PlotlyFont | undefined } | undefined;
}

interface SankeyTrace extends PlotlyTraceBase {
    type: 'sankey';
    node: {
        label: string[];
        color?: unknown | undefined;
        pad?: number | undefined;
        thickness?: number | undefined;
        line?: PlotlyLine | undefined;
        hovertemplate?: string | undefined;
    };
    link: {
        source: number[];
        target: number[];
        value: number[];
        color?: unknown | undefined;
        label?: string[] | undefined;
        hovertemplate?: string | undefined;
    };
    orientation?: string | undefined;
    valueformat?: string | undefined;
    valuesuffix?: string | undefined;
    arrangement?: string | undefined;
}

type PlotlyTrace = BarTrace | ScatterTrace | PieTrace | IndicatorTrace | SurfaceTrace | TreeMapTrace | SankeyTrace;

// ─── Plotly Chart Builder ──────────────────────────────────────────────────────────

class PlotlyChartBuilder {
    private readonly _traces: PlotlyTrace[];
    private readonly _layout: PlotlyLayout;
    private readonly _config: PlotlyConfig;

    constructor(
        traces?: PlotlyTrace[],
        layout?: PlotlyLayout,
        config?: PlotlyConfig,
    ) {
        this._traces = traces ?? [];
        this._layout = layout ?? { hovermode: PlotlyHoverModes.Closest, showlegend: true };
        this._config = config ?? {
            responsive: true,
            displayModeBar: false,
            displaylogo: false,
            staticPlot: false,
            scrollZoom: false,
            doubleClick: false,
        };
    }

    get traces(): PlotlyTrace[] { return this._traces; }
    get layout(): PlotlyLayout { return this._layout; }
    get config(): PlotlyConfig { return this._config; }

    private _new(traces?: PlotlyTrace[], layout?: PlotlyLayout, config?: PlotlyConfig): PlotlyChartBuilder {
        return new PlotlyChartBuilder(
            traces ?? this._traces,
            layout ?? this._layout,
            config ?? this._config,
        );
    }

    addTrace(trace: PlotlyTrace): PlotlyChartBuilder {
        return this._new([...this._traces, trace]);
    }

    withLayout(layout: PlotlyLayout): PlotlyChartBuilder {
        return this._new(undefined, layout);
    }

    withConfig(config: PlotlyConfig): PlotlyChartBuilder {
        return this._new(undefined, undefined, config);
    }

    withTitle(title: string): PlotlyChartBuilder {
        return this._new(undefined, { ...this._layout, title: { text: title } });
    }

    withXAxis(axis: PlotlyAxis): PlotlyChartBuilder {
        return this._new(undefined, { ...this._layout, xaxis: axis });
    }

    withYAxis(axis: PlotlyAxis): PlotlyChartBuilder {
        return this._new(undefined, { ...this._layout, yaxis: axis });
    }

    withScene(scene: PlotlyScene): PlotlyChartBuilder {
        return this._new(undefined, { ...this._layout, scene });
    }

    addSecondaryYAxis(axisId: string, axis: PlotlyAxis): PlotlyChartBuilder {
        return this._new(undefined, { ...this._layout, [axisId]: axis });
    }

    setBarMode(barMode: string): PlotlyChartBuilder {
        return this._new(undefined, { ...this._layout, barmode: barMode });
    }

    showLegend(show = true): PlotlyChartBuilder {
        return this._new(undefined, { ...this._layout, showlegend: show });
    }

    withDarkMode(): PlotlyChartBuilder {
        const darkAxis: Partial<PlotlyAxis> = {
            color: '#f2f5fa',
            gridcolor: '#444444',
            linecolor: '#666666',
            zeroline: false,
        };
        const layout: PlotlyLayout = {
            ...this._layout,
            paper_bgcolor: '#1e1e1e',
            plot_bgcolor: '#1e1e1e',
            font: { color: '#f2f5fa', family: PlotlyFontFamily },
            colorway: [...PlotlyColorways.Default],
            xaxis: { ...(this._layout.xaxis ?? {}), ...darkAxis },
            yaxis: { ...(this._layout.yaxis ?? {}), ...darkAxis },
        };
        // Apply dark axis styling to additional subplot axes (xaxis2, yaxis2, etc.)
        for (const key of Object.keys(this._layout)) {
            if (/^[xy]axis\d+$/.test(key)) {
                (layout as Record<string, unknown>)[key] = { ...(this._layout as Record<string, unknown>)[key] as Record<string, unknown>, ...darkAxis };
            }
        }
        return this._new(undefined, layout);
    }

    withLightMode(): PlotlyChartBuilder {
        const lightAxis: Partial<PlotlyAxis> = {
            color: '#2a3f5f',
            gridcolor: '#e2e2e2',
            linecolor: '#bcbcbc',
            zeroline: false,
        };
        const layout: PlotlyLayout = {
            ...this._layout,
            paper_bgcolor: '#ffffff',
            plot_bgcolor: '#ffffff',
            font: { color: '#2a3f5f', family: PlotlyFontFamily },
            xaxis: { ...(this._layout.xaxis ?? {}), ...lightAxis },
            yaxis: { ...(this._layout.yaxis ?? {}), ...lightAxis },
        };
        // Apply light axis styling to additional subplot axes (xaxis2, yaxis2, etc.)
        for (const key of Object.keys(this._layout)) {
            if (/^[xy]axis\d+$/.test(key)) {
                (layout as Record<string, unknown>)[key] = { ...(this._layout as Record<string, unknown>)[key] as Record<string, unknown>, ...lightAxis };
            }
        }
        return this._new(undefined, layout);
    }

    withFixedRange(): PlotlyChartBuilder {
        const layout: PlotlyLayout = {
            ...this._layout,
            xaxis: { ...(this._layout.xaxis ?? {}), fixedrange: true },
            yaxis: { ...(this._layout.yaxis ?? {}), fixedrange: true },
        };
        // Apply fixedrange to additional subplot axes
        for (const key of Object.keys(this._layout)) {
            if (/^[xy]axis\d+$/.test(key)) {
                (layout as Record<string, unknown>)[key] = { ...(this._layout as Record<string, unknown>)[key] as Record<string, unknown>, fixedrange: true };
            }
        }
        return this._new(
            undefined,
            layout,
            {
                ...this._config,
                scrollZoom: false,
                doubleClick: false,
            },
        );
    }

    toHtmlDiv(divId = 'plotly-chart'): string {
        const dataJson = JSON.stringify(this._traces);
        const layoutJson = JSON.stringify(this._layout);
        const configJson = JSON.stringify(this._config);
        return createChartDiv(dataJson, layoutJson, configJson, divId);
    }

    /**
     * Returns the chart's data/layout/config as JSON strings ready to be sent
     * to the webview page via a structured postMessage. The page handler does
     * `JSON.parse` + `Plotly.newPlot` directly, skipping the round-trip through
     * `<script>` reinjection in `innerHTML`. Use this in preference to
     * `toHtmlDiv()` for single-chart rendering — it avoids a multi-MB HTML
     * parse, a `textContent`-clone of the script body, and the JS-engine
     * parse of the embedded `JSON.parse('...')` literal.
     */
    toContent(divId = 'plotly-chart'): { type: 'plot'; divId: string; dataJson: string; layoutJson: string; configJson: string } {
        return {
            type: 'plot',
            divId,
            dataJson: JSON.stringify(this._traces),
            layoutJson: JSON.stringify(this._layout),
            configJson: JSON.stringify(this._config),
        };
    }

    // ─── Trace helpers (ported from PlotlyChartExtensions.cs) ───────────

    add2DBarTrace(
        x: unknown[],
        y: unknown[],
        name?: string,
        horizontal = false,
        yAxisId?: string,
        offsetGroup?: string,
        text?: unknown[],
        textPosition?: string,
    ): PlotlyChartBuilder {
        const trace: BarTrace = {
            type: 'bar',
            x: horizontal ? y : x,
            y: horizontal ? x : y,
            orientation: horizontal ? PlotlyOrientations.Horizontal : PlotlyOrientations.Vertical,
            name,
            yaxis: yAxisId,
            offsetgroup: offsetGroup,
            text,
            textposition: textPosition,
        };
        return this.addTrace(trace);
    }

    addLadderTrace(
        categories: unknown[],
        durations: number[],
        base: unknown[],
        name?: string,
    ): PlotlyChartBuilder {
        const trace: BarTrace = {
            type: 'bar',
            x: durations,
            y: categories,
            base,
            orientation: PlotlyOrientations.Horizontal,
            name,
        };
        return this.addTrace(trace);
    }

    add2DLineTrace(
        x: unknown[],
        y: unknown[],
        name?: string,
        showMarkers = false,
        yAxisId?: string,
        markerSymbol?: string,
        markerSize?: number,
        showValues = false,
        markerOutline = false,
        outlineColor = 'white',
    ): PlotlyChartBuilder {
        const markerObj: PlotlyMarker | undefined = showMarkers
            ? { symbol: markerSymbol, size: markerSize, line: markerOutline ? { color: outlineColor, width: 1.5 } : undefined }
            : undefined;
        let mode = PlotlyScatterModes.Lines as string;
        if (showMarkers && showValues) mode = 'lines+markers+text';
        else if (showMarkers) mode = PlotlyScatterModes.LinesAndMarkers;
        else if (showValues) mode = 'lines+text';
        const trace: ScatterTrace = {
            type: pickScatterType(x.length),
            x,
            y,
            mode,
            name,
            yaxis: yAxisId,
            marker: markerObj,
            text: showValues ? y.map(v => v as unknown) : undefined,
            textposition: showValues ? 'top center' : undefined,
        };
        return this.addTrace(trace);
    }

    add2DScatterTrace(
        x: unknown[],
        y: unknown[],
        name?: string,
        yAxisId?: string,
        markerSymbol?: string,
        markerSize?: number,
        showValues = false,
        markerOutline = false,
        outlineColor = 'white',
    ): PlotlyChartBuilder {
        const hasMarker = markerSymbol != null || markerSize != null;
        const trace: ScatterTrace = {
            type: pickScatterType(x.length),
            x,
            y,
            mode: showValues ? 'markers+text' : PlotlyScatterModes.Markers,
            name,
            yaxis: yAxisId,
            marker: hasMarker || markerOutline
                ? { symbol: markerSymbol, size: markerSize, line: markerOutline ? { color: outlineColor, width: 1.5 } : undefined }
                : undefined,
            text: showValues ? y.map(v => v as unknown) : undefined,
            textposition: showValues ? 'top center' : undefined,
        };
        return this.addTrace(trace);
    }

    addAreaChart(
        x: unknown[],
        y: unknown[],
        name?: string,
        stackGroup?: string,
        yAxisId?: string,
        groupNorm?: string,
        showMarkers = false,
        markerSymbol?: string,
        markerSize?: number,
        showValues = false,
        markerOutline = false,
        outlineColor = 'white',
    ): PlotlyChartBuilder {
        const markerObj: PlotlyMarker | undefined = showMarkers
            ? { symbol: markerSymbol, size: markerSize, line: markerOutline ? { color: outlineColor, width: 1.5 } : undefined }
            : undefined;
        let mode = PlotlyScatterModes.Lines as string;
        if (showMarkers && showValues) mode = 'lines+markers+text';
        else if (showMarkers) mode = PlotlyScatterModes.LinesAndMarkers;
        else if (showValues) mode = 'lines+text';
        // scattergl does not support stackgroup/groupnorm, so stacked area must stay on SVG scatter.
        const glCompatible = stackGroup == null && groupNorm == null;
        const trace: ScatterTrace = {
            type: pickScatterType(x.length, glCompatible),
            x,
            y,
            mode,
            fill: stackGroup != null ? PlotlyFillModes.ToNextY : PlotlyFillModes.ToZeroY,
            stackgroup: stackGroup,
            groupnorm: groupNorm,
            name,
            yaxis: yAxisId,
            marker: markerObj,
            text: showValues ? y.map(v => v as unknown) : undefined,
            textposition: showValues ? 'top center' : undefined,
        };
        return this.addTrace(trace);
    }

    addIndicatorTrace(
        value: number,
        title?: string,
        mode?: string,
        prefix?: string,
        suffix?: string,
        valueFormat?: string,
    ): PlotlyChartBuilder {
        const hasNumber = prefix != null || suffix != null || valueFormat != null;
        const trace: IndicatorTrace = {
            type: 'indicator',
            value,
            mode: mode ?? PlotlyIndicatorModes.Number,
            title: title != null ? { text: title } : undefined,
            number: hasNumber ? { prefix, suffix, valueformat: valueFormat } : undefined,
        };
        return this.addTrace(trace);
    }

    addPieTrace(
        labels: unknown[],
        values: unknown[],
        name?: string,
        hole = 0.0,
        textInfo?: string,
    ): PlotlyChartBuilder {
        const trace: PieTrace = {
            type: 'pie',
            labels,
            values,
            name,
            hole: hole > 0 ? hole : undefined,
            textinfo: textInfo,
        };
        return this.addTrace(trace);
    }

    add3DSurfaceTrace(
        z: unknown[][],
        x?: unknown[],
        y?: unknown[],
        name?: string,
        colorScale?: string,
        showScale = true,
        opacity?: number,
    ): PlotlyChartBuilder {
        const trace: SurfaceTrace = {
            type: 'surface',
            z,
            x,
            y,
            name,
            colorscale: colorScale,
            showscale: showScale,
            opacity,
        };
        return this.addTrace(trace);
    }

    addTreeMapTrace(
        labels: unknown[],
        parents: unknown[],
        values?: unknown[],
        name?: string,
        ids?: unknown[],
        textInfo?: string,
        branchValues?: string,
        maxDepth?: number,
    ): PlotlyChartBuilder {
        const trace: TreeMapTrace = {
            type: 'treemap',
            labels,
            parents,
            values,
            name,
            ids,
            textinfo: textInfo,
            branchvalues: branchValues,
            maxdepth: maxDepth,
            pathbar: { visible: true },
        };
        return this.addTrace(trace);
    }

    addSankeyTrace(
        nodeLabels: string[],
        linkSources: number[],
        linkTargets: number[],
        linkValues: number[],
        name?: string,
        nodeColors?: string[],
        linkColors?: string[],
        orientation?: string,
        arrangement?: string,
    ): PlotlyChartBuilder {
        // Generate default node colors if not provided
        let colors = nodeColors;
        if (!colors || colors.length === 0) {
            colors = nodeLabels.map((_, i) => SankeyDefaultNodeColors[i % SankeyDefaultNodeColors.length]!);
        }

        // Generate link colors based on source node colors with transparency
        let lColors = linkColors;
        if (!lColors || lColors.length === 0) {
            lColors = linkSources.map(srcIdx => {
                const srcColor = colors![srcIdx % colors!.length]!;
                return hexToRgba(srcColor, 0.4);
            });
        }

        const trace: SankeyTrace = {
            type: 'sankey',
            name,
            orientation: orientation ?? 'h',
            arrangement: arrangement ?? 'snap',
            node: {
                label: nodeLabels,
                color: colors,
                pad: 15,
                thickness: 20,
                line: { color: '#444444', width: 0.5 },
            },
            link: {
                source: linkSources,
                target: linkTargets,
                value: linkValues,
                color: lColors,
            },
        };
        return this.addTrace(trace);
    }

    // ─── Layout helpers (ported from PlotlyChartExtensions.cs) ──────────

    setStacked(): PlotlyChartBuilder {
        return this.withLayout({ ...this._layout, barmode: PlotlyBarModes.Stack });
    }

    setStacked100(): PlotlyChartBuilder {
        return this.withLayout({ ...this._layout, barmode: PlotlyBarModes.Relative });
    }

    setGrouped(): PlotlyChartBuilder {
        return this.withLayout({ ...this._layout, barmode: PlotlyBarModes.Group });
    }

    setXAxisTitle(title: string): PlotlyChartBuilder {
        const xaxis: PlotlyAxis = { ...(this._layout.xaxis ?? {}), title: { text: title } };
        return this.withXAxis(xaxis);
    }

    setYAxisTitle(title: string): PlotlyChartBuilder {
        const yaxis: PlotlyAxis = { ...(this._layout.yaxis ?? {}), title: { text: title } };
        return this.withYAxis(yaxis);
    }

    setLogX(): PlotlyChartBuilder {
        const xaxis: PlotlyAxis = { ...(this._layout.xaxis ?? {}), type: PlotlyAxisTypes.Log };
        return this.withXAxis(xaxis);
    }

    setLogY(): PlotlyChartBuilder {
        const yaxis: PlotlyAxis = { ...(this._layout.yaxis ?? {}), type: PlotlyAxisTypes.Log };
        return this.withYAxis(yaxis);
    }

    setXAxisRange(min: number, max: number): PlotlyChartBuilder {
        const xaxis: PlotlyAxis = { ...(this._layout.xaxis ?? {}), range: [min, max] };
        return this.withXAxis(xaxis);
    }

    setYAxisRange(min: number, max: number): PlotlyChartBuilder {
        const yaxis: PlotlyAxis = { ...(this._layout.yaxis ?? {}), range: [min, max] };
        return this.withYAxis(yaxis);
    }

    setSceneXAxisTitle(title: string): PlotlyChartBuilder {
        const scene = this._layout.scene ?? {};
        const xaxis: PlotlyAxis = { ...(scene.xaxis ?? {}), title: { text: title } };
        return this.withScene({ ...scene, xaxis });
    }

    setSceneYAxisTitle(title: string): PlotlyChartBuilder {
        const scene = this._layout.scene ?? {};
        const yaxis: PlotlyAxis = { ...(scene.yaxis ?? {}), title: { text: title } };
        return this.withScene({ ...scene, yaxis });
    }

    setSceneZAxisTitle(title: string): PlotlyChartBuilder {
        const scene = this._layout.scene ?? {};
        const zaxis: PlotlyAxis = { ...(scene.zaxis ?? {}), title: { text: title } };
        return this.withScene({ ...scene, zaxis });
    }

    setSceneZAxisRange(min: number, max: number): PlotlyChartBuilder {
        const scene = this._layout.scene ?? {};
        const zaxis: PlotlyAxis = { ...(scene.zaxis ?? {}), range: [min, max] };
        return this.withScene({ ...scene, zaxis });
    }

    setSceneAspectMode(mode: string): PlotlyChartBuilder {
        const scene = this._layout.scene ?? {};
        return this.withScene({ ...scene, aspectmode: mode });
    }

    setShowLegend(show: boolean): PlotlyChartBuilder {
        return this.withLayout({ ...this._layout, showlegend: show });
    }

    hideLegend(): PlotlyChartBuilder {
        return this.setShowLegend(false);
    }

    setColorway(...colors: string[]): PlotlyChartBuilder {
        return this.withLayout({ ...this._layout, colorway: colors });
    }

    setSize(width: number | undefined, height: number | undefined): PlotlyChartBuilder {
        const newLayout: PlotlyLayout = { ...this._layout };
        if (width !== undefined) { newLayout.width = width; }
        if (height !== undefined) { newLayout.height = height; }
        return this.withLayout(newLayout);
    }

    setXShowTicks(show: boolean): PlotlyChartBuilder {
        const xaxis: PlotlyAxis = { ...(this._layout.xaxis ?? {}), ticks: show ? PlotlyTickPositions.Outside : '' };
        return this.withLayout({ ...this._layout, xaxis });
    }

    setYShowTicks(show: boolean): PlotlyChartBuilder {
        const yaxis: PlotlyAxis = { ...(this._layout.yaxis ?? {}), ticks: show ? PlotlyTickPositions.Outside : '' };
        return this.withLayout({ ...this._layout, yaxis });
    }

    setXShowGrid(show: boolean): PlotlyChartBuilder {
        const xaxis: PlotlyAxis = { ...(this._layout.xaxis ?? {}), showgrid: show };
        return this.withLayout({ ...this._layout, xaxis });
    }

    setYShowGrid(show: boolean): PlotlyChartBuilder {
        const yaxis: PlotlyAxis = { ...(this._layout.yaxis ?? {}), showgrid: show };
        return this.withLayout({ ...this._layout, yaxis });
    }

    setXTickAngle(angle: number): PlotlyChartBuilder {
        const xaxis: PlotlyAxis = { ...(this._layout.xaxis ?? {}), tickangle: angle };
        return this.withLayout({ ...this._layout, xaxis });
    }

    setYTickAngle(angle: number): PlotlyChartBuilder {
        const yaxis: PlotlyAxis = { ...(this._layout.yaxis ?? {}), tickangle: angle };
        return this.withLayout({ ...this._layout, yaxis });
    }

    setCategoryOrder(order: string): PlotlyChartBuilder {
        const xaxis: PlotlyAxis = { ...(this._layout.xaxis ?? {}), categoryorder: order };
        return this.withLayout({ ...this._layout, xaxis });
    }

    setLegendPosition(position: string): PlotlyChartBuilder {
        let legend: PlotlyLegend;
        if (position === ChartLegendPosition.Bottom) {
            legend = { orientation: 'h', x: 0.5, y: -0.2, xanchor: 'center', yanchor: 'top' };
        } else {
            legend = { x: 1.02, y: 1, xanchor: 'left', yanchor: 'auto' };
        }
        return this.withLayout({ ...this._layout, legend });
    }
}

// ─── HTML Helpers ───────────────────────────────────────────────────────────

const PlotlyJsCdn = 'https://cdn.plot.ly/plotly-2.27.0.min.js';

/**
 * Escapes a JSON string so it can be embedded inside a single-quoted JS string
 * literal and recovered with `JSON.parse`. We escape:
 *  - `\\` (must come first) so JSON's own escapes survive JS-string decoding,
 *  - `'` so we don't terminate the surrounding JS string,
 *  - `</` → `<\/` so a literal `</script>` in the data can't break out of the
 *    enclosing `<script>` tag,
 *  - U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR), which were
 *    illegal inside JS string literals before ES2019 and remain a syntax-error
 *    risk on older runtimes. Modern V8 accepts them, but defensive escaping
 *    keeps the generated `<script>` valid for any string content in the data.
 *
 * Embedding the data via `JSON.parse('…')` is dramatically faster than emitting
 * a JS object literal (`var data = […];`) when the payload is large: V8 has a
 * hand-tuned fast path for `JSON.parse` of a string, but no equivalent fast
 * path for parsing a multi-megabyte inline literal at script-load time.
 */
function escapeForJsStringLiteral(json: string): string {
    return json
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/<\//g, '<\\/')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

function createChartDiv(dataJson: string, layoutJson: string, configJson: string, divId = 'plotly-chart'): string {
    const dataLit = escapeForJsStringLiteral(dataJson);
    const layoutLit = escapeForJsStringLiteral(layoutJson);
    const configLit = escapeForJsStringLiteral(configJson);
    return `<div id="${divId}"></div>
<script>
try {
  var data = JSON.parse('${dataLit}');
  var layout = JSON.parse('${layoutLit}');
  var config = JSON.parse('${configLit}');
  Plotly.newPlot('${divId}', data, layout, config);
} catch(e) { console.error('Plotly error:', e); document.getElementById('${divId}').innerText = 'Chart error: ' + e.message; }
</script>`;
}

// ─── Utility Functions ──────────────────────────────────────────────────────

/** Computes font sizes based on chart dimensions and a text-size preset. Mirrors the webview-side computeFontSizes. */
function computeFontSizes(chartW: number, chartH: number, preset?: string): { titleSize: number; axisSize: number; tickSize: number } {
    const scale = preset === 'Extra Small' ? 0.5 : preset === 'Small' ? 0.75 : preset === 'Large' ? 1.5 : preset === 'Extra Large' ? 2.0 : 1.0;
    const base = Math.min(chartW, chartH);
    const titleSize = Math.round(Math.max(10, Math.min(36, base * 0.04)) * scale);
    const axisSize = Math.round(Math.max(8, Math.min(24, base * 0.028)) * scale);
    const tickSize = Math.round(Math.max(7, Math.min(16, base * 0.018)) * scale);
    return { titleSize, axisSize, tickSize };
}

/** Applies computed font sizes to a Plotly layout object. */
function applyFontSizesToLayout(layout: Record<string, unknown>, fonts: { titleSize: number; axisSize: number; tickSize: number }): Record<string, unknown> {
    const result = { ...layout };
    const title = result.title as Record<string, unknown> | string | undefined;
    if (title && typeof title === 'object') {
        result.title = { ...title, font: { ...(title.font as Record<string, unknown> ?? {}), size: fonts.titleSize } };
    } else if (typeof title === 'string') {
        result.title = { text: title, font: { size: fonts.titleSize } };
    }
    const xaxis = result.xaxis as Record<string, unknown> | undefined;
    if (xaxis) {
        const xTitle = xaxis.title as Record<string, unknown> | undefined;
        result.xaxis = { ...xaxis, automargin: true,
            title: { ...(xTitle ?? {}), font: { ...((xTitle?.font as Record<string, unknown>) ?? {}), size: fonts.axisSize }, standoff: fonts.tickSize },
            tickfont: { ...(xaxis.tickfont as Record<string, unknown> ?? {}), size: fonts.tickSize } };
    }
    const yaxis = result.yaxis as Record<string, unknown> | undefined;
    if (yaxis) {
        const yTitle = yaxis.title as Record<string, unknown> | undefined;
        result.yaxis = { ...yaxis, automargin: true,
            title: { ...(yTitle ?? {}), font: { ...((yTitle?.font as Record<string, unknown>) ?? {}), size: fonts.axisSize }, standoff: fonts.tickSize },
            tickfont: { ...(yaxis.tickfont as Record<string, unknown> ?? {}), size: fonts.tickSize } };
    }
    // Apply font sizes to additional subplot axes (xaxis2, yaxis2, etc.)
    for (const key of Object.keys(result)) {
        if (/^[xy]axis\d+$/.test(key)) {
            const axis = result[key] as Record<string, unknown> | undefined;
            if (axis) {
                const axisTitle = axis.title as Record<string, unknown> | undefined;
                result[key] = { ...axis, automargin: true,
                    title: { ...(axisTitle ?? {}), font: { ...((axisTitle?.font as Record<string, unknown>) ?? {}), size: fonts.axisSize }, standoff: fonts.tickSize },
                    tickfont: { ...(axis.tickfont as Record<string, unknown> ?? {}), size: fonts.tickSize } };
            }
        }
    }
    const legend = (result.legend ?? {}) as Record<string, unknown>;
    result.legend = { ...legend, font: { ...(legend.font as Record<string, unknown> ?? {}), size: fonts.tickSize } };
    return result;
}

function isTimeChartType(type: string): boolean {
    return type === ChartType.TimeLine
        || type === ChartType.TimeLineAnomaly
        || type === ChartType.Ladder
        || type === ChartType.TimePivot;
}

// ─── Timespan Parsing & Binning ─────────────────────────────────────────────

/** Suffix → milliseconds multiplier for KQL timespan literals. */
const timespanSuffixes: Record<string, number> = {
    'nanosecond': 1e-6, 'nanoseconds': 1e-6,
    'tick': 1e-4, 'ticks': 1e-4,
    'microsecond': 1e-3, 'microseconds': 1e-3,
    'ms': 1, 'millisecond': 1, 'milliseconds': 1,
    's': 1000, 'sec': 1000, 'second': 1000, 'seconds': 1000,
    'm': 60_000, 'min': 60_000, 'minute': 60_000, 'minutes': 60_000,
    'h': 3_600_000, 'hr': 3_600_000, 'hrs': 3_600_000, 'hour': 3_600_000, 'hours': 3_600_000,
    'd': 86_400_000, 'day': 86_400_000, 'days': 86_400_000,
};

/**
 * Parses a bin size string into milliseconds.
 * Accepts KQL timespan syntax (e.g. "1d", "5m", "1.5h") or plain numbers.
 * Returns undefined if the string cannot be parsed.
 */
function parseBinSize(value: string): number | undefined {
    const trimmed = value.trim();
    if (!trimmed) return undefined;

    // Try KQL timespan: number + suffix
    const match = /^(\d+(?:\.\d+)?)\s*(nanoseconds?|ticks?|microseconds?|milliseconds?|ms|seconds?|sec|minutes?|min|hours?|hrs?|hr|days?|[smhd])$/i.exec(trimmed);
    if (match) {
        const num = parseFloat(match[1]!);
        const suffix = match[2]!.toLowerCase();
        const multiplier = timespanSuffixes[suffix];
        if (multiplier !== undefined && num > 0) return num * multiplier;
    }

    // Try plain number (for numeric bin width)
    const num = parseFloat(trimmed);
    if (!isNaN(num) && num > 0) return num;

    return undefined;
}

/** Aggregation function type. */
type AggregationType = 'Sum' | 'Count' | 'Average' | 'Min' | 'Max';

/**
 * Bins x-values and aggregates y-values within each bin.
 * For datetime x-values, binSizeMs is in milliseconds.
 * For numeric x-values, binSizeMs is the bin width.
 */
function binAndAggregate(
    xValues: unknown[],
    yValues: number[],
    binSize: number,
    aggregation: AggregationType,
    isDateTime: boolean,
): { x: unknown[]; y: number[] } {
    const bins = new Map<string | number, number[]>();
    const binKeys: (string | number)[] = [];

    for (let i = 0; i < xValues.length; i++) {
        const xVal = xValues[i];
        const yVal = yValues[i];
        if (xVal == null || yVal == null) continue;

        let binKey: string | number;
        if (isDateTime) {
            const ms = new Date(String(xVal)).getTime();
            if (isNaN(ms)) continue;
            const binned = Math.floor(ms / binSize) * binSize;
            binKey = new Date(binned).toISOString();
        } else {
            const num = typeof xVal === 'number' ? xVal : parseFloat(String(xVal));
            if (isNaN(num)) continue;
            binKey = Math.floor(num / binSize) * binSize;
        }

        let group = bins.get(binKey);
        if (!group) {
            group = [];
            bins.set(binKey, group);
            binKeys.push(binKey);
        }
        group.push(yVal);
    }

    const resultX: unknown[] = [];
    const resultY: number[] = [];

    for (const key of binKeys) {
        const values = bins.get(key)!;
        resultX.push(key);
        resultY.push(aggregateValues(values, aggregation));
    }

    return { x: resultX, y: resultY };
}

function aggregateValues(values: number[], aggregation: AggregationType): number {
    switch (aggregation) {
        case 'Sum': return values.reduce((a, b) => a + b, 0);
        case 'Count': return values.length;
        case 'Average': return values.reduce((a, b) => a + b, 0) / values.length;
        case 'Min': return Math.min(...values);
        case 'Max': return Math.max(...values);
    }
}

/**
 * Returns x/y sorted ascending by x. Skips all sorting work — and avoids
 * allocating two new arrays — when the input is already monotonically
 * non-decreasing in x, which is the common case for time-series data
 * (Kusto queries that end in `order by t asc`, `range`-generated rows,
 * binned aggregates emitted in bin order, etc.).
 *
 * The comparison uses raw JS `<`/`>`, which match the previous behavior
 * for numbers, Date objects, and ISO-8601 datetime strings.
 */
function sortPointsByX(x: unknown[], y: number[]): { x: unknown[]; y: number[] } {
    let sorted = true;
    for (let i = 1; i < x.length; i++) {
        if (x[i - 1]! > x[i]!) { sorted = false; break; }
    }
    if (sorted) return { x, y };
    const indices = new Array<number>(x.length);
    for (let i = 0; i < x.length; i++) indices[i] = i;
    indices.sort((a, b) => (x[a]! < x[b]! ? -1 : x[a]! > x[b]! ? 1 : 0));
    const sortedX = new Array<unknown>(x.length);
    const sortedY = new Array<number>(x.length);
    for (let i = 0; i < x.length; i++) {
        const j = indices[i]!;
        sortedX[i] = x[j];
        sortedY[i] = y[j]!;
    }
    return { x: sortedX, y: sortedY };
}

/**
 * Downsamples x/y arrays to at most maxPoints by taking every Nth point.
 * Always includes the first and last points to preserve the range.
 */
function downsample(x: unknown[], y: number[], maxPoints: number): { x: unknown[]; y: number[] } {
    if (x.length <= maxPoints) return { x, y };
    const step = (x.length - 1) / (maxPoints - 1);
    const resultX: unknown[] = [];
    const resultY: number[] = [];
    for (let i = 0; i < maxPoints; i++) {
        const idx = Math.round(i * step);
        resultX.push(x[idx]!);
        resultY.push(y[idx]!);
    }
    return { x: resultX, y: resultY };
}

function accumulateValues(values: number[]): number[] {
    let runningTotal = 0;
    return values.map(value => {
        runningTotal += value;
        return sanitizeDouble(runningTotal);
    });
}

/** Ordered set of product marker shapes for cycling. */
const markerShapes = ['Circle', 'Diamond', 'Square', 'TriangleUp', 'Cross', 'Star', 'X'] as const;
const markerShapeSymbols: Record<typeof markerShapes[number], string> = {
    Circle: 'circle',
    Diamond: 'diamond',
    Square: 'square',
    TriangleUp: 'triangle-up',
    Cross: 'cross',
    Star: 'star',
    X: 'x',
};

/** Marker size presets mapped to pixel values. */
const markerSizePresets: Record<string, number> = {
    'Extra Small': 4,
    'Small': 6,
    'Medium': 8,
    'Large': 10,
    'Extra Large': 14,
};

/**
 * Returns the marker shape for a given trace index, based on chart options.
 * - If no markerShape is set and cycleMarkerShapes is off, returns undefined (Plotly default).
 * - If markerShape is set but cycleMarkerShapes is false, returns its Plotly symbol for all traces.
 * - If cycleMarkerShapes is true, cycles through product shapes starting from the selected shape.
 */
function getMarkerShape(options: ChartOptions, traceIndex: number): string | undefined {
    if (!options.markerShape && !options.cycleMarkerShapes) return undefined;
    const startIndex = markerShapes.indexOf((options.markerShape ?? markerShapes[0]) as typeof markerShapes[number]);
    const base = startIndex >= 0 ? startIndex : 0;
    const selectedShape = markerShapes[base] ?? markerShapes[0];
    if (!options.cycleMarkerShapes) return markerShapeSymbols[selectedShape];
    const cycledShape = markerShapes[(base + traceIndex) % markerShapes.length] ?? markerShapes[0];
    return markerShapeSymbols[cycledShape];
}

/** Resolves the marker size preset to a pixel value, or undefined if not set. */
function getMarkerSize(options: ChartOptions): number | undefined {
    if (!options.markerSize) return undefined;
    return markerSizePresets[options.markerSize];
}

function toNumber(value: unknown): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') { const n = Number(value); return isNaN(n) ? 0 : n; }
    return 0;
}

function sanitizeDouble(value: number): number {
    if (value === Infinity) return Number.MAX_VALUE;
    if (value === -Infinity) return -Number.MAX_VALUE;
    return value;
}

function tryGetDouble(value: unknown): number | undefined {
    if (value == null) return undefined;
    const n = Number(value);
    if (isNaN(n)) return undefined;
    return n;
}

// ─── Data Access Helpers ────────────────────────────────────────────────────

function getColumnValues(table: ResultTable, col: ColumnRef): unknown[] {
    return table.rows.map(row => row?.[col.index]);
}

function trimNullRows(xValues: unknown[], yValues: unknown[]): { x: unknown[]; y: unknown[] } {
    const xResult: unknown[] = [];
    const yResult: unknown[] = [];
    const len = Math.min(xValues.length, yValues.length);
    for (let i = 0; i < len; i++) {
        const xValue = xValues[i];
        const yValue = yValues[i];
        if (xValue != null && yValue != null && !(typeof xValue === 'number' && Number.isNaN(xValue)) && !(typeof yValue === 'number' && Number.isNaN(yValue))) {
            xResult.push(xValues[i]);
            yResult.push(yValues[i]);
        }
    }
    return { x: xResult, y: yResult };
}

function convertToNumeric(values: unknown[]): number[] {
    return values.map(v => sanitizeDouble(toNumber(v)));
}

// ─── Plotly Chart Manager ──────────────────────────────────────────────────────────

/**
 * Plotly-specific client-side scripts for chart lifecycle management.
 * Handles resize, aspect ratio, font overrides, and copy-to-clipboard.
 * Expects the chart container to be `#chart` with optional `--chart-aspect-ratio` CSS var
 * and `data-text-size` attribute.
 * Exposes `window._chartResize()` for host-initiated resize (tab switch, edit panel toggle).
 * Exposes `window._chartUpdated()` — called by the page handler after chart HTML is inserted.
 */
const plotlyChartScripts = `
<script>
(function() {
    // ── Font size helpers ──────────────────────────────────────────────
    function computeFontSizes(chartW, chartH, preset) {
        var scale = preset === 'Extra Small' ? 0.5 : preset === 'Small' ? 0.75 : preset === 'Large' ? 1.5 : preset === 'Extra Large' ? 2.0 : 1.0;
        var base = Math.min(chartW, chartH);
        var titleSize = Math.round(Math.max(10, Math.min(36, base * 0.04)) * scale);
        var axisSize = Math.round(Math.max(8, Math.min(24, base * 0.028)) * scale);
        var tickSize = Math.round(Math.max(7, Math.min(16, base * 0.018)) * scale);
        return { titleSize: titleSize, axisSize: axisSize, tickSize: tickSize };
    }

    function applyFontOverrides(layout, w, h, preset) {
        var fonts = computeFontSizes(w, h, preset);
        var overrides = {};
        var titleObj = layout.title;
        if (titleObj && typeof titleObj === 'object') {
            overrides.title = Object.assign({}, titleObj, { font: Object.assign({}, titleObj.font || {}, { size: fonts.titleSize }) });
        } else if (typeof titleObj === 'string') {
            overrides.title = { text: titleObj, font: { size: fonts.titleSize } };
        }
        // For subplot charts, Plotly ignores per-axis font sizes on numbered axes
        // and derives them from layout.font.size. Set it to tickSize so tick labels
        // and legend text are consistent. Axis titles will also use this as their base.
        var hasSubplots = !!layout.xaxis2 || !!layout.yaxis2;
        if (hasSubplots) {
            overrides.font = Object.assign({}, layout.font || {}, { size: fonts.tickSize });
        }
        // Apply font sizes to all axes (xaxis, yaxis, xaxis2, yaxis2, etc.)
        var keys = Object.keys(layout);
        for (var ki = 0; ki < keys.length; ki++) {
            var key = keys[ki];
            if (/^[xy]axis\d*$/.test(key) && layout[key]) {
                var axis = layout[key];
                overrides[key] = Object.assign({}, axis, {
                    automargin: true,
                    title: Object.assign({}, axis.title || {}, { font: Object.assign({}, (axis.title && axis.title.font) || {}, { size: fonts.axisSize }), standoff: fonts.tickSize }),
                    tickfont: Object.assign({}, axis.tickfont || {}, { size: fonts.tickSize })
                });
            }
        }
        var legend = layout.legend || {};
        overrides.legend = Object.assign({}, legend, {
            font: Object.assign({}, legend.font || {}, { size: fonts.tickSize })
        });
        return overrides;
    }

    // ── Resize / aspect ratio ─────────────────────────────────────────
    var lastAppliedW = 0;
    var lastAppliedH = 0;
    var resizeTimer = null;
    var resizing = false;

    function isMultiChart() {
        return !!document.querySelector('.multi-chart-container');
    }

    function resizeMultiCharts() {
        var chartDiv = document.getElementById('chart');
        if (!chartDiv) return;
        var container = chartDiv.querySelector('.multi-chart-container');
        if (!container) return;

        var isScrollMode = container.classList.contains('multi-chart-scroll');

        // Scale each chart to fit its cell — no Plotly calls needed
        var cells = container.querySelectorAll('.multi-chart-cell');

        // In scroll mode, clear explicit heights first so the grid can
        // recalculate column widths before we re-measure.
        if (isScrollMode) {
            cells.forEach(function(cell) {
                if (!cell.classList.contains('zoomed')) {
                    cell.style.height = '';
                }
            });
            container.offsetHeight; // force reflow
        }

        cells.forEach(function(cell) {
            var scaler = cell.querySelector('.multi-chart-scaler');
            if (!scaler) return;
            var virtualW = Number(cell.getAttribute('data-virtual-w')) || 800;
            var virtualH = Number(cell.getAttribute('data-virtual-h')) || 500;
            var isZoomed = cell.classList.contains('zoomed');

            // For zoomed cells, use the container dimensions directly instead
            // of relying on CSS absolute positioning for the cell size.
            var cellW, cellH;
            if (isZoomed) {
                cellW = container.clientWidth;
                cellH = container.clientHeight;
            } else {
                cellW = cell.clientWidth;
                // In scroll mode, set explicit height from aspect ratio since the
                // absolutely-positioned scaler contributes no intrinsic height.
                if (isScrollMode && cellW > 0) {
                    cell.style.height = Math.round(cellW * virtualH / virtualW) + 'px';
                }
                cellH = cell.clientHeight;
            }
            if (cellW <= 0 || cellH <= 0) return;

            var scale = Math.min(cellW / virtualW, cellH / virtualH);
            var scaledW = virtualW * scale;
            var scaledH = virtualH * scale;
            var offsetX = Math.round((cellW - scaledW) / 2);
            var offsetY = Math.round((cellH - scaledH) / 2);

            scaler.style.transform = 'translate(' + offsetX + 'px, ' + offsetY + 'px) scale(' + scale + ')';
        });
    }

    function resizeChart() {
        if (resizing) return;
        resizing = true;
        try {
            resizeChartCore();
        } finally {
            resizing = false;
        }
    }

    function resizeChartCore() {
        var chartDiv = document.getElementById('chart');
        if (!chartDiv) return;

        if (isMultiChart()) {
            var w = chartDiv.clientWidth;
            var h = chartDiv.clientHeight;
            if (w > 0 && h > 0) {
                lastAppliedW = w;
                lastAppliedH = h;
                resizeMultiCharts();
            }
            return;
        }

        var plotDiv = chartDiv.querySelector('.js-plotly-plot') || chartDiv.querySelector('.plotly-graph-div');
        if (!plotDiv || typeof Plotly === 'undefined') return;
        var wrapperDiv = chartDiv.firstElementChild;
        if (!wrapperDiv) return;
        var arValue = getComputedStyle(chartDiv).getPropertyValue('--chart-aspect-ratio').trim();
        var availW = chartDiv.clientWidth;
        var availH = chartDiv.clientHeight;
        var preset = chartDiv.getAttribute('data-text-size') || '';

        function buildLayoutOverrides(w, h) {
            var overrides = { width: w, height: h };
            if (plotDiv.layout) {
                Object.assign(overrides, applyFontOverrides(plotDiv.layout, w, h, preset));
            }
            return overrides;
        }

        if (!arValue) {
            // Use absolute positioning so the wrapper is taken out of #chart's
            // flow. If the wrapper participates in flow, even sub-pixel content-
            // size changes from Plotly's internal layout can shift #chart's own
            // clientWidth/Height, which retriggers our ResizeObserver and causes
            // a second redundant resize. Aspect-ratio mode already works this way.
            wrapperDiv.style.position = 'absolute';
            wrapperDiv.style.left = '0';
            wrapperDiv.style.top = '0';
            wrapperDiv.style.width = availW + 'px';
            wrapperDiv.style.height = availH + 'px';
            wrapperDiv.style.visibility = 'visible';
            lastAppliedW = chartDiv.clientWidth;
            lastAppliedH = chartDiv.clientHeight;
            // Use relayout (not newPlot) so we don't re-upload trace data to the GPU
            // for every resize. The width/height/font overrides are layout-only and
            // relayout handles them efficiently.
            Plotly.relayout(plotDiv, buildLayoutOverrides(availW, availH));
            return;
        }
        var parts = arValue.split('/').map(Number);
        if (parts.length !== 2 || parts[0] <= 0 || parts[1] <= 0) {
            Plotly.Plots.resize(plotDiv);
            return;
        }
        var ratio = parts[0] / parts[1];
        var w, h;
        if (availW / availH > ratio) {
            h = availH;
            w = Math.round(h * ratio);
        } else {
            w = availW;
            h = Math.round(w / ratio);
        }
        wrapperDiv.style.position = 'absolute';
        wrapperDiv.style.left = Math.round((availW - w) / 2) + 'px';
        wrapperDiv.style.top = Math.round((availH - h) / 2) + 'px';
        wrapperDiv.style.width = w + 'px';
        wrapperDiv.style.height = h + 'px';
        wrapperDiv.style.margin = '';
        wrapperDiv.style.visibility = 'visible';
        lastAppliedW = chartDiv.clientWidth;
        lastAppliedH = chartDiv.clientHeight;
        // Use relayout (not newPlot) so we don't re-upload trace data to the GPU.
        Plotly.relayout(plotDiv, buildLayoutOverrides(w, h));
    }

    // Expose for host code (tab switching, edit panel toggle, etc.)
    window._chartResize = function() {
        lastAppliedW = 0; lastAppliedH = 0;
        resizeChart();
    };

    // Observe chart container resizes
    var chartContainer = document.getElementById('chart');
    if (chartContainer) {
        new ResizeObserver(function() {
            var w = chartContainer.clientWidth;
            var h = chartContainer.clientHeight;
            if (w === lastAppliedW && h === lastAppliedH) return;
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(function() { resizeChart(); }, 100);
        }).observe(chartContainer);
    }

    // ── Post-update hook (called by the page handler after chart HTML is inserted) ──
    window._chartUpdated = function() {
        var chartDiv = document.getElementById('chart');
        if (!chartDiv) return;

        if (isMultiChart()) {
            lastAppliedW = chartDiv.clientWidth;
            lastAppliedH = chartDiv.clientHeight;
            resizeMultiCharts();
            return;
        }

        var plotDiv = chartDiv.querySelector('.js-plotly-plot') || chartDiv.querySelector('.plotly-graph-div');
        if (!plotDiv || typeof Plotly === 'undefined') return;

        var arValue = getComputedStyle(chartDiv).getPropertyValue('--chart-aspect-ratio').trim();
        var availW = chartDiv.clientWidth;
        var availH = chartDiv.clientHeight;
        var preset = chartDiv.getAttribute('data-text-size') || '';
        var targetW = availW, targetH = availH;
        var centerLeft = null, centerTop = null;
        if (arValue) {
            var parts = arValue.split('/').map(Number);
            if (parts.length === 2 && parts[0] > 0 && parts[1] > 0) {
                var ratio = parts[0] / parts[1];
                if (availW / availH > ratio) {
                    targetH = availH;
                    targetW = Math.round(targetH * ratio);
                } else {
                    targetW = availW;
                    targetH = Math.round(targetW / ratio);
                }
                centerLeft = Math.round((availW - targetW) / 2);
                centerTop = Math.round((availH - targetH) / 2);
            }
        }

        var wrapperDiv = chartDiv.firstElementChild;
        if (wrapperDiv) {
            if (centerLeft !== null) {
                wrapperDiv.style.position = 'absolute';
                wrapperDiv.style.left = centerLeft + 'px';
                wrapperDiv.style.top = centerTop + 'px';
                wrapperDiv.style.width = targetW + 'px';
                wrapperDiv.style.height = targetH + 'px';
                wrapperDiv.style.margin = '';
            } else {
                // Fill mode: keep the wrapper absolutely positioned (matching
                // resizeChartCore) so its layout cannot perturb #chart's
                // clientWidth/Height and retrigger the ResizeObserver.
                wrapperDiv.style.position = 'absolute';
                wrapperDiv.style.left = '0';
                wrapperDiv.style.top = '0';
                wrapperDiv.style.width = availW + 'px';
                wrapperDiv.style.height = availH + 'px';
            }
            wrapperDiv.style.visibility = 'visible';
        }

        // Apply font/size overrides to the already-rendered plot via relayout.
        // newPlot would force Plotly to re-upload all trace data and rebuild the
        // GL canvas; relayout updates layout-only properties in place.
        var overrides = Object.assign({ width: targetW, height: targetH }, applyFontOverrides(plotDiv.layout || {}, targetW, targetH, preset));
        Plotly.relayout(plotDiv, overrides);

        lastAppliedW = availW;
        lastAppliedH = availH;
    };

    // ── Chart zoom ─────────────────────────────────────────────────────
    // In multi-chart mode, clicking a chart zooms in. A back button returns to grid.
    var zoomedCell = null;
    var backBtn = null;
    function zoomToCell(cell) {
        if (zoomedCell) unzoomCell();
        var container = cell.closest('.multi-chart-container');
        if (!container) return;
        zoomedCell = cell;
        container.scrollTop = 0;
        container.classList.add('has-zoomed');
        cell.classList.add('zoomed');
        cell.style.height = '';
        // Add back button to the container (not the cell) so it's always on top
        backBtn = document.createElement('button');
        backBtn.className = 'multi-chart-back-btn';
        backBtn.textContent = '\u25C0 All Charts';
        backBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            unzoomCell();
        });
        container.appendChild(backBtn);
        // Re-scale the zoomed chart to fill the container
        resizeMultiCharts();
    }
    function unzoomCell() {
        if (!zoomedCell) return;
        var container = zoomedCell.closest('.multi-chart-container');
        if (backBtn) { backBtn.remove(); backBtn = null; }
        zoomedCell.classList.remove('zoomed');
        if (container) container.classList.remove('has-zoomed');
        zoomedCell = null;
        // Force reflow so cells have valid dimensions before resizing
        if (container) container.offsetHeight;
        resizeMultiCharts();
    }
    document.addEventListener('click', function(e) {
        if (!isMultiChart()) return;
        // Ignore clicks outside the chart area (e.g. chart editor panel)
        var chartDiv = document.getElementById('chart');
        if (!chartDiv || !chartDiv.contains(e.target)) return;
        if (zoomedCell) {
            // Only unzoom if the click is outside the Plotly chart area
            // (allows legend clicks, axis interactions, etc. to work normally)
            var plotArea = e.target.closest('.js-plotly-plot');
            if (!plotArea) {
                unzoomCell();
            }
            return;
        }
        var target = e.target;
        while (target && target !== document.body) {
            if (target.classList && target.classList.contains('multi-chart-cell')) {
                zoomToCell(target);
                return;
            }
            target = target.parentElement;
        }
    });

    // Structured single-chart payload from the host. Avoids the multi-MB innerHTML
    // parse + script-clone shuffle by going straight to JSON.parse + Plotly.newPlot.
    // After this returns, plotDiv.data / plotDiv.layout are owned by Plotly, so
    // resize/copy paths continue to work unchanged.
    //
    // postMessage events can in principle originate from any script in the page,
    // so treat the payload as untrusted: validate divId against a strict pattern
    // and build the placeholder element with DOM APIs (no innerHTML concatenation).
    var SAFE_DIV_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
    window.addEventListener('message', function(event) {
        var msg = event.data;
        if (!msg || msg.command !== 'setChartContent' || typeof msg.divId !== 'string') return;
        if (!SAFE_DIV_ID_RE.test(msg.divId)) {
            console.error('setChartContent: rejecting unsafe divId');
            return;
        }
        var chartDiv = document.getElementById('chart');
        if (!chartDiv) return;
        // Replace contents safely: drop any existing children, then create the
        // placeholder via createElement so the divId is never parsed as HTML.
        while (chartDiv.firstChild) chartDiv.removeChild(chartDiv.firstChild);
        var plotPlaceholder = document.createElement('div');
        plotPlaceholder.id = msg.divId;
        chartDiv.appendChild(plotPlaceholder);
        if (typeof Plotly === 'undefined') {
            console.error('Plotly is not loaded yet; cannot render chart.');
            return;
        }
        try {
            var data = JSON.parse(msg.dataJson);
            var layout = JSON.parse(msg.layoutJson);
            var config = JSON.parse(msg.configJson);
            Plotly.newPlot(plotPlaceholder, data, layout, config);
        } catch (e) {
            console.error('Plotly error:', e);
            plotPlaceholder.innerText = 'Chart error: ' + (e && e.message ? e.message : e);
            return;
        }
        if (window._chartUpdated) window._chartUpdated();
    });

    // Tell the host our setChartContent listener is attached so it can replay
    // the latest payload. This makes structured-content delivery reliable
    // across initial page load and any subsequent webview.html rebuild,
    // independent of how the host buffers messages during page startup.
    if (window._vscodeApi) {
        try { window._vscodeApi.postMessage({ command: 'chartViewReady' }); } catch (e) {}
    } else {
        // _vscodeApi may be set up by another script later; retry briefly.
        var readyAttempts = 0;
        var readyTimer = setInterval(function() {
            readyAttempts++;
            if (window._vscodeApi) {
                clearInterval(readyTimer);
                try { window._vscodeApi.postMessage({ command: 'chartViewReady' }); } catch (e) {}
            } else if (readyAttempts > 20) {
                clearInterval(readyTimer);
            }
        }, 50);
    }

    window.addEventListener('message', async function(event) {
        var message = event.data;
        if (!(message && message.command === 'copyChart')) return;
        var vscodeApi = window._vscodeApi;
        if (!vscodeApi) return;
        try {
            // In multi-chart mode, copy the zoomed chart (or first if none zoomed)
            var plotDiv;
            if (isMultiChart() && zoomedCell) {
                plotDiv = zoomedCell.querySelector('.js-plotly-plot') || zoomedCell.querySelector('.plotly-graph-div');
            }
            if (!plotDiv) {
                plotDiv = document.querySelector('.js-plotly-plot') || document.querySelector('.plotly-graph-div');
            }
            if (plotDiv && typeof Plotly !== 'undefined') {
                var chartDiv = document.getElementById('chart');
                var arValue = chartDiv ? getComputedStyle(chartDiv).getPropertyValue('--chart-aspect-ratio').trim() : '';
                var width = plotDiv.offsetWidth;
                var height = plotDiv.offsetHeight;
                if (arValue) {
                    var parts = arValue.split('/').map(Number);
                    if (parts.length === 2 && parts[0] > 0 && parts[1] > 0) {
                        width = 800;
                        height = Math.round(800 * parts[1] / parts[0]);
                    }
                }
                var layout = plotDiv.layout || {};
                var pngDataUrl = await Plotly.toImage(plotDiv, { format: 'png', width: width, height: height, scale: 2 });
                var savedPaperBg = layout.paper_bgcolor || '#fff';
                var savedPlotBg = layout.plot_bgcolor || '#fff';
                await Plotly.relayout(plotDiv, { paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)' });
                var svgDataUrl = await Plotly.toImage(plotDiv, { format: 'svg', width: width, height: height });
                await Plotly.relayout(plotDiv, { paper_bgcolor: savedPaperBg, plot_bgcolor: savedPlotBg });
                vscodeApi.postMessage({ command: 'copyChartResult', pngDataUrl: pngDataUrl, svgDataUrl: svgDataUrl });
            } else {
                var canvas = document.querySelector('canvas');
                if (canvas) {
                    var dataUrl = canvas.toDataURL('image/png');
                    vscodeApi.postMessage({ command: 'copyChartResult', pngDataUrl: dataUrl });
                }
            }
        } catch (err) {
            vscodeApi.postMessage({ command: 'copyChartError', error: String(err) });
        }
    });

    // ── Initial layout on page load ───────────────────────────────────
    // When charts are embedded inline (full page rebuild), _chartUpdated isn't called
    // by the message handler. Retry until the chart div has positive dimensions.
    var initialResizeAttempts = 0;
    var maxInitialResizeAttempts = 50;
    (function initialResize() {
        var chartDiv = document.getElementById('chart');
        if (chartDiv && chartDiv.clientWidth > 0 && chartDiv.clientHeight > 0) {
            if (window._chartUpdated) window._chartUpdated();
        } else if (initialResizeAttempts < maxInitialResizeAttempts) {
            initialResizeAttempts++;
            setTimeout(initialResize, 100);
        }
    })();
})();
</script>`;

/**
 * Result returned by the chart-rendering pipeline.
 *
 * - `html`: a pre-baked HTML body to drop into the chart region. Used for the
 *   raw-Plotly path (data already comes from the user's query as JSON) and for
 *   the multi-chart panel grid (multiple charts concatenated into one HTML
 *   string with positioning/styling).
 * - `plot`: structured data for a single chart. The page handler builds the
 *   chart div and calls `Plotly.newPlot` directly with `JSON.parse`d inputs,
 *   avoiding `innerHTML` of a multi-MB HTML blob and the script-reinjection
 *   dance that comes with it.
 */
type ChartRenderResult =
    | { type: 'html'; html: string }
    | { type: 'plot'; divId: string; dataJson: string; layoutJson: string; configJson: string };

/** View for Plotly charts rendered inside a webview. */
class PlotlyChartView implements IChartView {
    onCopyResult: ((pngDataUrl: string, svgDataUrl?: string) => void) | undefined;
    onCopyError: ((error: string) => void) | undefined;
    private readonly subscription: { dispose(): void };
    /**
     * Last structured chart payload sent via `setChartContent`. Cached so we
     * can replay it whenever the page reports it's ready.
     *
     * Why: structured-content rendering does not embed anything into the
     * adapter's `contentHtml`, so the chart only appears via the message we
     * post. On initial render (and after any `webview.html` rebuild) the host
     * sends the message before the page's listener is attached, and depending
     * on how the host buffers messages during page load, that first message
     * could be lost. The page sends `chartViewReady` once its handler is up,
     * and we reliably re-send the latest payload here.
     */
    private lastPayload: { divId: string; dataJson: string; layoutJson: string; configJson: string } | undefined;

    constructor(
        private readonly webview: IWebView,
        private readonly render: (data: ResultTable, options: ChartOptions, darkMode: boolean) => ChartRenderResult | undefined
    ) {
        this.subscription = webview.handle((message) => {
            if (message.command === 'chartViewReady' && this.lastPayload) {
                // Page just attached its handler (initial load or rebuild) —
                // resend the latest payload so the chart renders even if the
                // immediate post during renderChart was missed.
                this.webview.invoke('setChartContent', { ...this.lastPayload });
                return;
            }
            if (message.command === 'copyChartResult') {
                const pngDataUrl = message.pngDataUrl as string;
                const svgDataUrl = message.svgDataUrl as string | undefined;
                if (pngDataUrl) {
                    this.onCopyResult?.(pngDataUrl, svgDataUrl);
                }
            }
            if (message.command === 'copyChartError') {
                this.onCopyError?.(String(message.error ?? 'Unknown error'));
            }
        });
    }

    copyChart(): void {
        this.webview.invoke('copyChart');
    }

    /**
     * Forget the cached structured payload. The composite chart view calls
     * this when delegating to a non-plotly renderer (e.g. TimePivot) so that
     * a subsequent `chartViewReady` from the rebuilt page does not replay a
     * stale plotly chart over the new renderer's HTML output.
     */
    clearReplayState(): void {
        this.lastPayload = undefined;
    }

    renderChart(data: ResultTable, options: ChartOptions, darkMode: boolean): void {
        const result = this.render(data, options, darkMode);
        if (!result) {
            const typeName = escapeHtml(options.type || 'Unknown');
            this.webview.setContent(
                `<div style="display:flex;align-items:center;justify-content:center;height:100%;visibility:visible;color:var(--vscode-foreground,inherit);">` +
                `<span style="font-size:1.5em;">&#10060;</span>&nbsp; Chart type "${typeName}" is not currently supported.</div>`
            );
            this.lastPayload = undefined;
            return;
        }
        if (result.type === 'html') {
            this.webview.setContent(result.html);
            this.lastPayload = undefined;
            return;
        }
        // Structured single-chart payload. Cache it so we can replay on
        // `chartViewReady` after a page (re)load, then send immediately for
        // the common case where the page is already up.
        const payload = {
            divId: result.divId,
            dataJson: result.dataJson,
            layoutJson: result.layoutJson,
            configJson: result.configJson,
        };
        this.lastPayload = payload;
        // Clear the adapter's cached contentHtml. BuildMultiTabbedHtml
        // embeds `contentHtml` directly into the rebuilt page's `#chart`
        // container, and a prior render (e.g. TimePivot, or an unsupported-
        // type message) may have left that string holding the previous
        // chart's HTML. Without this clear, switching between history items
        // would briefly show the previous chart inside the new history
        // item's page until `chartViewReady` replayed `setChartContent`.
        this.webview.setContent('');
        this.webview.invoke('setChartContent', { ...payload });
    }

    dispose(): void {
        this.subscription.dispose();
    }
}

export class PlotlyChartProvider implements IChartProvider {

    createView(webview: IWebView): IChartView {
        webview.setup(
            `<script src="${PlotlyJsCdn}" charset="utf-8"></script>
<style>
.multi-chart-container {
    width: 100%;
    height: 100%;
    overflow: hidden;
    box-sizing: border-box;
    position: relative;
}
.multi-chart-grid {
    display: grid;
    height: 100%;
    grid-auto-rows: 1fr;
    gap: 6px;
}
.multi-chart-grid > .multi-chart-cell { min-height: 0; }
.multi-chart-grid.multi-chart-scroll {
    overflow-y: auto;
    grid-auto-rows: auto;
}
.multi-chart-grid.multi-chart-scroll > .multi-chart-cell {
    aspect-ratio: var(--cell-aspect, 8 / 5);
    overflow: hidden;
}
.multi-chart-cell {
    position: relative;
    overflow: hidden;
    cursor: pointer;
}
.multi-chart-cell.zoomed {
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    margin: 0;
    z-index: 10;
    cursor: default;
}
.multi-chart-container.has-zoomed > .multi-chart-cell:not(.zoomed) {
    display: none;
}
.multi-chart-container.has-zoomed {
    height: 100%;
    overflow: hidden;
}
.multi-chart-back-btn {
    position: absolute;
    top: 6px;
    right: 6px;
    z-index: 20;
    background: var(--vscode-button-secondaryBackground, #333);
    color: var(--vscode-button-secondaryForeground, #ccc);
    border: 1px solid var(--vscode-button-border, #555);
    border-radius: 3px;
    padding: 2px 8px;
    font-size: 12px;
    cursor: pointer;
    opacity: 0.85;
}
.multi-chart-back-btn:hover {
    opacity: 1;
    background: var(--vscode-button-secondaryHoverBackground, #444);
}
.multi-chart-scaler {
    transform-origin: top left;
    position: absolute;
    visibility: visible;
}
.multi-chart-container {
    visibility: visible !important;
}
</style>`,
            plotlyChartScripts
        );
        return new PlotlyChartView(webview, (data, options, darkMode) => this.renderChartToHtmlDiv(data, options, darkMode));
    }

    private renderChartToHtmlDiv(data: ResultTable, options: ChartOptions, darkMode = false): ChartRenderResult | undefined {
        // Allow the chart's mode option to override the editor theme
        if (options.mode === ChartMode.Light) darkMode = false;
        else if (options.mode === ChartMode.Dark) darkMode = true;

        if (options.type === ChartType.Plotly) {
            const html = this.renderRawPlotlyChart(data, darkMode);
            return html ? { type: 'html', html } : undefined;
        }

        // Multiple independent charts (CSS-scaled). Concatenated into a single HTML
        // string so the grid layout/scaling sits next to each chart.
        if (options.yLayout === ChartYLayout.SeparateCharts && (this.is2dChartType(options.type) || options.type === ChartType.Pie)) {
            const xColumn = this.get2dXColumn(data, options);
            if (xColumn) {
                const yColumns = this.get2dYColumns(data, options, xColumn);
                if (yColumns.length > 1) {
                    const html = this.renderMultiChartPanels(data, options, darkMode, yColumns);
                    return html ? { type: 'html', html } : undefined;
                }
            }
        }

        const builder = this.buildChart(data, options, darkMode);
        return builder?.toContent();
    }

    /** Returns true for chart types that use 2D x/y column rendering and support y-split. */
    private is2dChartType(type: string): boolean {
        switch (type) {
            case ChartType.Bar:
            case ChartType.BarStacked:
            case ChartType.BarStacked100:
            case ChartType.Column:
            case ChartType.ColumnStacked:
            case ChartType.ColumnStacked100:
            case ChartType.Line:
            case ChartType.TimeLine:
            case ChartType.TimeLineAnomaly:
            case ChartType.Scatter:
            case ChartType.Area:
            case ChartType.AreaStacked:
            case ChartType.AreaStacked100:
                return true;
            default:
                return false;
        }
    }

    /** Renders multiple separate charts, one per y-column, arranged in a layout container. */
    private renderMultiChartPanels(
        data: ResultTable,
        options: ChartOptions,
        darkMode: boolean,
        yColumns: ColumnRef[],
    ): string | undefined {
        const { width: virtualW, height: virtualH } = this.getInitialChartSize(options.aspectRatio);
        const fontSizes = computeFontSizes(virtualW, virtualH, options.textSize);
        const colorway = PlotlyColorways.Default;
        const chartCells: string[] = [];
        for (let i = 0; i < yColumns.length; i++) {
            const yCol = yColumns[i]!;
            const splitOptions: ChartOptions = {
                ...options,
                yColumns: [yCol.column.name],
                yTitle: options.yTitle ? `${options.yTitle} - ${yCol.column.name}` : yCol.column.name,
            };
            delete splitOptions.yLayout; // prevent recursion
            let builder = this.buildChart(data, splitOptions, darkMode);
            if (builder) {
                // Hide the legend when there's only one trace and no explicit position was set
                if (options.legendPosition == null && builder.traces.length <= 1) {
                    builder = builder.hideLegend();
                }
                // Rotate the colorway so each chart's trace keeps the color it would
                // have had on the combined chart.
                const rotated = [...colorway.slice(i % colorway.length), ...colorway.slice(0, i % colorway.length)];
                builder = builder.setColorway(...rotated);
                // Render at a fixed virtual size. CSS transform: scale() handles fitting to the cell.
                const layout = applyFontSizesToLayout({ ...builder.layout, width: virtualW, height: virtualH }, fontSizes);
                builder = builder
                    .withLayout(layout)
                    .withConfig({ ...builder.config, responsive: false });
                const chartHtml = builder.toHtmlDiv(`plotly-chart-${i}`);
                chartCells.push(
                    `<div class="multi-chart-cell" data-virtual-w="${virtualW}" data-virtual-h="${virtualH}">` +
                    `<div class="multi-chart-scaler">${chartHtml}</div></div>`
                );
            }
        }

        if (chartCells.length === 0) return undefined;

        const maxCols = 3;
        const cols = Math.min(maxCols, Math.ceil(Math.sqrt(chartCells.length)));
        const scroll = chartCells.length > cols * 3;
        const scrollClass = scroll ? ' multi-chart-scroll' : '';
        const aspectVar = `--cell-aspect: ${virtualW} / ${virtualH}`;
        const colsStyle = `; grid-template-columns: repeat(${cols}, 1fr)`;
        const inlineStyle = ` style="${aspectVar}${colsStyle}"`;

        return `<div class="multi-chart-container multi-chart-grid${scrollClass}"${inlineStyle}>${chartCells.join('')}</div>`;
    }

    /** Returns an initial render size based on the aspect ratio, defaulting to 800×500 (roughly 16:10). */
    private getInitialChartSize(aspectRatio?: string): { width: number; height: number } {
        const baseWidth = 800;
        if (aspectRatio) {
            const parts = aspectRatio.split(':').map(Number);
            if (parts.length === 2 && parts[0]! > 0 && parts[1]! > 0) {
                return { width: baseWidth, height: Math.round(baseWidth * parts[1]! / parts[0]!) };
            }
        }
        return { width: baseWidth, height: 500 };
    }

    // ─── Raw Plotly ─────────────────────────────────────────────────────

    private renderRawPlotlyChart(data: ResultTable, darkMode = false, divId = 'plotly-chart'): string | undefined {
        if (data.columns.length === 0 || data.rows.length === 0) return undefined;

        const firstRow = data.rows[0];
        if (!firstRow) return undefined;
        const cellValue = firstRow[0];
        if (cellValue == null) return undefined;

        const jsonString = typeof cellValue === 'string' ? cellValue : String(cellValue);
        if (!jsonString.trim()) return undefined;

        try {
            const root = JSON.parse(jsonString) as Record<string, unknown>;
            if (!root || !root.data) return undefined;

            const dataJson = JSON.stringify(root.data);

            // Apply theme to the in-memory layout object before the single stringify,
            // so we don't pay an extra parse/stringify round-trip.
            const layoutObj = (root.layout && typeof root.layout === 'object')
                ? root.layout as Record<string, unknown>
                : {};
            const themedLayout = darkMode
                ? applyDarkModeToLayout(layoutObj)
                : applyLightModeToLayout(layoutObj);
            const layoutJson = JSON.stringify(themedLayout);

            const configJson = root.config
                ? JSON.stringify(root.config)
                : '{"responsive": true, "displayModeBar": false}';

            return createChartDiv(dataJson, layoutJson, configJson, divId);
        } catch {
            return undefined;
        }
    }

    // ─── Build Chart ────────────────────────────────────────────────────

    private buildChart(data: ResultTable, options: ChartOptions, darkMode: boolean): PlotlyChartBuilder | undefined {
        let builder: PlotlyChartBuilder | undefined;

        switch (options.type) {
            case ChartType.Bar:
            case ChartType.BarStacked:
            case ChartType.BarStacked100:
            case ChartType.Column:
            case ChartType.ColumnStacked:
            case ChartType.ColumnStacked100:
                builder = this.buildBarOrColumnChart(data, options);
                break;
            case ChartType.Line:
            case ChartType.TimeLine:
            case ChartType.TimeLineAnomaly:
                builder = this.buildLineChart(data, options, darkMode);
                break;
            case ChartType.Scatter:
                builder = this.buildScatterChart(data, options, darkMode);
                break;
            case ChartType.Pie:
                builder = this.buildPieChart(data, options);
                break;
            case ChartType.Area:
                builder = this.buildAreaChart(data, options);
                break;
            case ChartType.AreaStacked:
                builder = this.buildStackedAreaChart(data, options);
                break;
            case ChartType.AreaStacked100:
                builder = this.buildStackedAreaChart(data, options);
                break;
            case ChartType.Card:
                builder = this.buildCardChart(data, options);
                break;
            case ChartType.ThreeD:
                builder = this.buildThreeDChart(data, options);
                break;
            case ChartType.TreeMap:
                builder = this.buildTreeMapChart(data, options);
                break;
            case ChartType.Sankey:
                builder = this.buildSankeyChart(data, options);
                break;
            case ChartType.Ladder:
            case ChartType.TimePivot:
                builder = this.buildLadderChart(data, options);
                break;
            default:
                return undefined;
        }

        if (builder) {
            if (darkMode) {
                builder = builder.withDarkMode();
            } else {
                builder = builder.withLightMode();
            }
            if (options.type !== ChartType.ThreeD) {
                builder = builder.withFixedRange();
            }
        }

        return builder;
    }

    // ─── Bar / Column ───────────────────────────────────────────────────

    private buildBarOrColumnChart(data: ResultTable, options: ChartOptions): PlotlyChartBuilder | undefined {
        let builder = new PlotlyChartBuilder();
        const isHorizontal = options.type === ChartType.Bar || options.type === ChartType.BarStacked || options.type === ChartType.BarStacked100;
        const isStacked = options.type === ChartType.BarStacked || options.type === ChartType.BarStacked100
            || options.type === ChartType.ColumnStacked || options.type === ChartType.ColumnStacked100;
        const isStacked100 = options.type === ChartType.BarStacked100 || options.type === ChartType.ColumnStacked100;

        if (isStacked) {
            builder = builder.setStacked();
        }

        if (isStacked100) {
            return this.buildStacked100BarOrColumnChart(builder, data, options, isHorizontal);
        }

        const showValues = options.showValues === true;
        return this.build2dChart(builder, data, options,
            (b, keys, values, name, yAxis) =>
                b.add2DBarTrace(
                    keys, values, name, isHorizontal, yAxis, undefined,
                    showValues ? values.map(v => v as unknown) : undefined,
                    showValues ? 'auto' : undefined,
                ),
        );
    }

    private buildStacked100BarOrColumnChart(
        builder: PlotlyChartBuilder, data: ResultTable, options: ChartOptions, isHorizontal: boolean,
    ): PlotlyChartBuilder | undefined {
        const xColumn = this.get2dXColumn(data, options);
        if (!xColumn) return undefined;

        const yColumns = this.get2dYColumns(data, options, xColumn);

        const seriesData: { keys: unknown[]; values: number[]; name: string }[] = [];

        for (const valueColumn of yColumns) {
            const result = this.get2DChartData(data, xColumn, valueColumn);
            if (result) {
                seriesData.push({ keys: result.x, values: result.y, name: valueColumn.column.name });
            }
        }

        if (seriesData.length === 0) return undefined;

        const first = seriesData[0]!;
        const totals = new Array<number>(first.keys.length).fill(0);

        for (const { values } of seriesData) {
            for (let i = 0; i < Math.min(values.length, totals.length); i++) {
                totals[i] = (totals[i] ?? 0) + Math.abs(values[i] ?? 0);
            }
        }

        if (options.title) builder = builder.withTitle(options.title);
        if (options.xTitle) builder = builder.setXAxisTitle(options.xTitle);
        if (options.yTitle) builder = builder.setYAxisTitle(options.yTitle);
        builder = builder.setYAxisRange(0, 1);

        const showValues = options.showValues === true;
        for (const { keys, values, name } of seriesData) {
            const normalized = values.map((v, i) => {
                const total = totals[i] ?? 0;
                return total > 0 ? v / total : 0;
            });
            builder = builder.add2DBarTrace(
                keys, normalized, name, isHorizontal, undefined, undefined,
                showValues ? normalized.map(v => v as unknown) : undefined,
                showValues ? 'auto' : undefined,
            );
        }

        return builder;
    }

    // ─── Line / Scatter / Area ──────────────────────────────────────────

    private buildLineChart(data: ResultTable, options: ChartOptions, darkMode = false): PlotlyChartBuilder | undefined {
        const anomalySet = new Set(options.anomalyColumns ?? []);

        // If anomalyColumns are specified, exclude them from y-columns so they don't render as lines
        const effectiveOptions = anomalySet.size > 0
            ? (() => {
                const xColumn = this.get2dXColumn(data, options);
                if (!xColumn) return options;
                const filtered = this.get2dYColumns(data, options, xColumn)
                    .filter(c => !anomalySet.has(c.column.name));
                return { ...options, yColumns: filtered.map(c => c.column.name) } as ChartOptions;
            })()
            : options;

        const hasMarkers = options.showMarkers === true;
        const showValues = options.showValues === true;
        const markerOutline = options.markerOutline === true;
        const outlineColor = darkMode ? 'white' : '#333';
        let builder = this.build2dChart(new PlotlyChartBuilder(), data, effectiveOptions,
            (b, x, y, name, yAxis, traceIndex) => b.add2DLineTrace(x, y, name, hasMarkers, yAxis, getMarkerShape(options, traceIndex), getMarkerSize(options), showValues, markerOutline, outlineColor));

        return builder ? this.addAnomalyScatterOverlays(builder, data, options, effectiveOptions) : undefined;
    }

    private buildScatterChart(data: ResultTable, options: ChartOptions, darkMode = false): PlotlyChartBuilder | undefined {
        const anomalySet = new Set(options.anomalyColumns ?? []);
        const effectiveOptions = anomalySet.size > 0
            ? (() => {
                const xColumn = this.get2dXColumn(data, options);
                if (!xColumn) return options;
                const filtered = this.get2dYColumns(data, options, xColumn)
                    .filter(c => !anomalySet.has(c.column.name));
                return { ...options, yColumns: filtered.map(c => c.column.name) } as ChartOptions;
            })()
            : options;
        const outlineColor = darkMode ? 'white' : '#333';
        const builder = this.build2dChart(new PlotlyChartBuilder(), data, effectiveOptions,
            (b, x, y, name, yAxis, traceIndex) => b.add2DScatterTrace(x, y, name, yAxis, getMarkerShape(options, traceIndex), getMarkerSize(options), options.showValues === true, options.markerOutline === true, outlineColor));
        return builder ? this.addAnomalyScatterOverlays(builder, data, options, effectiveOptions) : undefined;
    }

    private buildAreaChart(data: ResultTable, options: ChartOptions, darkMode = false): PlotlyChartBuilder | undefined {
        const outlineColor = darkMode ? 'white' : '#333';
        return this.build2dChart(new PlotlyChartBuilder(), data, options,
            (b, x, y, name, yAxis, traceIndex) => b.addAreaChart(
                x, y, name, undefined, yAxis, undefined,
                options.showMarkers === true,
                getMarkerShape(options, traceIndex),
                getMarkerSize(options),
                options.showValues === true,
                options.markerOutline === true,
                outlineColor,
            ));
    }

    private buildStackedAreaChart(data: ResultTable, options: ChartOptions, darkMode = false): PlotlyChartBuilder | undefined {
        const groupNorm = options.type === ChartType.AreaStacked100 ? 'percent' : undefined;
        const outlineColor = darkMode ? 'white' : '#333';
        return this.build2dChart(new PlotlyChartBuilder(), data, options,
            (b, x, y, name, yAxis, traceIndex) => b.addAreaChart(
                x, y, name, '1', yAxis, groupNorm,
                options.showMarkers === true,
                getMarkerShape(options, traceIndex),
                getMarkerSize(options),
                options.showValues === true,
                options.markerOutline === true,
                outlineColor,
            ));
    }

    private addAnomalyScatterOverlays(
        builder: PlotlyChartBuilder,
        data: ResultTable,
        options: ChartOptions,
        effectiveOptions: ChartOptions,
    ): PlotlyChartBuilder {
        const anomalySet = new Set(options.anomalyColumns ?? []);
        if (anomalySet.size === 0) {
            return builder;
        }

        const xColumn = this.get2dXColumn(data, options);
        if (!xColumn) {
            return builder;
        }

        const allYColumns = this.get2dYColumns(data, effectiveOptions, xColumn);
        const yCol = allYColumns[0];
        if (!yCol) {
            return builder;
        }

        const xValues = getColumnValues(data, xColumn);
        const yValues = getColumnValues(data, yCol);
        let anomalyTraceIndex = allYColumns.length;
        let updatedBuilder = builder;

        for (const anomalyColName of anomalySet) {
            const anomalyCol = getColumnRef(data, anomalyColName);
            if (!anomalyCol) continue;
            const anomalyFlags = getColumnValues(data, anomalyCol);

            const anomalyX: unknown[] = [];
            const anomalyY: number[] = [];
            const len = Math.min(xValues.length, anomalyFlags.length, yValues.length);
            for (let i = 0; i < len; i++) {
                const flag = toNumber(anomalyFlags[i]);
                if (flag !== 0 && xValues[i] != null && yValues[i] != null) {
                    anomalyX.push(xValues[i]);
                    anomalyY.push(toNumber(yValues[i]));
                }
            }

            if (anomalyX.length > 0) {
                const shape = getMarkerShape(options, anomalyTraceIndex);
                updatedBuilder = updatedBuilder.add2DScatterTrace(anomalyX, anomalyY, anomalyColName, undefined, shape, getMarkerSize(options));
                anomalyTraceIndex++;
            }
        }

        return updatedBuilder;
    }

    // ─── Pie ────────────────────────────────────────────────────────────

    private buildPieChart(data: ResultTable, options: ChartOptions): PlotlyChartBuilder | undefined {
        let builder = new PlotlyChartBuilder();

        if (options.title) builder = builder.withTitle(options.title);
        builder = applyCommonOptions(builder, options);

        const labelColumn = this.get2dXColumn(data, options);
        if (!labelColumn) return undefined;

        const valueColumns = this.get2dYColumns(data, options, labelColumn);
        const textInfo = options.showValues === true ? 'label+value+percent' : undefined;

        for (const valueColumn of valueColumns) {
            const result = this.get2DChartData(data, labelColumn, valueColumn);
            if (result) {
                builder = builder.addPieTrace(result.x, result.y, valueColumn.column.name, 0.0, textInfo);
            }
        }

        return builder;
    }

    // ─── Card ───────────────────────────────────────────────────────────

    private buildCardChart(data: ResultTable, options: ChartOptions): PlotlyChartBuilder | undefined {
        if (data.rows.length === 0 || data.columns.length === 0) return undefined;

        let valueColumn: ColumnRef | undefined;
        for (let i = 0; i < data.columns.length; i++) {
            const col = data.columns[i];
            if (col && isNumericType(col.type)) {
                valueColumn = getColumnRefByIndex(data, i);
                break;
            }
        }
        if (!valueColumn) return undefined;

        const firstRow = data.rows[0];
        if (!firstRow) return undefined;
        const cellValue = firstRow[valueColumn.index];
        if (cellValue == null) return undefined;

        const value = sanitizeDouble(toNumber(cellValue));
        const title = options.title ?? valueColumn.column.name;

        return new PlotlyChartBuilder().addIndicatorTrace(value, title, PlotlyIndicatorModes.Number);
    }

    // ─── 3D Chart ───────────────────────────────────────────────────────

    private buildThreeDChart(data: ResultTable, options: ChartOptions): PlotlyChartBuilder | undefined {
        if (data.columns.length < 3 || data.rows.length === 0) return undefined;

        const xCol = getColumnRefByIndex(data, 0);
        const yCol = getColumnRefByIndex(data, 1);
        const zCol = getColumnRefByIndex(data, 2);
        if (!xCol || !yCol || !zCol) return undefined;

        if (!isNumericType(zCol.column.type)) return undefined;

        // Get unique sorted X and Y values
        const xSet = new Map<string, unknown>();
        const ySet = new Map<string, unknown>();
        for (const row of data.rows) {
            if (!row) continue;
            const xv = row[xCol.index];
            const yv = row[yCol.index];
            if (xv != null) xSet.set(String(xv), xv);
            if (yv != null) ySet.set(String(yv), yv);
        }

        const xValues = [...xSet.values()];
        const yValues = [...ySet.values()];
        if (xValues.length === 0 || yValues.length === 0) return undefined;

        // Build (x, y) -> z lookup
        const dataLookup = new Map<string, number>();
        for (const row of data.rows) {
            if (!row) continue;
            const x = row[xCol.index];
            const y = row[yCol.index];
            const z = row[zCol.index];
            if (x != null && y != null && z != null) {
                dataLookup.set(`${String(x)}|${String(y)}`, sanitizeDouble(toNumber(z)));
            }
        }

        // Build Z grid [yIndex][xIndex]
        const zGrid: unknown[][] = [];
        for (let i = 0; i < yValues.length; i++) {
            const row: unknown[] = [];
            for (let j = 0; j < xValues.length; j++) {
                const key = `${String(xValues[j])}|${String(yValues[i])}`;
                row.push(dataLookup.get(key) ?? 0.0);
            }
            zGrid.push(row);
        }

        let builder = new PlotlyChartBuilder();
        if (options.title) builder = builder.withTitle(options.title);

        builder = builder.add3DSurfaceTrace(zGrid, xValues, yValues, zCol.column.name);

        // Configure scene axes
        let scene: PlotlyScene = {};
        if (options.xTitle) {
            scene = { ...scene, xaxis: { title: { text: options.xTitle } } };
        }
        if (options.yTitle) {
            scene = { ...scene, yaxis: { title: { text: options.yTitle } } };
        }
        scene = { ...scene, zaxis: { title: { text: options.zTitle ?? zCol.column.name } } };
        builder = builder.withScene(scene);

        builder = applyCommonOptions(builder, options);

        return builder;
    }

    // ─── TreeMap ────────────────────────────────────────────────────────

    private buildTreeMapChart(data: ResultTable, options: ChartOptions): PlotlyChartBuilder | undefined {
        if (data.columns.length < 2 || data.rows.length === 0) return undefined;

        // Find value column (last numeric) and hierarchy columns (non-numeric)
        let valueColumn: ColumnRef | undefined;
        const hierarchyColumns: ColumnRef[] = [];

        for (let i = 0; i < data.columns.length; i++) {
            const col = data.columns[i];
            if (!col) continue;
            if (isNumericType(col.type)) {
                valueColumn = getColumnRefByIndex(data, i);
            } else {
                const ref = getColumnRefByIndex(data, i);
                if (ref) hierarchyColumns.push(ref);
            }
        }

        // If no non-numeric columns found, use all but last as hierarchy
        if (hierarchyColumns.length === 0) {
            for (let i = 0; i < data.columns.length - 1; i++) {
                const ref = getColumnRefByIndex(data, i);
                if (ref) hierarchyColumns.push(ref);
            }
            valueColumn = getColumnRefByIndex(data, data.columns.length - 1);
        }

        if (!valueColumn || hierarchyColumns.length === 0) return undefined;

        const labels: string[] = [];
        const parents: string[] = [];
        const values: number[] = [];
        const ids: string[] = [];
        const branchIndices = new Map<string, number>();
        const addedNodes = new Set<string>();

        for (let rowIndex = 0; rowIndex < data.rows.length; rowIndex++) {
            const row = data.rows[rowIndex];
            if (!row) continue;
            const cellValue = row[valueColumn.index];
            if (cellValue == null) continue;

            const value = sanitizeDouble(toNumber(cellValue));
            let parentId = '';

            for (let level = 0; level < hierarchyColumns.length; level++) {
                const col = hierarchyColumns[level];
                if (!col) continue;
                const nodeValue = row[col.index];
                if (nodeValue == null) continue;

                const nodeLabel = String(nodeValue);
                const nodeId = parentId === '' ? nodeLabel : `${parentId}/${nodeLabel}`;

                if (level < hierarchyColumns.length - 1) {
                    // Branch node
                    if (!addedNodes.has(nodeId)) {
                        const branchIndex = labels.length;
                        labels.push(nodeLabel);
                        parents.push(parentId);
                        values.push(0);
                        ids.push(nodeId);
                        addedNodes.add(nodeId);
                        branchIndices.set(nodeId, branchIndex);
                    }
                    const idx = branchIndices.get(nodeId);
                    if (idx !== undefined) {
                        values[idx] = (values[idx] ?? 0) + value;
                    }
                } else {
                    // Leaf node
                    const leafId = `${nodeId}_${rowIndex}`;
                    labels.push(nodeLabel);
                    parents.push(parentId);
                    values.push(value);
                    ids.push(leafId);
                }

                parentId = nodeId;
            }
        }

        if (labels.length === 0) return undefined;

        let builder = new PlotlyChartBuilder();
        if (options.title) builder = builder.withTitle(options.title);

        builder = builder.addTreeMapTrace(labels, parents, values, valueColumn.column.name, ids, 'label+value', 'total');

        builder = applyCommonOptions(builder, options);

        return builder;
    }

    // ─── Sankey ─────────────────────────────────────────────────────────

    private buildSankeyChart(data: ResultTable, options: ChartOptions): PlotlyChartBuilder | undefined {
        if (data.columns.length < 3 || data.rows.length === 0) return undefined;

        let sourceColumn: ColumnRef | undefined;
        let targetColumn: ColumnRef | undefined;
        let valueColumn: ColumnRef | undefined;

        for (let i = 0; i < data.columns.length; i++) {
            const col = data.columns[i];
            if (!col) continue;
            if (isNumericType(col.type)) {
                if (!valueColumn) valueColumn = getColumnRefByIndex(data, i);
            } else {
                if (!sourceColumn) sourceColumn = getColumnRefByIndex(data, i);
                else if (!targetColumn) targetColumn = getColumnRefByIndex(data, i);
            }
        }

        // Fallback: first two columns as source/target, third as value
        if (!sourceColumn || !targetColumn) {
            if (data.columns.length >= 3) {
                sourceColumn = getColumnRefByIndex(data, 0);
                targetColumn = getColumnRefByIndex(data, 1);
                valueColumn = getColumnRefByIndex(data, 2);
            } else {
                return undefined;
            }
        }

        if (!sourceColumn || !targetColumn || !valueColumn) return undefined;

        const nodeLabels: string[] = [];
        const nodeIndexMap = new Map<string, number>();

        function ensureNode(label: string) {
            if (!nodeIndexMap.has(label)) {
                nodeIndexMap.set(label, nodeLabels.length);
                nodeLabels.push(label);
            }
        }

        const linkSources: number[] = [];
        const linkTargets: number[] = [];
        const linkValues: number[] = [];

        for (const row of data.rows) {
            if (!row) continue;
            const sourceValue = row[sourceColumn.index];
            const targetValue = row[targetColumn.index];
            const flowValue = row[valueColumn.index];

            if (sourceValue == null || targetValue == null || flowValue == null) continue;

            const sourceLabel = String(sourceValue);
            const targetLabel = String(targetValue);
            const value = sanitizeDouble(toNumber(flowValue));

            if (value <= 0) continue;

            ensureNode(sourceLabel);
            ensureNode(targetLabel);

            linkSources.push(nodeIndexMap.get(sourceLabel)!);
            linkTargets.push(nodeIndexMap.get(targetLabel)!);
            linkValues.push(value);
        }

        if (nodeLabels.length === 0 || linkSources.length === 0) return undefined;

        let builder = new PlotlyChartBuilder();
        if (options.title) builder = builder.withTitle(options.title);

        builder = builder.addSankeyTrace(nodeLabels, linkSources, linkTargets, linkValues, valueColumn.column.name);

        builder = applyCommonOptions(builder, options);

        return builder;
    }

    // ─── Ladder Chart ─────────────────────────────────────────────────

    private buildLadderChart(data: ResultTable, options: ChartOptions): PlotlyChartBuilder | undefined {
        if (data.columns.length < 3 || data.rows.length === 0) return undefined;

        // Find columns: first datetime → start, second datetime → end, first non-datetime non-numeric → category
        let startColumn: ColumnRef | undefined;
        let endColumn: ColumnRef | undefined;
        let categoryColumn: ColumnRef | undefined;

        for (let i = 0; i < data.columns.length; i++) {
            const col = data.columns[i];
            if (!col) continue;
            if (isDateTimeType(col.type)) {
                if (!startColumn) startColumn = getColumnRefByIndex(data, i);
                else if (!endColumn) endColumn = getColumnRefByIndex(data, i);
            } else if (!categoryColumn && !isNumericType(col.type)) {
                categoryColumn = getColumnRefByIndex(data, i);
            }
        }

        if (!startColumn || !endColumn || !categoryColumn) return undefined;

        // Resolve series columns for grouping
        const seriesCols = (options.seriesColumns ?? [])
            .map(name => getColumnRef(data, name))
            .filter((c): c is ColumnRef => c !== undefined);

        // Category label = seriesColumns joined (if set), otherwise the category column value.
        // Uses <br> between series values for multi-line wrapping.
        // Color key = first series column value (if multiple series cols), otherwise same as category label.
        interface RowData { category: string; start: unknown; duration: number }
        const rowsByColorKey = new Map<string, RowData[]>();
        const categoryOrder: string[] = [];
        const categorySet = new Set<string>();
        let hasData = false;

        for (const row of data.rows) {
            if (!row) continue;
            const cat = row[categoryColumn.index];
            const start = row[startColumn.index];
            const end = row[endColumn.index];
            if (cat == null || start == null || end == null) continue;
            const startMs = new Date(String(start)).getTime();
            const endMs = new Date(String(end)).getTime();
            if (isNaN(startMs) || isNaN(endMs)) continue;

            // Category label used as string y-value (Plotly manages categorical axis)
            const categoryLabel = seriesCols.length > 0
                ? seriesCols.map(c => String(row[c.index] ?? '')).join(' - ')
                : String(cat);

            // Track category order as first encountered in data
            if (!categorySet.has(categoryLabel)) {
                categorySet.add(categoryLabel);
                categoryOrder.push(categoryLabel);
            }

            // Color key determines the trace (and thus the color)
            const colorKey = seriesCols.length > 1
                ? String(row[seriesCols[0]!.index] ?? '')
                : categoryLabel;

            let group = rowsByColorKey.get(colorKey);
            if (!group) {
                group = [];
                rowsByColorKey.set(colorKey, group);
            }
            group.push({ category: categoryLabel, start, duration: endMs - startMs });
            hasData = true;
        }

        if (!hasData) return undefined;

        let builder = new PlotlyChartBuilder();
        if (options.title) builder = builder.withTitle(options.title);
        if (options.xTitle) builder = builder.setXAxisTitle(options.xTitle);
        if (options.yTitle) builder = builder.setYAxisTitle(options.yTitle);
        builder = applyCommonOptions(builder, options);

        // Overlay bars so they align with grid lines (not grouped/dodged)
        builder = builder.setBarMode('overlay');

        // Set x-axis to date type; preserve data order on y-axis
        builder = builder.withXAxis({ ...(builder.layout.xaxis ?? {}), type: 'date' });
        builder = builder.withYAxis({
            ...(builder.layout.yaxis ?? {}),
            categoryorder: 'array',
            categoryarray: categoryOrder,
        });

        // Reverse legend order so it matches the y-axis (which displays bottom-to-top)
        builder = builder.withLayout({
            ...builder.layout,
            legend: { ...(builder.layout.legend ?? {}), traceorder: 'reversed' },
        });

        // Add traces in data order (categories appear in the order first encountered)
        for (const [colorKey, rows] of rowsByColorKey) {
            builder = builder.addLadderTrace(
                rows.map(r => r.category),
                rows.map(r => r.duration),
                rows.map(r => r.start),
                colorKey,
            );
        }

        return builder;
    }

    // ─── Common 2D Chart Builder ────────────────────────────────────────

    private build2dChart(
        builder: PlotlyChartBuilder,
        data: ResultTable,
        options: ChartOptions,
        addTrace: (b: PlotlyChartBuilder, x: unknown[], y: number[], name: string, yAxis: string | undefined, traceIndex: number) => PlotlyChartBuilder,
    ): PlotlyChartBuilder | undefined {
        const xColumn = this.get2dXColumn(data, options);
        if (!xColumn) return undefined;

        // Auto-infer series column when not explicitly specified
        let effectiveOptions = options;
        if (!options.seriesColumns || options.seriesColumns.length === 0) {
            const inferredSeries = this.inferSeriesColumn(data, xColumn, options.anomalyColumns);
            if (inferredSeries) {
                effectiveOptions = { ...options, seriesColumns: [inferredSeries.column.name] };
            }
        }

        const yColumns = this.get2dYColumns(data, effectiveOptions, xColumn);

        if (options.title) builder = builder.withTitle(options.title);
        if (options.xTitle) builder = builder.setXAxisTitle(options.xTitle);
        if (options.yTitle) builder = builder.setYAxisTitle(options.yTitle);
        if (options.xAxis === ChartAxis.Log) builder = builder.setLogX();
        if (options.yAxis === ChartAxis.Log) builder = builder.setLogY();

        const xMinD = tryGetDouble(options.xMin);
        const xMaxD = tryGetDouble(options.xMax);
        if (xMinD !== undefined && xMaxD !== undefined) {
            builder = builder.setXAxisRange(xMinD, xMaxD);
        }

        const yMinD = tryGetDouble(options.yMin);
        const yMaxD = tryGetDouble(options.yMax);
        if (yMinD !== undefined && yMaxD !== undefined) {
            builder = builder.setYAxisRange(yMinD, yMaxD);
        }

        builder = applyCommonOptions(builder, options);

        // ── Y-axis split modes ──────────────────────────────────────────
        // Build a map from y-column index to Plotly yaxis reference (e.g., 'y', 'y2', 'y3').
        const yAxisMap = new Map<number, string>();

        if (options.yLayout === ChartYLayout.DualAxis && yColumns.length > 1) {
            // Dual Axis: first y-column on left axis, rest on a shared right axis with its own scale
            for (let i = 1; i < yColumns.length; i++) {
                yAxisMap.set(i, 'y2');
            }
            builder = builder.addSecondaryYAxis('yaxis2', {
                overlaying: 'y',
                side: 'right',
                showgrid: false,
            });
        } else if (options.yLayout === ChartYLayout.SeparatePanels && yColumns.length > 1) {
            // Panels: each y-column in its own subplot area (stacked vertically)
            // The primary yaxis/xaxis is assigned to the BOTTOM panel so that Plotly's
            // default margin handling benefits the panel that needs tick labels and title.
            const count = yColumns.length;
            const gap = 0.05;
            const totalGap = gap * (count - 1);
            const plotHeight = (1 - totalGap) / count;

            // Build a clean base from the primary yaxis, stripping title/domain/range
            // so all subplot axes start from an identical base.
            const { title: _t, domain: _d, range: _r, ...yAxisBase } = (builder.layout.yaxis ?? {}) as Record<string, unknown>;
            const { title: xTitle, ...xAxisBase } = (builder.layout.xaxis ?? {}) as Record<string, unknown>;

            // Use ONLY numbered axes (yaxis2/xaxis2 .. yaxisN+1/xaxisN+1) for all panels.
            // Hide the primary yaxis/xaxis so Plotly doesn't give them special margin treatment.
            builder = builder.withLayout({
                ...builder.layout,
                yaxis: { visible: false, showticklabels: false, zeroline: false } as PlotlyAxis,
                xaxis: { visible: false, showticklabels: false, zeroline: false } as PlotlyAxis,
            });

            const bottomIdx = count - 1;

            for (let i = 0; i < count; i++) {
                const domainBottom = i * (plotHeight + gap);
                const domainTop = domainBottom + plotHeight;
                // Reverse so first column is at top
                const domain: [number, number] = [1 - domainTop, 1 - domainBottom];
                const isBottom = i === bottomIdx;
                const axisNum = i + 2; // yaxis2, xaxis2, yaxis3, xaxis3, ...
                const yRef = `y${axisNum}`;
                const xRef = `x${axisNum}`;
                yAxisMap.set(i, yRef);

                builder = builder.withLayout({
                    ...builder.layout,
                    [`yaxis${axisNum}`]: {
                        ...yAxisBase,
                        domain,
                        title: { text: yColumns[i]!.column.name },
                        anchor: xRef,
                        showline: true,
                        mirror: options.yMirror === true ? 'ticks' : true,
                        linecolor: '#888888'
                    },
                    [`xaxis${axisNum}`]: { ...xAxisBase, anchor: yRef, showticklabels: isBottom, title: isBottom ? (xTitle ?? '') : '', showline: true, mirror: true, linecolor: '#888888' },
                });
            }
        }

        // Resolve series columns (may include auto-inferred)
        const seriesCols = (effectiveOptions.seriesColumns ?? [])
            .map(name => getColumnRef(data, name))
            .filter((c): c is ColumnRef => c !== undefined);

        // Resolve binning options
        const binSize = options.binSize ? parseBinSize(options.binSize) : undefined;
        const aggregation = options.aggregation as AggregationType | undefined;
        const shouldBin = binSize !== undefined && binSize > 0 && aggregation !== undefined;
        const xIsDateTime = isDateTimeType(xColumn.column.type);

        if (seriesCols.length > 0) {
            // Pivot data by series column values
            let groups = this.groupRowsBySeries(data, seriesCols);

            // Limit to top N series by total y-value
            if (options.maxSeries != null && options.maxSeries > 0 && groups.size > options.maxSeries) {
                const ranked = [...groups.entries()].map(([key, rowIndices]) => {
                    let total = 0;
                    for (const ri of rowIndices) {
                        const row = data.rows[ri];
                        if (!row) continue;
                        for (const yCol of yColumns) {
                            if (!isNumericType(yCol.column.type)) continue;
                            const v = row[yCol.index];
                            if (v != null) total += Math.abs(toNumber(v));
                        }
                    }
                    return { key, rowIndices, total };
                });
                ranked.sort((a, b) => b.total - a.total);
                groups = new Map(ranked.slice(0, options.maxSeries).map(r => [r.key, r.rowIndices]));
            }

            const multipleYCols = yColumns.length > 1;
            let traceIndex = 0;
            for (const [seriesKey, rowIndices] of groups) {
                for (let yColIdx = 0; yColIdx < yColumns.length; yColIdx++) {
                    const yCol = yColumns[yColIdx]!;
                    if (!isNumericType(yCol.column.type)) continue;
                    let xValues: unknown[] = [];
                    let yValues: number[] = [];
                    for (const ri of rowIndices) {
                        const row = data.rows[ri];
                        if (!row) continue;
                        const xVal = row[xColumn.index];
                        const yVal = row[yCol.index];
                        if (xVal != null && yVal != null) {
                            xValues.push(xVal);
                            yValues.push(sanitizeDouble(toNumber(yVal)));
                        }
                    }
                    if (shouldBin && xValues.length > 0) {
                        const binned = binAndAggregate(xValues, yValues, binSize, aggregation, xIsDateTime);
                        xValues = binned.x;
                        yValues = binned.y;
                    }
                    if (xValues.length > 0) {
                        // Sort by x-value so lines don't zigzag (no-op when already sorted).
                        const sorted = sortPointsByX(xValues, yValues);
                        let sortedX: unknown[] = sorted.x;
                        let sortedY: number[] = sorted.y;
                        if (options.accumulate) {
                            sortedY = accumulateValues(sortedY);
                        }
                        // Downsample if over max points
                        if (options.maxPointsPerSeries != null && options.maxPointsPerSeries > 0) {
                            const ds = downsample(sortedX, sortedY, options.maxPointsPerSeries);
                            sortedX = ds.x;
                            sortedY = ds.y;
                        }
                        const traceName = multipleYCols ? `${seriesKey} - ${yCol.column.name}` : seriesKey;
                        const yAxisRef = yAxisMap.get(yColIdx);
                        builder = addTrace(builder, sortedX, sortedY, traceName, yAxisRef, traceIndex);
                        traceIndex++;
                    }
                }
            }
        } else {
            // No series columns: one trace per y-column (existing behavior)
            let traceIndex = 0;
            for (let yColIdx = 0; yColIdx < yColumns.length; yColIdx++) {
                const valueColumn = yColumns[yColIdx]!;
                let result = this.get2DChartData(data, xColumn, valueColumn);
                if (result) {
                    if (shouldBin) {
                        result = binAndAggregate(result.x, result.y, binSize, aggregation, xIsDateTime);
                    }
                    // Sort by x-value so lines don't zigzag (no-op when already sorted).
                    result = sortPointsByX(result.x, result.y);
                    if (options.accumulate) {
                        result = { x: result.x, y: accumulateValues(result.y) };
                    }
                    if (options.maxPointsPerSeries != null && options.maxPointsPerSeries > 0) {
                        result = downsample(result.x, result.y, options.maxPointsPerSeries);
                    }
                    const yAxisRef = yAxisMap.get(yColIdx);
                    builder = addTrace(builder, result.x, result.y, valueColumn.column.name, yAxisRef, traceIndex);
                    traceIndex++;
                }
            }
        }

        // For Panels mode, assign each trace to its corresponding x-axis subplot
        if (options.yLayout === ChartYLayout.SeparatePanels && yColumns.length > 1) {
            const updatedTraces = builder.traces.map(trace => {
                if (trace.yaxis && trace.yaxis !== 'y') {
                    const axisNum = trace.yaxis.replace('y', '');
                    return { ...trace, xaxis: `x${axisNum}` };
                }
                return trace;
            });
            builder = builder.withLayout(builder.layout).withConfig(builder.config);
            // Rebuild with updated traces
            builder = new PlotlyChartBuilder(updatedTraces as PlotlyTrace[], builder.layout, builder.config);
        }

        return builder;
    }

    /**
     * Groups row indices by the combined string key of the specified series columns.
     * Returns a Map preserving insertion order (first-seen order of distinct keys).
     */
    private groupRowsBySeries(data: ResultTable, seriesCols: ColumnRef[]): Map<string, number[]> {
        const groups = new Map<string, number[]>();
        for (let i = 0; i < data.rows.length; i++) {
            const row = data.rows[i];
            if (!row) continue;
            const key = seriesCols.map(c => String(row[c.index] ?? '')).join(' - ');
            let arr = groups.get(key);
            if (!arr) {
                arr = [];
                groups.set(key, arr);
            }
            arr.push(i);
        }
        return groups;
    }

    /**
     * Infers a series column from the data when none is explicitly specified.
     * Picks the first non-x, non-numeric, non-datetime column.
     */
    private inferSeriesColumn(data: ResultTable, xColumn: ColumnRef, anomalyColumns?: string[]): ColumnRef | undefined {
        const anomalySet = new Set(anomalyColumns ?? []);
        for (let i = 0; i < data.columns.length; i++) {
            if (i === xColumn.index) continue;
            const col = data.columns[i];
            if (col && !isNumericType(col.type) && !isDateTimeType(col.type) && !anomalySet.has(col.name)) {
                return getColumnRefByIndex(data, i);
            }
        }
        return undefined;
    }

    // ─── Data Column Helpers ────────────────────────────────────────────

    private get2dXColumn(data: ResultTable, options: ChartOptions): ColumnRef | undefined {
        if (options.xColumn) {
            return getColumnRef(data, options.xColumn);
        }
        const anomalySet = new Set(options.anomalyColumns ?? []);
        // For time-based chart types, prefer a datetime column as x-axis that is not in yColumns
        if (isTimeChartType(options.type)) {
            for (let i = 0; i < data.columns.length; i++) {
                const col = data.columns[i];
                if (col && isDateTimeType(col.type)
                    && !anomalySet.has(col.name)
                    && (!options.yColumns || !options.yColumns.includes(col.name))) {
                    return getColumnRefByIndex(data, i);
                }
            }
        }
        // otherwise, pick the first column that is not in yColumns or anomalyColumns
        if (options.yColumns) {
            for (let i = 0; i < data.columns.length; i++) {
                const col = data.columns[i];
                if (col && !options.yColumns.includes(col.name) && !anomalySet.has(col.name)) {
                    return getColumnRefByIndex(data, i);
                }
            }
        }
        // otherwise, pick the first non-anomaly column
        for (let i = 0; i < data.columns.length; i++) {
            const col = data.columns[i];
            if (col && !anomalySet.has(col.name)) {
                return getColumnRefByIndex(data, i);
            }
        }
        return getColumnRefByIndex(data, 0);
    }

    private get2dYColumns(data: ResultTable, options: ChartOptions, xColumn: ColumnRef): ColumnRef[] {
        if (options.yColumns) {
            return options.yColumns
                .map(name => getColumnRef(data, name))
                .filter((c): c is ColumnRef => c !== undefined);
        }
        const seriesSet = new Set(options.seriesColumns ?? []);
        const anomalySet = new Set(options.anomalyColumns ?? []);
        const result: ColumnRef[] = [];
        for (let i = 0; i < data.columns.length; i++) {
            if (i !== xColumn.index && !seriesSet.has(data.columns[i]!.name) && !anomalySet.has(data.columns[i]!.name)) {
                const ref = getColumnRefByIndex(data, i);
                if (ref && isNumericType(ref.column.type)) result.push(ref);
            }
        }
        return result;
    }

    private get2DChartData(data: ResultTable, xColumn: ColumnRef, yColumn: ColumnRef): { x: unknown[]; y: number[] } | undefined {
        if (!isNumericType(yColumn.column.type)) return undefined;

        const xValues = getColumnValues(data, xColumn);
        const yValues = getColumnValues(data, yColumn);

        const trimmed = trimNullRows(xValues, yValues);
        return { x: trimmed.x, y: convertToNumeric(trimmed.y) };
    }
}

// ─── Apply Common Options ───────────────────────────────────────────────────

function applyCommonOptions(builder: PlotlyChartBuilder, options: ChartOptions): PlotlyChartBuilder {
    if (options.xShowTicks === true) builder = builder.setXShowTicks(true);
    else if (options.xShowTicks === false) builder = builder.setXShowTicks(false);

    if (options.yShowTicks === true) builder = builder.setYShowTicks(true);
    else if (options.yShowTicks === false) builder = builder.setYShowTicks(false);

    if (options.xShowGrid === false) builder = builder.setXShowGrid(false);
    else if (options.xShowGrid === true) builder = builder.setXShowGrid(true);

    if (options.yShowGrid === false) builder = builder.setYShowGrid(false);
    else if (options.yShowGrid === true) builder = builder.setYShowGrid(true);

    if (options.xTickAngle != null) builder = builder.setXTickAngle(options.xTickAngle);
    if (options.yTickAngle != null) builder = builder.setYTickAngle(options.yTickAngle);

    if (options.yMirror === true && options.yLayout !== ChartYLayout.DualAxis) {
        const mirroredLayout: PlotlyLayout = {
            ...builder.layout,
            yaxis: { ...(builder.layout.yaxis ?? {}), showline: true, mirror: 'ticks' } as PlotlyAxis,
        };
        for (const key of Object.keys(builder.layout)) {
            if (/^yaxis\d+$/.test(key)) {
                mirroredLayout[key] = {
                    ...((builder.layout[key] as PlotlyAxis | undefined) ?? {}),
                    showline: true,
                    mirror: 'ticks',
                } as PlotlyAxis;
            }
        }
        builder = builder.withLayout(mirroredLayout);
    }

    if (options.sort != null && options.sort !== ChartSortOrder.Auto) {
        const order = options.sort === ChartSortOrder.Ascending
            ? PlotlyCategoryOrders.TotalAscending
            : PlotlyCategoryOrders.TotalDescending;
        builder = builder.setCategoryOrder(order);
    }

    if (options.legendPosition != null && options.legendPosition !== ChartLegendPosition.Auto) {
        if (options.legendPosition === ChartLegendPosition.None || options.legendPosition === 'Hidden') {
            builder = builder.hideLegend();
        } else {
            builder = builder.setLegendPosition(options.legendPosition);
        }
    } else if (options.yLayout === ChartYLayout.DualAxis) {
        // Right-side axis clips with the default right-side legend
        builder = builder.setLegendPosition(ChartLegendPosition.Bottom);
    }

    return builder;
}

// ─── Dark Mode Layout Helper ────────────────────────────────────────────────

/**
 * Mutates `layout` in place with dark-mode background, font, and axis colors,
 * and returns it. Operates on the in-memory object so the caller can avoid a
 * parse/stringify round-trip.
 */
function applyDarkModeToLayout(layout: Record<string, unknown>): Record<string, unknown> {
    layout.paper_bgcolor = '#1e1e1e';
    layout.plot_bgcolor = '#1e1e1e';

    if (!layout.font || typeof layout.font !== 'object') { layout.font = {}; }
    const font = layout.font as Record<string, unknown>;
    font.color = '#f2f5fa';
    if (!font.family) { font.family = PlotlyFontFamily; }

    applyDarkModeToAxis(layout, 'xaxis');
    applyDarkModeToAxis(layout, 'yaxis');

    // Apply to additional axes (xaxis2, yaxis2, etc.)
    for (const key of Object.keys(layout)) {
        if ((key.startsWith('xaxis') || key.startsWith('yaxis')) && key !== 'xaxis' && key !== 'yaxis') {
            applyDarkModeToAxis(layout, key);
        }
    }

    // Apply to 3D scene axes if present
    if (layout.scene && typeof layout.scene === 'object') {
        const scene = layout.scene as Record<string, unknown>;
        applyDarkModeToAxis(scene, 'xaxis');
        applyDarkModeToAxis(scene, 'yaxis');
        applyDarkModeToAxis(scene, 'zaxis');
    }

    return layout;
}

function applyDarkModeToAxis(parent: Record<string, unknown>, axisKey: string): void {
    if (!parent[axisKey] || typeof parent[axisKey] !== 'object') { parent[axisKey] = {}; }
    const axis = parent[axisKey] as Record<string, unknown>;
    axis.color = '#f2f5fa';
    axis.gridcolor = '#444444';
    axis.linecolor = '#666666';
    axis.zeroline = false;
}

// ─── Light Mode Layout Helper ───────────────────────────────────────────────

/**
 * Mutates `layout` in place with light-mode background, font, and axis colors,
 * and returns it. Operates on the in-memory object so the caller can avoid a
 * parse/stringify round-trip.
 */
function applyLightModeToLayout(layout: Record<string, unknown>): Record<string, unknown> {
    layout.paper_bgcolor = '#ffffff';
    layout.plot_bgcolor = '#ffffff';

    if (!layout.font || typeof layout.font !== 'object') { layout.font = {}; }
    const font = layout.font as Record<string, unknown>;
    font.color = '#2a3f5f';
    if (!font.family) { font.family = PlotlyFontFamily; }

    applyLightModeToAxis(layout, 'xaxis');
    applyLightModeToAxis(layout, 'yaxis');

    // Apply to additional axes (xaxis2, yaxis2, etc.)
    for (const key of Object.keys(layout)) {
        if ((key.startsWith('xaxis') || key.startsWith('yaxis')) && key !== 'xaxis' && key !== 'yaxis') {
            applyLightModeToAxis(layout, key);
        }
    }

    // Apply to 3D scene axes if present
    if (layout.scene && typeof layout.scene === 'object') {
        const scene = layout.scene as Record<string, unknown>;
        applyLightModeToAxis(scene, 'xaxis');
        applyLightModeToAxis(scene, 'yaxis');
        applyLightModeToAxis(scene, 'zaxis');
    }

    return layout;
}

function applyLightModeToAxis(parent: Record<string, unknown>, axisKey: string): void {
    if (!parent[axisKey] || typeof parent[axisKey] !== 'object') { parent[axisKey] = {}; }
    const axis = parent[axisKey] as Record<string, unknown>;
    axis.color = '#2a3f5f';
    axis.gridcolor = '#e2e2e2';
    axis.linecolor = '#bcbcbc';
    axis.zeroline = false;
}
