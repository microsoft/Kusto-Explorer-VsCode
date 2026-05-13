// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using System.Collections.Immutable;
using System.Data;
using System.Runtime.Serialization;

namespace Kusto.Vscode;

/// <summary>
/// Serializable representation of a Kusto query execution result.
/// </summary>
[DataContract]
public class ResultData
{
    /// <summary>
    /// The query that produced the result
    /// </summary>
    [DataMember(Name = "query")]
    public string? Query { get; init; }

    /// <summary>
    /// The cluster that ran the query
    /// </summary>
    [DataMember(Name = "cluster")]
    public string? Cluster { get; init; }

    /// <summary>
    /// The default database context for the query
    /// </summary>
    [DataMember(Name = "database")]
    public string? Database { get; init; }

    /// <summary>
    /// The resulting data tables
    /// </summary>
    [DataMember(Name = "tables")]
    public required ImmutableList<ResultTable> Tables { get; init; }

    /// <summary>
    /// The descriptors for customized charts related to the result data.
    /// </summary>
    [DataMember(Name = "charts")]
    public ImmutableList<ResultChart>? Charts { get; init; }

    /// <summary>
    /// Converts an <see cref="ExecuteResult"/> to a <see cref="ResultData"/>.
    /// </summary>
    /// <param name="executeResult">The query execution result to convert.</param>
    /// <param name="query">The query text that produced the result.</param>
    /// <param name="cluster">The cluster where the query was executed.</param>
    /// <param name="database">The database where the query was executed.</param>
    /// <param name="tableName">Optional table name to filter to a specific table.</param>
    /// <returns>The serializable result, or null if there are no tables.</returns>
    public static ResultData FromExecuteResult(ExecuteResult executeResult, string? query = null, string? cluster = null, string? database = null, string? tableName = null)
    {
        ImmutableList<ResultTable> resultTables = ImmutableList<ResultTable>.Empty;

        if (executeResult.Tables != null)
        {
            var tables = executeResult.Tables;

            // Filter to specific table if tableName is provided
            if (tableName != null)
            {
                tables = tables.Where(t => t.TableName == tableName).ToImmutableList();
            }

            resultTables = tables.Select(t => ResultTable.FromDataTable(t)).ToImmutableList();
        }

        return new ResultData
        {
            Query = query,
            Cluster = cluster,
            Database = database,
            Tables = resultTables,
            Charts = executeResult.Charts
        };
    }

    /// <summary>
    /// Converts this <see cref="ResultData"/> back to an <see cref="ExecuteResult"/>.
    /// </summary>
    /// <returns>The execution result.</returns>
    public ExecuteResult ToExecuteResult()
    {
        var tables = Tables.Select(t => t.ToDataTable()).ToImmutableList();

        return new ExecuteResult
        {
            Tables = tables,
            Charts = Charts
        };
    }
}

/// <summary>
/// Serializable representation of a named chart bound to an optional result table.
/// </summary>
[DataContract]
public class ResultChart
{
    [DataMember(Name = "name")]
    public string? Name { get; init; }

    [DataMember(Name = "tableName")]
    public string? TableName { get; init; }

    [DataMember(Name = "options")]
    public required ChartOptions Options { get; init; }
}

/// <summary>
/// Serializable representation of a data table.
/// </summary>
[DataContract]
public class ResultTable
{
    [DataMember(Name = "name")]
    public required string Name { get; init; }

    [DataMember(Name = "columns")]
    public required ImmutableList<ResultColumn> Columns { get; init; }

    [DataMember(Name = "rows")]
    public required ImmutableList<ImmutableList<object?>> Rows { get; init; }

    /// <summary>
    /// Converts a <see cref="DataTable"/> to a <see cref="ResultTable"/>.
    /// </summary>
    public static ResultTable FromDataTable(DataTable table)
    {
        var columns = table.Columns.OfType<DataColumn>()
            .Select(c => new ResultColumn
            {
                Name = c.ColumnName,
                Type = KustoGenerator.GetKustoSymbol(c.DataType).Name
            })
            .ToImmutableList();

        var columnTypes = columns.Select(c => c.Type).ToArray();
        var rows = table.Rows.OfType<DataRow>()
            .Select(r => r.ItemArray.Select((v, i) => ConvertCellValue(v, columnTypes[i])).ToImmutableList())
            .ToImmutableList();

        return new ResultTable
        {
            Name = table.TableName,
            Columns = columns,
            Rows = rows
        };
    }

    /// <summary>
    /// Converts this <see cref="ResultTable"/> back to a <see cref="DataTable"/>.
    /// </summary>
    public DataTable ToDataTable()
    {
        var table = new DataTable(Name);

        // Add columns
        foreach (var col in Columns)
        {
            var clrType = GetClrTypeFromKustoType(col.Type);
            table.Columns.Add(col.Name, clrType);
        }

        // Add rows
        foreach (var row in Rows)
        {
            var values = row.Select((value, index) =>
                ConvertFromCellValue(value, Columns[index].Type)).ToArray();
            table.Rows.Add(values);
        }

        return table;
    }

    private static object? ConvertCellValue(object? value, string kustoType)
    {
        if (value == null || value == DBNull.Value)
            return null;

        // The Kusto ADO.NET client surfaces bool columns as sbyte/byte (0 or 1).
        // Convert to a real bool so JSON serialization emits `true`/`false`
        // instead of numeric 0/1.
        if (kustoType == "bool")
        {
            return value switch
            {
                bool b => b,
                sbyte sb => sb != 0,
                byte b => b != 0,
                short s => s != 0,
                int i => i != 0,
                long l => l != 0,
                _ => value
            };
        }

        // Convert to JSON-safe types
        return value switch
        {
            DateTime dt => dt.ToString("o"), // ISO 8601 format
            TimeSpan ts => ts.ToString("c"), // Constant format
            Guid g => g.ToString(),
            byte[] bytes => Convert.ToBase64String(bytes),
            _ => value
        };
    }

    private static Type GetClrTypeFromKustoType(string kustoType)
    {
        return kustoType switch
        {
            "bool" => typeof(bool),
            "int" => typeof(int),
            "long" => typeof(long),
            "real" => typeof(double),
            "decimal" => typeof(decimal),
            "string" => typeof(string),
            "datetime" => typeof(DateTime),
            "timespan" => typeof(TimeSpan),
            "guid" => typeof(Guid),
            "dynamic" => typeof(object),
            _ => typeof(string)
        };
    }

    private static object? ConvertFromCellValue(object? value, string kustoType)
    {
        if (value == null)
            return DBNull.Value;

        // Convert from JSON types back to CLR types
        return kustoType switch
        {
            "datetime" when value is string s => DateTime.Parse(s, null, System.Globalization.DateTimeStyles.RoundtripKind),
            "timespan" when value is string s => TimeSpan.Parse(s),
            "guid" when value is string s => Guid.Parse(s),
            "dynamic" when value is string s => s, // Keep as string for dynamic
            _ => value
        };
    }
}

/// <summary>
/// Serializable representation of a table column.
/// </summary>
[DataContract]
public class ResultColumn
{
    [DataMember(Name = "name")]
    public required string Name { get; init; }

    [DataMember(Name = "type")]
    public required string Type { get; init; }
}
