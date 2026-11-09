// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Diagnostics.CodeAnalysis;
using Kusto.Language;
using Kusto.Language.Editor;
using Kusto.Vscode;

namespace Tests.Features;

[TestClass]
public class QueryManagerCancelTests
{
    private const string ClientRequestId = "KustoExplorerVsCode;11111111-2222-3333-4444-555555555555";
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    [TestMethod]
    public async Task Cancel_RunningQuery_CancelsByItsClientRequestId()
    {
        var connection = new BlockingConnection(blockOnCall: 1);
        var manager = CreateManager(connection);

        var run = RunAsync(manager, "StormEvents | take 10");
        await connection.WaitForBlockedCallAsync();

        var result = await manager.CancelQueryAsync(ClientRequestId, CancellationToken.None);

        Assert.IsTrue(result.Found);
        Assert.AreEqual(ClientRequestId, result.CancelledClientRequestId);
        Assert.IsNull(result.Error);
        Assert.AreEqual($".cancel query '{ClientRequestId}'", connection.CancelCommands.Single());
        Assert.AreEqual("The query was cancelled.", (await run.WaitAsync(Timeout)).Error?.Message);
    }

    [TestMethod]
    public async Task Cancel_StoredResultCommandPhase_TargetsOriginalId_AndAbortsLocallyEvenIfCommandIgnoresToken()
    {
        var connection = new BlockingConnection(blockOnCall: 1, ignoreToken: true);
        var manager = CreateManager(connection);

        var run = RunAsync(manager, "#sqr MyResult\nStormEvents | take 10");
        await connection.WaitForBlockedCallAsync();
        StringAssert.StartsWith(connection.Executed[0].Query, ".set-or-replace stored_query_result");
        Assert.AreEqual(ClientRequestId, connection.Executed[0].ClientRequestId);

        var result = await manager.CancelQueryAsync(ClientRequestId, CancellationToken.None);

        Assert.AreEqual(ClientRequestId, result.CancelledClientRequestId);
        Assert.AreEqual($".cancel query '{ClientRequestId}'", connection.CancelCommands.Single());
        Assert.AreEqual("The query was cancelled.", (await run.WaitAsync(Timeout)).Error?.Message);

        // the abandoned command completing later must not start the fetch phase
        connection.Release();
        await Task.Delay(100);
        Assert.AreEqual(1, connection.Executed.Count);
    }

    [TestMethod]
    public async Task Cancel_StoredResultFetchPhase_TargetsSuffixedId()
    {
        var connection = new BlockingConnection(blockOnCall: 2);
        var manager = CreateManager(connection);

        var run = RunAsync(manager, "#sqr MyResult\nStormEvents | take 10");
        await connection.WaitForBlockedCallAsync();

        var result = await manager.CancelQueryAsync(ClientRequestId, CancellationToken.None);

        var fetchId = ClientRequestId + ";fetchStoredQueryResult";
        Assert.AreEqual(fetchId, connection.Executed[1].ClientRequestId);
        Assert.AreEqual(fetchId, result.CancelledClientRequestId);
        Assert.AreEqual($".cancel query '{fetchId}'", connection.CancelCommands.Single());
        Assert.AreEqual("The query was cancelled.", (await run.WaitAsync(Timeout)).Error?.Message);
    }

    [TestMethod]
    public async Task Cancel_UnknownOrFinishedId_IsNotFound()
    {
        var connection = new BlockingConnection(blockOnCall: 0);
        var manager = CreateManager(connection);

        var unknown = await manager.CancelQueryAsync("unknown", CancellationToken.None);
        Assert.IsFalse(unknown.Found);

        var completed = await RunAsync(manager, "print 1").WaitAsync(Timeout);
        Assert.IsNull(completed.Error);

        var finished = await manager.CancelQueryAsync(ClientRequestId, CancellationToken.None);
        Assert.IsFalse(finished.Found);
        Assert.AreEqual(0, connection.CancelCommands.Count);
    }

    [TestMethod]
    public async Task Cancel_ServerCancelFailure_IsReportedButLocalRunStillCancelled()
    {
        var connection = new BlockingConnection(blockOnCall: 1) { CancelError = "Principal is not authorized" };
        var manager = CreateManager(connection);

        var run = RunAsync(manager, "StormEvents | take 10");
        await connection.WaitForBlockedCallAsync();

        var result = await manager.CancelQueryAsync(ClientRequestId, CancellationToken.None);

        Assert.IsTrue(result.Found);
        Assert.AreEqual("Principal is not authorized", result.Error);
        Assert.AreEqual("The query was cancelled.", (await run.WaitAsync(Timeout)).Error?.Message);
    }

    private static QueryManager CreateManager(IConnection connection) =>
        new(new SingleConnectionManager(connection), symbolManager: null!, documentManager: null!, optionsManager: null!);

    private static Task<RunResult> RunAsync(QueryManager manager, string query) =>
        manager.RunQueryAsync(
            new EditString(query),
            "help.kusto.windows.net",
            "Samples",
            ImmutableDictionary<string, string>.Empty,
            ImmutableDictionary<string, string>.Empty,
            ClientRequestId,
            CancellationToken.None);

    private sealed class SingleConnectionManager(IConnection connection) : IConnectionManager
    {
        public IConnection GetOrAddConnection(string connectionStrings) => connection;

        public bool TryGetConnection(string clusterName, [NotNullWhen(true)] out IConnection? result)
        {
            result = connection;
            return true;
        }
    }

    /// <summary>
    /// Records executed requests and blocks the n-th one (1-based) until cancelled, or until
    /// <see cref="Release"/> when <c>ignoreToken</c> mimics control commands that don't observe the token.
    /// </summary>
    private sealed class BlockingConnection(int blockOnCall, bool ignoreToken = false) : IConnection
    {
        private readonly TaskCompletionSource _blocked = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _released = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly ConcurrentQueue<string> _cancelCommands = new();
        private readonly List<(string Query, string? ClientRequestId)> _executed = new();
        private int _calls;

        public string? CancelError { get; init; }
        public IReadOnlyList<(string Query, string? ClientRequestId)> Executed { get { lock (_executed) return _executed.ToList(); } }
        public IReadOnlyList<string> CancelCommands => _cancelCommands.ToList();

        public string Cluster => "help.kusto.windows.net";
        public string? Database => "Samples";
        public IConnection WithCluster(string clusterName) => this;
        public IConnection WithDatabase(string databaseName) => this;

        public Task WaitForBlockedCallAsync() => _blocked.Task.WaitAsync(Timeout);
        public void Release() => _released.TrySetResult();

        public async Task<ExecuteResult> ExecuteAsync(
            EditString query,
            ImmutableDictionary<string, string>? options = null,
            ImmutableDictionary<string, string>? parameters = null,
            string? clientRequestId = null,
            CancellationToken cancellationToken = default)
        {
            var text = query.ToString();
            if (text.StartsWith(".cancel query", StringComparison.Ordinal))
            {
                _cancelCommands.Enqueue(text);
                return CancelError != null
                    ? new ExecuteResult { Diagnostics = [new Diagnostic("KE", CancelError)] }
                    : new ExecuteResult();
            }

            lock (_executed)
                _executed.Add((text, clientRequestId));

            if (Interlocked.Increment(ref _calls) == blockOnCall)
            {
                _blocked.TrySetResult();
                try
                {
                    await (ignoreToken ? _released.Task : _released.Task.WaitAsync(cancellationToken));
                }
                catch (OperationCanceledException ex)
                {
                    // like ConnectionManager, surface failures as diagnostics
                    return new ExecuteResult { Diagnostics = [new Diagnostic("KE", ex.Message)] };
                }
            }

            return new ExecuteResult { Tables = ImmutableList<System.Data.DataTable>.Empty };
        }

        public Task<ExecuteResult<T>> ExecuteAsync<T>(
            EditString query,
            ImmutableDictionary<string, string>? options = null,
            ImmutableDictionary<string, string>? parameters = null,
            CancellationToken cancellationToken = default) =>
            Task.FromResult(new ExecuteResult<T>());

        public Task<string> GetServerKindAsync(CancellationToken cancellationToken) => Task.FromResult("Engine");
    }
}
