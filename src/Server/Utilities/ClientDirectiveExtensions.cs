// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using Kusto.Data;
using Kusto.Language;
using Kusto.Language.Editor;
using System.Collections.Immutable;

namespace Kusto.Vscode;

public static class ClientDirectiveExtensions
{
    /// <summary>
    /// Gets the connection information from the connect or database directive.
    /// </summary>
    public static bool TryGetConnectionInfo(
        this ClientDirective directive, out string? connection, out string? clusterName, out string? databaseName)
    {
        connection = null;
        clusterName = null;
        databaseName = null;

        if (directive.Name == "database")
        {
            if (directive.Arguments.Count > 1)
            {
                clusterName = GetDirectiveArgumentStringValue(directive.Arguments[0]);
                databaseName = GetDirectiveArgumentStringValue(directive.Arguments[1]);
                return true;
            }
            else if (directive.Arguments.Count == 1)
            {
                var arg = GetDirectiveArgumentStringValue(directive.Arguments[0]);
                KustoFacts.GetHostAndPath(arg, out var hostname, out var path);
                if (hostname != null && path != null)
                {
                    clusterName = hostname;
                    databaseName = path;
                    return true;
                }
                else if (hostname != null)
                {
                    clusterName = null;
                    databaseName = hostname;
                    return true;
                }
            }
        }
        else if (directive.Name == "connect" && directive.Arguments.Count > 0)
        {
            var arg = directive.Arguments[0];
            if (arg.Text.StartsWith("cluster"))
            {
                var cluster = GetStringValueAfterPrefix(arg.Text, "cluster(", 0, out var end);
                if (cluster != null)
                {
                    KustoFacts.GetHostAndPath(cluster, out clusterName, out var path);
                    if (ConnectionFacts.TryGetResourceScopedClusterUri(cluster) is { } resourceUri)
                    {
                        clusterName = resourceUri;
                        path = null;
                    }
                    databaseName = GetStringValueAfterPrefix(arg.Text, "database(", end, out _)
                        ?? path;
                    return clusterName != null;
                }
            }
            else if (!arg.Text.StartsWith("@"))
            {
                connection = GetDirectiveArgumentStringValue(arg);
                var builder = new KustoConnectionStringBuilder(connection);
                clusterName = ConnectionFacts.TryGetResourceScopedClusterUri(builder.DataSource) ?? builder.Hostname;
                databaseName = builder.InitialCatalog;
                return true;
            }
        }

        return false;
    }

    private static string? GetStringValueAfterPrefix(string text, string prefix, int start, out int end)
    {
        var index = text.IndexOf(prefix, start);
        if (index >= 0)
        {
            var wsLen = Kusto.Language.Parsing.TokenParser.ScanWhitespace(text, index + prefix.Length);
            var stringStart = index + prefix.Length + wsLen;
            if (Kusto.Language.Parsing.TokenParser.ScanStringLiteral(text, stringStart) is int len
                && len > 0)
            {
                var stringLiteral = text.Substring(stringStart, len);
                end = index + len;
                return KustoFacts.GetStringLiteralValue(stringLiteral);
            }
        }
        end = start;
        return null;
    }

    private static string GetDirectiveArgumentStringValue(ClientDirectiveArgument argument)
    {
        return argument.Value as string ?? "";
    }

    /// <summary>
    /// Gets the argument values from the directive as key value pairs.
    /// If the argument does not have a value, the item is removed from the set.
    /// </summary>
    public static ImmutableDictionary<string, string> GetArgumentPairs(this ClientDirective directive, ImmutableDictionary<string, string>? map = null)
    {
        map ??= ImmutableDictionary<string, string>.Empty;

        foreach (var arg in directive.Arguments)
        {
            if (arg.Name != null)
            {
                if (arg.Value != null)
                {
                    map = map.SetItem(arg.Name, arg.Value.ToString()!);
                }
                else
                {
                    map = map.Remove(arg.Name);
                }
            }
        }

        return map;
    }
}
