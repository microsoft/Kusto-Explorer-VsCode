// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using System.Collections.Immutable;
using System.Data;
using Kusto.Data;
using Kusto.Language;
using Kusto.Language.Editor;

namespace Kusto.Vscode;

public interface IConnection
{
    /// <summary>
    /// The cluster (host name of server)
    /// </summary>
    string Cluster { get; }

    /// <summary>
    /// The default database, optional
    /// </summary>
    string? Database { get; }

    /// <summary>
    /// Gets the equivalent connection, but referring to the specified cluster.
    /// </summary>
    IConnection WithCluster(string clusterName);

    /// <summary>
    /// Gets the equivalent connection, but referring the specified database.
    /// </summary>
    IConnection WithDatabase(string databaseName);

    /// <summary>
    ///Gets the equivalent connection, but referring to the specified cluster and database
    /// </summary>
    IConnection WithClusterAndDatabase(string clusterName, string? databaseName)
    {
        var result = WithCluster(clusterName);
        if (databaseName != null)
            result = result.WithDatabase(databaseName);
        return result;
    }

    /// <summary>
    /// Executes a query over the connection.
    /// </summary>
    public Task<ExecuteResult> ExecuteAsync(
        EditString query,
        ImmutableDictionary<string, string>? options = null,
        ImmutableDictionary<string, string>? parameters = null,
        string? clientRequestId = null,
        CancellationToken cancellationToken = default
        );

    /// <summary>
    /// Execute a query over the connection, returning the typed results.
    /// </summary>
    public Task<ExecuteResult<T>> ExecuteAsync<T>(
        EditString query,
        ImmutableDictionary<string, string>? options = null,
        ImmutableDictionary<string, string>? parameters = null,
        CancellationToken cancellationToken = default
        );

    /// <summary>
    /// Gets the kind of server this connection is connected to.
    /// </summary>
    public Task<string> GetServerKindAsync(CancellationToken cancellationToken);
}

/// <summary>
/// The result for <see cref="IConnection.ExecuteAsync"/>."/>
/// </summary>
public record ExecuteResult
{
    /// <summary>
    /// The resulting tables.
    /// </summary>
    public ImmutableList<DataTable>? Tables { get; init; }

    /// <summary>
    /// Any chart descriptors included in the result.
    /// </summary>
    public ImmutableList<ResultChart>? Charts { get; init; }

    /// <summary>
    /// Any diagnostics produced during query execution, such as errors or warnings.
    /// </summary>
    public ImmutableList<Diagnostic>? Diagnostics { get; init; }
}

/// <summary>
/// The result for <see cref="IConnection.ExecuteAsync{T}"/>
/// </summary>
/// <typeparam name="T">The type that a row is mapped to.</typeparam>
public record ExecuteResult<T>
{
    /// <summary>
    /// The values mapped from the resulting rows.
    /// </summary>
    public ImmutableList<T>? Values { get; init; }

    /// <summary>
    /// Any diagnostics produced during query execution, such as errors or warnings.
    /// </summary>
    public ImmutableList<Diagnostic>? Diagnostics { get; init; }
}
