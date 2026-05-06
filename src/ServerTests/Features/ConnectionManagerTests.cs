// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using System.Reflection;
using Kusto.Data;
using Kusto.Vscode;

namespace Tests.Features;

[TestClass]
public class ConnectionManagerTests
{
    #region GetOrAddConnection Tests

    [TestMethod]
    public void GetOrAddConnection_SimpleClusterUrl_ReturnsConnection()
    {
        var manager = new ConnectionManager();

        var connection = manager.GetOrAddConnection("https://mycluster.kusto.windows.net");

        Assert.IsNotNull(connection);
        Assert.AreEqual("mycluster.kusto.windows.net", connection.Cluster);
    }

    [TestMethod]
    public void GetOrAddConnection_ClusterUrlWithDatabase_ReturnsConnectionWithDatabase()
    {
        var manager = new ConnectionManager();

        var connection = manager.GetOrAddConnection("https://mycluster.kusto.windows.net/mydb");

        Assert.IsNotNull(connection);
        Assert.AreEqual("mycluster.kusto.windows.net", connection.Cluster);
        Assert.AreEqual("mydb", connection.Database);
    }

    [TestMethod]
    public void GetOrAddConnection_ConnectionString_ReturnsConnection()
    {
        var manager = new ConnectionManager();

        var connection = manager.GetOrAddConnection("Data Source=https://mycluster.kusto.windows.net;Initial Catalog=mydb");

        Assert.IsNotNull(connection);
        Assert.AreEqual("mycluster.kusto.windows.net", connection.Cluster);
        Assert.AreEqual("mydb", connection.Database);
    }

    [TestMethod]
    public void GetOrAddConnection_SameConnectionString_ReturnsSameConnection()
    {
        var manager = new ConnectionManager();
        var connectionString = "https://mycluster.kusto.windows.net";

        var connection1 = manager.GetOrAddConnection(connectionString);
        var connection2 = manager.GetOrAddConnection(connectionString);

        Assert.AreSame(connection1, connection2);
    }

    #endregion

    #region TryGetConnection Tests

    [TestMethod]
    public void TryGetConnection_AfterAdd_ReturnsTrue()
    {
        var manager = new ConnectionManager();
        manager.GetOrAddConnection("https://mycluster.kusto.windows.net");

        var found = manager.TryGetConnection("mycluster.kusto.windows.net", out var connection);

        Assert.IsTrue(found);
        Assert.IsNotNull(connection);
        Assert.AreEqual("mycluster.kusto.windows.net", connection.Cluster);
    }

    [TestMethod]
    public void TryGetConnection_ShortName_ReturnsTrue()
    {
        var manager = new ConnectionManager();
        manager.GetOrAddConnection("https://mycluster.kusto.windows.net");

        // Should find by short name too
        var found = manager.TryGetConnection("mycluster", out var connection);

        Assert.IsTrue(found);
        Assert.IsNotNull(connection);
    }

    [TestMethod]
    public void TryGetConnection_NotAdded_ReturnsFalse()
    {
        var manager = new ConnectionManager();

        var found = manager.TryGetConnection("nonexistent.kusto.windows.net", out var connection);

        Assert.IsFalse(found);
        Assert.IsNull(connection);
    }

    #endregion

    #region IConnection.WithCluster Tests

    [TestMethod]
    public void WithCluster_ReturnsNewConnectionWithDifferentCluster()
    {
        var manager = new ConnectionManager();
        var connection = manager.GetOrAddConnection("https://cluster1.kusto.windows.net/mydb");

        var newConnection = connection.WithCluster("cluster2");

        Assert.AreNotSame(connection, newConnection);
        Assert.AreEqual("cluster2.kusto.windows.net", newConnection.Cluster);
    }

    [TestMethod]
    public void WithCluster_FullHostName_ReturnsConnectionWithFullHostName()
    {
        var manager = new ConnectionManager();
        var connection = manager.GetOrAddConnection("https://cluster1.kusto.windows.net");

        var newConnection = connection.WithCluster("cluster2.eastus.kusto.windows.net");

        Assert.AreEqual("cluster2.eastus.kusto.windows.net", newConnection.Cluster);
    }

    [TestMethod]
    public void WithCluster_OriginalConnectionUnchanged()
    {
        var manager = new ConnectionManager();
        var connection = manager.GetOrAddConnection("https://cluster1.kusto.windows.net");

        connection.WithCluster("cluster2");

        Assert.AreEqual("cluster1.kusto.windows.net", connection.Cluster);
    }

    #endregion

    #region IConnection.WithDatabase Tests

    [TestMethod]
    public void WithDatabase_ReturnsNewConnectionWithDifferentDatabase()
    {
        var manager = new ConnectionManager();
        var connection = manager.GetOrAddConnection("https://mycluster.kusto.windows.net/db1");

        var newConnection = connection.WithDatabase("db2");

        Assert.AreNotSame(connection, newConnection);
        Assert.AreEqual("db2", newConnection.Database);
        Assert.AreEqual("mycluster.kusto.windows.net", newConnection.Cluster);
    }

    [TestMethod]
    public void WithDatabase_OriginalConnectionUnchanged()
    {
        var manager = new ConnectionManager();
        var connection = manager.GetOrAddConnection("https://mycluster.kusto.windows.net/db1");

        connection.WithDatabase("db2");

        Assert.AreEqual("db1", connection.Database);
    }

    [TestMethod]
    public void WithDatabase_NoOriginalDatabase_SetsDatabase()
    {
        var manager = new ConnectionManager();
        var connection = manager.GetOrAddConnection("https://mycluster.kusto.windows.net");

        var newConnection = connection.WithDatabase("mydb");

        Assert.AreEqual("mydb", newConnection.Database);
    }

    #endregion

    #region IConnection.WithClusterAndDatabase Tests

    [TestMethod]
    public void WithClusterAndDatabase_ReturnsBothChanged()
    {
        var manager = new ConnectionManager();
        var connection = manager.GetOrAddConnection("https://cluster1.kusto.windows.net/db1");

        var newConnection = connection.WithClusterAndDatabase("cluster2", "db2");

        Assert.AreEqual("cluster2.kusto.windows.net", newConnection.Cluster);
        Assert.AreEqual("db2", newConnection.Database);
    }

    [TestMethod]
    public void WithClusterAndDatabase_NullDatabase_OnlyChangesCluster()
    {
        var manager = new ConnectionManager();
        var connection = manager.GetOrAddConnection("https://cluster1.kusto.windows.net/db1");

        var newConnection = connection.WithClusterAndDatabase("cluster2", null);

        Assert.AreEqual("cluster2.kusto.windows.net", newConnection.Cluster);
        // Database should be reset to the default for the new cluster connection
    }

    [TestMethod]
    public void WithClusterAndDatabase_OriginalConnectionUnchanged()
    {
        var manager = new ConnectionManager();
        var connection = manager.GetOrAddConnection("https://cluster1.kusto.windows.net/db1");

        connection.WithClusterAndDatabase("cluster2", "db2");

        Assert.AreEqual("cluster1.kusto.windows.net", connection.Cluster);
        Assert.AreEqual("db1", connection.Database);
    }

    #endregion

    #region IConnectionManager.TryGetConnection with Database Tests

    [TestMethod]
    public void TryGetConnection_WithDatabase_ReturnsConnectionWithDatabase()
    {
        var manager = new ConnectionManager();
        manager.GetOrAddConnection("https://mycluster.kusto.windows.net");

        // Use interface to access default implementation
        IConnectionManager connectionManager = manager;
        var found = connectionManager.TryGetConnection("mycluster", "mydb", out var connection);

        Assert.IsTrue(found);
        Assert.IsNotNull(connection);
        Assert.AreEqual("mydb", connection.Database);
    }

    [TestMethod]
    public void TryGetConnection_WithContextCluster_ReturnsConnectionDerivedFromContext()
    {
        var manager = new ConnectionManager();
        manager.GetOrAddConnection("https://cluster1.kusto.windows.net");

        // Use interface to access default implementation
        // Get cluster2 connection using cluster1 as context (inherits auth settings)
        IConnectionManager connectionManager = manager;
        var found = connectionManager.TryGetConnection("cluster2", "mydb", "cluster1.kusto.windows.net", out var connection);

        Assert.IsTrue(found);
        Assert.IsNotNull(connection);
        Assert.AreEqual("cluster2.kusto.windows.net", connection.Cluster);
        Assert.AreEqual("mydb", connection.Database);
    }

    #endregion

    #region Connection Chaining Tests

    [TestMethod]
    public void ConnectionChaining_MultipleWithCalls_ProducesCorrectResult()
    {
        var manager = new ConnectionManager();
        var connection = manager.GetOrAddConnection("https://cluster1.kusto.windows.net/db1");

        var newConnection = connection
            .WithCluster("cluster2")
            .WithDatabase("db2")
            .WithDatabase("db3");

        Assert.AreEqual("cluster2.kusto.windows.net", newConnection.Cluster);
        Assert.AreEqual("db3", newConnection.Database);
    }

    #endregion

    #region IAuthenticationProvider Tests

    private sealed class CountingAuthProvider : IAuthenticationProvider
    {
        public int CallCount;
        public string? LastClusterUri;
        public string? Token = "test-access-token";

        public Task<string?> GetAccessTokenAsync(string clusterUri, CancellationToken cancellationToken)
        {
            CallCount++;
            LastClusterUri = clusterUri;
            return Task.FromResult(Token);
        }
    }

    /// <summary>
    /// Reads the named non-public property from the internal <c>KustoConnection</c>
    /// wrapper. Used to verify how the connection has wired up authentication
    /// without actually executing a query against a real cluster. Reading the
    /// property (rather than a private field) keeps these tests decoupled from
    /// internal field naming.
    /// </summary>
    private static KustoConnectionStringBuilder? GetBuilderProperty(IConnection connection, string propertyName)
    {
        var prop = connection.GetType().GetProperty(propertyName, BindingFlags.Instance | BindingFlags.NonPublic);
        Assert.IsNotNull(prop, $"Expected KustoConnection to expose an internal {propertyName} property.");
        return prop!.GetValue(connection) as KustoConnectionStringBuilder;
    }

    private static KustoConnectionStringBuilder? GetFallbackBuilder(IConnection connection)
        => GetBuilderProperty(connection, "FallbackBuilder");

    private static void MarkFallbackRequired(ConnectionManager manager, string clusterHostName)
    {
        var method = typeof(ConnectionManager).GetMethod("MarkFallbackRequired", BindingFlags.Instance | BindingFlags.NonPublic);
        Assert.IsNotNull(method, "Expected ConnectionManager to expose an internal MarkFallbackRequired method.");
        method!.Invoke(manager, new object[] { clusterHostName });
    }

    [TestMethod]
    public void PrimaryBuilder_NeverHasTokenProviderCallback()
    {
        // The primary builder always uses Kusto.Data's native authentication
        // path (WAM/MSAL/SSO) - the host-bridged auth provider is only used
        // as a fallback after native auth fails. So even when an
        // IAuthenticationProvider is registered, the primary builder must
        // not have a TokenProviderCallback installed.
        var auth = new CountingAuthProvider();
        var manager = new ConnectionManager(auth);

        var connection = manager.GetOrAddConnection("https://mycluster.kusto.windows.net");

        var primary = GetBuilderProperty(connection, "PrimaryBuilder");
        Assert.IsNotNull(primary);
        Assert.IsNull(primary!.TokenProviderCallback,
            "Primary builder must use native authentication, not host-bridged.");
        Assert.AreEqual(0, auth.CallCount,
            "Provider must not be invoked while the cluster is on the native auth path.");
    }

    [TestMethod]
    public void FallbackBuilder_AvailableWhenAuthProviderIsSupplied()
    {
        var auth = new CountingAuthProvider();
        var manager = new ConnectionManager(auth);

        var connection = manager.GetOrAddConnection("https://mycluster.kusto.windows.net");

        var fallback = GetFallbackBuilder(connection);
        Assert.IsNotNull(fallback, "Fallback builder should be available when an IAuthenticationProvider is supplied.");
        Assert.IsNotNull(fallback!.TokenProviderCallback,
            "Fallback builder must route authentication through the host-supplied provider.");
    }

    [TestMethod]
    public async Task FallbackBuilder_CallbackInvokesProvider()
    {
        var auth = new CountingAuthProvider();
        var manager = new ConnectionManager(auth);

        var connection = manager.GetOrAddConnection("https://mycluster.kusto.windows.net");
        var fallback = GetFallbackBuilder(connection);
        Assert.IsNotNull(fallback);

        // Simulate Kusto.Data asking the fallback builder for a token.
        var token = await fallback!.TokenProviderCallback!();

        Assert.AreEqual(1, auth.CallCount, "Provider should be called exactly once per token request.");
        Assert.AreEqual("https://mycluster.kusto.windows.net", auth.LastClusterUri);
        Assert.AreEqual("test-access-token", token);
    }

    [TestMethod]
    public async Task FallbackBuilder_NullToken_CallbackThrows()
    {
        var auth = new CountingAuthProvider { Token = null };
        var manager = new ConnectionManager(auth);

        var connection = manager.GetOrAddConnection("https://mycluster.kusto.windows.net");
        var fallback = GetFallbackBuilder(connection);
        Assert.IsNotNull(fallback);

        await Assert.ThrowsExactlyAsync<InvalidOperationException>(
            async () => await fallback!.TokenProviderCallback!());
        Assert.AreEqual(1, auth.CallCount);
    }

    [TestMethod]
    public void FallbackBuilder_NotAvailableWithoutAuthProvider()
    {
        var manager = new ConnectionManager();

        var connection = manager.GetOrAddConnection("https://mycluster.kusto.windows.net");

        var fallback = GetFallbackBuilder(connection);
        Assert.IsNull(fallback,
            "Without an IAuthenticationProvider there is no fallback builder.");
    }

    [TestMethod]
    public void FallbackBuilder_NotAvailableWhenConnectionStringHasExplicitAuth()
    {
        var auth = new CountingAuthProvider();
        var manager = new ConnectionManager(auth);

        var connection = manager.GetOrAddConnection(
            "Data Source=https://mycluster.kusto.windows.net;AppClientId=client;AppKey=secret;Authority Id=tenant");

        var fallback = GetFallbackBuilder(connection);
        Assert.IsNull(fallback,
            "Explicit credentials in the connection string suppress the fallback path.");
        Assert.AreEqual(0, auth.CallCount);
    }

    [TestMethod]
    public void ActiveBuilder_SwitchesToFallback_WhenClusterIsMarked()
    {
        var auth = new CountingAuthProvider();
        var manager = new ConnectionManager(auth);

        var connection = manager.GetOrAddConnection("https://mycluster.kusto.windows.net");

        // Before marking: the active builder is the primary (native auth).
        var beforeBuilder = GetBuilderProperty(connection, "PrimaryBuilder");
        Assert.IsNotNull(beforeBuilder);
        var activeBefore = GetBuilderProperty(connection, "Builder");
        Assert.AreSame(beforeBuilder, activeBefore,
            "Before fallback is required, the active builder is the primary builder.");

        // Simulate the auth-failure retry path marking the cluster.
        MarkFallbackRequired(manager, "mycluster.kusto.windows.net");

        var fallback = GetFallbackBuilder(connection);
        var activeAfter = GetBuilderProperty(connection, "Builder");
        Assert.AreSame(fallback, activeAfter,
            "After the cluster is marked, the active builder is the fallback builder.");
    }

    #endregion
}
