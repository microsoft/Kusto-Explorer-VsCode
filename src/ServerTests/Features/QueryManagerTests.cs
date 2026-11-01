// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using Kusto.Language;
using Kusto.Vscode;
using System.Collections.Immutable;

namespace Tests.Features;

[TestClass]
public class QueryManagerTests
{
    private const string WorkspaceUri =
        "https://ade.loganalytics.io/subscriptions/sub-1/resourcegroups/rg-1/providers/microsoft.operationalinsights/workspaces/my-workspace";
    private const string ComponentUri =
        "https://ade.applicationinsights.io/subscriptions/sub-1/resourcegroups/rg-1/providers/microsoft.insights/components/my-app";

    [TestMethod]
    [DataRow(WorkspaceUri, "url", "NetDefaultDB")]
    [DataRow(ComponentUri, "url", "NetDefaultDB")]
    [DataRow(WorkspaceUri, "connectionString", "db1")]
    [DataRow(ComponentUri, "connectionString", "db1")]
    [DataRow(WorkspaceUri, "cluster", "db1")]
    [DataRow(ComponentUri, "cluster", "db1")]
    [DataRow(WorkspaceUri, "clusterOnly", null)]
    [DataRow(ComponentUri, "clusterOnly", null)]
    [DataRow("mycluster", "cluster", "db1")]
    [DataRow("https://mycluster.kusto.windows.net", "connectionString", "db1")]
    [DataRow("https://mycluster.kusto.windows.net/db1", "url", "db1")]
    public async Task RunQueryAsync_ConnectDirective_PreservesRoutingAndDatabase(
        string cluster, string form, string? expectedDatabase)
    {
        var connections = new ConnectionManager();
        var symbols = new UnusedSymbolManager();
        var manager = new QueryManager(
            connections, symbols, new DocumentManager(symbols), new OptionsManager(new UnusedSettingSource()));
        var directive = form switch
        {
            "url" => $"#connect \"{cluster}\"",
            "connectionString" => $"#connect \"Data Source={cluster};Initial Catalog=db1\"",
            "clusterOnly" => $"#connect cluster(\"{cluster}\")",
            _ => $"#connect cluster(\"{cluster}\").database(\"db1\")"
        };
        var expectedCluster = cluster == "mycluster" || cluster.StartsWith("https://mycluster.kusto.windows.net", StringComparison.Ordinal)
            ? "mycluster.kusto.windows.net"
            : cluster;

        var result = await manager.RunQueryAsync(directive, null, null,
            ImmutableDictionary<string, string>.Empty, ImmutableDictionary<string, string>.Empty,
            null, CancellationToken.None);

        Assert.IsNull(result.Error);
        Assert.AreEqual(expectedCluster, result.Cluster);
        Assert.AreEqual(expectedDatabase, result.Database);
        if (result.Connection != null)
        {
            var registered = connections.GetOrAddConnection(result.Connection);
            Assert.AreEqual(registered.Cluster, result.Cluster);
        }
        else
        {
            connections.GetOrAddConnection(expectedCluster);
        }
        Assert.IsTrue(((IConnectionManager)connections).TryGetConnection(
            result.Cluster!, result.Database, out var nextConnection));
        Assert.AreEqual(expectedCluster, nextConnection.Cluster);
        if (result.Database != null)
        {
            Assert.AreEqual(result.Database, nextConnection.Database);
        }
    }

    private sealed class UnusedSymbolManager : ISymbolManager
    {
        public GlobalState Globals => GlobalState.Default;
        public event EventHandler<GlobalState>? GlobalsChanged { add { } remove { } }
        public Task RefreshAsync(string clusterName, string? databaseName, CancellationToken cancellationToken)
            => throw new AssertFailedException("A standalone directive must not fetch schema.");
        public Task EnsureClustersAsync(ImmutableList<string> clusterNames, string? contextCluster, CancellationToken cancellationToken)
            => throw new AssertFailedException("A standalone directive must not fetch schema.");
        public Task EnsureDatabaseAsync(string clusterName, string databaseName, string? contextCluster, CancellationToken cancellationToken)
            => throw new AssertFailedException("A standalone directive must not fetch schema.");
    }

    private sealed class UnusedSettingSource : ISettingSource
    {
        public event EventHandler? SettingsChanged { add { } remove { } }
        public Task<T> GetSettingAsync<T>(Setting<T> setting, CancellationToken cancellation)
            => throw new AssertFailedException("A standalone directive uses the default options.");
        public Task<ImmutableDictionary<string, object?>> GetSettingsAsync(IReadOnlyList<Setting> settings, CancellationToken cancellationToken)
            => throw new AssertFailedException("A standalone directive uses the default options.");
    }
}
