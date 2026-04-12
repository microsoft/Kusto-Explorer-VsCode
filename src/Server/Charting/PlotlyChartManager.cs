// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using System.Data;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Kusto.Vscode;

/// <summary>
/// Plotly-based implementation of IChartManager using immutable PlotlyChartBuilder.
/// </summary>
public class PlotlyChartManager : IChartManager
{
    /// <summary>
    /// Renders chart as HTML using Plotly.js.
    /// </summary>
    public string? RenderChartToHtmlDiv(DataTable data, ChartOptions options, bool darkMode = false)
    {
        // Handle raw Plotly JSON charts specially - they bypass the builder
        if (options.Type == ChartType.Plotly)
        {
            return RenderRawPlotlyChart(data, darkMode);
        }

        var builder = BuildChart(data, options, darkMode);
        return builder != null ? builder.ToHtmlDiv() : null;
    }

    public string? RenderChartToHtmlDocument(DataTable data, ChartOptions options, bool darkMode = false)
    {
        var chartDiv = RenderChartToHtmlDiv(data, options, darkMode);
        return chartDiv != null ? PlotlyHtmlHelper.CreateHtmlDocument(chartDiv, darkMode) : null;
    }

    /// <summary>
    /// Renders a raw Plotly chart where the data contains pre-built Plotly JSON.
    /// The expected format is a single column with a single row containing a JSON string
    /// with "data", "layout", and optionally "config" properties.
    /// </summary>
    private string? RenderRawPlotlyChart(DataTable data, bool darkMode = false, string divId = "plotly-chart")
    {
        // Expect single column, single row with JSON string
        if (data.Columns.Count == 0 || data.Rows.Count == 0)
            return null;

        var cellValue = data.Rows[0][0];
        if (cellValue == null || cellValue == DBNull.Value)
            return null;

        var jsonString = cellValue.ToString();
        if (string.IsNullOrWhiteSpace(jsonString))
            return null;

        // Validate it's valid JSON and has expected structure
        try
        {
            using var doc = JsonDocument.Parse(jsonString);
            var root = doc.RootElement;

            // Must have "data" property at minimum
            if (!root.TryGetProperty("data", out _))
                return null;

            // Extract components, using defaults if not present
            var dataJson = root.GetProperty("data").GetRawText();
            
            string layoutJson = "{}";
            if (root.TryGetProperty("layout", out var layoutElement))
            {
                layoutJson = layoutElement.GetRawText();
            }

            // Apply dark mode styling if requested
            if (darkMode)
            {
                layoutJson = ApplyDarkModeToLayout(layoutJson);
            }

            string configJson = """{"responsive": true, "displayModeBar": false}""";
            if (root.TryGetProperty("config", out var configElement))
            {
                configJson = configElement.GetRawText();
            }

            return PlotlyHtmlHelper.CreateChartDiv(dataJson, layoutJson, configJson, divId);
        }
        catch (JsonException)
        {
            // Invalid JSON
            return null;
        }
    }

    /// <summary>
    /// Applies dark mode styling to a Plotly layout JSON string by overriding
    /// background colors, font colors, and axis colors.
    /// </summary>
    private static string ApplyDarkModeToLayout(string layoutJson)
    {
        var layout = JsonNode.Parse(layoutJson)?.AsObject() ?? new JsonObject();

        // Override background colors
        layout["paper_bgcolor"] = "#1e1e1e";
        layout["plot_bgcolor"] = "#1e1e1e";

        // Override font color
        var font = layout["font"]?.AsObject() ?? new JsonObject();
        font["color"] = "#f2f5fa";
        layout["font"] = font;

        // Apply dark mode to xaxis
        ApplyDarkModeToAxis(layout, "xaxis");
        
        // Apply dark mode to yaxis
        ApplyDarkModeToAxis(layout, "yaxis");

        // Apply dark mode to additional axes (xaxis2, yaxis2, etc.)
        foreach (var key in layout.ToArray().Select(kvp => kvp.Key))
        {
            if ((key.StartsWith("xaxis") || key.StartsWith("yaxis")) && key != "xaxis" && key != "yaxis")
            {
                ApplyDarkModeToAxis(layout, key);
            }
        }

        // Apply dark mode to 3D scene axes if present
        if (layout["scene"] is JsonObject scene)
        {
            ApplyDarkModeToAxis(scene, "xaxis");
            ApplyDarkModeToAxis(scene, "yaxis");
            ApplyDarkModeToAxis(scene, "zaxis");
        }

        return layout.ToJsonString();
    }

    /// <summary>
    /// Applies dark mode colors to a specific axis within a layout or scene object.
    /// </summary>
    private static void ApplyDarkModeToAxis(JsonObject parent, string axisKey)
    {
        var axis = parent[axisKey]?.AsObject() ?? new JsonObject();
        axis["color"] = "#f2f5fa";
        axis["gridcolor"] = "#444444";
        axis["linecolor"] = "#666666";
        axis["zerolinecolor"] = "#666666";
        parent[axisKey] = axis;
    }

    private PlotlyChartBuilder? BuildChart(DataTable data, ChartOptions options, bool darkMode)
    {
        var builder = options.Type switch
        {
            ChartType.BarChart or ChartType.ColumnChart => BuildBarOrColumnChart(data, options),
            ChartType.LineChart => BuildLineChart(data, options),
            ChartType.ScatterChart => BuildScatterChart(data, options),
            ChartType.PieChart => BuildPieChart(data, options),
            ChartType.AreaChart => options.Kind is ChartKind.Stacked or ChartKind.Stacked100
                ? BuildStackedAreaChart(data, options)
                : BuildAreaChart(data, options),
            ChartType.StackedAreaChart => BuildStackedAreaChart(data, options),
            ChartType.Card => BuildCardChart(data, options),
            ChartType.ThreeDChart => BuildThreeDChart(data, options),
            ChartType.TreeMap => BuildTreeMapChart(data, options),
            ChartType.Sankey => BuildSankeyChart(data, options),
            // Plotly is handled specially in RenderChartToHtmlDiv before reaching here
            ChartType.TimeLineChart => BuildTimeLineChart(data, options),
            // The following visualization types are not yet supported
            ChartType.Graph => null,
            ChartType.PivotChart => null,
            ChartType.TimeLadderChart => null,
            ChartType.TimeLineWithAnomalyChart => null,
            ChartType.TimePivot => null,
            _ => null
        };

        if (builder != null)
        {
            // Apply dark mode styling if requested
            if (darkMode)
            {
                builder = builder.WithDarkMode();
            }

            // Disable zoom/pan on 2D charts but keep hover tooltips - 3D charts need full interaction for rotation
            if (options.Type != ChartType.ThreeDChart)
            {
                builder = builder.WithFixedRange();
            }
        }

        return builder;
    }

    private PlotlyChartBuilder? BuildBarOrColumnChart(DataTable data, ChartOptions options)
    {
        var builder = new PlotlyChartBuilder();
        bool isHorizontal = options.Type == ChartType.BarChart;

        builder = options.Kind switch
        {
            ChartKind.Stacked => builder.SetStacked(),
            ChartKind.Stacked100 => builder.SetStacked(),  // Use regular stack mode with normalized data
            ChartKind.Unstacked => builder.SetGrouped(),
            _ => builder
        };

        // For Stacked100, we need to normalize the data ourselves
        if (options.Kind == ChartKind.Stacked100)
        {
            return BuildStacked100BarOrColumnChart(builder, data, options, isHorizontal);
        }
        else
        {
            bool showValues = options.ShowValues == ChartVisibility.Visible;
            return Build2dChart(builder, data, options,
                (builder, keys, values, name, yAxis) =>
                    builder.Add2DBarTrace(
                        x: keys,
                        y: values,
                        name: name,
                        horizontal: isHorizontal,
                        yAxis: yAxis,
                        offsetGroup: null,
                        text: showValues ? values.Cast<object>().ToArray() : null,
                        textPosition: showValues ? "auto" : null
                    )
                );
        }
    }

    private PlotlyChartBuilder? BuildStacked100BarOrColumnChart(PlotlyChartBuilder builder, DataTable data, ChartOptions options, bool isHorizontal)
    {
        var xColumn = Get2dXColumn(data, options);
        if (xColumn == null)
            return null;

        var yColumns = Get2dYColumns(data, options, xColumn);

        // Collect all series data first
        var seriesData = new List<(object[] keys, double[] values, string name)>();
        
        foreach (var valueColumn in yColumns)
        {
            var (keys, values) = Get2DChartData(xColumn, valueColumn);
            if (keys != null && values != null)
            {
                seriesData.Add((keys, values, valueColumn.ColumnName));
            }
        }

        if (seriesData.Count == 0)
            return null;

        // Calculate totals for each X position (use first series' keys as reference)
        var referenceKeys = seriesData[0].keys;
        var totals = new double[referenceKeys.Length];

        foreach (var (keys, values, _) in seriesData)
        {
            for (int i = 0; i < Math.Min(values.Length, totals.Length); i++)
            {
                totals[i] += Math.Abs(values[i]);  // Use absolute values for proper normalization
            }
        }

        // Configure chart based on visualization options
        if (options.Title != null)
            builder = builder.WithTitle(options.Title);

        if (options.XTitle != null)
            builder = builder.SetXAxisTitle(options.XTitle);

        if (options.YTitle != null)
            builder = builder.SetYAxisTitle(options.YTitle);

        if (options.Legend == ChartLegendMode.Hidden)
            builder = builder.HideLegend();

        // Set Y-axis range to 0-1 for percentage display
        builder = builder.SetYAxisRange(0, 1);

        // Add traces with normalized values
        bool showValues = options.ShowValues == ChartVisibility.Visible;
        foreach (var (keys, values, name) in seriesData)
        {
            var normalizedValues = new double[values.Length];
            for (int i = 0; i < values.Length; i++)
            {
                normalizedValues[i] = totals[i] > 0 ? values[i] / totals[i] : 0;
            }

            builder = builder.Add2DBarTrace(
                x: keys,
                y: normalizedValues,
                name: name,
                horizontal: isHorizontal,
                yAxis: null,
                offsetGroup: null,
                text: showValues ? normalizedValues.Cast<object>().ToArray() : null,
                textPosition: showValues ? "auto" : null
            );
        }

        return builder;
    }

    private PlotlyChartBuilder? BuildLineChart(DataTable data, ChartOptions options)
    {
        var builder = new PlotlyChartBuilder();
        return Build2dChart(builder, data, options, 
            (builder, x, y, name, yAxis) => builder.Add2DLineTrace(x, y, name, yAxis: yAxis)
            );
    }

    private PlotlyChartBuilder? BuildScatterChart(DataTable data, ChartOptions options)
    {
        var builder = new PlotlyChartBuilder();
        return Build2dChart(builder, data, options, 
            (builder, x, y, name, yAxis) => builder.Add2DScatterTrace(x, y, name, yAxis: yAxis)
            );
    }

    private PlotlyChartBuilder? BuildTimeLineChart(DataTable data, ChartOptions options)
    {
        if (data.Rows.Count == 0 || data.Columns.Count == 0)
            return null;

        // Find the datetime column for X axis
        var xColumn = options.XColumn != null
            ? data.Columns[options.XColumn]
            : data.Columns.OfType<DataColumn>().FirstOrDefault(c =>
                c.DataType == typeof(DateTime) || c.DataType == typeof(DateTimeOffset));

        if (xColumn == null)
            return null;

        // Find numeric columns for Y values
        var yColumns = options.YColumns != null
            ? options.YColumns.Select(name => data.Columns[name]).OfType<DataColumn>().ToArray()
            : data.Columns.OfType<DataColumn>().Where(c => c != xColumn && IsNumeric(c.DataType)).ToArray();

        if (yColumns.Length == 0)
            return null;

        // Find series columns (string columns that are not X or Y)
        var seriesColumns = options.Series != null
            ? options.Series.Select(name => data.Columns[name]).OfType<DataColumn>().ToArray()
            : data.Columns.OfType<DataColumn>()
                .Where(c => c != xColumn && !yColumns.Contains(c) && !IsNumeric(c.DataType))
                .ToArray();

        var builder = new PlotlyChartBuilder();

        if (options.Title != null)
            builder = builder.WithTitle(options.Title);
        if (options.XTitle != null)
            builder = builder.SetXAxisTitle(options.XTitle);
        if (options.YTitle != null)
            builder = builder.SetYAxisTitle(options.YTitle);
        if (options.Legend == ChartLegendMode.Hidden)
            builder = builder.HideLegend();

        builder = ApplyCommonOptions(builder, options);

        double globalYMax = double.MinValue;
        double globalYMin = double.MaxValue;

        if (seriesColumns.Length > 0)
        {
            // Pivot: group rows by series column values, creating one trace per group
            var groups = new Dictionary<string, List<DataRow>>();
            foreach (DataRow row in data.Rows)
            {
                var seriesKey = string.Join(" / ",
                    seriesColumns.Select(c => row[c]?.ToString() ?? ""));
                if (!groups.TryGetValue(seriesKey, out var list))
                {
                    list = new List<DataRow>();
                    groups[seriesKey] = list;
                }
                list.Add(row);
            }

            foreach (var (seriesName, rows) in groups)
            {
                // Sort rows by datetime in ascending order
                var sortedRows = rows.OrderBy(r => r[xColumn]).ToList();

                foreach (var yCol in yColumns)
                {
                    var xValues = new List<object>();
                    var yValues = new List<double>();
                    foreach (var row in sortedRows)
                    {
                        var xVal = row[xColumn];
                        var yVal = row[yCol];
                        if (xVal != null && xVal != DBNull.Value
                            && yVal != null && yVal != DBNull.Value)
                        {
                            xValues.Add(xVal);
                            var yNum = SanitizeDoubleValue(Convert.ToDouble(yVal));
                            yValues.Add(yNum);
                            if (yNum > globalYMax) globalYMax = yNum;
                            if (yNum < globalYMin) globalYMin = yNum;
                        }
                    }
                    if (xValues.Count > 0)
                    {
                        var traceName = yColumns.Length > 1
                            ? $"{seriesName} - {yCol.ColumnName}"
                            : seriesName;
                        builder = builder.Add2DLineTrace(
                            xValues.ToArray(), yValues.ToArray(), traceName);
                    }
                }
            }
        }
        else
        {
            // No series columns: one trace per Y column (simple wide-format data)
            // Sort the data table by datetime ascending
            var sortedRows = data.Rows.OfType<DataRow>().OrderBy(r => r[xColumn]).ToList();

            foreach (var yCol in yColumns)
            {
                var xValues = new List<object>();
                var yValues = new List<double>();
                foreach (var row in sortedRows)
                {
                    var xVal = row[xColumn];
                    var yVal = row[yCol];
                    if (xVal != null && xVal != DBNull.Value
                        && yVal != null && yVal != DBNull.Value && IsNumeric(yVal.GetType()))
                    {
                        xValues.Add(xVal);
                        var yNum = SanitizeDoubleValue(Convert.ToDouble(yVal));
                        yValues.Add(yNum);
                        if (yNum > globalYMax) globalYMax = yNum;
                        if (yNum < globalYMin) globalYMin = yNum;
                    }
                }
                if (xValues.Count > 0)
                {
                    builder = builder.Add2DLineTrace(xValues.ToArray(), yValues.ToArray(), yCol.ColumnName);
                }
            }
        }

        // Force x-axis to date type for proper time-series formatting
        var xAxis = builder.Layout.XAxis ?? new PlotlyAxis();
        builder = builder.WithXAxis(xAxis with { Type = PlotlyAxisTypes.Date });

        // Add Y-axis headroom: extend range above max value (5% padding)
        if (globalYMax > double.MinValue && globalYMin < double.MaxValue)
        {
            var yRange = globalYMax - globalYMin;
            var padding = yRange > 0 ? yRange * 0.05 : Math.Abs(globalYMax) * 0.05;
            var yAxisMin = Math.Min(0, globalYMin);
            var yAxisMax = globalYMax + padding;
            var yAxis = builder.Layout.YAxis ?? new PlotlyAxis();
            builder = builder.WithYAxis(yAxis with { Range = new object[] { yAxisMin, yAxisMax }, AutoRange = false });
        }

        return builder;
    }

    private PlotlyChartBuilder? BuildPieChart(DataTable data, ChartOptions options)
    {
        var builder = new PlotlyChartBuilder();

        // Configure chart title
        if (options.Title != null)
            builder = builder.WithTitle(options.Title);

        if (options.Legend == ChartLegendMode.Hidden)
            builder = builder.HideLegend();

        // Apply new chart options
        builder = ApplyCommonOptions(builder, options);

        // Get label and value columns
        var labelColumn = this.Get2dXColumn(data, options);
        if (labelColumn == null)
            return null;

        var valueColumns = this.Get2dYColumns(data, options, labelColumn);
        
        // For pie charts, we typically use only the first value column
        // Multiple value columns would create multiple pie charts
        string? textInfo = options.ShowValues == ChartVisibility.Visible ? "label+value+percent" : null;

        foreach (var valueColumn in valueColumns)
        {
            var (labels, values) = this.Get2DChartData(labelColumn, valueColumn);

            if (labels != null && values != null)
            {
                builder = builder.AddPieTrace(
                    labels: labels,
                    values: values,
                    name: valueColumn.ColumnName,
                    hole: 0.0,  // Can be made configurable via options if needed
                    textInfo: textInfo
                );
            }
        }

        return builder;
    }

    private PlotlyChartBuilder? BuildAreaChart(DataTable data, ChartOptions options)
    {
        var builder = new PlotlyChartBuilder();
        return Build2dChart(builder, data, options, 
            (builder, x, y, name, yAxis) => builder.AddAreaChart(x, y, name, stackGroup: null, yAxis: yAxis)
        );
    }

    private PlotlyChartBuilder? BuildStackedAreaChart(DataTable data, ChartOptions options)
    {
        var builder = new PlotlyChartBuilder();
        string? groupNorm = options.Kind == ChartKind.Stacked100 ? "percent" : null;
        return Build2dChart(builder, data, options, 
            (builder, x, y, name, yAxis) => builder.AddAreaChart(x, y, name, stackGroup: "1", yAxis: yAxis, groupNorm: groupNorm)
        );
    }

    private PlotlyChartBuilder? BuildCardChart(DataTable data, ChartOptions options)
    {
        var builder = new PlotlyChartBuilder();

        // Card charts expect a single aggregated value
        // Get the first numeric column's first row value
        if (data.Rows.Count == 0 || data.Columns.Count == 0)
            return null;

        // Try to find a numeric column
        DataColumn? valueColumn = null;
        foreach (DataColumn col in data.Columns)
        {
            if (IsNumeric(col.DataType))
            {
                valueColumn = col;
                break;
            }
        }

        if (valueColumn == null)
            return null;

        var firstRow = data.Rows[0];
        var cellValue = firstRow[valueColumn];

        if (cellValue == null || cellValue == DBNull.Value)
            return null;

        double value = Convert.ToDouble(cellValue);

        // Sanitize infinity values
        value = SanitizeDoubleValue(value);

        // Determine title - use the column name or the provided title
        string? title = options.Title ?? valueColumn.ColumnName;

        builder = builder.AddIndicatorTrace(
            value: value,
            title: title,
            mode: PlotlyIndicatorModes.Number
        );

        return builder;
    }

    private PlotlyChartBuilder? BuildThreeDChart(DataTable data, ChartOptions options)
    {
        var builder = new PlotlyChartBuilder();

        // 3D charts expect 3 columns: X, Y, Z
        if (data.Columns.Count < 3 || data.Rows.Count == 0)
            return null;

        // Get the three columns
        var xColumn = data.Columns[0];
        var yColumn = data.Columns[1];
        var zColumn = data.Columns[2];

        // Z must be numeric
        if (!IsNumeric(zColumn.DataType))
            return null;

        // Extract data from rows
        var rows = data.Rows.OfType<DataRow>().ToList();

        // Get unique X and Y values (sorted)
        var xValues = rows
            .Select(r => r[xColumn])
            .Where(v => v != null && v != DBNull.Value)
            .Distinct()
            .OrderBy(v => v)
            .ToArray();

        var yValues = rows
            .Select(r => r[yColumn])
            .Where(v => v != null && v != DBNull.Value)
            .Distinct()
            .OrderBy(v => v)
            .ToArray();

        if (xValues.Length == 0 || yValues.Length == 0)
            return null;

        // Create a lookup dictionary for quick access: (x, y) -> z
        var dataLookup = new Dictionary<(object x, object y), double>();
        
        foreach (var row in rows)
        {
            var x = row[xColumn];
            var y = row[yColumn];
            var z = row[zColumn];

            if (x != null && x != DBNull.Value &&
                y != null && y != DBNull.Value &&
                z != null && z != DBNull.Value)
            {
                var zValue = SanitizeDoubleValue(Convert.ToDouble(z));
                dataLookup[(x, y)] = zValue;
            }
        }

        // Build the 2D Z array in the format Z[yIndex][xIndex]
        var zGrid = new object[yValues.Length][];
        
        for (int i = 0; i < yValues.Length; i++)
        {
            zGrid[i] = new object[xValues.Length];
            
            for (int j = 0; j < xValues.Length; j++)
            {
                // Try to get the value from the lookup
                if (dataLookup.TryGetValue((xValues[j], yValues[i]), out var zValue))
                {
                    zGrid[i][j] = zValue;
                }
                else
                {
                    // If no data point exists for this (x, y), use null or 0
                    zGrid[i][j] = 0.0;
                }
            }
        }

        // Configure title
        if (options.Title != null)
            builder = builder.WithTitle(options.Title);

        // Add the surface trace
        builder = builder.Add3DSurfaceTrace(
            z: zGrid,
            x: xValues,
            y: yValues,
            name: zColumn.ColumnName
        );

        // Configure scene axes if titles are provided
        var scene = new PlotlyScene();
        bool hasSceneConfig = false;

        if (options.XTitle != null)
        {
            scene = scene with { XAxis = new PlotlyAxis { Title = new PlotlyTitle { Text = options.XTitle } } };
            hasSceneConfig = true;
        }

        if (options.YTitle != null)
        {
            scene = scene with { YAxis = new PlotlyAxis { Title = new PlotlyTitle { Text = options.YTitle } } };
            hasSceneConfig = true;
        }

        // For 3D charts, we could use a "ZTitle" if it existed in options
        // For now, use the column name for Z axis
        scene = scene with { ZAxis = new PlotlyAxis { Title = new PlotlyTitle { Text = options.ZTitle ?? zColumn.ColumnName } } };
        hasSceneConfig = true;

        if (hasSceneConfig)
        {
            builder = builder.WithScene(scene);
        }

        if (options.Legend == ChartLegendMode.Hidden)
            builder = builder.HideLegend();

        // Apply new chart options
        builder = ApplyCommonOptions(builder, options);

        return builder;
    }

    private PlotlyChartBuilder? BuildTreeMapChart(DataTable data, ChartOptions options)
    {
        var builder = new PlotlyChartBuilder();

        // TreeMap expects hierarchical data with at least 2 columns:
        // - One or more hierarchy columns (categories)
        // - One value column (numeric, for sizing)
        if (data.Columns.Count < 2 || data.Rows.Count == 0)
            return null;

        // Find the value column (last numeric column)
        DataColumn? valueColumn = null;
        var hierarchyColumns = new List<DataColumn>();

        foreach (DataColumn col in data.Columns)
        {
            if (IsNumeric(col.DataType))
            {
                valueColumn = col;
            }
            else
            {
                hierarchyColumns.Add(col);
            }
        }

        // If no non-numeric columns found, use all but the last column as hierarchy
        if (hierarchyColumns.Count == 0)
        {
            for (int i = 0; i < data.Columns.Count - 1; i++)
            {
                hierarchyColumns.Add(data.Columns[i]);
            }
            valueColumn = data.Columns[data.Columns.Count - 1];
        }

        if (valueColumn == null || hierarchyColumns.Count == 0)
            return null;

        // Build the treemap data: labels, parents, values, and ids
        var labels = new List<string>();
        var parents = new List<string>();
        var values = new List<double>();
        var ids = new List<string>();

        // Track branch nodes and their indices for later value calculation
        var branchIndices = new Dictionary<string, int>();
        
        // Track unique nodes at each level to avoid duplicates
        var addedNodes = new HashSet<string>();

        // Process each row to build the hierarchy
        foreach (DataRow row in data.Rows)
        {
            var cellValue = row[valueColumn];
            if (cellValue == null || cellValue == DBNull.Value)
                continue;

            double value = SanitizeDoubleValue(Convert.ToDouble(cellValue));
            
            // Build the path for this row
            string parentId = "";
            
            for (int level = 0; level < hierarchyColumns.Count; level++)
            {
                var col = hierarchyColumns[level];
                var nodeValue = row[col];
                
                if (nodeValue == null || nodeValue == DBNull.Value)
                    continue;

                string nodeLabel = nodeValue.ToString() ?? "";
                
                // Create a unique ID for this node based on its path
                string nodeId = parentId == "" ? nodeLabel : $"{parentId}/{nodeLabel}";
                
                // Add intermediate nodes (branches) if not already added
                if (level < hierarchyColumns.Count - 1)
                {
                    if (!addedNodes.Contains(nodeId))
                    {
                        int branchIndex = labels.Count;
                        labels.Add(nodeLabel);
                        parents.Add(parentId);
                        values.Add(0); // Will be calculated later
                        ids.Add(nodeId);
                        addedNodes.Add(nodeId);
                        branchIndices[nodeId] = branchIndex;
                    }
                    
                    // Accumulate value to this branch
                    if (branchIndices.TryGetValue(nodeId, out int idx))
                    {
                        values[idx] += value;
                    }
                }
                else
                {
                    // Leaf node - add with actual value
                    // For leaf nodes, we might have duplicate labels, so always use unique ID
                    string leafId = nodeId + "_" + data.Rows.IndexOf(row);
                    labels.Add(nodeLabel);
                    parents.Add(parentId);
                    values.Add(value);
                    ids.Add(leafId);
                }
                
                parentId = nodeId;
            }
        }

        if (labels.Count == 0)
            return null;

        // Configure title
        if (options.Title != null)
            builder = builder.WithTitle(options.Title);

        // Add the treemap trace
        builder = builder.AddTreeMapTrace(
            labels: labels,
            parents: parents,
            values: values,
            ids: ids,
            name: valueColumn.ColumnName,
            textInfo: "label+value",
            branchValues: "total"
        );

        if (options.Legend == ChartLegendMode.Hidden)
            builder = builder.HideLegend();

        // Apply new chart options
        builder = ApplyCommonOptions(builder, options);

        return builder;
    }

    private PlotlyChartBuilder? BuildSankeyChart(DataTable data, ChartOptions options)
    {
        var builder = new PlotlyChartBuilder();

        // Sankey expects flow data with at least 3 columns:
        // - Source node column (string)
        // - Target node column (string)
        // - Value column (numeric, for flow size)
        if (data.Columns.Count < 3 || data.Rows.Count == 0)
            return null;

        // Find the columns: first two non-numeric are source/target, first numeric is value
        DataColumn? sourceColumn = null;
        DataColumn? targetColumn = null;
        DataColumn? valueColumn = null;

        foreach (DataColumn col in data.Columns)
        {
            if (IsNumeric(col.DataType))
            {
                valueColumn ??= col;
            }
            else
            {
                if (sourceColumn == null)
                    sourceColumn = col;
                else if (targetColumn == null)
                    targetColumn = col;
            }
        }

        // If we don't have enough categorical columns, use first two columns as source/target
        if (sourceColumn == null || targetColumn == null)
        {
            if (data.Columns.Count >= 3)
            {
                sourceColumn = data.Columns[0];
                targetColumn = data.Columns[1];
                valueColumn = data.Columns[2];
            }
            else
            {
                return null;
            }
        }

        if (sourceColumn == null || targetColumn == null || valueColumn == null)
            return null;

        // Build unique node list and create index mapping
        var nodeLabels = new List<string>();
        var nodeIndexMap = new Dictionary<string, int>();

        void EnsureNode(string label)
        {
            if (!nodeIndexMap.ContainsKey(label))
            {
                nodeIndexMap[label] = nodeLabels.Count;
                nodeLabels.Add(label);
            }
        }

        // Collect links
        var linkSources = new List<int>();
        var linkTargets = new List<int>();
        var linkValues = new List<double>();

        foreach (DataRow row in data.Rows)
        {
            var sourceValue = row[sourceColumn];
            var targetValue = row[targetColumn];
            var flowValue = row[valueColumn];

            if (sourceValue == null || sourceValue == DBNull.Value ||
                targetValue == null || targetValue == DBNull.Value ||
                flowValue == null || flowValue == DBNull.Value)
                continue;

            string sourceLabel = sourceValue.ToString() ?? "";
            string targetLabel = targetValue.ToString() ?? "";
            double value = SanitizeDoubleValue(Convert.ToDouble(flowValue));

            // Skip zero or negative flows
            if (value <= 0)
                continue;

            // Ensure both nodes exist
            EnsureNode(sourceLabel);
            EnsureNode(targetLabel);

            // Add the link
            linkSources.Add(nodeIndexMap[sourceLabel]);
            linkTargets.Add(nodeIndexMap[targetLabel]);
            linkValues.Add(value);
        }

        if (nodeLabels.Count == 0 || linkSources.Count == 0)
            return null;

        // Configure title
        if (options.Title != null)
            builder = builder.WithTitle(options.Title);

        // Add the Sankey trace
        builder = builder.AddSankeyTrace(
            nodeLabels: nodeLabels,
            linkSources: linkSources,
            linkTargets: linkTargets,
            linkValues: linkValues,
            name: valueColumn.ColumnName
        );

        if (options.Legend == ChartLegendMode.Hidden)
            builder = builder.HideLegend();

        // Apply new chart options
        builder = ApplyCommonOptions(builder, options);

        return builder;
    }

    /// <summary>
    /// Common rendering logic for 2D charts (bar, column, line, scatter, etc.)
    /// </summary>
    private PlotlyChartBuilder? Build2dChart(
        PlotlyChartBuilder builder,
        DataTable data, 
        ChartOptions options,
        Func<PlotlyChartBuilder, object[], double[], string, string?, PlotlyChartBuilder> addTrace)
    {
        var xColumn = Get2dXColumn(data, options);
        if (xColumn == null)
            return null;

        var yColumns = Get2dYColumns(data, options, xColumn);

        // Configure chart based on visualization options
        if (options.Title != null)
            builder = builder.WithTitle(options.Title);

        if (options.XTitle != null)
            builder = builder.SetXAxisTitle(options.XTitle);

        if (options.YTitle != null)
            builder = builder.SetYAxisTitle(options.YTitle);

        if (options.XAxis == ChartAxis.Log)
            builder = builder.SetLogX();

        if (options.YAxis == ChartAxis.Log)
            builder = builder.SetLogY();

        if (TryGetDouble(options.Xmin, out var xMinD)
            && TryGetDouble(options.Xmax, out var xMaxD))
            builder = builder.SetXAxisRange(xMinD, xMaxD);

        if (TryGetDouble(options.Ymin, out var yMinD)
            && TryGetDouble(options.Ymax, out var yMaxD))
            builder = builder.SetYAxisRange(yMinD, yMaxD);

        if (options.Legend == ChartLegendMode.Hidden)
            builder = builder.HideLegend();

        // Apply new chart options
        builder = ApplyCommonOptions(builder, options);

        // Add traces for each value column
        bool useSecondaryAxis = false;

        for (int i = 0; i < yColumns.Length; i++)
        {
            var valueColumn = yColumns[i];
            var (keys, values) = Get2DChartData(xColumn, valueColumn);

            if (keys != null && values != null)
            {
                string? yAxis = null;

                // Assign to secondary axis if split mode
                if (useSecondaryAxis && i > 0)
                {
                    yAxis = "y2";
                }

                builder = addTrace(builder, keys, values, valueColumn.ColumnName, yAxis);
            }
        }

        // Add secondary Y axis if needed
        if (useSecondaryAxis)
        {
            builder = builder.AddSecondaryYAxis("yaxis2",
                new PlotlyAxis
                {
                    Overlaying = "y",
                    Side = PlotlyAxisSides.Right,
                    Type = options.YAxis == ChartAxis.Log ? PlotlyAxisTypes.Log : null
                });
        }

        return builder;
    }

    private static bool TryGetDouble(object? value, out double result)
    {
        if (value is IConvertible valueC
            && Convert.ToDouble(valueC) is double valueD
            && !double.IsNaN(valueD))
        {
            result = valueD;
            return true;
        }
        result = default;
        return false;
    }

    private DataColumn? Get2dXColumn(DataTable data, ChartOptions options)
    {
        return options.XColumn != null
            ? data.Columns[options.XColumn]
            : options.YColumns != null
                ? data.Columns.OfType<DataColumn>().FirstOrDefault(c => !options.YColumns.Contains(c.ColumnName))
                : data.Columns[0];
    }

    private DataColumn[] Get2dYColumns(DataTable data, ChartOptions options, DataColumn keyColumn)
    {
        return options.YColumns != null
            ? options.YColumns.Select(name => (DataColumn)data.Columns[name]!).Where(c => c != null).ToArray() // the exact columns requested in order
            : data.Columns.OfType<DataColumn>().Where(c => c != keyColumn).ToArray(); // the first column in table order that is not the key column
    }

    private (object[]? x, double[]? y) Get2DChartData(DataColumn xColumn, DataColumn yColumn)
    {
        if (!IsNumeric(yColumn.DataType))
            return (null, null);

        var xValues = GetColumnValues(xColumn);
        var yValues = GetColumnValues(yColumn);

        (xValues, yValues) = TrimNullRows(xValues, yValues);

        var x = xValues;
        var y = ConvertToNumeric(yValues);
        
        return (x, y);
    }

    private object[] GetColumnValues(DataColumn column)
    {
        return column.Table!.Rows.OfType<DataRow>().Select(dr => dr[column]).ToArray();
    }

    private T[] ConvertValues<T>(object[] values)
    {
        return values.Select(v => (T)Convert.ChangeType(v, typeof(T))).ToArray();
    }

    private double[] ConvertToNumeric(object[] values)
    {
        return values.Select(v => SanitizeDoubleValue(Convert.ToDouble(v))).ToArray();
    }

    /// <summary>
    /// Sanitizes double values by replacing infinity with min/max values.
    /// </summary>
    private static double SanitizeDoubleValue(double value)
    {
        if (double.IsPositiveInfinity(value))
            return double.MaxValue;
        
        if (double.IsNegativeInfinity(value))
            return double.MinValue;
        
        return value;
    }

    /// <summary>
    /// Trim (x,y) pairs if either is null/DBNull
    /// </summary>
    private (object[] x, object[] y) TrimNullRows(object[] xValues, object[] yValues)
    {
        var result = new List<(object x, object y)>();

        for (int i = 0; i < Math.Min(xValues.Length, yValues.Length); i++)
        {
            if (xValues[i] != null && xValues[i] != DBNull.Value &&
                yValues[i] != null && yValues[i] != DBNull.Value)
            {
                result.Add((xValues[i], yValues[i]));
            }
        }

        return (result.Select(t => t.x).ToArray(), result.Select(t => t.y).ToArray());
    }

    private static bool IsNumeric(Type type)
    {
        return type == typeof(byte) ||
               type == typeof(sbyte) ||
               type == typeof(short) ||
               type == typeof(ushort) ||
               type == typeof(int) ||
               type == typeof(uint) ||
               type == typeof(long) ||
               type == typeof(ulong) ||
               type == typeof(float) ||
               type == typeof(double) ||
               type == typeof(decimal);
    }

    /// <summary>
    /// Applies common chart options (ticks, grid, tick angle, sort, legend position) to the builder.
    /// Called after chart-specific configuration so these settings layer on top.
    /// </summary>
    private static PlotlyChartBuilder ApplyCommonOptions(PlotlyChartBuilder builder, ChartOptions options)
    {
        if (options.XShowTicks == ChartVisibility.Visible)
            builder = builder.SetXShowTicks(true);
        else if (options.XShowTicks == ChartVisibility.Hidden)
            builder = builder.SetXShowTicks(false);

        if (options.YShowTicks == ChartVisibility.Visible)
            builder = builder.SetYShowTicks(true);
        else if (options.YShowTicks == ChartVisibility.Hidden)
            builder = builder.SetYShowTicks(false);

        if (options.XShowGrid == ChartVisibility.Hidden)
            builder = builder.SetXShowGrid(false);
        else if (options.XShowGrid == ChartVisibility.Visible)
            builder = builder.SetXShowGrid(true);

        if (options.YShowGrid == ChartVisibility.Hidden)
            builder = builder.SetYShowGrid(false);
        else if (options.YShowGrid == ChartVisibility.Visible)
            builder = builder.SetYShowGrid(true);

        if (options.XTickAngle.HasValue)
            builder = builder.SetXTickAngle(options.XTickAngle.Value);

        if (options.YTickAngle.HasValue)
            builder = builder.SetYTickAngle(options.YTickAngle.Value);

        if (options.Sort != null && options.Sort != ChartSortOrder.Default)
        {
            var order = options.Sort == ChartSortOrder.Ascending
                ? PlotlyCategoryOrders.TotalAscending
                : PlotlyCategoryOrders.TotalDescending;
            builder = builder.SetCategoryOrder(order);
        }

        if (options.LegendPosition != null)
        {
            if (options.LegendPosition == ChartLegendPosition.Hidden)
                builder = builder.HideLegend();
            else
                builder = builder.SetLegendPosition(options.LegendPosition);
        }

        return builder;
    }
}
