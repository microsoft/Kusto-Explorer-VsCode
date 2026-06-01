// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using System.Collections.Immutable;
using System.Runtime.Serialization;
using Kusto.Data.Utils;

namespace Kusto.Vscode;

/// <summary>
/// Serializable representation of chart visualization options.
/// </summary>
[DataContract]
public class ChartOptions
{
    /// <summary>
    /// Chart type. Use <see cref="ChartType"/> constants.
    /// </summary>
    [DataMember(Name = "type")]
    public required string Type { get; init; }

    /// <summary>
    /// Chart title text displayed above the chart. If null, no title is shown.
    /// </summary>
    [DataMember(Name = "title")]
    public string? Title { get; init; }

    /// <summary>
    /// X-axis title text. If null, no X-axis title is shown.
    /// </summary>
    [DataMember(Name = "xTitle")]
    public string? XTitle { get; init; }

    /// <summary>
    /// Y-axis title text. If null, no Y-axis title is shown.
    /// </summary>
    [DataMember(Name = "yTitle")]
    public string? YTitle { get; init; }

    /// <summary>
    /// Name of the data column to use for the X-axis. If null, the first column is used.
    /// </summary>
    [DataMember(Name = "xColumn")]
    public string? XColumn { get; init; }

    /// <summary>
    /// Names of the data columns to plot as Y values. If null, all numeric columns except the X column are used.
    /// </summary>
    [DataMember(Name = "yColumns")]
    public ImmutableList<string>? YColumns { get; init; }

    /// <summary>
    /// Column names used to split data into separate series. If null, each Y column becomes its own series.
    /// </summary>
    [DataMember(Name = "seriesColumns")]
    public ImmutableList<string>? SeriesColumns { get; init; }

    /// <summary>
    /// Column names to render as anomaly points on an anomaly chart.
    /// </summary>
    [DataMember(Name = "anomalyColumns")]
    public ImmutableList<string>? AnomalyColumns { get; init; }

    /// <summary>
    /// X-axis scale type. Use <see cref="ChartAxis"/> constants: "Linear", "Log".
    /// If null, defaults to "Linear".
    /// </summary>
    [DataMember(Name = "xAxis")]
    public string? XAxis { get; init; }

    /// <summary>
    /// Y-axis scale type. Use <see cref="ChartAxis"/> constants: "Linear", "Log".
    /// If null, defaults to "Linear".
    /// </summary>
    [DataMember(Name = "yAxis")]
    public string? YAxis { get; init; }

    /// <summary>
    /// Minimum value for the X-axis range. Must be numeric. If null (or if XMax is also null), auto-ranges.
    /// Both XMin and XMax must be set together to take effect.
    /// </summary>
    [DataMember(Name = "xMin")]
    public object? XMin { get; init; }

    /// <summary>
    /// Maximum value for the X-axis range. Must be numeric. If null (or if XMin is also null), auto-ranges.
    /// Both XMin and XMax must be set together to take effect.
    /// </summary>
    [DataMember(Name = "xMax")]
    public object? XMax { get; init; }

    /// <summary>
    /// Minimum value for the Y-axis range. Must be numeric. If null (or if YMax is also null), auto-ranges.
    /// Both YMin and YMax must be set together to take effect.
    /// </summary>
    [DataMember(Name = "yMin")]
    public object? YMin { get; init; }

    /// <summary>
    /// Maximum value for the Y-axis range. Must be numeric. If null (or if YMin is also null), auto-ranges.
    /// Both YMin and YMax must be set together to take effect.
    /// </summary>
    [DataMember(Name = "yMax")]
    public object? YMax { get; init; }

    /// <summary>
    /// Y-column layout mode. Use <see cref="ChartYLayout"/> constants.
    /// "SharedAxis" plots all Y columns on a single shared axis.
    /// "DualAxis" adds an independent right-side axis for additional Y columns.
    /// "SeparatePanels" renders each Y column as a separate chart panel.
    /// "SeparateCharts" renders each Y column as a separate chart.
    /// If null, defaults to "SharedAxis".
    /// </summary>
    [DataMember(Name = "yLayout")]
    public string? YLayout { get; init; }

    /// <summary>
    /// Whether to mirror the Y-axis line and tick marks on the right side of the chart.
    /// If null or false, the mirrored axis line and ticks are not shown.
    /// </summary>
    [DataMember(Name = "yMirror")]
    public bool? YMirror { get; init; }

    /// <summary>
    /// Whether to accumulate Y values across the X-axis (running total). Defaults to false.
    /// </summary>
    [DataMember(Name = "accumulate")]
    public bool Accumulate { get; init; }

    /// <summary>
    /// Z-axis title text for 3D charts. If null, the Z column name is used.
    /// Only applies to 3D chart types.
    /// </summary>
    [DataMember(Name = "zTitle")]
    public string? ZTitle { get; init; }

    /// <summary>
    /// Whether tick marks are visible on the X-axis. If null, ticks are hidden by default.
    /// </summary>
    [DataMember(Name = "xShowTicks")]
    public bool? XShowTicks { get; init; }

    /// <summary>
    /// Whether tick marks are visible on the Y-axis. If null, ticks are hidden by default.
    /// </summary>
    [DataMember(Name = "yShowTicks")]
    public bool? YShowTicks { get; init; }

    /// <summary>
    /// Whether grid lines are visible on the X-axis. If null, grid lines are shown by default.
    /// </summary>
    [DataMember(Name = "xShowGrid")]
    public bool? XShowGrid { get; init; }

    /// <summary>
    /// Whether grid lines are visible on the Y-axis. If null, grid lines are shown by default.
    /// </summary>
    [DataMember(Name = "yShowGrid")]
    public bool? YShowGrid { get; init; }

    /// <summary>
    /// Rotation angle for tick labels on the X-axis, in degrees (e.g., -45, 90).
    /// If null, labels auto-rotate to avoid overlap.
    /// </summary>
    [DataMember(Name = "xTickAngle")]
    public double? XTickAngle { get; init; }

    /// <summary>
    /// Rotation angle for tick labels on the Y-axis, in degrees (e.g., -45, 90).
    /// If null, labels auto-rotate to avoid overlap.
    /// </summary>
    [DataMember(Name = "yTickAngle")]
    public double? YTickAngle { get; init; }

    /// <summary>
    /// Whether data value labels are shown. If null, labels are hidden.
    /// When true, bar charts show values on bars and pie charts show label+value+percent.
    /// </summary>
    [DataMember(Name = "showValues")]
    public bool? ShowValues { get; init; }

    /// <summary>
    /// Category sort order on the X-axis. Use <see cref="ChartSortOrder"/> constants: "Auto", "Ascending", "Descending".
    /// "Auto" and null preserve the axis's natural/data order.
    /// "Ascending" and "Descending" sort categories by total value.
    /// </summary>
    [DataMember(Name = "sort")]
    public string? Sort { get; init; }

    /// <summary>
    /// Legend position. Use <see cref="ChartLegendPosition"/> constants: "Auto", "Right", "Bottom", "None".
    /// "Auto" chooses a layout-aware legend position.
    /// "None" hides the legend.
    /// If null, older saved options behave like "Auto".
    /// </summary>
    [DataMember(Name = "legendPosition")]
    public string? LegendPosition { get; init; }

    /// <summary>
    /// Color mode override. Use <see cref="ChartMode"/> constants: "Auto", "Light", "Dark".
    /// "Auto" uses the darkMode parameter (which reflects the editor theme).
    /// "Light" or "Dark" overrides the darkMode parameter.
    /// If null, older saved options behave like "Auto".
    /// </summary>
    [DataMember(Name = "mode")]
    public string? Mode { get; init; }

    /// <summary>
    /// Aspect ratio for the chart display area. Use <see cref="ChartAspectRatio"/> constants: "Fill", "16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16".
    /// If null, the chart falls back to the configured default aspect ratio or the product default.
    /// </summary>
    [DataMember(Name = "aspectRatio")]
    public string? AspectRatio { get; init; }

    /// <summary>
    /// Text size preset for chart titles and axis labels. Use <see cref="ChartTextSize"/> constants.
    /// "Auto" scales dynamically based on chart dimensions.
    /// If null, older saved options behave like "Auto".
    /// </summary>
    [DataMember(Name = "textSize")]
    public string? TextSize { get; init; }

    /// <summary>
    /// Marker shape for scatter points. Use chart marker shape values such as "Circle" and "TriangleUp".
    /// If null, defaults to the configured marker shape or the product default.
    /// </summary>
    [DataMember(Name = "markerShape")]
    public string? MarkerShape { get; init; }

    /// <summary>
    /// Whether to cycle through different marker shapes for each trace.
    /// When true, each trace uses a different shape starting from <see cref="MarkerShape"/>.
    /// When false or null, all traces use the same shape.
    /// </summary>
    [DataMember(Name = "cycleMarkerShapes")]
    public bool? CycleMarkerShapes { get; init; }

    /// <summary>
    /// Marker size preset. Use "Extra Small", "Small", "Medium", "Large", "Extra Large".
    /// If null, defaults to the configured marker size or the product default.
    /// </summary>
    [DataMember(Name = "markerSize")]
    public string? MarkerSize { get; init; }

    /// <summary>
    /// Name of the sibling result table to use as the nodes table for graph charts.
    /// If null, the provider auto-detects (prefers a table named "nodes", else the single non-empty other table).
    /// </summary>
    [DataMember(Name = "nodesTable")]
    public string? NodesTable { get; init; }

    /// <summary>
    /// Name of the column on the nodes table that contains the node id. If null, auto-detected by name (id, name, ...).
    /// </summary>
    [DataMember(Name = "nodeIdColumn")]
    public string? NodeIdColumn { get; init; }

    /// <summary>
    /// Name of the column on the nodes table to use as the node label. If null, auto-detected by name.
    /// </summary>
    [DataMember(Name = "nodeLabelColumn")]
    public string? NodeLabelColumn { get; init; }

    /// <summary>
    /// Name of the column on the nodes table to use as the node kind (drives per-kind coloring). If null, auto-detected by name.
    /// </summary>
    [DataMember(Name = "nodeKindColumn")]
    public string? NodeKindColumn { get; init; }

    /// <summary>
    /// Name of the column on the edges table to use as the edge kind. If null, falls back to the first <see cref="SeriesColumns"/> entry.
    /// </summary>
    [DataMember(Name = "edgeKindColumn")]
    public string? EdgeKindColumn { get; init; }

    /// <summary>
    /// Converts a <see cref="ChartVisualizationOptions"/> from the Kusto SDK to a <see cref="ChartOptions"/>.
    /// </summary>
    public static ChartOptions FromChartVisualizationOptions(ChartVisualizationOptions options)
    {
        return new ChartOptions
        {
            Type = VisualizationToChartType(options.Visualization, options.Mode),
            Title = options.Title,
            XTitle = options.XTitle,
            YTitle = options.YTitle,
            XColumn = options.XColumn,
            YColumns = options.YColumns?.ToImmutableList(),
            SeriesColumns = options.Series?.ToImmutableList(),
            LegendPosition = options.Legend.ToString() == "Hidden" ? ChartLegendPosition.None : null,
            XAxis = options.XAxis.ToString(),
            YAxis = options.YAxis.ToString(),
            XMin = ConvertNanToNull(options.Xmin),
            XMax = ConvertNanToNull(options.Xmax),
            YMin = ConvertNanToNull(options.Ymin),
            YMax = ConvertNanToNull(options.Ymax),
            Accumulate = options.Accumulate,
            AnomalyColumns = options.AnomalyColumns?.ToImmutableList(),
            YLayout = SplitVisualizationModeToYLayout(options.YSplit),
        };
    }

    /// <summary>
    /// Returns a new <see cref="ChartOptions"/> with null properties filled in from the specified defaults.
    /// </summary>
    public ChartOptions WithDefaults(ChartOptions defaults)
    {
        return new ChartOptions
        {
            Type = this.Type,
            Title = this.Title,
            XTitle = this.XTitle,
            YTitle = this.YTitle,
            XColumn = this.XColumn,
            YColumns = this.YColumns,
            SeriesColumns = this.SeriesColumns,
            YLayout = this.YLayout ?? defaults.YLayout,
            YMirror = this.YMirror ?? defaults.YMirror,
            XAxis = this.XAxis,
            YAxis = this.YAxis,
            XMin = this.XMin,
            XMax = this.XMax,
            YMin = this.YMin,
            YMax = this.YMax,
            Accumulate = this.Accumulate,
            ZTitle = this.ZTitle,
            XShowTicks = this.XShowTicks ?? defaults.XShowTicks,
            YShowTicks = this.YShowTicks ?? defaults.YShowTicks,
            XShowGrid = this.XShowGrid ?? defaults.XShowGrid,
            YShowGrid = this.YShowGrid ?? defaults.YShowGrid,
            XTickAngle = this.XTickAngle,
            YTickAngle = this.YTickAngle,
            ShowValues = this.ShowValues ?? defaults.ShowValues,
            Sort = this.Sort is "Default" or ChartSortOrder.Auto ? null : this.Sort,
            LegendPosition = NormalizeLegendPosition(this.LegendPosition) ?? defaults.LegendPosition,
            Mode = this.Mode,
            AspectRatio = this.AspectRatio ?? defaults.AspectRatio,
            TextSize = this.TextSize ?? defaults.TextSize,
            MarkerShape = this.MarkerShape ?? defaults.MarkerShape,
            CycleMarkerShapes = this.CycleMarkerShapes ?? defaults.CycleMarkerShapes,
            MarkerSize = this.MarkerSize ?? defaults.MarkerSize,
            NodesTable = this.NodesTable ?? defaults.NodesTable,
            NodeIdColumn = this.NodeIdColumn ?? defaults.NodeIdColumn,
            NodeLabelColumn = this.NodeLabelColumn ?? defaults.NodeLabelColumn,
            NodeKindColumn = this.NodeKindColumn ?? defaults.NodeKindColumn,
            EdgeKindColumn = this.EdgeKindColumn ?? defaults.EdgeKindColumn,
        };
    }

    private static string? NormalizeLegendPosition(string? legendPosition)
    {
        return legendPosition switch
        {
            "Hidden" => ChartLegendPosition.None,
            _ => legendPosition,
        };
    }

    private static string? SplitVisualizationModeToYLayout(SplitVisualizationMode mode)
    {
        return mode switch
        {
            SplitVisualizationMode.None => null,
            SplitVisualizationMode.Axes => ChartYLayout.DualAxis,
            SplitVisualizationMode.Panels => ChartYLayout.SeparatePanels,
            _ => null,
        };
    }

    private static object? ConvertNanToNull(object? value)
    {
        return value switch
        {
            double d when double.IsNaN(d) => null,
            double d when double.IsPositiveInfinity(d) => double.MaxValue,
            double d when double.IsNegativeInfinity(d) => double.MinValue,
            float f when float.IsNaN(f) => null,
            float f when float.IsPositiveInfinity(f) => float.MaxValue,
            float f when float.IsNegativeInfinity(f) => float.MinValue,
            _ => value
        };
    }

    private static string VisualizationToChartType(VisualizationKind visualization, object mode)
    {
        var modeStr = mode?.ToString();

        return visualization switch
        {
            VisualizationKind.AreaChart => modeStr switch
            {
                "Stacked" => ChartType.AreaStacked,
                "Stacked100" => ChartType.AreaStacked100,
                _ => ChartType.Area,
            },
            VisualizationKind.BarChart => modeStr switch
            {
                "Stacked" => ChartType.BarStacked,
                "Stacked100" => ChartType.BarStacked100,
                _ => ChartType.Bar,
            },
            VisualizationKind.Card => ChartType.Card,
            VisualizationKind.ColumnChart => modeStr switch
            {
                "Stacked" => ChartType.ColumnStacked,
                "Stacked100" => ChartType.ColumnStacked100,
                _ => ChartType.Column,
            },
            VisualizationKind.Graph => ChartType.Graph,
            VisualizationKind.LineChart => ChartType.Line,
            VisualizationKind.PieChart => ChartType.Pie,
            VisualizationKind.PivotChart => ChartType.Line,
            VisualizationKind.Plotly => ChartType.Plotly,
            VisualizationKind.Sankey => ChartType.Sankey,
            VisualizationKind.ScatterChart => ChartType.Scatter,
            VisualizationKind.StackedAreaChart => ChartType.AreaStacked,
            VisualizationKind.ThreeDChart => ChartType.ThreeD,
            VisualizationKind.TimeLadderChart => ChartType.Ladder,
            VisualizationKind.TimeLineChart => ChartType.TimeLine,
            VisualizationKind.TimeLineWithAnomalyChart => ChartType.TimeLineAnomaly,
            VisualizationKind.TimePivot => ChartType.TimePivot,
            VisualizationKind.TreeMap => ChartType.TreeMap,
            _ => ChartType.None,
        };
    }
}
