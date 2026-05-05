// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using Kusto.Data;
using Kusto.Data.Common;
using Kusto.Language;
using Kusto.Language.Editor;
using Kusto.Language.Symbols;
using System.Collections.Immutable;

namespace Kusto.Vscode;

public class QueryManager : IQueryManager
{
    private readonly IConnectionManager _connectionManager;
    private readonly ISymbolManager _symbolManager;
    private readonly IDocumentManager _documentManager;
    private readonly IOptionsManager _optionsManager;
    private readonly ILogger? _logger;

    public QueryManager(
        IConnectionManager connectionManager,
        ISymbolManager symbolManager,
        IDocumentManager documentManager,
        IOptionsManager optionsManager,
        ILogger? logger = null)
    {
        _connectionManager = connectionManager;
        _symbolManager = symbolManager;
        _documentManager = documentManager;
        _optionsManager = optionsManager; 
        _logger = logger;
    }


    private async Task<GlobalState> GetGlobalsAsync(string? clusterName, string? databaseName, CancellationToken cancellationToken)
    {
        var globals = _symbolManager.Globals;
        if (clusterName != null)
        {
            await _symbolManager.EnsureClustersAsync([clusterName], contextCluster: null, cancellationToken).ConfigureAwait(false);
            if (globals.GetCluster(clusterName) is { } clusterSymbol)
            {
                globals = globals.WithCluster(clusterSymbol);
                if (databaseName != null)
                {
                    await _symbolManager.EnsureDatabaseAsync(clusterName, databaseName, contextCluster: null, cancellationToken).ConfigureAwait(false);
                    if (clusterSymbol.GetDatabase(databaseName) is { } databaseSymbol)
                    {
                        globals = globals.WithDatabase(databaseSymbol);
                    }
                }
            }
        }
        return globals;
    }

    /// <summary>
    /// Validates a query and returns any diagnostics.
    /// </summary>
    public async Task<IReadOnlyList<Diagnostic>> ValidateQueryAsync(
        string query,
        string clusterName,
        string? databaseName,
        CancellationToken cancellationToken)
    {
        var globals = await GetGlobalsAsync(clusterName, databaseName, cancellationToken).ConfigureAwait(false);

        // Create a temporary document for validation
        var tempId = new Uri($"kusto://validation/{Guid.NewGuid()}");
        var document = new SectionedDocument(tempId, query, globals);

        // Get diagnostics
        var diagnostics = document.GetDiagnostics(waitForAnalysis: true, cancellationToken);
        var analyzerDiagnostics = document.GetAnalyzerDiagnostics(waitForAnalysis: true, cancellationToken);

        // Combine and filter diagnostics
        var allDiagnostics = diagnostics
            .Concat(analyzerDiagnostics)
            .Where(d => d.Severity == DiagnosticSeverity.Error
                || d.Severity == DiagnosticSeverity.Warning)
            .ToImmutableList();

        return allDiagnostics;
    }

    /// <summary>
    /// Gets the result type of a query as a formatted string.
    /// </summary>
    public async Task<string?> GetQueryResultTypeAsync(
        string query,
        string clusterName,
        string? databaseName,
        CancellationToken cancellationToken)
    {
        var globals = await GetGlobalsAsync(clusterName, databaseName, cancellationToken).ConfigureAwait(false);

        // Create a temporary document for analysis
        var tempId = new Uri($"kusto://resulttype/{Guid.NewGuid()}");
        var document = new SectionedDocument(tempId, query, globals);

        // Get the result type using the document API
        var resultType = document.GetQueryResultType(0, cancellationToken);

        if (resultType is TableSymbol tableSymbol)
        {
            // Format as schema: (col1: type1, col2: type2, ...)
            var schema = string.Join(", ", tableSymbol.Columns.Select(c => $"{KustoFacts.BracketNameIfNecessary(c.Name)}: {c.Type.Name}"));
            return $"({schema})";
        }
        else if (resultType is ScalarSymbol scalarSymbol)
        {
            // Scalar type - just return the name
            return scalarSymbol.Name;
        }
        else
        {
            return null;
        }
    }

    public Task<RunResult> RunQueryAsync(
        EditString query,
        string? clusterName,
        string? databaseName,
        ImmutableDictionary<string, string> queryOptions,
        ImmutableDictionary<string, string> queryParameters,
        string? clientRequestId,
        CancellationToken cancellationToken)
    {
        var context = new ExecutionContext
        {
            Query = query,
            Options = queryOptions,
            Parameters = queryParameters,
            ClientRequestId = clientRequestId
        };

        // handle any directives
        if (IsDirective(context.Query))
        {
            if (IsDirectiveOnly(context.Query))
            {
                // a single directive by itself has a special result
                return Task.FromResult(ExecuteDirective(context));
            }

            // otherwise apply one or more directives to the context
            // and use that context for query execution
            do
            {
                context = ApplyDirective(context);
            }
            while (IsDirective(context.Query));
        }

        var effectiveCluster = context.Cluster ?? clusterName;
        var effectiveDatabase = context.Database ?? databaseName;

        if (effectiveCluster == null)
        {
            return Task.FromResult(
                new RunResult
                {
                    Query = query,
                    Error = CreateDiagnostic(query, "The query cannot be run. There is no server connection.")
                });
        }

        if (!_connectionManager.TryGetConnection(effectiveCluster, effectiveDatabase, out var connection))
        {
            return Task.FromResult(
                new RunResult
                {
                    Query = query,
                    Error = CreateDiagnostic(query, "The query cannot be run. The server connection is invalid.")
                });
        }

        return ExecuteQueryAsync(connection, context, cancellationToken);
    }

    private static bool IsDirective(string text)
    {
        var firstToken = Kusto.Language.Parsing.TokenParser.ParseToken(text);
        return firstToken.Kind == Kusto.Language.Syntax.SyntaxKind.DirectiveToken;
    }

    private static bool IsDirectiveOnly(string text)
    {
        return ClientDirective.TryParse(text, out ClientDirective directive)
            && string.IsNullOrWhiteSpace(directive.AfterDirectiveText);
    }

    private Diagnostic CreateDiagnostic(EditString query, string message)
    {
        var start = query.GetOriginalPosition(0);
        var end = query.GetOriginalPosition(query.Length);
        return new Diagnostic("KLS100", message).WithLocation(start, end - start);
    }

    private static string? AddClientRequestIdSuffix(string? clientRequestId, string suffix)
    {
        return string.IsNullOrWhiteSpace(clientRequestId)
            ? clientRequestId
            : $"{clientRequestId};{suffix}";
    }

    private record ExecutionContext
    {
        /// <summary>
        /// The query to execute
        /// </summary>
        public required EditString Query { get; init; }

        /// <summary>
        /// The default cluster to use for this query
        /// </summary>
        public string? Cluster { get; init; }

        /// <summary>
        /// The default database to use for this query
        /// </summary>
        public string? Database { get; init; }

        /// <summary>
        /// The options for this query.
        /// </summary>
        public required ImmutableDictionary<string, string> Options { get; init; }

        /// <summary>
        /// The parameters for this query.
        /// </summary>
        public required ImmutableDictionary<string, string> Parameters { get; init; }

        /// <summary>
        /// The client request id to use when executing the query.
        /// </summary>
        public string? ClientRequestId { get; init; }

        /// <summary>
        ///  the name of the stored query result to store the result of this execution into.
        /// </summary>
        public string? StoredQueryResultName { get; init; }
    }

    private async Task<RunResult> ExecuteQueryAsync(IConnection connection, ExecutionContext context, CancellationToken cancellationToken)
    {
        // some servers will if there is any comment or whitespace preceeding the first token
        var query = RemoveLeadingTrivia(context.Query);

        if (string.IsNullOrWhiteSpace(query))
        {
            return new RunResult
            {
                Query = query,
                Error = CreateDiagnostic(query, "No query")
            };
        }

        var executeClientRequestId = context.ClientRequestId;

        // handle stored query results
        if (context.StoredQueryResultName != null)
        {
            // execute command to execute query and store results on server
            var command = query.ReplaceAt(0, query.Length, CslCommandGenerator.GenerateStoredQueryResultSetOrReplaceCommand(context.StoredQueryResultName, query, previewCount: 0));
            var commandResult = await ExecuteQueryAsync(connection, context with { Query = command, StoredQueryResultName = null }, cancellationToken).ConfigureAwait(false);
            if (commandResult.Error != null)
                return commandResult;

            // change query to retrieve the stored result
            query = query.ReplaceAt(0, query.Length, $"stored_query_result({KustoFacts.GetStringLiteral(context.StoredQueryResultName)})");
            executeClientRequestId = AddClientRequestIdSuffix(context.ClientRequestId, "fetchStoredQueryResult");
        }

        var executeResult = await connection.ExecuteAsync(
            query,
            context.Options,
            context.Parameters,
            clientRequestId: executeClientRequestId,
            cancellationToken: cancellationToken).ConfigureAwait(false);
        return new RunResult
        {
            Query = query,
            ExecuteResult = executeResult,
            Error = executeResult.Diagnostics?.FirstOrDefault()
        };
    }

    private static EditString RemoveLeadingTrivia(EditString query)
    {
        var firstToken = Kusto.Language.Parsing.TokenParser.ParseToken(query);
        if (firstToken != null)
        {
            return query.Substring(firstToken.Trivia.Length);
        }
        else
        {
            return query;
        }
    }

    private RunResult ExecuteDirective(ExecutionContext context)
    {
        if (ClientDirective.TryParse(context.Query, out var directive))
        {
            switch (directive.Name)
            {
                case "connect":
                case "database":
                    return ExecuteConnectOrDatabaseDirective(directive, context);
                case "crp":
                    return ExecuteClientRequestPropertyDirective(directive, context);
                case "qp":
                    return ExecuteQueryParameterDirective(directive, context);
                case "sqr":
                case "welcome":
                case "upload":
                case "download":
                case "truesight":
                case "run":
                case "browse":
                case "automate":
                case "query":
                case "save":
                    return new RunResult
                    {
                        Query = context.Query,
                        Error = CreateDiagnostic(context.Query, $"Unhandled directive: {directive.Name}")
                    };
                default:
                    return new RunResult
                    {
                        Query = context.Query,
                        Error = CreateDiagnostic(context.Query, $"Unknown directive: {directive.Name}")
                    };
            }
        }
        else
        {
            return new RunResult
            {
                Query = context.Query,
                Error = CreateDiagnostic(context.Query, "Invalid Directive")
            };
        }

        RunResult ExecuteConnectOrDatabaseDirective(ClientDirective directive, ExecutionContext context)
        {
            if (directive.TryGetConnectionInfo(out var connection, out var clusterName, out var databaseName))
            {
                return new RunResult
                {
                    Query = context.Query,
                    Connection = connection,
                    Cluster = KustoFacts.GetFullHostName(clusterName, _optionsManager.DefaultDomain),
                    Database = databaseName
                };
            }

            return new RunResult
            {
                Query = context.Query,
                Error = CreateDiagnostic(context.Query, "Invalid connect directive. Expected format: .connect clusterName databaseName")
            };
        }

        RunResult ExecuteClientRequestPropertyDirective(ClientDirective directive, ExecutionContext context)
        {
            var newContext = ApplyClientRequestPropertyDirective(directive, context);
            if (newContext.Options != context.Options)
            {
                return new RunResult
                {
                    Query = context.Query,
                    QueryOptions = newContext.Options
                };
            }

            return new RunResult
            {
                Query = context.Query,
                Error = CreateDiagnostic(context.Query, "Invalid client request property directive. Expected format: .crp propertyName=propertyValue")
            };
        }

        RunResult ExecuteQueryParameterDirective(ClientDirective directive, ExecutionContext context)
        {
            var newContext = ApplyQueryParameterDirective(directive, context);
            if (newContext.Parameters != context.Parameters)
            {
                return new RunResult
                {
                    Query = context.Query,
                    QueryParameters = newContext.Parameters
                };
            }

            return new RunResult
            {
                Query = context.Query,
                Error = CreateDiagnostic(context.Query, "Invalid query parameter directive. Expected format: .qp parameterName=parameterValue")
            };
        }
    }

    private ExecutionContext ApplyDirective(ExecutionContext context)
    {
        if (ClientDirective.TryParse(context.Query, out var directive))
        {
            switch (directive.Name)
            {
                case "connect":
                case "database":
                    return ApplyConnectOrDatabaseDirective(directive, context);
                case "crp":
                    return ApplyClientRequestPropertyDirective(directive, context);
                case "qp":
                    return ApplyQueryParameterDirective(directive, context);
                case "sqr":
                    return ApplyStoreQueryResultDirective(directive, context);
                case "welcome":
                case "upload":
                case "download":
                case "truesight":
                case "run":
                case "browse":
                case "automate":
                case "query":
                case "save":
                default:
                    return context;
            }

        }

        return context;
    }

    private ExecutionContext ApplyConnectOrDatabaseDirective(ClientDirective directive, ExecutionContext context)
    {
        if (directive.TryGetConnectionInfo(out _, out var clusterName, out var databaseName)
            && clusterName != null
            && _connectionManager.TryGetConnection(clusterName, databaseName, out var conn))
        {
            // change default cluster and database and continue
            return context with { Query = directive.AfterDirectiveText, Cluster = clusterName, Database = databaseName };
        }
        return context;
    }

    private ExecutionContext ApplyClientRequestPropertyDirective(ClientDirective directive, ExecutionContext context)
    {
        var properties = context.Options;
        var newProperties = directive.GetArgumentPairs(properties);
        return context with { Query = directive.AfterDirectiveText, Options = newProperties };
    }

    private ExecutionContext ApplyQueryParameterDirective(ClientDirective directive, ExecutionContext context)
    {
        var newParameters = directive.GetArgumentPairs(context.Parameters);
        return context = context with { Query = directive.AfterDirectiveText, Parameters = newParameters };
    }

    private ExecutionContext ApplyStoreQueryResultDirective(ClientDirective directive, ExecutionContext context)
    {
        if (directive.Arguments.Count > 0)
        {
            var name = directive.Arguments[0].Text;
            return context with { Query = directive.AfterDirectiveText, StoredQueryResultName = name };
        }
        return context;
    }
}
