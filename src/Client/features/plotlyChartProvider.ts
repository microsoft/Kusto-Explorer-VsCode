// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Plotly.js chart rendering implementation.
 * Ported from Server/Charting C# implementation.
 */

import type { ChartOptions, ResultColumn, ResultTable } from './server';
import { ChartType, ChartKind, ChartAxis, ChartSortOrder, ChartLegendPosition } from './chartProvider';
import type { IChartView, IWebView, IChartProvider } from './chartProvider';

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

const PlotlyColorways = {
    Default: [
        '#636EFA', '#EF553B', '#00CC96', '#AB63FA', '#FDC826',
        '#19D3F3', '#FF6692', '#B6E880', '#FF97FF', '#FECB52',
    ],
} as const;

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
}

interface BarTrace extends PlotlyTraceBase {
    type: 'bar';
    x: unknown[];
    y: unknown[];
    orientation: string;
    offsetgroup?: string | undefined;
    marker?: PlotlyMarker | undefined;
    text?: unknown[] | undefined;
    textposition?: string | undefined;
}

interface ScatterTrace extends PlotlyTraceBase {
    type: 'scatter';
    x: unknown[];
    y: unknown[];
    mode: string;
    fill?: string | undefined;
    stackgroup?: string | undefined;
    groupnorm?: string | undefined;
    line?: PlotlyLine | undefined;
    marker?: PlotlyMarker | undefined;
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
            zerolinecolor: '#666666',
        };
        return this._new(undefined, {
            ...this._layout,
            paper_bgcolor: '#1e1e1e',
            plot_bgcolor: '#1e1e1e',
            font: { color: '#f2f5fa' },
            colorway: [...PlotlyColorways.Default],
            xaxis: { ...(this._layout.xaxis ?? {}), ...darkAxis },
            yaxis: { ...(this._layout.yaxis ?? {}), ...darkAxis },
        });
    }

    withFixedRange(): PlotlyChartBuilder {
        return this._new(
            undefined,
            {
                ...this._layout,
                xaxis: { ...(this._layout.xaxis ?? {}), fixedrange: true },
                yaxis: { ...(this._layout.yaxis ?? {}), fixedrange: true },
            },
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

    add2DLineTrace(
        x: unknown[],
        y: unknown[],
        name?: string,
        showMarkers = false,
        yAxisId?: string,
    ): PlotlyChartBuilder {
        const trace: ScatterTrace = {
            type: 'scatter',
            x,
            y,
            mode: showMarkers ? PlotlyScatterModes.LinesAndMarkers : PlotlyScatterModes.Lines,
            name,
            yaxis: yAxisId,
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
    ): PlotlyChartBuilder {
        const hasMarker = markerSymbol != null || markerSize != null;
        const trace: ScatterTrace = {
            type: 'scatter',
            x,
            y,
            mode: PlotlyScatterModes.Markers,
            name,
            yaxis: yAxisId,
            marker: hasMarker ? { symbol: markerSymbol, size: markerSize } : undefined,
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
    ): PlotlyChartBuilder {
        const trace: ScatterTrace = {
            type: 'scatter',
            x,
            y,
            mode: PlotlyScatterModes.Lines,
            fill: stackGroup != null ? PlotlyFillModes.ToNextY : PlotlyFillModes.ToZeroY,
            stackgroup: stackGroup,
            groupnorm: groupNorm,
            name,
            yaxis: yAxisId,
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

function createChartDiv(dataJson: string, layoutJson: string, configJson: string, divId = 'plotly-chart'): string {
    return `<div id="${divId}"></div>
<script>
try {
  var data = ${dataJson};
  var layout = ${layoutJson};
  var config = ${configJson};
  Plotly.newPlot('${divId}', data, layout, config);
} catch(e) { console.error('Plotly error:', e); document.getElementById('${divId}').innerText = 'Chart error: ' + e.message; }
</script>`;
}

// ─── Utility Functions ──────────────────────────────────────────────────────

function hexToRgba(hex: string, opacity: number): string {
    let h = hex.replace(/^#/, '');
    if (h.length === 3) {
        h = (h[0] ?? '') + (h[0] ?? '') + (h[1] ?? '') + (h[1] ?? '') + (h[2] ?? '') + (h[2] ?? '');
    }
    if (h.length !== 6) {
        return `rgba(128, 128, 128, ${opacity})`;
    }
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

function isNumericType(type: string): boolean {
    switch (type) {
        case 'int':
        case 'long':
        case 'real':
        case 'decimal':
            return true;
        default:
            return false;
    }
}

function isDateTimeType(type: string): boolean {
    return type === 'datetime' || type === 'timespan';
}

function isTimeChartType(type: string): boolean {
    return type === ChartType.TimeLineChart
        || type === ChartType.TimeLineWithAnomalyChart
        || type === ChartType.TimeLadderChart
        || type === ChartType.TimePivot;
}

/** Ordered set of marker shapes for cycling. */
const markerShapes = ['circle', 'diamond', 'square', 'triangle-up', 'cross', 'star', 'x'] as const;

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
 * - If markerShape is set but cycleMarkerShapes is false, returns that shape for all traces.
 * - If cycleMarkerShapes is true, cycles through shapes starting from the selected shape.
 */
function getMarkerShape(options: ChartOptions, traceIndex: number): string | undefined {
    if (!options.markerShape && !options.cycleMarkerShapes) return undefined;
    const startIndex = markerShapes.indexOf((options.markerShape ?? markerShapes[0]) as typeof markerShapes[number]);
    const base = startIndex >= 0 ? startIndex : 0;
    if (!options.cycleMarkerShapes) return markerShapes[base];
    return markerShapes[(base + traceIndex) % markerShapes.length];
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

// ─── Data Access Helpers (replaces DataTable/DataColumn) ────────────────────

/** A ResultColumn together with its position in the table. */
interface ColumnRef {
    column: ResultColumn;
    index: number;
}

function getColumnRef(table: ResultTable, name: string): ColumnRef | undefined {
    const idx = table.columns.findIndex(c => c.name === name);
    if (idx < 0) return undefined;
    const col = table.columns[idx];
    if (!col) return undefined;
    return { column: col, index: idx };
}

function getColumnRefByIndex(table: ResultTable, index: number): ColumnRef | undefined {
    if (index < 0 || index >= table.columns.length) return undefined;
    const col = table.columns[index];
    if (!col) return undefined;
    return { column: col, index };
}

function getColumnValues(table: ResultTable, col: ColumnRef): unknown[] {
    return table.rows.map(row => row?.[col.index]);
}

function trimNullRows(xValues: unknown[], yValues: unknown[]): { x: unknown[]; y: unknown[] } {
    const xResult: unknown[] = [];
    const yResult: unknown[] = [];
    const len = Math.min(xValues.length, yValues.length);
    for (let i = 0; i < len; i++) {
        if (xValues[i] != null && yValues[i] != null) {
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
        var xaxis = layout.xaxis;
        if (xaxis) {
            overrides.xaxis = Object.assign({}, xaxis, {
                automargin: true,
                title: Object.assign({}, xaxis.title || {}, { font: Object.assign({}, (xaxis.title && xaxis.title.font) || {}, { size: fonts.axisSize }), standoff: fonts.tickSize }),
                tickfont: Object.assign({}, xaxis.tickfont || {}, { size: fonts.tickSize })
            });
        }
        var yaxis = layout.yaxis;
        if (yaxis) {
            overrides.yaxis = Object.assign({}, yaxis, {
                automargin: true,
                title: Object.assign({}, yaxis.title || {}, { font: Object.assign({}, (yaxis.title && yaxis.title.font) || {}, { size: fonts.axisSize }), standoff: fonts.tickSize }),
                tickfont: Object.assign({}, yaxis.tickfont || {}, { size: fonts.tickSize })
            });
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

    function resizeChart() {
        var chartDiv = document.getElementById('chart');
        if (!chartDiv) return;
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
            wrapperDiv.style.position = '';
            wrapperDiv.style.left = '';
            wrapperDiv.style.top = '';
            wrapperDiv.style.width = availW + 'px';
            wrapperDiv.style.height = availH + 'px';
            wrapperDiv.style.visibility = 'visible';
            lastAppliedW = chartDiv.clientWidth;
            lastAppliedH = chartDiv.clientHeight;
            Plotly.newPlot(plotDiv, plotDiv.data, Object.assign({}, plotDiv.layout, buildLayoutOverrides(availW, availH)), plotDiv._context);
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
        Plotly.newPlot(plotDiv, plotDiv.data, Object.assign({}, plotDiv.layout, buildLayoutOverrides(w, h)), plotDiv._context);
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
            resizeTimer = setTimeout(function() { resizeChart(); }, 30);
        }).observe(chartContainer);
    }

    // ── Post-update hook (called by the page handler after chart HTML is inserted) ──
    window._chartUpdated = function() {
        var chartDiv = document.getElementById('chart');
        if (!chartDiv) return;
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
                wrapperDiv.style.position = '';
                wrapperDiv.style.left = '';
                wrapperDiv.style.top = '';
                wrapperDiv.style.width = availW + 'px';
                wrapperDiv.style.height = availH + 'px';
            }
            wrapperDiv.style.visibility = 'visible';
        }

        // Apply font/size overrides to the already-rendered plot
        var overrides = Object.assign({ width: targetW, height: targetH }, applyFontOverrides(plotDiv.layout || {}, targetW, targetH, preset));
        Plotly.relayout(plotDiv, overrides);

        lastAppliedW = availW;
        lastAppliedH = availH;
    };

    // ── Copy chart ────────────────────────────────────────────────────
    window.addEventListener('message', async function(event) {
        var message = event.data;
        if (!(message && message.command === 'copyChart')) return;
        var vscodeApi = window._vscodeApi;
        if (!vscodeApi) return;
        try {
            var plotDiv = document.querySelector('.js-plotly-plot') || document.querySelector('.plotly-graph-div');
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
})();
</script>`;

/** View for Plotly charts rendered inside a webview. */
class PlotlyChartView implements IChartView {
    onCopyResult: ((pngDataUrl: string, svgDataUrl?: string) => void) | undefined;
    onCopyError: ((error: string) => void) | undefined;
    private readonly subscription: { dispose(): void };

    constructor(
        private readonly webview: IWebView,
        private readonly render: (data: ResultTable, options: ChartOptions, darkMode: boolean) => string | undefined
    ) {
        this.subscription = webview.handle((message) => {
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

    renderChart(data: ResultTable, options: ChartOptions, darkMode: boolean): void {
        const bodyHtml = this.render(data, options, darkMode);
        if (bodyHtml) {
            this.webview.setContent(bodyHtml);
        }
    }

    dispose(): void {
        this.subscription.dispose();
    }
}

export class PlotlyChartProvider implements IChartProvider {

    createView(webview: IWebView): IChartView {
        webview.setup(
            `<script src="${PlotlyJsCdn}" charset="utf-8"></script>`,
            plotlyChartScripts
        );
        return new PlotlyChartView(webview, (data, options, darkMode) => this.renderChartToHtmlDiv(data, options, darkMode));
    }

    private renderChartToHtmlDiv(data: ResultTable, options: ChartOptions, darkMode = false): string | undefined {
        if (options.type === ChartType.Plotly) {
            return this.renderRawPlotlyChart(data, darkMode);
        }

        const builder = this.buildChart(data, options, darkMode);
        return builder?.toHtmlDiv();
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
            let layoutJson = root.layout ? JSON.stringify(root.layout) : '{}';

            if (darkMode) {
                layoutJson = applyDarkModeToLayout(layoutJson);
            }

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
            case ChartType.BarChart:
            case ChartType.ColumnChart:
                builder = this.buildBarOrColumnChart(data, options);
                break;
            case ChartType.LineChart:
            case ChartType.TimeLineChart:
                builder = this.buildLineChart(data, options);
                break;
            case ChartType.TimeLineWithAnomalyChart:
                builder = this.buildAnomalyChart(data, options);
                break;
            case ChartType.ScatterChart:
                builder = this.buildScatterChart(data, options);
                break;
            case ChartType.PieChart:
                builder = this.buildPieChart(data, options);
                break;
            case ChartType.AreaChart:
                builder = (options.kind === ChartKind.Stacked || options.kind === ChartKind.Stacked100)
                    ? this.buildStackedAreaChart(data, options)
                    : this.buildAreaChart(data, options);
                break;
            case ChartType.StackedAreaChart:
                builder = this.buildStackedAreaChart(data, options);
                break;
            case ChartType.Card:
                builder = this.buildCardChart(data, options);
                break;
            case ChartType.ThreeDChart:
                builder = this.buildThreeDChart(data, options);
                break;
            case ChartType.TreeMap:
                builder = this.buildTreeMapChart(data, options);
                break;
            case ChartType.Sankey:
                builder = this.buildSankeyChart(data, options);
                break;
            default:
                return undefined;
        }

        if (builder) {
            if (darkMode) {
                builder = builder.withDarkMode();
            }
            if (options.type !== ChartType.ThreeDChart) {
                builder = builder.withFixedRange();
            }
        }

        return builder;
    }

    // ─── Bar / Column ───────────────────────────────────────────────────

    private buildBarOrColumnChart(data: ResultTable, options: ChartOptions): PlotlyChartBuilder | undefined {
        let builder = new PlotlyChartBuilder();
        const isHorizontal = options.type === ChartType.BarChart;

        switch (options.kind) {
            case ChartKind.Stacked:
                builder = builder.setStacked();
                break;
            case ChartKind.Stacked100:
                builder = builder.setStacked();
                break;
            case ChartKind.Unstacked:
                builder = builder.setGrouped();
                break;
        }

        if (options.kind === ChartKind.Stacked100) {
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
        if (options.showLegend === false) builder = builder.hideLegend();

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

    private buildLineChart(data: ResultTable, options: ChartOptions): PlotlyChartBuilder | undefined {
        return this.build2dChart(new PlotlyChartBuilder(), data, options,
            (b, x, y, name, yAxis) => b.add2DLineTrace(x, y, name, false, yAxis));
    }

    private buildAnomalyChart(data: ResultTable, options: ChartOptions): PlotlyChartBuilder | undefined {
        const anomalySet = new Set(options.anomalyColumns ?? []);

        // If no anomalyColumns specified, fall back to a plain line chart
        if (anomalySet.size === 0) {
            return this.buildLineChart(data, options);
        }

        // Exclude anomaly columns from yColumns so they don't render as lines
        const xColumn = this.get2dXColumn(data, options);
        if (!xColumn) return undefined;

        const allYColumns = this.get2dYColumns(data, options, xColumn)
            .filter(c => !anomalySet.has(c.column.name));
        const filteredOptions: ChartOptions = {
            ...options,
            yColumns: allYColumns.map(c => c.column.name),
        };

        // Build the line chart for non-anomaly columns
        let builder = this.build2dChart(new PlotlyChartBuilder(), data, filteredOptions,
            (b, x, y, name, yAxis) => b.add2DLineTrace(x, y, name, false, yAxis));
        if (!builder) return undefined;

        // Overlay anomaly points: for each anomaly column, show markers where flag != 0
        const xValues = getColumnValues(data, xColumn);

        let anomalyTraceIndex = allYColumns.length;
        for (const anomalyColName of anomalySet) {
            const anomalyCol = getColumnRef(data, anomalyColName);
            if (!anomalyCol) continue;
            const anomalyFlags = getColumnValues(data, anomalyCol);

            // Find the corresponding y-column to plot anomaly points at (use the first one)
            const yCol = allYColumns[0];
            if (!yCol) continue;
            const yValues = getColumnValues(data, yCol);

            // Filter to only non-zero anomaly flag positions
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
                builder = builder.add2DScatterTrace(anomalyX, anomalyY, anomalyColName, undefined, shape, getMarkerSize(options));
                anomalyTraceIndex++;
            }
        }

        return builder;
    }

    private buildScatterChart(data: ResultTable, options: ChartOptions): PlotlyChartBuilder | undefined {
        return this.build2dChart(new PlotlyChartBuilder(), data, options,
            (b, x, y, name, yAxis, traceIndex) => b.add2DScatterTrace(x, y, name, yAxis, getMarkerShape(options, traceIndex), getMarkerSize(options)));
    }

    private buildAreaChart(data: ResultTable, options: ChartOptions): PlotlyChartBuilder | undefined {
        return this.build2dChart(new PlotlyChartBuilder(), data, options,
            (b, x, y, name, yAxis) => b.addAreaChart(x, y, name, undefined, yAxis));
    }

    private buildStackedAreaChart(data: ResultTable, options: ChartOptions): PlotlyChartBuilder | undefined {
        const groupNorm = options.kind === ChartKind.Stacked100 ? 'percent' : undefined;
        return this.build2dChart(new PlotlyChartBuilder(), data, options,
            (b, x, y, name, yAxis) => b.addAreaChart(x, y, name, '1', yAxis, groupNorm));
    }

    // ─── Pie ────────────────────────────────────────────────────────────

    private buildPieChart(data: ResultTable, options: ChartOptions): PlotlyChartBuilder | undefined {
        let builder = new PlotlyChartBuilder();

        if (options.title) builder = builder.withTitle(options.title);
        if (options.showLegend === false) builder = builder.hideLegend();
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

        if (options.showLegend === false) builder = builder.hideLegend();
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

        if (options.showLegend === false) builder = builder.hideLegend();
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

        if (options.showLegend === false) builder = builder.hideLegend();
        builder = applyCommonOptions(builder, options);

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

        const yColumns = this.get2dYColumns(data, options, xColumn);

        if (options.title) builder = builder.withTitle(options.title);
        if (options.xTitle) builder = builder.setXAxisTitle(options.xTitle);
        if (options.yTitle) builder = builder.setYAxisTitle(options.yTitle);
        if (options.xAxis === ChartAxis.Log) builder = builder.setLogX();
        if (options.yAxis === ChartAxis.Log) builder = builder.setLogY();

        const xMinD = tryGetDouble(options.xmin);
        const xMaxD = tryGetDouble(options.xmax);
        if (xMinD !== undefined && xMaxD !== undefined) {
            builder = builder.setXAxisRange(xMinD, xMaxD);
        }

        const yMinD = tryGetDouble(options.ymin);
        const yMaxD = tryGetDouble(options.ymax);
        if (yMinD !== undefined && yMaxD !== undefined) {
            builder = builder.setYAxisRange(yMinD, yMaxD);
        }

        if (options.showLegend === false) builder = builder.hideLegend();
        builder = applyCommonOptions(builder, options);

        const sort = isTimeChartType(options.type);
        let traceIndex = 0;
        for (const valueColumn of yColumns) {
            const result = this.get2DChartData(data, xColumn, valueColumn, sort);
            if (result) {
                builder = addTrace(builder, result.x, result.y, valueColumn.column.name, undefined, traceIndex);
                traceIndex++;
            }
        }

        return builder;
    }

    // ─── Data Column Helpers ────────────────────────────────────────────

    private get2dXColumn(data: ResultTable, options: ChartOptions): ColumnRef | undefined {
        if (options.xColumn) {
            return getColumnRef(data, options.xColumn);
        }
        // For time-based chart types, prefer a datetime column as x-axis that is not in yColumns
        if (isTimeChartType(options.type)) {
            for (let i = 0; i < data.columns.length; i++) {
                const col = data.columns[i];
                if (col && isDateTimeType(col.type)
                    && (!options.yColumns || !options.yColumns.includes(col.name))) {
                    return getColumnRefByIndex(data, i);
                }
            }
        }
        // otherwise, pick the first column that is not in yColumns
        if (options.yColumns) {
            for (let i = 0; i < data.columns.length; i++) {
                const col = data.columns[i];
                if (col && !options.yColumns.includes(col.name)) {
                    return getColumnRefByIndex(data, i);
                }
            }
        }
        // otherwise, pick the first column
        return getColumnRefByIndex(data, 0);
    }

    private get2dYColumns(data: ResultTable, options: ChartOptions, xColumn: ColumnRef): ColumnRef[] {
        if (options.yColumns) {
            return options.yColumns
                .map(name => getColumnRef(data, name))
                .filter((c): c is ColumnRef => c !== undefined);
        }
        const result: ColumnRef[] = [];
        for (let i = 0; i < data.columns.length; i++) {
            if (i !== xColumn.index) {
                const ref = getColumnRefByIndex(data, i);
                if (ref) result.push(ref);
            }
        }
        return result;
    }

    private get2DChartData(data: ResultTable, xColumn: ColumnRef, yColumn: ColumnRef, sort = false): { x: unknown[]; y: number[] } | undefined {
        if (!isNumericType(yColumn.column.type)) return undefined;

        const xValues = getColumnValues(data, xColumn);
        const yValues = getColumnValues(data, yColumn);

        const trimmed = trimNullRows(xValues, yValues);
        const x = trimmed.x;
        const y = convertToNumeric(trimmed.y);

        if (sort && x.length > 1) {
            const indices = x.map((_, i) => i);
            indices.sort((a, b) => {
                const va = x[a], vb = x[b];
                if (va == null && vb == null) return 0;
                if (va == null) return -1;
                if (vb == null) return 1;
                return va < vb ? -1 : va > vb ? 1 : 0;
            });
            return { x: indices.map(i => x[i]!), y: indices.map(i => y[i]!) };
        }

        return { x, y };
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

    if (options.sort != null && options.sort !== ChartSortOrder.Default) {
        const order = options.sort === ChartSortOrder.Ascending
            ? PlotlyCategoryOrders.TotalAscending
            : PlotlyCategoryOrders.TotalDescending;
        builder = builder.setCategoryOrder(order);
    }

    if (options.legendPosition != null) {
        if (options.legendPosition === ChartLegendPosition.Hidden) {
            builder = builder.hideLegend();
        } else {
            builder = builder.setLegendPosition(options.legendPosition);
        }
    }

    return builder;
}

// ─── Dark Mode Layout Helper ────────────────────────────────────────────────

function applyDarkModeToLayout(layoutJson: string): string {
    const layout = (JSON.parse(layoutJson) as Record<string, unknown>) ?? {};

    layout.paper_bgcolor = '#1e1e1e';
    layout.plot_bgcolor = '#1e1e1e';

    if (!layout.font || typeof layout.font !== 'object') { layout.font = {}; }
    (layout.font as Record<string, unknown>).color = '#f2f5fa';

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

    return JSON.stringify(layout);
}

function applyDarkModeToAxis(parent: Record<string, unknown>, axisKey: string): void {
    if (!parent[axisKey] || typeof parent[axisKey] !== 'object') { parent[axisKey] = {}; }
    const axis = parent[axisKey] as Record<string, unknown>;
    axis.color = '#f2f5fa';
    axis.gridcolor = '#444444';
    axis.linecolor = '#666666';
    axis.zerolinecolor = '#666666';
}
