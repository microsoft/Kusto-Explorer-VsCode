// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using Kusto.Language;
using Kusto.Language.Symbols;
using Kusto.Vscode;

namespace Tests.Utilities;

[TestClass]
public class ConnectionFactsTests
{
    private const string DefaultDomain = ".kusto.windows.net";

    #region GetFullHostName - Cluster Name Tests

    [TestMethod]
    public void GetFullHostName_ShortClusterName_AppendsDomain()
    {
        var result = ConnectionFacts.GetFullHostName("mycluster", DefaultDomain);

        Assert.AreEqual("mycluster.kusto.windows.net", result);
    }

    [TestMethod]
    public void GetFullHostName_FullHostName_ReturnsAsIs()
    {
        var result = ConnectionFacts.GetFullHostName("mycluster.kusto.windows.net", DefaultDomain);

        Assert.AreEqual("mycluster.kusto.windows.net", result);
    }

    [TestMethod]
    public void GetFullHostName_DifferentDomain_ReturnsAsIs()
    {
        // If the cluster already has a domain, it should not be replaced
        var result = ConnectionFacts.GetFullHostName("mycluster.eastus.kusto.windows.net", DefaultDomain);

        Assert.AreEqual("mycluster.eastus.kusto.windows.net", result);
    }

    #endregion

    #region GetFullHostName - URI Tests

    [TestMethod]
    public void GetFullHostName_HttpsUri_ExtractsHostName()
    {
        var result = ConnectionFacts.GetFullHostName("https://mycluster.kusto.windows.net", DefaultDomain);

        Assert.AreEqual("mycluster.kusto.windows.net", result);
    }

    [TestMethod]
    public void GetFullHostName_HttpsUriWithPath_ExtractsHostName()
    {
        var result = ConnectionFacts.GetFullHostName("https://mycluster.kusto.windows.net/mydb", DefaultDomain);

        Assert.AreEqual("mycluster.kusto.windows.net", result);
    }

    [TestMethod]
    public void GetFullHostName_HttpsUriShortName_AppendsDomain()
    {
        // URI with just cluster name (no domain)
        var result = ConnectionFacts.GetFullHostName("https://mycluster", DefaultDomain);

        Assert.AreEqual("mycluster.kusto.windows.net", result);
    }

    #endregion

    #region GetFullHostName - Custom Domain Tests

    [TestMethod]
    public void GetFullHostName_CustomDefaultDomain_AppendsCustomDomain()
    {
        var result = ConnectionFacts.GetFullHostName("mycluster", ".kusto.azure.com");

        Assert.AreEqual("mycluster.kusto.azure.com", result);
    }

    [TestMethod]
    public void GetFullHostName_AriaDomain_AppendsAriaDomain()
    {
        var result = ConnectionFacts.GetFullHostName("mycluster", ".kusto.aria.microsoft.com");

        Assert.AreEqual("mycluster.kusto.aria.microsoft.com", result);
    }

    #endregion

    #region GetFullHostName - Edge Cases

    [TestMethod]
    public void GetFullHostName_EmptyString_ReturnsWithDomain()
    {
        var result = ConnectionFacts.GetFullHostName("", DefaultDomain);

        // Empty names are always empty, even with a domain appended
        Assert.AreEqual("", result);
    }

    [TestMethod]
    public void GetFullHostName_ClusterWithPort_HandlesPort()
    {
        var result = ConnectionFacts.GetFullHostName("https://mycluster.kusto.windows.net:443", DefaultDomain);

        Assert.AreEqual("mycluster.kusto.windows.net", result);
    }

    #endregion

    #region Resource-Scoped Proxy Cluster URIs (issue #139)

    private const string WorkspaceUri =
        "https://ade.loganalytics.io/subscriptions/sub-1/resourcegroups/rg-1/providers/microsoft.operationalinsights/workspaces/my-workspace";

    private const string ComponentUri =
        "https://ade.applicationinsights.io/subscriptions/sub-1/resourcegroups/rg-1/providers/microsoft.insights/components/my-app";

    [TestMethod]
    public void TryGetResourceScopedClusterUri_LogAnalyticsWorkspace_ReturnsFullUri()
    {
        Assert.AreEqual(WorkspaceUri, ConnectionFacts.TryGetResourceScopedClusterUri(WorkspaceUri));
    }

    [TestMethod]
    public void TryGetResourceScopedClusterUri_ApplicationInsightsComponent_ReturnsFullUri()
    {
        Assert.AreEqual(ComponentUri, ConnectionFacts.TryGetResourceScopedClusterUri(ComponentUri));
    }

    [TestMethod]
    public void TryGetResourceScopedClusterUri_PlainClusterUri_ReturnsNull()
    {
        Assert.IsNull(ConnectionFacts.TryGetResourceScopedClusterUri("https://mycluster.kusto.windows.net"));
    }

    [TestMethod]
    public void TryGetResourceScopedClusterUri_SinglePathSegment_ReturnsNull()
    {
        // A single segment is a database (https://cluster/mydb), not a resource path.
        Assert.IsNull(ConnectionFacts.TryGetResourceScopedClusterUri("https://help.kusto.windows.net/Samples"));
    }

    [TestMethod]
    public void TryGetResourceScopedClusterUri_BareHostName_ReturnsNull()
    {
        Assert.IsNull(ConnectionFacts.TryGetResourceScopedClusterUri("ade.loganalytics.io"));
    }

    [TestMethod]
    public void GetClusterSymbolName_ResourceScopedUri_ReducesToHost()
    {
        Assert.AreEqual("ade.loganalytics.io", ConnectionFacts.GetClusterSymbolName(WorkspaceUri));
        Assert.AreEqual("ade.applicationinsights.io", ConnectionFacts.GetClusterSymbolName(ComponentUri));
    }

    [TestMethod]
    public void GetClusterSymbolName_OrdinaryClusterName_ReturnsUnchanged()
    {
        Assert.AreEqual("mycluster", ConnectionFacts.GetClusterSymbolName("mycluster"));
        Assert.AreEqual("mycluster.kusto.windows.net", ConnectionFacts.GetClusterSymbolName("mycluster.kusto.windows.net"));
        Assert.AreEqual("https://mycluster.kusto.windows.net", ConnectionFacts.GetClusterSymbolName("https://mycluster.kusto.windows.net"));
    }

    [TestMethod]
    public void GlobalStateGetCluster_NormalizesLookupKeyToHost()
    {
        // Pins the Kusto.Language constraint that forces GetClusterSymbolName to exist.
        // If this ever starts finding the URI-named symbol, the reduction to a host name
        // (and the schema-symbol collision it causes) can be revisited.
        var uriNamed = GlobalState.Default.AddOrReplaceCluster(new ClusterSymbol(WorkspaceUri, [], isOpen: true));
        Assert.IsNull(uriNamed.GetCluster(WorkspaceUri), "A cluster symbol named with a full proxy URI is expected to be unfindable.");

        var hostNamed = GlobalState.Default.AddOrReplaceCluster(new ClusterSymbol("ade.loganalytics.io", [], isOpen: true));
        Assert.IsNotNull(hostNamed.GetCluster("ade.loganalytics.io"));
        Assert.IsNotNull(hostNamed.GetCluster(WorkspaceUri), "A host-named symbol is expected to resolve from the full proxy URI.");
    }

    #endregion
}
