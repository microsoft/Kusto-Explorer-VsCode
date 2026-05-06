// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using System.Collections.Immutable;
using System.Data;
using System.Diagnostics.CodeAnalysis;
using Kusto.Data;
using Kusto.Data.Common;
using Kusto.Data.Data;
using Kusto.Language;
using Kusto.Language.Editor;
using Kusto.Vscode;
using Newtonsoft.Json;

namespace Tests.Features;

[TestClass]
public class ServerSchemaSourceTests
{
    private const string TestCluster = "testcluster.kusto.windows.net";
    private const string TestDatabase = "testdb";

    // A minimal but valid GraphModel JSON. The parser uses Newtonsoft.Json to
    // deserialize directly into the GraphModel type; an empty object suffices.
    private const string ValidGraphModelContent = "{}";

    [TestMethod]
    public async Task GetGraphModelInfosAsync_NoSnapshotData_LoadsGraphModel()
    {
        // Graph model exists, but the snapshots query returns no rows for it.
        // Schema loading must not break, and the graph model should still be
        // returned (with an empty snapshots list).
        var entities = new List<DatabasesEntitiesShowCommandResult>
        {
            CreateGraphEntity("MyGraph", content: ValidGraphModelContent),
        };
        var snapshots = new List<ServerSchemaSource.LoadGraphModelSnapshotsResult>();

        var source = CreateSource(entities, snapshots);

        var result = await source.GetGraphModelInfosAsync(TestCluster, TestDatabase, null, CancellationToken.None);

        Assert.IsNotNull(result);
        var graph = result.FirstOrDefault(g => g.Name == "MyGraph");
        Assert.IsNotNull(graph, "Graph model should load even with no snapshot data.");
        Assert.IsEmpty(graph.Snapshots);
    }

    [TestMethod]
    public async Task GetGraphModelInfosAsync_NullSnapshotsField_LoadsGraphModel()
    {
        var entities = new List<DatabasesEntitiesShowCommandResult>
        {
            CreateGraphEntity("MyGraph", content: ValidGraphModelContent),
        };
        var snapshots = new List<ServerSchemaSource.LoadGraphModelSnapshotsResult>
        {
            new() { ModelName = "MyGraph", Snapshots = null! },
        };

        var source = CreateSource(entities, snapshots);

        var result = await source.GetGraphModelInfosAsync(TestCluster, TestDatabase, null, CancellationToken.None);

        Assert.IsNotNull(result);
        var graph = result.FirstOrDefault(g => g.Name == "MyGraph");
        Assert.IsNotNull(graph, "Graph model should load even when its snapshots field is null.");
        Assert.IsEmpty(graph.Snapshots);
    }

    [TestMethod]
    public async Task GetGraphModelInfosAsync_BadSnapshotJson_LoadsGraphModelWithEmptySnapshots()
    {
        var entities = new List<DatabasesEntitiesShowCommandResult>
        {
            CreateGraphEntity("MyGraph", content: ValidGraphModelContent),
        };
        var snapshots = new List<ServerSchemaSource.LoadGraphModelSnapshotsResult>
        {
            new() { ModelName = "MyGraph", Snapshots = "this is not json" },
        };

        var source = CreateSource(entities, snapshots);

        // The bug-fix wraps deserialization in a try/catch so bad JSON should
        // not propagate and break schema loading.
        var result = await source.GetGraphModelInfosAsync(TestCluster, TestDatabase, null, CancellationToken.None);

        Assert.IsNotNull(result);
        var graph = result.FirstOrDefault(g => g.Name == "MyGraph");
        Assert.IsNotNull(graph, "Graph model should load even when snapshot JSON is malformed.");
        Assert.IsEmpty(graph.Snapshots);
    }

    [TestMethod]
    public async Task GetGraphModelInfosAsync_BadSnapshotJsonOnOneModel_OtherModelsLoad()
    {
        var entities = new List<DatabasesEntitiesShowCommandResult>
        {
            CreateGraphEntity("BadGraph", content: ValidGraphModelContent),
            CreateGraphEntity("GoodGraph", content: ValidGraphModelContent),
        };
        var snapshots = new List<ServerSchemaSource.LoadGraphModelSnapshotsResult>
        {
            new() { ModelName = "BadGraph", Snapshots = "}{not json" },
            new() { ModelName = "GoodGraph", Snapshots = JsonConvert.SerializeObject(new[] { "snap1" }) },
        };

        var source = CreateSource(entities, snapshots);

        var result = await source.GetGraphModelInfosAsync(TestCluster, TestDatabase, null, CancellationToken.None);

        Assert.IsNotNull(result);
        var good = result.FirstOrDefault(g => g.Name == "GoodGraph");
        Assert.IsNotNull(good, "GoodGraph should still be loaded despite a sibling having bad JSON.");
        Assert.HasCount(1, good.Snapshots);
        Assert.AreEqual("snap1", good.Snapshots[0]);
    }

    [TestMethod]
    public async Task GetDatabaseInfoAsync_GraphModelWithBadSnapshotJson_DoesNotBreakSchemaLoading()
    {
        // Verify the broader schema-load path also tolerates the bad data.
        var entities = new List<DatabasesEntitiesShowCommandResult>
        {
            CreateGraphEntity("MyGraph", content: ValidGraphModelContent),
        };
        var snapshots = new List<ServerSchemaSource.LoadGraphModelSnapshotsResult>
        {
            new() { ModelName = "MyGraph", Snapshots = "garbage" },
        };

        var source = CreateSource(entities, snapshots);

        var info = await source.GetDatabaseInfoAsync(TestCluster, TestDatabase, null, CancellationToken.None);

        Assert.IsNotNull(info);
        Assert.AreEqual(TestDatabase, info.Name);
        Assert.HasCount(1, info.GraphModels);
    }

    [TestMethod]
    public async Task GetDatabaseInfoAsync_GraphModelWithoutSnapshotData_DoesNotBreakSchemaLoading()
    {
        var entities = new List<DatabasesEntitiesShowCommandResult>
        {
            CreateGraphEntity("MyGraph", content: ValidGraphModelContent),
        };
        var snapshots = new List<ServerSchemaSource.LoadGraphModelSnapshotsResult>();

        var source = CreateSource(entities, snapshots);

        var info = await source.GetDatabaseInfoAsync(TestCluster, TestDatabase, null, CancellationToken.None);

        Assert.IsNotNull(info);
        Assert.AreEqual(TestDatabase, info.Name);
        Assert.HasCount(1, info.GraphModels);
    }

    #region Helpers

    private static ServerSchemaSource CreateSource(
        IEnumerable<DatabasesEntitiesShowCommandResult> entities,
        IEnumerable<ServerSchemaSource.LoadGraphModelSnapshotsResult> snapshots)
    {
        var connection = new TestConnection(TestCluster, TestDatabase)
        {
            EntitiesResult = entities.ToImmutableList(),
            GraphSnapshotsResult = snapshots.ToImmutableList(),
            DatabaseIdentityResult = ImmutableList.Create(
                new ServerSchemaSource.DatabaseNamesResult
                {
                    DatabaseName = TestDatabase,
                    PrettyName = TestDatabase,
                }),
        };

        var manager = new TestConnectionManager(connection);
        return new ServerSchemaSource(manager, logger: null);
    }

    private static DatabasesEntitiesShowCommandResult CreateGraphEntity(string name, string content)
    {
        return new DatabasesEntitiesShowCommandResult
        {
            DatabaseName = TestDatabase,
            EntityType = "Graph",
            EntityName = name,
            Content = content,
            DocString = null,
            Folder = null,
            CslInputSchema = null,
            CslOutputSchema = null,
        };
    }

    #endregion

    #region Test Doubles

    private sealed class TestConnectionManager : IConnectionManager
    {
        private readonly IConnection _connection;

        public TestConnectionManager(IConnection connection)
        {
            _connection = connection;
        }

        public IConnection GetOrAddConnection(string connectionStrings) => _connection;

        public bool TryGetConnection(string clusterName, [NotNullWhen(true)] out IConnection? connection)
        {
            connection = _connection;
            return true;
        }
    }

    private sealed class TestConnection : IConnection
    {
        public TestConnection(string cluster, string? database)
        {
            Cluster = cluster;
            Database = database;
        }

        public string Cluster { get; }
        public string? Database { get; }

        public ImmutableList<DatabasesEntitiesShowCommandResult> EntitiesResult { get; set; }
            = ImmutableList<DatabasesEntitiesShowCommandResult>.Empty;

        public ImmutableList<ServerSchemaSource.LoadGraphModelSnapshotsResult> GraphSnapshotsResult { get; set; }
            = ImmutableList<ServerSchemaSource.LoadGraphModelSnapshotsResult>.Empty;

        public ImmutableList<ServerSchemaSource.DatabaseNamesResult> DatabaseIdentityResult { get; set; }
            = ImmutableList<ServerSchemaSource.DatabaseNamesResult>.Empty;

        public IConnection WithCluster(string clusterName) => this;
        public IConnection WithDatabase(string databaseName) => this;

        public Task<ExecuteResult> ExecuteAsync(
            EditString query,
            ImmutableDictionary<string, string>? options = null,
            ImmutableDictionary<string, string>? parameters = null,
            string? clientRequestId = null,
            CancellationToken cancellationToken = default)
        {
            return Task.FromResult(new ExecuteResult());
        }

        public Task<ExecuteResult<T>> ExecuteAsync<T>(
            EditString query,
            ImmutableDictionary<string, string>? options = null,
            ImmutableDictionary<string, string>? parameters = null,
            CancellationToken cancellationToken = default)
        {
            object? values = null;

            if (typeof(T) == typeof(DatabasesEntitiesShowCommandResult))
            {
                values = EntitiesResult;
            }
            else if (typeof(T) == typeof(ServerSchemaSource.LoadGraphModelSnapshotsResult))
            {
                values = GraphSnapshotsResult;
            }
            else if (typeof(T) == typeof(ServerSchemaSource.DatabaseNamesResult))
            {
                values = DatabaseIdentityResult;
            }

            var result = new ExecuteResult<T>
            {
                Values = (ImmutableList<T>?)values,
            };
            return Task.FromResult(result);
        }

        public Task<string> GetServerKindAsync(CancellationToken cancellationToken)
            => Task.FromResult("Engine");
    }

    #endregion
}
