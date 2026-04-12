using System.Collections.Immutable;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Kusto.Vscode;

/// <summary>
/// Immutable fluent builder for creating Plotly charts with C# idioms.
/// </summary>
public sealed class PlotlyChartBuilder
{
    private readonly ImmutableList<PlotlyTrace> _traces;
    private readonly PlotlyLayout _layout;
    private readonly PlotlyConfig _config;

    public PlotlyChartBuilder()
        : this(ImmutableList<PlotlyTrace>.Empty, new PlotlyLayout(), new PlotlyConfig())
    {
    }

    private PlotlyChartBuilder(
        ImmutableList<PlotlyTrace> traces,
        PlotlyLayout layout,
        PlotlyConfig config)
    {
        _traces = traces;
        _layout = layout;
        _config = config;
    }

    /// <summary>
    /// The current list of traces.
    /// </summary>
    public ImmutableList<PlotlyTrace> Traces => _traces;

    /// <summary>
    /// The current layout.
    /// </summary>
    public PlotlyLayout Layout => _layout;

    /// <summary>
    /// The current configuration.
    /// </summary>
    public PlotlyConfig Config => _config;

    /// <summary>
    /// The current 2D X-axis. Returns null if not configured.
    /// </summary>
    public PlotlyAxis? XAxis => _layout.XAxis;

    /// <summary>
    /// The current 2D Y-axis. Returns null if not configured.
    /// </summary>
    public PlotlyAxis? YAxis => _layout.YAxis;

    /// <summary>
    /// Returns a new builder with the added trace.
    /// </summary>
    public PlotlyChartBuilder AddTrace(PlotlyTrace trace)
    {
        return new PlotlyChartBuilder(_traces.Add(trace), _layout, _config);
    }

    /// <summary>
    /// Returns a new builder with the replaced layout.
    /// </summary>
    public PlotlyChartBuilder WithLayout(PlotlyLayout layout)
    {
        return new PlotlyChartBuilder(_traces, layout, _config);
    }

    /// <summary>
    /// Returns a new builder with the replaced configuration.
    /// </summary>
    public PlotlyChartBuilder WithConfig(PlotlyConfig config)
    {
        return new PlotlyChartBuilder(_traces, _layout, config);
    }

    /// <summary>
    /// Returns a new builder with the updated title.
    /// </summary>
    public PlotlyChartBuilder WithTitle(string title)
    {
        return new PlotlyChartBuilder(_traces, _layout with { Title = title }, _config);
    }

    /// <summary>
    /// Replaces the 2D X-axis with a new axis configuration.
    /// </summary>
    public PlotlyChartBuilder WithXAxis(PlotlyAxis axis)
    {
        return new PlotlyChartBuilder(_traces, _layout with { XAxis = axis }, _config);
    }

    /// <summary>
    /// Replaces the 2D Y-axis with a new axis configuration.
    /// </summary>
    public PlotlyChartBuilder WithYAxis(PlotlyAxis axis)
    {
        return new PlotlyChartBuilder(_traces, _layout with { YAxis = axis }, _config);
    }

    /// <summary>
    /// Replaces the 3D scene configuration.
    /// </summary>
    public PlotlyChartBuilder WithScene(PlotlyScene scene)
    {
        return new PlotlyChartBuilder(_traces, _layout with { Scene = scene }, _config);
    }

    /// <summary>
    /// Adds a secondary axis (e.g., "yaxis2") to the layout.
    /// </summary>
    public PlotlyChartBuilder AddSecondaryYAxis(string axisId, PlotlyAxis axis)
    {
        var newAxes = _layout.AdditionalAxes.SetItem(axisId, axis);
        return new PlotlyChartBuilder(_traces, _layout with { AdditionalAxes = newAxes }, _config);
    }

    /// <summary>
    /// Sets the bar display mode. Use <see cref="PlotlyBarModes"/> constants.
    /// </summary>
    public PlotlyChartBuilder SetBarMode(string barMode)
    {
        return new PlotlyChartBuilder(_traces, _layout with { BarMode = barMode }, _config);
    }

    /// <summary>
    /// Deetermines is the legend is shown or not.
    /// </summary>
    public PlotlyChartBuilder ShowLegend(bool show = true)
    {
        return new PlotlyChartBuilder(_traces, _layout with { ShowLegend = show }, _config);
    }

    /// <summary>
    /// Sets the template/theme for the chart. Use <see cref="PlotlyTemplates"/> constants.
    /// </summary>
    public PlotlyChartBuilder WithTemplate(string template)
    {
        return new PlotlyChartBuilder(_traces, _layout with { Template = template }, _config);
    }

    /// <summary>
    /// Applies dark mode styling to the chart (dark backgrounds, light text).
    /// </summary>
    public PlotlyChartBuilder WithDarkMode()
    {
        return new PlotlyChartBuilder(_traces, _layout with 
        { 
            PaperBackgroundColor = "#1e1e1e",
            PlotBackgroundColor = "#1e1e1e",
            Font = new PlotlyFont { Color = "#f2f5fa" },
            Colorway = PlotlyColorways.Default,
            XAxis = (_layout.XAxis ?? new PlotlyAxis()) with 
            { 
                Color = "#f2f5fa", 
                GridColor = "#444444",
                LineColor = "#666666",
                ZeroLineColor = "#666666"
            },
            YAxis = (_layout.YAxis ?? new PlotlyAxis()) with 
            { 
                Color = "#f2f5fa", 
                GridColor = "#444444",
                LineColor = "#666666",
                ZeroLineColor = "#666666"
            }
        }, _config);
    }

    /// <summary>
    /// Makes the chart static by disabling all mouse interactions (zoom, pan, hover).
    /// </summary>
    public PlotlyChartBuilder AsStatic()
    {
        return new PlotlyChartBuilder(_traces, _layout, _config with { StaticPlot = true });
    }

    /// <summary>
    /// Disables zoom and pan while keeping hover tooltips.
    /// Sets fixed range on axes and disables scroll zoom and double-click reset.
    /// </summary>
    public PlotlyChartBuilder WithFixedRange()
    {
        return new PlotlyChartBuilder(
            _traces, 
            _layout with 
            { 
                XAxis = (_layout.XAxis ?? new PlotlyAxis()) with { FixedRange = true },
                YAxis = (_layout.YAxis ?? new PlotlyAxis()) with { FixedRange = true }
            }, 
            _config with 
            { 
                ScrollZoom = false, 
                DoubleClick = false 
            });
    }

    /// <summary>
    /// Returns the text of an HTML div containing the Plotly chart.
    /// The Plotly.js library must be loaded separately elsewhere in the HTML document.
    /// </summary>
    public string ToHtmlDiv(string divId = "plotly-chart")
    {
        var options = new JsonSerializerOptions
        {
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            WriteIndented = false
        };

        var dataJson = JsonSerializer.Serialize(_traces, options);
        var layoutJson = JsonSerializer.Serialize(_layout, options);
        var configJson = JsonSerializer.Serialize(_config, options);

        return PlotlyHtmlHelper.CreateChartDiv(dataJson, layoutJson, configJson, divId);
    }
}

/// <summary>
/// Base record for all Plotly traces.
/// </summary>
[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]
[JsonDerivedType(typeof(BarTrace), typeDiscriminator: "bar")]
[JsonDerivedType(typeof(ScatterTrace), typeDiscriminator: "scatter")]
[JsonDerivedType(typeof(PieTrace), typeDiscriminator: "pie")]
[JsonDerivedType(typeof(HistogramTrace), typeDiscriminator: "histogram")]
[JsonDerivedType(typeof(HeatmapTrace), typeDiscriminator: "heatmap")]
[JsonDerivedType(typeof(BoxTrace), typeDiscriminator: "box")]
[JsonDerivedType(typeof(ViolinTrace), typeDiscriminator: "violin")]
[JsonDerivedType(typeof(SurfaceTrace), typeDiscriminator: "surface")]
[JsonDerivedType(typeof(IndicatorTrace), typeDiscriminator: "indicator")]
[JsonDerivedType(typeof(TreeMapTrace), typeDiscriminator: "treemap")]
[JsonDerivedType(typeof(SankeyTrace), typeDiscriminator: "sankey")]
public abstract record PlotlyTrace
{
    /// <summary>
    /// Name of the trace, displayed in the legend and on hover.
    /// </summary>
    [JsonPropertyName("name")]
    public string? Name { get; init; }

    [JsonPropertyName("xaxis")]
    public string? XAxis { get; init; }

    [JsonPropertyName("yaxis")]
    public string? YAxis { get; init; }
}

/// <summary>
/// Bar chart trace.
/// </summary>
public sealed record BarTrace : PlotlyTrace
{
    /// <summary>
    /// X-axis values. Must be JSON-serializable types: numbers, strings, DateTime, or null.
    /// </summary>
    [JsonPropertyName("x")]
    public required object[] X { get; init; } = Array.Empty<object>();

    /// <summary>
    /// Y-axis values. Must be JSON-serializable types: numbers, strings, DateTime, or null.
    /// </summary>
    [JsonPropertyName("y")]
    public required object[] Y { get; init; } = Array.Empty<object>();

    /// <summary>
    /// Bar orientation. Use <see cref="PlotlyOrientations"/> constants.
    /// </summary>
    [JsonPropertyName("orientation")]
    public string Orientation { get; init; } = PlotlyOrientations.Vertical;

    /// <summary>
    /// Offset group for positioning bars when using multiple Y-axes or overlay mode.
    /// </summary>
    [JsonPropertyName("offsetgroup")]
    public string? OffsetGroup { get; init; }

    /// <summary>
    /// Marker styling for the bars (color, size, opacity).
    /// </summary>
    [JsonPropertyName("marker")]
    public PlotlyMarker? Marker { get; init; }

    /// <summary>
    /// Text values to display on each bar. If null, no text is shown.
    /// </summary>
    [JsonPropertyName("text")]
    public object[]? Text { get; init; }

    /// <summary>
    /// Position of text on the bars. Use "inside", "outside", "auto", or "none". If null, defaults to "none".
    /// </summary>
    [JsonPropertyName("textposition")]
    public string? TextPosition { get; init; }
}

/// <summary>
/// Line/Scatter chart trace.
/// </summary>
public sealed record ScatterTrace : PlotlyTrace
{
    /// <summary>
    /// X-axis values. Must be JSON-serializable types: numbers, strings, DateTime, or null.
    /// </summary>
    [JsonPropertyName("x")]
    public required object[] X { get; init; } = Array.Empty<object>();

    /// <summary>
    /// Y-axis values. Must be JSON-serializable types: numbers, strings, DateTime, or null.
    /// </summary>
    [JsonPropertyName("y")]
    public required object[] Y { get; init; } = Array.Empty<object>();

    /// <summary>
    /// Display mode. Use <see cref="PlotlyScatterModes"/> constants.
    /// </summary>
    [JsonPropertyName("mode")]
    public string Mode { get; init; } = PlotlyScatterModes.Lines;

    /// <summary>
    /// Fill mode for area charts. Use <see cref="PlotlyFillModes"/> constants. If null, no fill.
    /// </summary>
    [JsonPropertyName("fill")]
    public string? Fill { get; init; }

    /// <summary>
    /// Stack group identifier for stacked area charts. Traces with the same stackgroup are stacked together.
    /// </summary>
    [JsonPropertyName("stackgroup")]
    public string? StackGroup { get; init; }

    /// <summary>
    /// Normalization mode for the stack group. Use "percent" for 100% stacked areas, "fraction" for 0–1 range.
    /// If null, values are stacked without normalization.
    /// </summary>
    [JsonPropertyName("groupnorm")]
    public string? GroupNorm { get; init; }

    /// <summary>
    /// Line styling (color, width, dash style).
    /// </summary>
    [JsonPropertyName("line")]
    public PlotlyLine? Line { get; init; }

    /// <summary>
    /// Marker styling for data points (color, size, opacity).
    /// </summary>
    [JsonPropertyName("marker")]
    public PlotlyMarker? Marker { get; init; }
}

/// <summary>
/// Pie chart trace.
/// </summary>
public sealed record PieTrace : PlotlyTrace
{
    /// <summary>
    /// Sector labels. Must be JSON-serializable types: strings, numbers, or null.
    /// </summary>
    [JsonPropertyName("labels")]
    public required object[] Labels { get; init; } = Array.Empty<object>();

    /// <summary>
    /// Sector values (sizes). Must be numeric values.
    /// </summary>
    [JsonPropertyName("values")]
    public required object[] Values { get; init; } = Array.Empty<object>();

    /// <summary>
    /// Fraction of the radius to cut out of the pie. 0 for pie, >0 for donut chart.
    /// </summary>
    [JsonPropertyName("hole")]
    public double? Hole { get; init; }

    /// <summary>
    /// Marker styling for the pie sectors (color, opacity).
    /// </summary>
    [JsonPropertyName("marker")]
    public PlotlyMarker? Marker { get; init; }

    /// <summary>
    /// Text information to display on hover.
    /// </summary>
    [JsonPropertyName("hoverinfo")]
    public string? HoverInfo { get; init; }

    /// <summary>
    /// Controls which text elements appear on the pie. Use "label", "value", "percent", or combinations like "label+percent".
    /// If null, defaults to "percent".
    /// </summary>
    [JsonPropertyName("textinfo")]
    public string? TextInfo { get; init; }
}

/// <summary>
/// Histogram trace.
/// </summary>
public sealed record HistogramTrace : PlotlyTrace
{
    /// <summary>
    /// Sample values for the histogram. Must be numeric.
    /// </summary>
    [JsonPropertyName("x")]
    public object[]? X { get; init; }

    /// <summary>
    /// Sample values for the histogram (alternative to X for vertical orientation). Must be numeric.
    /// </summary>
    [JsonPropertyName("y")]
    public object[]? Y { get; init; }

    /// <summary>
    /// Number of bins or binning specification.
    /// </summary>
    [JsonPropertyName("nbinsx")]
    public int? NBinsX { get; init; }

    /// <summary>
    /// Number of bins for Y-axis binning.
    /// </summary>
    [JsonPropertyName("nbinsy")]
    public int? NBinsY { get; init; }

    /// <summary>
    /// Histogram normalization mode. Use <see cref="PlotlyHistogramNorms"/> constants. If null, shows raw counts.
    /// </summary>
    [JsonPropertyName("histnorm")]
    public string? HistNorm { get; init; }

    /// <summary>
    /// Marker styling for the histogram bars (color, opacity).
    /// </summary>
    [JsonPropertyName("marker")]
    public PlotlyMarker? Marker { get; init; }
}

/// <summary>
/// Heatmap trace.
/// </summary>
public sealed record HeatmapTrace : PlotlyTrace
{
    /// <summary>
    /// X coordinates. Can be 1D array or null for auto-generated coordinates.
    /// </summary>
    [JsonPropertyName("x")]
    public object[]? X { get; init; }

    /// <summary>
    /// Y coordinates. Can be 1D array or null for auto-generated coordinates.
    /// </summary>
    [JsonPropertyName("y")]
    public object[]? Y { get; init; }

    /// <summary>
    /// Z values as a 2D array (array of arrays). Must be numeric values.
    /// </summary>
    [JsonPropertyName("z")]
    public required object[][] Z { get; init; }

    /// <summary>
    /// Colorscale for the heatmap. Use <see cref="PlotlyColorScales"/> constants. If null, uses default colorscale.
    /// </summary>
    [JsonPropertyName("colorscale")]
    public string? ColorScale { get; init; }

    /// <summary>
    /// Whether to show the color bar.
    /// </summary>
    [JsonPropertyName("showscale")]
    public bool? ShowScale { get; init; }
}

/// <summary>
/// Box plot trace.
/// </summary>
public sealed record BoxTrace : PlotlyTrace
{

    /// <summary>
    /// X coordinates or categories for the boxes.
    /// </summary>
    [JsonPropertyName("x")]
    public object[]? X { get; init; }

    /// <summary>
    /// Y values for the box plot. Must be numeric.
    /// </summary>
    [JsonPropertyName("y")]
    public object[]? Y { get; init; }

    /// <summary>
    /// Box orientation. Use <see cref="PlotlyOrientations"/> constants. If null, defaults to vertical.
    /// </summary>
    [JsonPropertyName("orientation")]
    public string? Orientation { get; init; }

    /// <summary>
    /// How to display box points. Use <see cref="PlotlyBoxPointsModes"/> constants. If null, uses default behavior.
    /// </summary>
    [JsonPropertyName("boxpoints")]
    public object? BoxPoints { get; init; }

    /// <summary>
    /// Marker styling for outlier points (color, size, opacity).
    /// </summary>
    [JsonPropertyName("marker")]
    public PlotlyMarker? Marker { get; init; }

    /// <summary>
    /// Line styling for the box outline (color, width).
    /// </summary>
    [JsonPropertyName("line")]
    public PlotlyLine? Line { get; init; }
}

/// <summary>
/// Violin plot trace.
/// </summary>
public sealed record ViolinTrace : PlotlyTrace
{
    /// <summary>
    /// X coordinates or categories for the violins.
    /// </summary>
    [JsonPropertyName("x")]
    public object[]? X { get; init; }

    /// <summary>
    /// Y values for the violin plot. Must be numeric.
    /// </summary>
    [JsonPropertyName("y")]
    public object[]? Y { get; init; }

    /// <summary>
    /// Violin orientation. Use <see cref="PlotlyOrientations"/> constants. If null, defaults to vertical.
    /// </summary>
    [JsonPropertyName("orientation")]
    public string? Orientation { get; init; }

    /// <summary>
    /// Whether to show the box plot inside the violin.
    /// </summary>
    [JsonPropertyName("box")]
    public object? Box { get; init; }

    /// <summary>
    /// Whether to show the mean line.
    /// </summary>
    [JsonPropertyName("meanline")]
    public object? MeanLine { get; init; }

    /// <summary>
    /// Marker styling for data points (color, size, opacity).
    /// </summary>
    [JsonPropertyName("marker")]
    public PlotlyMarker? Marker { get; init; }

    /// <summary>
    /// Line styling for the violin outline (color, width).
    /// </summary>
    [JsonPropertyName("line")]
    public PlotlyLine? Line { get; init; }
}

/// <summary>
/// 3D surface plot trace.
/// </summary>
public sealed record SurfaceTrace : PlotlyTrace
{
    /// <summary>
    /// X coordinates. Can be 1D array or null for auto-generated coordinates.
    /// </summary>
    [JsonPropertyName("x")]
    public object[]? X { get; init; }

    /// <summary>
    /// Y coordinates. Can be 1D array or null for auto-generated coordinates.
    /// </summary>
    [JsonPropertyName("y")]
    public object[]? Y { get; init; }

    /// <summary>
    /// Z values as a 2D array (array of arrays) representing the surface heights. Must be numeric values.
    /// </summary>
    [JsonPropertyName("z")]
    public required object[][] Z { get; init; }

    /// <summary>
    /// Colorscale for the surface. Use <see cref="PlotlyColorScales"/> constants. If null, uses default colorscale.
    /// </summary>
    [JsonPropertyName("colorscale")]
    public string? ColorScale { get; init; }

    /// <summary>
    /// Whether to show the color bar.
    /// </summary>
    [JsonPropertyName("showscale")]
    public bool? ShowScale { get; init; }

    /// <summary>
    /// Surface opacity (0.0 to 1.0, where 0 is transparent and 1 is opaque).
    /// </summary>
    [JsonPropertyName("opacity")]
    public double? Opacity { get; init; }

    /// <summary>
    /// Array of colors for custom surface coloring. If provided, overrides the colorscale.
    /// </summary>
    [JsonPropertyName("surfacecolor")]
    public object[][]? SurfaceColor { get; init; }

    /// <summary>
    /// Contour configuration for the surface (x, y, z contours).
    /// </summary>
    [JsonPropertyName("contours")]
    public object? Contours { get; init; }
}

/// <summary>
/// Indicator trace for displaying single values/KPIs (card charts).
/// </summary>
public sealed record IndicatorTrace : PlotlyTrace
{
    /// <summary>
    /// The value to display.
    /// </summary>
    [JsonPropertyName("value")]
    public required double Value { get; init; }

    /// <summary>
    /// Display mode. Use <see cref="PlotlyIndicatorModes"/> constants.
    /// </summary>
    [JsonPropertyName("mode")]
    public string Mode { get; init; } = PlotlyIndicatorModes.Number;

    /// <summary>
    /// Title configuration for the indicator.
    /// </summary>
    [JsonPropertyName("title")]
    public PlotlyTitle? Title { get; init; }

    /// <summary>
    /// Number formatting configuration.
    /// </summary>
    [JsonPropertyName("number")]
    public PlotlyIndicatorNumber? Number { get; init; }

    /// <summary>
    /// Delta configuration for showing change from a reference value.
    /// </summary>
    [JsonPropertyName("delta")]
    public PlotlyIndicatorDelta? Delta { get; init; }

    /// <summary>
    /// Gauge configuration for gauge-style indicators.
    /// </summary>
    [JsonPropertyName("gauge")]
    public object? Gauge { get; init; }

    /// <summary>
    /// Domain (position and size) of the indicator in the plot area.
    /// </summary>
    [JsonPropertyName("domain")]
    public object? Domain { get; init; }
}

/// <summary>
/// TreeMap trace for hierarchical data visualization.
/// </summary>
public sealed record TreeMapTrace : PlotlyTrace
{
    /// <summary>
    /// Labels for each sector of the treemap.
    /// </summary>
    [JsonPropertyName("labels")]
    public required object[] Labels { get; init; } = Array.Empty<object>();

    /// <summary>
    /// Parent labels for each sector, defining the hierarchy.
    /// Use empty string "" for root-level items.
    /// </summary>
    [JsonPropertyName("parents")]
    public required object[] Parents { get; init; } = Array.Empty<object>();

    /// <summary>
    /// Values determining the size of each sector. Must be numeric.
    /// </summary>
    [JsonPropertyName("values")]
    public object[]? Values { get; init; }

    /// <summary>
    /// Unique identifiers for each sector. Useful when labels are not unique.
    /// </summary>
    [JsonPropertyName("ids")]
    public object[]? Ids { get; init; }

    /// <summary>
    /// Text to display on each sector.
    /// </summary>
    [JsonPropertyName("text")]
    public object[]? Text { get; init; }

    /// <summary>
    /// Text template for customizing displayed text.
    /// </summary>
    [JsonPropertyName("texttemplate")]
    public string? TextTemplate { get; init; }

    /// <summary>
    /// Controls text display: "text", "value", "percent", "label", or combinations like "label+value".
    /// </summary>
    [JsonPropertyName("textinfo")]
    public string? TextInfo { get; init; }

    /// <summary>
    /// Hover text template.
    /// </summary>
    [JsonPropertyName("hovertemplate")]
    public string? HoverTemplate { get; init; }

    /// <summary>
    /// Marker styling for the treemap sectors.
    /// </summary>
    [JsonPropertyName("marker")]
    public PlotlyTreeMapMarker? Marker { get; init; }

    /// <summary>
    /// How much of the entry to show when drilling down. 0 shows all, higher values show less context.
    /// </summary>
    [JsonPropertyName("maxdepth")]
    public int? MaxDepth { get; init; }

    /// <summary>
    /// Sets the level from which to render the treemap. Use "" for root.
    /// </summary>
    [JsonPropertyName("level")]
    public string? Level { get; init; }

    /// <summary>
    /// Determines how the items are grouped in branches.
    /// </summary>
    [JsonPropertyName("branchvalues")]
    public string? BranchValues { get; init; }

    /// <summary>
    /// Pathbar configuration for showing the current navigation path.
    /// </summary>
    [JsonPropertyName("pathbar")]
    public PlotlyPathbar? Pathbar { get; init; }
}

/// <summary>
/// Marker configuration for TreeMap traces.
/// </summary>
public sealed record PlotlyTreeMapMarker
{
    /// <summary>
    /// Color values for each sector. Can be array of colors or numeric values for colorscale.
    /// If null, Plotly assigns colors from the layout colorway.
    /// </summary>
    [JsonPropertyName("colors")]
    public object[]? Colors { get; init; }

    /// <summary>
    /// Colorscale for numeric color values. If null, uses the default sequential colorscale.
    /// </summary>
    [JsonPropertyName("colorscale")]
    public string? ColorScale { get; init; }

    /// <summary>
    /// Whether to show the colorbar. If null, defaults to true when colorscale is used.
    /// </summary>
    [JsonPropertyName("showscale")]
    public bool? ShowScale { get; init; }

    /// <summary>
    /// Line styling for sector borders. If null, uses a thin white border.
    /// </summary>
    [JsonPropertyName("line")]
    public PlotlyLine? Line { get; init; }
}

/// <summary>
/// Pathbar configuration for hierarchical charts (TreeMap, Sunburst).
/// </summary>
public sealed record PlotlyPathbar
{
    /// <summary>
    /// Whether the pathbar is visible. If null, defaults to true.
    /// </summary>
    [JsonPropertyName("visible")]
    public bool? Visible { get; init; }

    /// <summary>
    /// Position of the pathbar. If null, defaults to "top". Use "top" or "bottom".
    /// </summary>
    [JsonPropertyName("side")]
    public string? Side { get; init; }

    /// <summary>
    /// Font for the pathbar text. If null, inherits from the layout font.
    /// </summary>
    [JsonPropertyName("textfont")]
    public PlotlyFont? TextFont { get; init; }
}

/// <summary>
/// Sankey diagram trace for visualizing flows between nodes.
/// </summary>
public sealed record SankeyTrace : PlotlyTrace
{
    /// <summary>
    /// Node configuration for the Sankey diagram.
    /// </summary>
    [JsonPropertyName("node")]
    public required SankeyNode Node { get; init; }

    /// <summary>
    /// Link configuration for the Sankey diagram.
    /// </summary>
    [JsonPropertyName("link")]
    public required SankeyLink Link { get; init; }

    /// <summary>
    /// Orientation of the Sankey diagram: "h" for horizontal, "v" for vertical.
    /// </summary>
    [JsonPropertyName("orientation")]
    public string? Orientation { get; init; }

    /// <summary>
    /// Value format string for display.
    /// </summary>
    [JsonPropertyName("valueformat")]
    public string? ValueFormat { get; init; }

    /// <summary>
    /// Value suffix for display (e.g., " units").
    /// </summary>
    [JsonPropertyName("valuesuffix")]
    public string? ValueSuffix { get; init; }

    /// <summary>
    /// The arrangement of nodes: "snap", "perpendicular", "freeform", or "fixed".
    /// </summary>
    [JsonPropertyName("arrangement")]
    public string? Arrangement { get; init; }
}

/// <summary>
/// Node configuration for Sankey diagrams.
/// </summary>
public sealed record SankeyNode
{
    /// <summary>
    /// Labels for each node.
    /// </summary>
    [JsonPropertyName("label")]
    public required string[] Label { get; init; } = Array.Empty<string>();

    /// <summary>
    /// Colors for each node. Can be array of colors or a single color.
    /// </summary>
    [JsonPropertyName("color")]
    public object? Color { get; init; }

    /// <summary>
    /// Padding between nodes in pixels.
    /// </summary>
    [JsonPropertyName("pad")]
    public int? Pad { get; init; }

    /// <summary>
    /// Thickness of nodes in pixels.
    /// </summary>
    [JsonPropertyName("thickness")]
    public int? Thickness { get; init; }

    /// <summary>
    /// Line styling for node borders.
    /// </summary>
    [JsonPropertyName("line")]
    public PlotlyLine? Line { get; init; }

    /// <summary>
    /// Hover template for nodes.
    /// </summary>
    [JsonPropertyName("hovertemplate")]
    public string? HoverTemplate { get; init; }
}

/// <summary>
/// Link configuration for Sankey diagrams.
/// </summary>
public sealed record SankeyLink
{
    /// <summary>
    /// Source node indices for each link.
    /// </summary>
    [JsonPropertyName("source")]
    public required int[] Source { get; init; } = Array.Empty<int>();

    /// <summary>
    /// Target node indices for each link.
    /// </summary>
    [JsonPropertyName("target")]
    public required int[] Target { get; init; } = Array.Empty<int>();

    /// <summary>
    /// Flow values for each link.
    /// </summary>
    [JsonPropertyName("value")]
    public required double[] Value { get; init; } = Array.Empty<double>();

    /// <summary>
    /// Colors for each link. Can be array of colors or a single color.
    /// </summary>
    [JsonPropertyName("color")]
    public object? Color { get; init; }

    /// <summary>
    /// Labels for each link (shown on hover).
    /// </summary>
    [JsonPropertyName("label")]
    public string[]? Label { get; init; }

    /// <summary>
    /// Hover template for links.
    /// </summary>
    [JsonPropertyName("hovertemplate")]
    public string? HoverTemplate { get; init; }
}

/// <summary>
/// Marker styling for traces.
/// </summary>
public sealed record PlotlyMarker
{
    /// <summary>
    /// Marker color. If null, uses the trace's color from the layout colorway.
    /// Use hex ("#FF5733"), RGB ("rgb(255,87,51)"), or named colors.
    /// </summary>
    [JsonPropertyName("color")]
    public string? Color { get; init; }

    /// <summary>
    /// Marker size in pixels. If null, defaults to 6.
    /// </summary>
    [JsonPropertyName("size")]
    public double? Size { get; init; }

    /// <summary>
    /// Marker opacity (0.0 to 1.0). If null, defaults to 1 (fully opaque).
    /// </summary>
    [JsonPropertyName("opacity")]
    public double? Opacity { get; init; }
}

/// <summary>
/// Line styling for traces.
/// </summary>
public sealed record PlotlyLine
{
    /// <summary>
    /// Line color. If null, uses the trace's color from the layout colorway.
    /// Use hex ("#FF5733"), RGB ("rgb(255,87,51)"), or named colors.
    /// </summary>
    [JsonPropertyName("color")]
    public string? Color { get; init; }

    /// <summary>
    /// Line width in pixels. If null, defaults to 2.
    /// </summary>
    [JsonPropertyName("width")]
    public double? Width { get; init; }

    /// <summary>
    /// Line dash style. Use <see cref="PlotlyDashStyles"/> constants. If null, defaults to solid.
    /// </summary>
    [JsonPropertyName("dash")]
    public string? Dash { get; init; }
}

/// <summary>
/// Plotly axis configuration.
/// </summary>
public sealed record PlotlyAxis
{
    /// <summary>
    /// Title configuration for the axis. If null, no title is shown.
    /// </summary>
    [JsonPropertyName("title")]
    public PlotlyTitle? Title { get; init; }

    /// <summary>
    /// Axis type. Use <see cref="PlotlyAxisTypes"/> constants.
    /// If null, Plotly auto-detects from the data (typically linear for numbers, category for strings, date for DateTime).
    /// </summary>
    [JsonPropertyName("type")]
    public string? Type { get; init; }

    /// <summary>
    /// Axis position. Use <see cref="PlotlyAxisSides"/> constants.
    /// If null, X-axis defaults to "bottom" and Y-axis defaults to "left".
    /// </summary>
    [JsonPropertyName("side")]
    public string? Side { get; init; }

    /// <summary>
    /// ID of axis to overlay on (e.g., "y" to overlay on primary y-axis). If null, the axis occupies its own space.
    /// </summary>
    [JsonPropertyName("overlaying")]
    public string? Overlaying { get; init; }

    /// <summary>
    /// Axis range as [min, max]. If null, Plotly auto-ranges to fit all data.
    /// </summary>
    [JsonPropertyName("range")]
    public object[]? Range { get; init; }

    /// <summary>
    /// How the axis range relates to the data. Use "normal" (default), "tozero" (include zero), or "nonnegative" (non-negative only).
    /// If null, defaults to "normal".
    /// </summary>
    [JsonPropertyName("rangemode")]
    public string? RangeMode { get; init; }

    /// <summary>
    /// Whether to automatically determine the axis range from data. If null, defaults to true.
    /// </summary>
    [JsonPropertyName("autorange")]
    public bool? AutoRange { get; init; }

    /// <summary>
    /// Color for axis line, tick marks, and tick labels. If null, inherits from the layout font color.
    /// </summary>
    [JsonPropertyName("color")]
    public string? Color { get; init; }

    /// <summary>
    /// Color of the grid lines. If null, uses a light gray (#eee for light themes).
    /// </summary>
    [JsonPropertyName("gridcolor")]
    public string? GridColor { get; init; }

    /// <summary>
    /// Color of the axis line. If null, uses #444.
    /// </summary>
    [JsonPropertyName("linecolor")]
    public string? LineColor { get; init; }

    /// <summary>
    /// Color of the zero line. If null, uses #444.
    /// </summary>
    [JsonPropertyName("zerolinecolor")]
    public string? ZeroLineColor { get; init; }

    /// <summary>
    /// If true, Plotly automatically expands margins so tick labels are not clipped.
    /// Defaults to true to prevent text labels from extending outside the viewable area.
    /// </summary>
    [JsonPropertyName("automargin")]
    public bool? AutoMargin { get; init; } = true;

    /// <summary>
    /// If true, the axis range cannot be changed by user interaction (zoom/pan). If null, defaults to false (zooming allowed).
    /// Hover tooltips still work. Use this instead of staticPlot to keep interactivity.
    /// </summary>
    [JsonPropertyName("fixedrange")]
    public bool? FixedRange { get; init; }

    /// <summary>
    /// How ticks are placed on the axis. Use <see cref="PlotlyTickModes"/> constants.
    /// If null, defaults to "auto" (Plotly determines tick placement based on data and axis size).
    /// "linear" uses LinearTickStartingValue+TickInterval spacing, "array" uses TickValues/TickText.
    /// </summary>
    [JsonPropertyName("tickmode")]
    public string? TickMode { get; init; }

    /// <summary>
    /// Maximum number of ticks. Plotly uses this as a hint when TickMode is "auto". If null, Plotly chooses automatically.
    /// </summary>
    [JsonPropertyName("nticks")]
    public int? MaximumTicks { get; init; }

    /// <summary>
    /// Starting tick value when TickMode is "linear". If null, Plotly auto-selects a round starting value.
    /// </summary>
    [JsonPropertyName("tick0")]
    public object? LinearTickStartingValue { get; init; }

    /// <summary>
    /// Tick interval when TickMode is "linear". If null, Plotly auto-selects the interval.
    /// For date axes, use milliseconds or a string like "M1" (1 month), "D1" (1 day).
    /// </summary>
    [JsonPropertyName("dtick")]
    public object? TickInterval { get; init; }

    /// <summary>
    /// Explicit tick positions when TickMode is "array". If null, positions are determined by TickMode.
    /// </summary>
    [JsonPropertyName("tickvals")]
    public object[]? TickValues { get; init; }

    /// <summary>
    /// Explicit tick labels corresponding to TickValues when TickMode is "array".
    /// If null, tick values are displayed as-is.
    /// </summary>
    [JsonPropertyName("ticktext")]
    public string[]? TickText { get; init; }

    /// <summary>
    /// Rotation angle for tick labels in degrees (e.g., -45, 90).
    /// If null, Plotly auto-rotates labels to avoid overlap.
    /// </summary>
    [JsonPropertyName("tickangle")]
    public double? TickAngle { get; init; }

    /// <summary>
    /// d3-format string for tick labels (e.g., ".2f" for 2 decimal places, ".0%" for percentages).
    /// If null, Plotly formats based on axis type (SI notation for numbers, ISO for dates).
    /// </summary>
    [JsonPropertyName("tickformat")]
    public string? TickFormat { get; init; }

    /// <summary>
    /// Prefix added before each tick label (e.g., "$"). If null, no prefix is shown.
    /// </summary>
    [JsonPropertyName("tickprefix")]
    public string? TickPrefix { get; init; }

    /// <summary>
    /// Suffix added after each tick label (e.g., "%", "kg"). If null, no suffix is shown.
    /// </summary>
    [JsonPropertyName("ticksuffix")]
    public string? TickSuffix { get; init; }

    /// <summary>
    /// Whether to show tick labels. If null, defaults to true.
    /// </summary>
    [JsonPropertyName("showticklabels")]
    public bool? ShowTickLabels { get; init; }

    /// <summary>
    /// Where to draw tick marks. Use <see cref="PlotlyTickPositions"/> constants.
    /// If null, no tick marks are drawn (only labels). "outside" or "inside" enables them.
    /// </summary>
    [JsonPropertyName("ticks")]
    public string? Ticks { get; init; }

    /// <summary>
    /// Tick mark length in pixels. If null, defaults to 5.
    /// </summary>
    [JsonPropertyName("ticklen")]
    public double? TickLength { get; init; }

    /// <summary>
    /// Tick mark width in pixels. If null, defaults to 1.
    /// </summary>
    [JsonPropertyName("tickwidth")]
    public double? TickWidth { get; init; }

    /// <summary>
    /// Color of tick marks. If null, inherits from the axis Color property.
    /// </summary>
    [JsonPropertyName("tickcolor")]
    public string? TickColor { get; init; }

    /// <summary>
    /// Font for tick labels. If null, inherits from the layout font.
    /// </summary>
    [JsonPropertyName("tickfont")]
    public PlotlyFont? TickFont { get; init; }

    /// <summary>
    /// Show every Nth tick label (e.g., 2 to show every other label). If null, defaults to 1 (every label).
    /// </summary>
    [JsonPropertyName("ticklabelstep")]
    public int? TickLabelStep { get; init; }

    // ─── Visibility & line control ──────────────────────────────────────

    /// <summary>
    /// Whether the axis is visible. If null, defaults to true. Set to false to hide the entire axis.
    /// </summary>
    [JsonPropertyName("visible")]
    public bool? Visible { get; init; }

    /// <summary>
    /// Whether to show grid lines. If null, defaults to true.
    /// </summary>
    [JsonPropertyName("showgrid")]
    public bool? ShowGrid { get; init; }

    /// <summary>
    /// Whether to show the axis line. If null, defaults to false.
    /// </summary>
    [JsonPropertyName("showline")]
    public bool? ShowLine { get; init; }

    /// <summary>
    /// Whether to show a line at value 0. If null, defaults to true for linear axes, false for log/category.
    /// </summary>
    [JsonPropertyName("zeroline")]
    public bool? ZeroLine { get; init; }

    /// <summary>
    /// Width of the axis line in pixels. If null, defaults to 1.
    /// </summary>
    [JsonPropertyName("linewidth")]
    public double? LineWidth { get; init; }

    /// <summary>
    /// Width of grid lines in pixels. If null, defaults to 1.
    /// </summary>
    [JsonPropertyName("gridwidth")]
    public double? GridWidth { get; init; }

    /// <summary>
    /// Width of the zero line in pixels. If null, defaults to 1.
    /// </summary>
    [JsonPropertyName("zerolinewidth")]
    public double? ZeroLineWidth { get; init; }

    /// <summary>
    /// Mirror the axis line to the opposite side. If null, no mirroring.
    /// Use true to mirror the line, "ticks" to mirror line and ticks, "all" for line, ticks, and labels.
    /// </summary>
    [JsonPropertyName("mirror")]
    public object? Mirror { get; init; }

    // ─── Category ordering ──────────────────────────────────────────────

    /// <summary>
    /// Order of categories on the axis. Use <see cref="PlotlyCategoryOrders"/> constants.
    /// If null, defaults to "trace" (categories appear in the order they are encountered in trace data).
    /// </summary>
    [JsonPropertyName("categoryorder")]
    public string? CategoryOrder { get; init; }

    /// <summary>
    /// Explicit category order when CategoryOrder is "array". If null, has no effect.
    /// </summary>
    [JsonPropertyName("categoryarray")]
    public object[]? CategoryArray { get; init; }

    // ─── Formatting ─────────────────────────────────────────────────────

    /// <summary>
    /// d3-format string for hover labels (separate from TickFormat).
    /// If null, uses the same format as tick labels.
    /// </summary>
    [JsonPropertyName("hoverformat")]
    public string? HoverFormat { get; init; }

    /// <summary>
    /// Whether to add thousand separators to tick labels. If null, defaults to false.
    /// </summary>
    [JsonPropertyName("separatethousands")]
    public bool? SeparateThousands { get; init; }

    /// <summary>
    /// How exponents are displayed on tick labels. Use <see cref="PlotlyExponentFormats"/> constants.
    /// If null, defaults to "B" (abbreviated: 1B, 1k, etc.).
    /// </summary>
    [JsonPropertyName("exponentformat")]
    public string? ExponentFormat { get; init; }

    /// <summary>
    /// Which ticks show the exponent. If null, defaults to "all".
    /// Use "all", "first", "last", or "none".
    /// </summary>
    [JsonPropertyName("showexponent")]
    public string? ShowExponent { get; init; }

    // ─── Subplots & layout ──────────────────────────────────────────────

    /// <summary>
    /// Fractional domain of the plot area this axis occupies, as [min, max] where values are 0–1.
    /// If null, defaults to [0, 1] (full width/height).
    /// </summary>
    [JsonPropertyName("domain")]
    public double[]? Domain { get; init; }

    /// <summary>
    /// ID of the axis this one anchors to (e.g., "x", "y2").
    /// If null, the axis anchors to its default counterpart (xaxis to yaxis and vice versa).
    /// Use "free" to position the axis independently via the Position property.
    /// </summary>
    [JsonPropertyName("anchor")]
    public string? Anchor { get; init; }

    /// <summary>
    /// Axis position as a 0–1 fraction of the plot area. Only used when Anchor is "free".
    /// If null, defaults to 0 (left/bottom edge).
    /// </summary>
    [JsonPropertyName("position")]
    public double? Position { get; init; }

    /// <summary>
    /// Constrains the axis scaling. If null, no constraint is applied.
    /// Use "range" to constrain the range, or "domain" to constrain the domain.
    /// </summary>
    [JsonPropertyName("constrain")]
    public string? Constrain { get; init; }

    /// <summary>
    /// When Constrain is set, determines which end of the axis to keep fixed.
    /// If null, defaults to "center".
    /// Use "left", "center", "right" for x-axes; "bottom", "middle", "top" for y-axes.
    /// </summary>
    [JsonPropertyName("constraintoward")]
    public string? ConstrainToward { get; init; }

    /// <summary>
    /// ID of another axis to lock aspect ratio with (e.g., "x", "y"). If null, axes scale independently.
    /// </summary>
    [JsonPropertyName("scaleanchor")]
    public string? ScaleAnchor { get; init; }

    /// <summary>
    /// Aspect ratio relative to ScaleAnchor axis (e.g., 1.0 for equal scaling). If null, defaults to 1.
    /// </summary>
    [JsonPropertyName("scaleratio")]
    public double? ScaleRatio { get; init; }

    /// <summary>
    /// ID of another axis whose range this axis should match (e.g., "x2"). If null, range is independent.
    /// </summary>
    [JsonPropertyName("matches")]
    public string? Matches { get; init; }

    // ─── Interactive features ───────────────────────────────────────────

    /// <summary>
    /// Whether to show spike lines on hover (lines extending from data point to axis). If null, defaults to false.
    /// </summary>
    [JsonPropertyName("showspikes")]
    public bool? ShowSpikes { get; init; }

    /// <summary>
    /// Color of spike lines. If null, uses the trace color.
    /// </summary>
    [JsonPropertyName("spikecolor")]
    public string? SpikeColor { get; init; }

    /// <summary>
    /// Thickness of spike lines in pixels. If null, defaults to 3.
    /// </summary>
    [JsonPropertyName("spikethickness")]
    public double? SpikeThickness { get; init; }

    /// <summary>
    /// Dash style for spike lines. Use <see cref="PlotlyDashStyles"/> constants. If null, defaults to "dash".
    /// </summary>
    [JsonPropertyName("spikedash")]
    public string? SpikeDash { get; init; }

    /// <summary>
    /// How spike lines are drawn. Use <see cref="PlotlySpikeModes"/> constants. If null, defaults to "toaxis".
    /// </summary>
    [JsonPropertyName("spikemode")]
    public string? SpikeMode { get; init; }

    /// <summary>
    /// Minimum allowed value the user can zoom to. If null, no minimum zoom limit is enforced.
    /// </summary>
    [JsonPropertyName("minallowed")]
    public object? MinAllowed { get; init; }

    /// <summary>
    /// Maximum allowed value the user can zoom to. If null, no maximum zoom limit is enforced.
    /// </summary>
    [JsonPropertyName("maxallowed")]
    public object? MaxAllowed { get; init; }

    /// <summary>
    /// Range slider configuration for interactive date zooming.
    /// If null, no range slider is shown. Set to an empty object to enable with defaults.
    /// </summary>
    [JsonPropertyName("rangeslider")]
    public object? RangeSlider { get; init; }

    /// <summary>
    /// Range selector buttons configuration (e.g., "1M", "6M", "1Y" preset buttons).
    /// If null, no range selector buttons are shown.
    /// </summary>
    [JsonPropertyName("rangeselector")]
    public object? RangeSelector { get; init; }
}

/// <summary>
/// 3D scene configuration for surface and other 3D plots.
/// </summary>
public sealed record PlotlyScene
{
    /// <summary>
    /// X-axis configuration for the 3D scene. If null, Plotly uses default axis settings.
    /// </summary>
    [JsonPropertyName("xaxis")]
    public PlotlyAxis? XAxis { get; init; }

    /// <summary>
    /// Y-axis configuration for the 3D scene. If null, Plotly uses default axis settings.
    /// </summary>
    [JsonPropertyName("yaxis")]
    public PlotlyAxis? YAxis { get; init; }

    /// <summary>
    /// Z-axis configuration for the 3D scene. If null, Plotly uses default axis settings.
    /// </summary>
    [JsonPropertyName("zaxis")]
    public PlotlyAxis? ZAxis { get; init; }

    /// <summary>
    /// Camera configuration for the 3D view (eye position, center, up vector).
    /// If null, uses a default perspective looking at the center of the data.
    /// </summary>
    [JsonPropertyName("camera")]
    public object? Camera { get; init; }

    /// <summary>
    /// Aspect ratio configuration for the 3D scene (x, y, z ratios).
    /// If null, determined by AspectMode.
    /// </summary>
    [JsonPropertyName("aspectratio")]
    public object? AspectRatio { get; init; }

    /// <summary>
    /// Aspect mode: "auto", "cube", "data", or "manual". If null, defaults to "auto".
    /// </summary>
    [JsonPropertyName("aspectmode")]
    public string? AspectMode { get; init; }
}

/// <summary>
/// Title configuration.
/// </summary>
public sealed record PlotlyTitle
{
    /// <summary>
    /// The title text to display. If null, no title is shown.
    /// </summary>
    [JsonPropertyName("text")]
    public string? Text { get; init; }

    /// <summary>
    /// Font styling for the title text. If null, inherits from the layout font (larger size for chart title).
    /// </summary>
    [JsonPropertyName("font")]
    public PlotlyFont? Font { get; init; }

    /// <summary>
    /// Horizontal position as fraction (0–1). If null, defaults to 0.5 (centered).
    /// </summary>
    [JsonPropertyName("x")]
    public double? X { get; init; }

    /// <summary>
    /// Vertical position as fraction (0–1). If null, Plotly auto-positions above the plot area.
    /// </summary>
    [JsonPropertyName("y")]
    public double? Y { get; init; }

    /// <summary>
    /// Vertical anchor point. Use "top", "middle", "bottom", or "auto". If null, defaults to "auto".
    /// </summary>
    [JsonPropertyName("yanchor")]
    public string? YAnchor { get; init; }

    /// <summary>
    /// Reference for y positioning. Use "container" or "paper". If null, defaults to "container".
    /// </summary>
    [JsonPropertyName("yref")]
    public string? YRef { get; init; }

    /// <summary>
    /// Padding between the title and the plot area or container edges.
    /// </summary>
    [JsonPropertyName("pad")]
    public PlotlyTitlePad? Pad { get; init; }
}

/// <summary>
/// Padding for title positioning.
/// </summary>
public sealed record PlotlyTitlePad
{
    /// <summary>Bottom padding in pixels.</summary>
    [JsonPropertyName("b")]
    public double? Bottom { get; init; }

    /// <summary>Left padding in pixels.</summary>
    [JsonPropertyName("l")]
    public double? Left { get; init; }

    /// <summary>Right padding in pixels.</summary>
    [JsonPropertyName("r")]
    public double? Right { get; init; }

    /// <summary>Top padding in pixels.</summary>
    [JsonPropertyName("t")]
    public double? Top { get; init; }
}

/// <summary>
/// Font configuration.
/// </summary>
public sealed record PlotlyFont
{
    /// <summary>
    /// Font family name (e.g., "Arial", "Courier New", "Times New Roman").
    /// If null, defaults to "Open Sans", verdana, arial, sans-serif.
    /// </summary>
    [JsonPropertyName("family")]
    public string? Family { get; init; }

    /// <summary>
    /// Font size in pixels. If null, defaults to 12 (or a context-dependent size for titles/labels).
    /// </summary>
    [JsonPropertyName("size")]
    public double? Size { get; init; }

    /// <summary>
    /// Font color. If null, defaults to "#444" for light themes.
    /// Use hex ("#FF5733"), RGB ("rgb(255,87,51)"), or named colors.
    /// </summary>
    [JsonPropertyName("color")]
    public string? Color { get; init; }
}

/// <summary>
/// Number formatting for indicator traces.
/// </summary>
public sealed record PlotlyIndicatorNumber
{
    /// <summary>
    /// Number format prefix (e.g., "$" for currency). If null, no prefix is shown.
    /// </summary>
    [JsonPropertyName("prefix")]
    public string? Prefix { get; init; }

    /// <summary>
    /// Number format suffix (e.g., "%" for percentage). If null, no suffix is shown.
    /// </summary>
    [JsonPropertyName("suffix")]
    public string? Suffix { get; init; }

    /// <summary>
    /// Font styling for the number. If null, uses a large default font.
    /// </summary>
    [JsonPropertyName("font")]
    public PlotlyFont? Font { get; init; }

    /// <summary>
    /// d3-format string for the number (e.g., ".2f" for 2 decimal places). If null, displays the raw value.
    /// </summary>
    [JsonPropertyName("valueformat")]
    public string? ValueFormat { get; init; }
}

/// <summary>
/// Delta configuration for indicator traces (shows change from reference).
/// </summary>
public sealed record PlotlyIndicatorDelta
{
    /// <summary>
    /// Reference value to compare against. Required for delta to display.
    /// </summary>
    [JsonPropertyName("reference")]
    public double? Reference { get; init; }

    /// <summary>
    /// Whether to show the delta as relative (percentage). If null, defaults to false (absolute difference).
    /// </summary>
    [JsonPropertyName("relative")]
    public bool? Relative { get; init; }

    /// <summary>
    /// Position of the delta relative to the number. If null, defaults to "bottom".
    /// Use "left", "right", "top", or "bottom".
    /// </summary>
    [JsonPropertyName("position")]
    public string? Position { get; init; }

    /// <summary>
    /// Font styling for the delta. If null, uses a default font.
    /// </summary>
    [JsonPropertyName("font")]
    public PlotlyFont? Font { get; init; }

    /// <summary>
    /// Whether the delta is increasing or decreasing.
    /// </summary>
    [JsonPropertyName("increasing")]
    public object? Increasing { get; init; }

    /// <summary>
    /// Whether the delta is decreasing.
    /// </summary>
    [JsonPropertyName("decreasing")]
    public object? Decreasing { get; init; }
}

/// <summary>
/// Plotly layout configuration.
/// </summary>
public sealed record PlotlyLayout
{
    /// <summary>
    /// Title configuration object. If null, no title is shown.
    /// </summary>
    [JsonPropertyName("title")]
    public PlotlyTitle? TitleObject { get; init; }

    [JsonIgnore]
    public string? Title
    {
        get => TitleObject?.Text;
        init => TitleObject = value != null ? new PlotlyTitle { Text = value } : null;
    }

    /// <summary>
    /// Primary X-axis configuration for 2D charts. If null, uses Plotly defaults.
    /// </summary>
    [JsonPropertyName("xaxis")]
    public PlotlyAxis? XAxis { get; init; }

    /// <summary>
    /// Primary Y-axis configuration for 2D charts. If null, uses Plotly defaults.
    /// </summary>
    [JsonPropertyName("yaxis")]
    public PlotlyAxis? YAxis { get; init; }

    /// <summary>
    /// Additional axes (e.g., "yaxis2", "yaxis3"). Values must be PlotlyAxis objects.
    /// </summary>
    [JsonIgnore]
    public ImmutableDictionary<string, PlotlyAxis> AdditionalAxes { get; init; } = ImmutableDictionary<string, PlotlyAxis>.Empty;

    private ImmutableDictionary<string, JsonElement>? _extensionData;
    
    /// <summary>
    /// JSON extension data for serializing additional axes as top-level layout properties.
    /// Automatically populated from AdditionalAxes dictionary.
    /// </summary>
    [JsonExtensionData]
    public ImmutableDictionary<string, JsonElement> ExtensionData
    {
        get
        {
            if (_extensionData == null)
            {
                _extensionData = this.AdditionalAxes.ToImmutableDictionary(kvp => kvp.Key, kvp => JsonSerializer.SerializeToElement(kvp.Value));
            }
            return _extensionData;
        }
    }

    /// <summary>
    /// Bar display mode. Use <see cref="PlotlyBarModes"/> constants.
    /// If null, defaults to "group" (bars side by side).
    /// </summary>
    [JsonPropertyName("barmode")]
    public string? BarMode { get; init; }

    /// <summary>
    /// Whether to show the legend. Default is true.
    /// </summary>
    [JsonPropertyName("showlegend")]
    public bool ShowLegend { get; init; } = true;

    /// <summary>
    /// Template/theme to use for the chart. Use <see cref="PlotlyTemplates"/> constants.
    /// If null, uses the Plotly default theme. This property is not serialized directly —
    /// it's handled specially in ToHtmlDiv to reference the actual Plotly template object.
    /// </summary>
    [JsonIgnore]
    public string? Template { get; init; }

    /// <summary>
    /// Background color of the plotting area. If null, defaults to white ("#fff").
    /// </summary>
    [JsonPropertyName("plot_bgcolor")]
    public string? PlotBackgroundColor { get; init; }

    /// <summary>
    /// Background color of the paper/canvas around the plot. If null, defaults to white ("#fff").
    /// </summary>
    [JsonPropertyName("paper_bgcolor")]
    public string? PaperBackgroundColor { get; init; }

    /// <summary>
    /// Default font settings for the entire chart. If null, uses 12px "Open Sans" in #444.
    /// </summary>
    [JsonPropertyName("font")]
    public PlotlyFont? Font { get; init; }

    /// <summary>
    /// Hover behavior. Use <see cref="PlotlyHoverModes"/> constants.
    /// If null, defaults to "closest" (nearest data point).
    /// </summary>
    [JsonPropertyName("hovermode")]
    public string? HoverMode { get; init; } = PlotlyHoverModes.Closest;

    /// <summary>
    /// 3D scene configuration for surface and other 3D plots. If null, no 3D scene is configured.
    /// </summary>
    [JsonPropertyName("scene")]
    public PlotlyScene? Scene { get; init; }

    /// <summary>
    /// Array of colors to cycle through for traces when colors are not explicitly specified.
    /// Use hex colors (e.g., "#FF5733"), RGB strings (e.g., "rgb(255,87,51)"), or named colors.
    /// If null, uses the template's default colorway.
    /// </summary>
    [JsonPropertyName("colorway")]
    public string[]? Colorway { get; init; }

    /// <summary>
    /// Chart width in pixels. If null, uses responsive/container width.
    /// </summary>
    [JsonPropertyName("width")]
    public double? Width { get; init; }

    /// <summary>
    /// Chart height in pixels. If null, uses responsive/container height.
    /// </summary>
    [JsonPropertyName("height")]
    public double? Height { get; init; }

    /// <summary>
    /// Whether the chart should automatically resize to fit its container. If null, defaults to true.
    /// </summary>
    [JsonPropertyName("autosize")]
    public bool? AutoSize { get; init; }

    // ─── Margin ─────────────────────────────────────────────────────────

    /// <summary>
    /// Plot margins (left, right, top, bottom, pad). If null, Plotly uses auto-computed margins.
    /// </summary>
    [JsonPropertyName("margin")]
    public PlotlyMargin? Margin { get; init; }

    // ─── Legend ─────────────────────────────────────────────────────────

    /// <summary>
    /// Legend configuration (position, orientation, styling). If null, uses default legend at top-right.
    /// </summary>
    [JsonPropertyName("legend")]
    public PlotlyLegend? Legend { get; init; }

    // ─── Hover ──────────────────────────────────────────────────────────

    /// <summary>
    /// Default styling for hover labels (background, font, border). If null, uses Plotly defaults.
    /// </summary>
    [JsonPropertyName("hoverlabel")]
    public PlotlyHoverLabel? HoverLabel { get; init; }

    /// <summary>
    /// Distance threshold (in pixels) for hover to trigger. If null, defaults to 20.
    /// </summary>
    [JsonPropertyName("hoverdistance")]
    public int? HoverDistance { get; init; }

    /// <summary>
    /// Distance threshold (in pixels) for spike lines. If null, defaults to 20. Use -1 for full range.
    /// </summary>
    [JsonPropertyName("spikedistance")]
    public int? SpikeDistance { get; init; }

    // ─── Interaction ────────────────────────────────────────────────────

    /// <summary>
    /// Drag interaction mode. Use <see cref="PlotlyDragModes"/> constants. If null, defaults to "zoom".
    /// </summary>
    [JsonPropertyName("dragmode")]
    public object? DragMode { get; init; }

    /// <summary>
    /// Selection direction when dragmode is "select" or "lasso". If null, defaults to "any".
    /// Use "h", "v", "d", or "any".
    /// </summary>
    [JsonPropertyName("selectdirection")]
    public string? SelectDirection { get; init; }

    /// <summary>
    /// Click interaction mode. If null, defaults to "event".
    /// Use "event", "select", "event+select", or false to disable.
    /// </summary>
    [JsonPropertyName("clickmode")]
    public string? ClickMode { get; init; }

    // ─── Bar/Box/Violin spacing ────────────────────────────────────────

    /// <summary>
    /// Gap between bars in a bar chart, as a fraction of bar width (0–1). If null, defaults to ~0.2.
    /// </summary>
    [JsonPropertyName("bargap")]
    public double? BarGap { get; init; }

    /// <summary>
    /// Gap between bar groups, as a fraction of bar width (0–1). If null, defaults to 0.
    /// </summary>
    [JsonPropertyName("bargroupgap")]
    public double? BarGroupGap { get; init; }

    /// <summary>
    /// How multiple box traces are displayed. If null, defaults to "overlay".
    /// Use "group" or "overlay".
    /// </summary>
    [JsonPropertyName("boxmode")]
    public string? BoxMode { get; init; }

    /// <summary>
    /// How multiple violin traces are displayed. If null, defaults to "overlay".
    /// Use "group" or "overlay".
    /// </summary>
    [JsonPropertyName("violinmode")]
    public string? ViolinMode { get; init; }

    // ─── Annotations & shapes ──────────────────────────────────────────

    /// <summary>
    /// Text annotations drawn on the chart (labels, callouts, notes). If null, no annotations are drawn.
    /// </summary>
    [JsonPropertyName("annotations")]
    public PlotlyAnnotation[]? Annotations { get; init; }

    /// <summary>
    /// Shapes drawn on the chart (lines, rectangles, circles — e.g., threshold lines). If null, no shapes are drawn.
    /// </summary>
    [JsonPropertyName("shapes")]
    public PlotlyShape[]? Shapes { get; init; }

    // ─── Grid (subplots) ───────────────────────────────────────────────

    /// <summary>
    /// Grid layout for subplots (rows, columns, pattern). If null, no subplot grid is used.
    /// </summary>
    [JsonPropertyName("grid")]
    public PlotlyGrid? Grid { get; init; }

    // ─── Text appearance ───────────────────────────────────────────────

    /// <summary>
    /// Uniform text settings to enforce consistent text sizing across traces. If null, each trace sizes text independently.
    /// </summary>
    [JsonPropertyName("uniformtext")]
    public PlotlyUniformText? UniformText { get; init; }

    // ─── Animation ─────────────────────────────────────────────────────

    /// <summary>
    /// Transition/animation settings (duration, easing) for layout changes. If null, changes are applied instantly.
    /// </summary>
    [JsonPropertyName("transition")]
    public object? Transition { get; init; }
}

/// <summary>
/// Plot margin configuration.
/// </summary>
public sealed record PlotlyMargin
{
    /// <summary>Left margin in pixels. If null, Plotly auto-computes (typically ~80).</summary>
    [JsonPropertyName("l")]
    public double? Left { get; init; }

    /// <summary>Right margin in pixels. If null, Plotly auto-computes (typically ~80).</summary>
    [JsonPropertyName("r")]
    public double? Right { get; init; }

    /// <summary>Top margin in pixels. If null, Plotly auto-computes (typically ~100).</summary>
    [JsonPropertyName("t")]
    public double? Top { get; init; }

    /// <summary>Bottom margin in pixels. If null, Plotly auto-computes (typically ~80).</summary>
    [JsonPropertyName("b")]
    public double? Bottom { get; init; }

    /// <summary>Padding between the plot area and the axis lines in pixels. If null, defaults to 0.</summary>
    [JsonPropertyName("pad")]
    public double? Pad { get; init; }

    /// <summary>Whether margins expand automatically to fit tick labels, titles, etc. If null, defaults to true.</summary>
    [JsonPropertyName("autoexpand")]
    public bool? AutoExpand { get; init; }
}

/// <summary>
/// Legend configuration.
/// </summary>
public sealed record PlotlyLegend
{
    /// <summary>Horizontal position as fraction of plot area (0–1). If null, defaults to ~1.02 (just outside right edge).</summary>
    [JsonPropertyName("x")]
    public double? X { get; init; }

    /// <summary>Vertical position as fraction of plot area (0–1). If null, defaults to 1 (top).</summary>
    [JsonPropertyName("y")]
    public double? Y { get; init; }

    /// <summary>Reference for x positioning. If null, defaults to "paper". Use "container" for full-container coordinates.</summary>
    [JsonPropertyName("xref")]
    public string? XRef { get; init; }

    /// <summary>Reference for y positioning. If null, defaults to "paper". Use "container" for full-container coordinates.</summary>
    [JsonPropertyName("yref")]
    public string? YRef { get; init; }

    /// <summary>Horizontal anchor point. If null, defaults to "left". Use "left", "center", or "right".</summary>
    [JsonPropertyName("xanchor")]
    public string? XAnchor { get; init; }

    /// <summary>Vertical anchor point. If null, defaults to "auto". Use "top", "middle", "bottom", or "auto".</summary>
    [JsonPropertyName("yanchor")]
    public string? YAnchor { get; init; }

    /// <summary>Orientation of legend items. If null, defaults to "v" (vertical). Use "v" or "h" (horizontal).</summary>
    [JsonPropertyName("orientation")]
    public string? Orientation { get; init; }

    /// <summary>Font for legend text. If null, inherits from layout font.</summary>
    [JsonPropertyName("font")]
    public PlotlyFont? Font { get; init; }

    /// <summary>Background color of the legend box. If null, inherits from paper background.</summary>
    [JsonPropertyName("bgcolor")]
    public string? BackgroundColor { get; init; }

    /// <summary>Border color of the legend box. If null, defaults to "#444".</summary>
    [JsonPropertyName("bordercolor")]
    public string? BorderColor { get; init; }

    /// <summary>Border width of the legend box in pixels. If null, defaults to 0 (no border).</summary>
    [JsonPropertyName("borderwidth")]
    public double? BorderWidth { get; init; }

    /// <summary>Title configuration for the legend. If null, no legend title is shown.</summary>
    [JsonPropertyName("title")]
    public PlotlyTitle? Title { get; init; }

    /// <summary>Trace display order. If null, defaults to "normal". Use "normal", "reversed", "grouped", or "reversed+grouped".</summary>
    [JsonPropertyName("traceorder")]
    public string? TraceOrder { get; init; }

    /// <summary>Maximum width of each legend item in pixels before text wraps. If null, defaults to 30.</summary>
    [JsonPropertyName("itemwidth")]
    public double? ItemWidth { get; init; }
}

/// <summary>
/// Hover label styling.
/// </summary>
public sealed record PlotlyHoverLabel
{
    /// <summary>Background color of hover labels. If null, uses the trace color.</summary>
    [JsonPropertyName("bgcolor")]
    public string? BackgroundColor { get; init; }

    /// <summary>Border color of hover labels. If null, uses the trace color.</summary>
    [JsonPropertyName("bordercolor")]
    public string? BorderColor { get; init; }

    /// <summary>Font for hover label text. If null, inherits from layout font.</summary>
    [JsonPropertyName("font")]
    public PlotlyFont? Font { get; init; }

    /// <summary>Horizontal alignment of hover label text. If null, defaults to "auto". Use "left", "right", or "auto".</summary>
    [JsonPropertyName("align")]
    public string? Align { get; init; }

    /// <summary>Maximum length of the trace name in hover labels, in characters. If null, defaults to 15. Use -1 to show the full name.</summary>
    [JsonPropertyName("namelength")]
    public int? NameLength { get; init; }
}

/// <summary>
/// Text annotation drawn on a chart.
/// </summary>
public sealed record PlotlyAnnotation
{
    /// <summary>The annotation text. Supports HTML and newlines. Required.</summary>
    [JsonPropertyName("text")]
    public string? Text { get; init; }

    /// <summary>X-coordinate of the annotation (data coordinates, or paper fraction if XRef is "paper").</summary>
    [JsonPropertyName("x")]
    public object? X { get; init; }

    /// <summary>Y-coordinate of the annotation (data coordinates, or paper fraction if YRef is "paper").</summary>
    [JsonPropertyName("y")]
    public object? Y { get; init; }

    /// <summary>Coordinate reference for X. If null, uses the default x-axis. Use "paper" for fractional (0–1), or an axis id like "x", "x2".</summary>
    [JsonPropertyName("xref")]
    public string? XRef { get; init; }

    /// <summary>Coordinate reference for Y. If null, uses the default y-axis. Use "paper" for fractional (0–1), or an axis id like "y", "y2".</summary>
    [JsonPropertyName("yref")]
    public string? YRef { get; init; }

    /// <summary>Whether to show an arrow from the annotation to the point. If null, defaults to true.</summary>
    [JsonPropertyName("showarrow")]
    public bool? ShowArrow { get; init; }

    /// <summary>Color of the arrow. If null, inherits from the annotation font color.</summary>
    [JsonPropertyName("arrowcolor")]
    public string? ArrowColor { get; init; }

    /// <summary>Arrow head style (0–8). If null, defaults to 1.</summary>
    [JsonPropertyName("arrowhead")]
    public int? ArrowHead { get; init; }

    /// <summary>Arrow line width in pixels. If null, defaults to 1.</summary>
    [JsonPropertyName("arrowwidth")]
    public double? ArrowWidth { get; init; }

    /// <summary>X shift of the annotation text from the arrow tip, in pixels. If null, defaults to -10.</summary>
    [JsonPropertyName("ax")]
    public double? ArrowOffsetX { get; init; }

    /// <summary>Y shift of the annotation text from the arrow tip, in pixels. If null, defaults to -30.</summary>
    [JsonPropertyName("ay")]
    public double? ArrowOffsetY { get; init; }

    /// <summary>Font for the annotation text. If null, inherits from layout font.</summary>
    [JsonPropertyName("font")]
    public PlotlyFont? Font { get; init; }

    /// <summary>Horizontal text alignment. If null, defaults to "center". Use "left", "center", or "right".</summary>
    [JsonPropertyName("align")]
    public string? Align { get; init; }

    /// <summary>Background color of the annotation box. If null, transparent (no background).</summary>
    [JsonPropertyName("bgcolor")]
    public string? BackgroundColor { get; init; }

    /// <summary>Border color of the annotation box. If null, transparent (no border shown).</summary>
    [JsonPropertyName("bordercolor")]
    public string? BorderColor { get; init; }

    /// <summary>Border width of the annotation box in pixels. If null, defaults to 1 (visible only if BorderColor is set).</summary>
    [JsonPropertyName("borderwidth")]
    public double? BorderWidth { get; init; }

    /// <summary>Padding (in pixels) between the text and the annotation border. If null, defaults to 1.</summary>
    [JsonPropertyName("borderpad")]
    public double? BorderPad { get; init; }

    /// <summary>Opacity of the annotation (0–1). If null, defaults to 1 (fully opaque).</summary>
    [JsonPropertyName("opacity")]
    public double? Opacity { get; init; }
}

/// <summary>
/// Shape drawn on a chart (line, rectangle, circle, or SVG path).
/// </summary>
public sealed record PlotlyShape
{
    /// <summary>Shape type. Required. Use "line", "rect", "circle", or "path".</summary>
    [JsonPropertyName("type")]
    public string? Type { get; init; }

    /// <summary>X start position (data coordinates, or paper fraction if XRef is "paper"). Required for rect/circle/line.</summary>
    [JsonPropertyName("x0")]
    public object? X0 { get; init; }

    /// <summary>X end position. Required for rect/circle/line.</summary>
    [JsonPropertyName("x1")]
    public object? X1 { get; init; }

    /// <summary>Y start position. Required for rect/circle/line.</summary>
    [JsonPropertyName("y0")]
    public object? Y0 { get; init; }

    /// <summary>Y end position. Required for rect/circle/line.</summary>
    [JsonPropertyName("y1")]
    public object? Y1 { get; init; }

    /// <summary>Coordinate reference for X. If null, uses the default x-axis. Use "paper" for 0–1 fraction, or an axis id like "x".</summary>
    [JsonPropertyName("xref")]
    public string? XRef { get; init; }

    /// <summary>Coordinate reference for Y. If null, uses the default y-axis. Use "paper" for 0–1 fraction, or an axis id like "y".</summary>
    [JsonPropertyName("yref")]
    public string? YRef { get; init; }

    /// <summary>SVG path string for "path" type shapes. If null, X0/X1/Y0/Y1 are used instead.</summary>
    [JsonPropertyName("path")]
    public string? Path { get; init; }

    /// <summary>Line styling for the shape border. If null, uses a 2px solid line in a default color.</summary>
    [JsonPropertyName("line")]
    public PlotlyLine? Line { get; init; }

    /// <summary>Fill color of the shape. If null, transparent for lines, light blue for rect/circle.</summary>
    [JsonPropertyName("fillcolor")]
    public string? FillColor { get; init; }

    /// <summary>Opacity of the shape (0–1). If null, defaults to 1 (fully opaque).</summary>
    [JsonPropertyName("opacity")]
    public double? Opacity { get; init; }

    /// <summary>Whether the shape is drawn below or above traces. If null, defaults to "above". Use "below" or "above".</summary>
    [JsonPropertyName("layer")]
    public string? Layer { get; init; }
}

/// <summary>
/// Grid configuration for subplot layouts.
/// </summary>
public sealed record PlotlyGrid
{
    /// <summary>Number of rows in the grid. Required when using grid layout.</summary>
    [JsonPropertyName("rows")]
    public int? Rows { get; init; }

    /// <summary>Number of columns in the grid. Required when using grid layout.</summary>
    [JsonPropertyName("columns")]
    public int? Columns { get; init; }

    /// <summary>Grid pattern. If null, defaults to "coupled" (subplots share axes). Use "independent" for separate axes.</summary>
    [JsonPropertyName("pattern")]
    public string? Pattern { get; init; }

    /// <summary>Horizontal gap between subplots as a fraction (0–1). If null, defaults to ~0.1.</summary>
    [JsonPropertyName("xgap")]
    public double? XGap { get; init; }

    /// <summary>Vertical gap between subplots as a fraction (0–1). If null, defaults to ~0.1.</summary>
    [JsonPropertyName("ygap")]
    public double? YGap { get; init; }

    /// <summary>Row ordering direction. If null, defaults to "top to bottom". Use "top to bottom" or "bottom to top".</summary>
    [JsonPropertyName("roworder")]
    public string? RowOrder { get; init; }
}

/// <summary>
/// Uniform text configuration to enforce consistent text sizing.
/// </summary>
public sealed record PlotlyUniformText
{
    /// <summary>Minimum text size in pixels. Text smaller than this is hidden or clipped (depending on Mode). If null, no minimum is enforced.</summary>
    [JsonPropertyName("minsize")]
    public double? MinSize { get; init; }

    /// <summary>What to do when text doesn't fit. If null, text is shown clipped. Use "hide" to hide it entirely, or false to show clipped text.</summary>
    [JsonPropertyName("mode")]
    public object? Mode { get; init; }
}

/// <summary>
/// Plotly configuration options.
/// </summary>
public sealed record PlotlyConfig
{
    /// <summary>
    /// Whether the chart should be responsive and resize with its container. Default is true.
    /// </summary>
    [JsonPropertyName("responsive")]
    public bool Responsive { get; init; } = true;

    /// <summary>
    /// Whether to display the mode bar (toolbar with zoom, pan, download buttons). Default is false.
    /// </summary>
    [JsonPropertyName("displayModeBar")]
    public bool DisplayModeBar { get; init; } = false;

    /// <summary>
    /// Whether to display the Plotly logo in the mode bar. Default is false.
    /// </summary>
    [JsonPropertyName("displaylogo")]
    public bool DisplayLogo { get; init; } = false;

    /// <summary>
    /// Whether the chart is static (no mouse interactions like zoom, pan, hover). Default is false.
    /// When true, disables all interactivity for a read-only chart.
    /// </summary>
    [JsonPropertyName("staticPlot")]
    public bool StaticPlot { get; init; } = false;

    /// <summary>
    /// Whether scroll wheel zooming is enabled. Default is false.
    /// </summary>
    [JsonPropertyName("scrollZoom")]
    public bool ScrollZoom { get; init; } = false;

    /// <summary>
    /// Double-click behavior: "reset", "autosize", "reset+autosize", or false to disable.
    /// Default is false (disabled).
    /// </summary>
    [JsonPropertyName("doubleClick")]
    public object DoubleClick { get; init; } = false;

    /// <summary>
    /// Options for the "Download plot as PNG" button. Value should be a JSON-serializable object.
    /// </summary>
    [JsonPropertyName("toImageButtonOptions")]
    public object? ToImageButtonOptions { get; init; }
}
