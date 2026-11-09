// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using System.Collections.Immutable;
using Kusto.Language;
using Kusto.Language.Editor;

namespace Kusto.Vscode;

public interface IQueryManager
{
    /// <summary>
    /// Validates a query and returns any diagnostics.
    /// </summary>
    Task<IReadOnlyList<Diagnostic>> ValidateQueryAsync(
        string query,
        string clusterName,
        string? databaseName,
        CancellationToken cancellationToken);

    /// <summary>
    /// Gets the result type of a query as a formatted string.
    /// Returns the schema for tabular results, the type name for scalar results, or null if the query has no result.
    /// </summary>
    Task<string?> GetQueryResultTypeAsync(
        string query,
        string clusterName,
        string? databaseName,
        CancellationToken cancellationToken);

    /// <summary>
    /// Runs the query text against the specified cluster and database.
    /// </summary>
    Task<RunResult> RunQueryAsync(
        EditString query,
        string? clusterName,
        string? databaseName,
        ImmutableDictionary<string, string> queryOptions,
        ImmutableDictionary<string, string> queryParameters,
        string? clientRequestId,
        CancellationToken cancellationToken
        );

    /// <summary>
    /// Cancels the run started with the specified client request id: aborts the local request and
    /// sends a best-effort <c>.cancel query</c> for the request currently executing on the server.
    /// </summary>
    Task<CancelQueryResult> CancelQueryAsync(string clientRequestId, CancellationToken cancellationToken);
}

/// <summary>
/// The result of cancelling a running query.
/// </summary>
public record CancelQueryResult
{
    /// <summary>
    /// True if a run with the client request id was in progress.
    /// </summary>
    public bool Found { get; init; }

    /// <summary>
    /// The client request id targeted by the server-side <c>.cancel query</c>, if one was sent.
    /// This can differ from the run's id when the run executes more than one request.
    /// </summary>
    public string? CancelledClientRequestId { get; init; }

    /// <summary>
    /// The error from the server-side cancellation, if it failed.
    /// </summary>
    public string? Error { get; init; }
}

/// <summary>
/// The result of running a document query.
/// </summary>
public record RunResult
{
    /// <summary>
    /// The query text that was ultimately executed.
    /// This is a portion of the document text.
    /// </summary>
    public required EditString Query { get; init; }

    /// <summary>
    /// The result of executing the query, including any relevant diagnostics.
    /// </summary>
    public ExecuteResult? ExecuteResult { get; init; }

    /// <summary>
    /// The final query options, if the query alterated the global query options.
    /// </summary>
    public ImmutableDictionary<string, string>? QueryOptions { get; init; }

    /// <summary>
    /// The final query parameters, if the query altered the global query parameters.
    /// </summary>
    public ImmutableDictionary<string, string>? QueryParameters { get; init; }

    /// <summary>
    /// The resulting connection string.
    /// </summary>
    public string? Connection { get; init; }

    /// <summary>
    /// The resulting cluster
    /// </summary>
    public string? Cluster { get; init; }

    /// <summary>
    /// The resulting database
    /// </summary>
    public string? Database { get; init; }

    /// <summary>
    /// The error if the run failed.
    /// </summary>
    public Diagnostic? Error { get; init; }
};
