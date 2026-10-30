using Kusto.Language;
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

namespace Kusto.Vscode;

public static class ConnectionFacts
{
    /// <summary>
    /// Gets full host name (including domain) from a cluster name or URI.
    /// If the input is already a full host name, it is returned as is.
    /// If the input is a cluster name without a domain, the default domain is appended to it.
    /// If the input is a URI, the host name is extracted.
    /// </summary>
    public static string GetFullHostName(string clusterNameOrUri, string defaultDomain)
    {
        return KustoFacts.GetFullHostName(KustoFacts.GetHostName(clusterNameOrUri), defaultDomain);
    }

    /// <summary>
    /// Returns the resource-scoped cluster URI for an Azure Data Explorer proxy endpoint,
    /// or null when the host name alone is the routing identity.
    /// <para>
    /// Log Analytics and Application Insights are reached through the ADX proxy, and the
    /// routing target lives in the URI <em>path</em> rather than the host:
    /// <c>https://ade.loganalytics.io/subscriptions/{sub}/resourcegroups/{rg}/providers/microsoft.operationalinsights/workspaces/{workspace}</c>.
    /// Reducing such a URI to <c>ade.loganalytics.io</c> yields the proxy front door, which
    /// is not routable on its own.
    /// </para>
    /// <para>
    /// A <em>single</em> path segment is a database, not a resource path
    /// (<c>https://cluster/mydb</c>), matching how <c>KustoConnectionStringBuilder</c> parses
    /// it into the initial catalog, so only multi-segment paths are treated as resource scopes.
    /// </para>
    /// </summary>
    public static string? TryGetResourceScopedClusterUri(string? clusterNameOrUri)
    {
        if (string.IsNullOrEmpty(clusterNameOrUri)
            || !Uri.TryCreate(clusterNameOrUri, UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp))
        {
            return null;
        }

        var path = uri.AbsolutePath.Trim('/');
        return path.Contains('/')
            ? $"{uri.Scheme}://{uri.Authority}/{path}"
            : null;
    }

    /// <summary>
    /// Returns the name to use for a cluster <em>symbol</em>. Ordinary cluster names are
    /// returned unchanged; a resource-scoped proxy URI is reduced to its host.
    /// <para>
    /// Constraint this works around: <c>Kusto.Language</c>'s <c>GlobalState.GetCluster(name)</c>
    /// normalizes its lookup key to a host name. The obvious alternative - naming the symbol
    /// with the full proxy URI, so each workspace gets its own symbol - therefore produces a
    /// symbol that can never be found again. To check whether that still holds, add a
    /// <c>ClusterSymbol</c> named with a full resource-scoped URI to a <c>GlobalState</c> and
    /// look it up by that same URI: if it resolves, the normalization has been relaxed and
    /// this reduction is no longer required.
    /// </para>
    /// <para>
    /// Known consequence: every workspace behind one proxy front door shares a single cluster
    /// symbol, so schema/IntelliSense for a second workspace on the same host replaces the
    /// first. Query routing is unaffected - connections are keyed by the full URI.
    /// </para>
    /// </summary>
    public static string GetClusterSymbolName(string clusterNameOrUri)
    {
        return TryGetResourceScopedClusterUri(clusterNameOrUri) != null
            ? KustoFacts.GetHostName(clusterNameOrUri)
            : clusterNameOrUri;
    }
}