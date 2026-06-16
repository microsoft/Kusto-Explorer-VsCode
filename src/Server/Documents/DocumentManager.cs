// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using Kusto.Language.Editor;
using Kusto.Language.Symbols;
using System.Collections.Immutable;
using System.Diagnostics.CodeAnalysis;

namespace Kusto.Vscode;

/// <summary>
/// Tracks every open editor document (keyed by URI) and keeps its parsed
/// <see cref="Kusto.Language.Editor.CodeScript"/> in sync with two moving inputs: the document text
/// (as the user types) and the shared symbols (when <see cref="ISymbolManager.GlobalsChanged"/>
/// fires). It also remembers each document's cluster/database connection context so language
/// services analyze the query against the right schema. Editor features (diagnostics, completion,
/// hover, etc.) read documents from here rather than re-parsing, so parsing happens once per change.
/// </summary>
public class DocumentManager : IDocumentManager
{
    /// <summary>
    /// The maximum number of times the resolve operation
    /// can repeat resolving as long as symbols are updating.
    /// </summary>
    private const int MaxResolveLoopCount = 20;

    private readonly ISymbolManager _symbolManager;
    private readonly ILogger? _logger;

    private ImmutableDictionary<Uri, DocumentInfo> _idToInfoMap =
        ImmutableDictionary<Uri, DocumentInfo>.Empty;

    public DocumentManager(
        ISymbolManager symbolManager, 
        ILogger? logger = null)
    {
        _symbolManager = symbolManager;
        _logger = logger;

        // update scripts when global symbols change
        _symbolManager.GlobalsChanged += (_, _) =>
        {
            foreach (var id in _idToInfoMap.Keys)
            {
                UpdateGlobals(id);
            }
        };
    }

    public event EventHandler<Uri>? DocumentAdded;

    private void RaiseDocumentAdded(Uri id)
    {
        if (this.DocumentAdded != null)
        {
            Task.Run(() => this.DocumentAdded?.Invoke(this, id));
        }
    }

    public event EventHandler<Uri>? DocumentRemoved;

    private void RaiseDocumentRemoved(Uri id)
    {
        if (this.DocumentRemoved != null)
        {
            Task.Run(() => this.DocumentRemoved?.Invoke(this, id));
        }
    }

    /// <summary>
    /// An event that is raised when a script has changed (text or globals).
    /// </summary>
    public event EventHandler<Uri>? DocumentChanged;

    private void RaiseDocumentChanged(Uri id)
    {
        if (this.DocumentChanged != null)
        {
            Task.Run(() => this.DocumentChanged?.Invoke(this, id));
        }
    }

    class DocumentInfo
    {
        public Uri Id { get; }

        public required IDocument Document { get; set; }

        public string? ServerKind { get; set; }

        public string? Cluster { get; set; }

        public string? Database { get; set; }

        public readonly LatestRequestQueue EnsureSymbolsQueue = new();

        public readonly LatestRequestQueue ResolveSymbolsQueue = new();

        public DocumentInfo(Uri uri)
        {
            this.Id = uri;
        }
    }

    public ImmutableList<Uri> GetDocumentIds()
    {
        return _idToInfoMap.Keys.ToImmutableList();
    }

    /// <summary>
    /// Gets existing ScriptInfo or creates a new placeholder.
    /// </summary>
    private DocumentInfo GetOrCreateDocumentInfo(Uri id)
    {
        return ImmutableInterlocked.GetOrAdd(
            ref _idToInfoMap, id, 
            _ => new DocumentInfo(id) { Document = new SectionedDocument(id, "", _symbolManager.Globals) }
            );
    }

    public void AddDocument(Uri id, string text)
    {
        _logger?.Log($"DocumentManager: Adding document {id}");

        var info = GetOrCreateDocumentInfo(id);
        
        // Update script with actual text
        info.Document = info.Document.WithText(text);

        // If connection info was already set, ensure globals are loaded
        if (info.Cluster != null)
        {
            _ = EnsureConnectionSymbolsAsync(info);
        }

        RaiseDocumentAdded(id);
    }

    public void RemoveDocument(Uri id)
    {
        _logger?.Log($"DocumentManager: Removing document {id}");

        ImmutableInterlocked.TryRemove(ref _idToInfoMap, id, out _);
        RaiseDocumentRemoved(id);
    }

    /// <summary>
    /// Changes the cluster and database for the script.
    /// </summary>
    public Task UpdateConnectionAsync(Uri id, string? clusterName, string? databaseName, string? serverKind)
    {
        _logger?.Log($"DocumentManager: Updating document connection: {id} cluster: {clusterName ?? "<no-cluster>"} database: {databaseName ?? "<no-database>"}");

        var info = GetOrCreateDocumentInfo(id);
        
        // Update connection info
        info.Cluster = clusterName;
        info.Database = databaseName;
        info.ServerKind = serverKind;

        // update changes to the connection info in the document
        UpdateGlobals(info, raiseDocumentChanged: true);

        _ = EnsureConnectionSymbolsAsync(info);

        return Task.CompletedTask;
    }

    /// <summary>
    /// Gets the current cluster and database for the script.
    /// </summary>
    public DocumentConnection GetConnection(Uri documentId)
    {
        if (_idToInfoMap.TryGetValue(documentId, out var info))
        {
            return new DocumentConnection(info.Cluster, info.Database);
        }
        else
        {
            return new DocumentConnection(null, null);
        }
    }

    /// <summary>
    /// Ensures the symbols corresponding to the connection are available.
    /// </summary>
    private Task EnsureConnectionSymbolsAsync(DocumentInfo info)
    {
        _logger?.Log($"DocumentManager: Ensuring symbols for (cluster: {info.Cluster}, database: {info.Database})");

        // ensure symbols are loaded for this cluster and database
        return info.EnsureSymbolsQueue.Run(async (useThisCancellationToken) =>
        {
            if (info.Cluster != null)
            {
                await _symbolManager.EnsureClustersAsync([info.Cluster], contextCluster: null, useThisCancellationToken).ConfigureAwait(false);

                if (info.Database != null)
                {
                    await _symbolManager.EnsureDatabaseAsync(info.Cluster, info.Database, contextCluster: null, useThisCancellationToken);
                }
            }

            _ = ResolveSymbolsAsync(info);
        });
    }

    /// <summary>
    /// Change the text for the script.
    /// </summary>
    public Task UpdateTextAsync(Uri documentId, string newText)
    {
        if (_idToInfoMap.TryGetValue(documentId, out var info))
        {
            if (newText != info.Document.Text)
            {
                info.Document = info.Document.WithText(newText);

                RaiseDocumentChanged(documentId);

                return ResolveSymbolsAsync(info);
            }
        }

        return Task.CompletedTask;
    }

    /// <summary>
    /// Resolve symbols for this document.
    /// </summary>
    private Task ResolveSymbolsAsync(DocumentInfo info)
    {
        // resolve symbols for this script using latest request queue.
        return info.ResolveSymbolsQueue.Run(async (useThisCancellationToken) =>
        {
            await Task.Delay(TimeSpan.FromMilliseconds(100));
            await ResolveDeepAsync(info, useThisCancellationToken).ConfigureAwait(false);
        });

        // ensures symbols for all referenced symbols
        async Task ResolveDeepAsync(DocumentInfo info, CancellationToken cancellationToken)
        {
            // keep looping until no more changes are made to the globals
            for (int loopCount = 0; loopCount < MaxResolveLoopCount; loopCount++)
            {
                var initialGlobals = _symbolManager.Globals;
                await ResolveAsync(info.Document, cancellationToken).ConfigureAwait(false);
                if (_symbolManager.Globals.Clusters == initialGlobals.Clusters)
                    return;
                // copy current info into document globals if not already done
                UpdateGlobals(info, raiseDocumentChanged: false);
            }
        }

        // ensures symbols for all referenced symbols
        async Task ResolveAsync(IDocument document, CancellationToken cancellationToken)
        {
            var globals = document.Globals;
            var contextCluster = document.Globals.Cluster != ClusterSymbol.Unknown ? document.Globals.Cluster.Name : null;

            // find all explicit cluster('xxx') references
            var referencedClusterNames = document.GetClusterReferences(cancellationToken)
                .Select(cr => ConnectionFacts.GetFullHostName(cr.Cluster, globals.Domain))
                .Distinct()
                .ToList();

            foreach (var clusterName in referencedClusterNames)
            {
                var cluster = globals.GetCluster(clusterName);
                if (cluster == null || cluster.IsOpen)
                {
                    await _symbolManager.EnsureClustersAsync([clusterName], contextCluster, cancellationToken).ConfigureAwait(false);
                }
            }

            // find all explicit database('xxx') references
            var dbRefs = document.GetDatabaseReferences(cancellationToken)
                .Select(dbref => (Cluster: ConnectionFacts.GetFullHostName(dbref.Cluster, globals.Domain), Database: dbref.Database, ClusterRef: dbref.Cluster))
                .Distinct()
                .ToList();

            foreach (var dbRef in dbRefs)
            {
                var cluster = string.IsNullOrEmpty(dbRef.Cluster)
                    ? globals.Cluster
                    : globals.GetCluster(ConnectionFacts.GetFullHostName(dbRef.Cluster, globals.Domain));

                // don't rely on the user to do the right thing.
                if (cluster == null
                    || cluster == ClusterSymbol.Unknown
                    || string.IsNullOrEmpty(cluster.Name)
                    || string.IsNullOrEmpty(dbRef.Database))
                    continue;

                var db = cluster.GetDatabase(dbRef.Database);
                if (db == null || (db != null && db.Members.Count == 0 && db.IsOpen))
                {
                    await _symbolManager.EnsureDatabaseAsync(dbRef.Cluster, dbRef.Database, contextCluster, cancellationToken).ConfigureAwait(false);
                }
            }
        }
    }

    /// <summary>
    /// Refreshes schema for external symbols referenced by the document.
    /// </summary>
    public async Task RefreshReferencedSymbolsAsync(Uri documentId, CancellationToken cancellationToken)
    {
        if (_idToInfoMap.TryGetValue(documentId, out var info)
            && this.TryGetDocument(documentId, out var document))
        {
            // get list of unique database references in the document
            var dbRefs = document
                .GetDatabaseReferences(cancellationToken)
                .Select(dbr => (Cluster: ConnectionFacts.GetFullHostName(dbr.Cluster, document.Globals.Domain), dbr.Database))
                .OfType<(string Cluster, string? Database)>()
                .ToList();

            if (info.Cluster != null)
            {
                // add the document's current cluster and database if not already included in the references
                dbRefs.Add((info.Cluster, info.Database)!);
            }

            var distinctDbRefs = dbRefs
                .Distinct()
                .ToList();

            foreach (var dbRef in distinctDbRefs)
            {
                // Refresh the database symbol
                await _symbolManager.RefreshAsync(dbRef.Cluster, dbRef.Database, cancellationToken).ConfigureAwait(false);
            }
        }
    }

    /// <summary>
    /// Updates the document with the latest globals from the symbol manager.
    /// </summary>
    private void UpdateGlobals(Uri documentId)
    {
        if (_idToInfoMap.TryGetValue(documentId, out var info))
        {
            UpdateGlobals(info, raiseDocumentChanged: true);
        }
    }

    /// <summary>
    /// Updates the document with the latest globals from the symbol manager.
    /// </summary>
    private void UpdateGlobals(DocumentInfo info, bool raiseDocumentChanged)
    {
        var originalDoc = info.Document;

        // update script with latest symbols
        var newGlobals = originalDoc.Globals.WithClusterList(_symbolManager.Globals.Clusters);

        // set server kind (default to Engine if unknown)
        newGlobals = newGlobals.WithServerKind(info.ServerKind ?? Kusto.Language.ServerKinds.Engine);

        if (info.Cluster == null
            && newGlobals.Cluster != Language.Symbols.ClusterSymbol.Unknown)
        {
            newGlobals = newGlobals.WithCluster(Language.Symbols.ClusterSymbol.Unknown);
        }
        else if (info.Cluster != null
            && newGlobals.GetCluster(info.Cluster) is { } clusterSymbol
            && newGlobals.Cluster != clusterSymbol)
        {
            newGlobals = newGlobals.WithCluster(clusterSymbol);
        }

        if (info.Database == null
            && newGlobals.Database != Language.Symbols.DatabaseSymbol.Unknown)
        {
            newGlobals = newGlobals.WithDatabase(Language.Symbols.DatabaseSymbol.Unknown);
        }
        else if (info.Database != null
            && newGlobals.Cluster.GetDatabase(info.Database) is { } databaseSymbol
            && newGlobals.Database != databaseSymbol)
        {
            newGlobals = newGlobals.WithDatabase(databaseSymbol);
        }

        if (originalDoc.Globals != newGlobals)
        {
            var newDoc = originalDoc.WithGlobals(newGlobals);
            info.Document = newDoc;

            if (raiseDocumentChanged)
                RaiseDocumentChanged(info.Id);
        }
    }

    /// <summary>
    /// Gets the document for the given id.
    /// </summary>
    public bool TryGetDocument(Uri documentId, [NotNullWhen(true)] out IDocument? document)
    {
        if (_idToInfoMap.TryGetValue(documentId, out var info))
        {
            UpdateGlobals(info, raiseDocumentChanged: true);
            document = info.Document;
            return true;
        }
        document = null;
        return false;
    }
}