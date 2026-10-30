// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using Kusto.Language;
using Kusto.Language.Editor;
using Kusto.Language.Symbols;
using System.Collections.Immutable;

namespace Kusto.Vscode;

/// <summary>
/// Owns the shared <see cref="Kusto.Language.Symbols.GlobalState"/> that the Kusto parser needs to
/// resolve names (clusters, databases, tables, functions). It turns the raw schema from
/// <see cref="ISchemaManager"/> into parser symbols and publishes a single, immutable globals
/// snapshot via <see cref="GlobalsChanged"/>, which downstream consumers (documents, diagnostics,
/// completion) react to. All loads run through a <see cref="TaskQueue"/> so concurrent requests
/// can't race while mutating the globals — the global state has exactly one writer.
/// </summary>
public class SymbolManager : ISymbolManager
{
    private readonly ISchemaManager _schemaManager;
    private readonly IOptionsManager _optionsManager;
    private readonly ILogger? _logger;

    /// <summary>
    /// Task Queue to serialize symbol loading and resolution requests,
    /// and protect updates to the global state.
    /// </summary>
    private readonly TaskQueue _taskQueue = new TaskQueue();

    public SymbolManager(
        ISchemaManager schemaManager, 
        IOptionsManager optionsManager,
        ILogger? logger = null)
    {
        _schemaManager = schemaManager;
        _optionsManager = optionsManager;
        _logger = logger;

        _optionsManager.OptionsChanged += _optionsManager_OptionsChanged;
    }

    private void _optionsManager_OptionsChanged(object? sender, EventArgs e)
    {
        var newGlobals = this.Globals.WithDomain(_optionsManager.DefaultDomain);
        this.SetGlobals(newGlobals);
    }

    public GlobalState Globals { get; private set; } = GlobalState.Default;

    /// <summary>
    /// Event when globals have changed
    /// </summary>
    public event EventHandler<GlobalState>? GlobalsChanged;

    /// <summary>
    /// Update the shared globals and notify listeners.
    /// </summary>
    private void SetGlobals(GlobalState newGlobals)
    {
        newGlobals = newGlobals.WithDomain(_optionsManager.DefaultDomain);

        if (newGlobals != this.Globals)
        {
            _logger?.Log("SymbolManager: globals updated");

            this.Globals = newGlobals;

            if (this.GlobalsChanged != null)
            {
                // Notify listeners asynchronously
                Task.Run(() =>
                {
                    this.GlobalsChanged?.Invoke(this, newGlobals);
                });
            }
        }
    }

    public async Task RefreshAsync(string clusterName, string? databaseName, CancellationToken cancellationToken)
    {
        await _taskQueue.Run(cancellationToken, async (useThisCancellationToken) =>
        {
            var newGlobals = this.Globals;

            var clusterSymbol = newGlobals.GetCluster(clusterName);
            if (clusterSymbol != null && !clusterSymbol.IsOpen)
            {
                if (databaseName == null)
                {
                    _logger?.Log($"SymbolManager: refreshing symbols for cluster '{clusterName}'");

                    // clear schema so we when re-added the cluster symbol is rebuilt from fresh schema
                    await _schemaManager.ClearCachedClusterAsync(clusterName, useThisCancellationToken).ConfigureAwait(false);

                    // replace with new empty/open cluster 
                    newGlobals = this.Globals.AddOrReplaceCluster(new ClusterSymbol(ConnectionFacts.GetClusterSymbolName(clusterName), [], isOpen: true));
                    newGlobals = await this.AddClusterAsync(newGlobals, clusterName, contextCluster: null, useThisCancellationToken).ConfigureAwait(false);

                    // re-add previously loaded databases
                    foreach (var db in clusterSymbol.Databases)
                    {
                        if (!db.IsOpen)
                        {
                            newGlobals = await this.AddDatabaseAsync(newGlobals, clusterName, db.Name, contextCluster: null, useThisCancellationToken).ConfigureAwait(false);
                        }
                    }
                }
                else
                {
                    _logger?.Log($"SymbolManager: refreshing symbols for database '{databaseName}'");

                    // clear schema so when re-added the database symbol will be built from fresh schema
                    await _schemaManager.ClearCachedDatabaseAsync(clusterName, databaseName, useThisCancellationToken).ConfigureAwait(false);

                    var db = clusterSymbol.GetDatabase(databaseName);
                    if (db != null && !db.IsOpen)
                    {
                        // reset to open database
                        var newCluster = clusterSymbol.AddOrUpdateDatabase(new DatabaseSymbol(db.Name, db.AlternateName, null, isOpen: true));
                        newGlobals = newGlobals.AddOrReplaceCluster(newCluster);
                    }

                    newGlobals = await this.AddDatabaseAsync(newGlobals, clusterName, databaseName, contextCluster: null, useThisCancellationToken).ConfigureAwait(false);
                }
            }

            SetGlobals(newGlobals);
        });
    }

    /// <summary>
    /// Loads symbols associated with the given cluster and database into the managed global state.
    /// </summary>
    public Task EnsureDatabaseAsync(string clusterName, string databaseName, string? contextCluster, CancellationToken cancellationToken)
    {
        return _taskQueue.Run(cancellationToken, async (useThisCancellationToken) =>
        {
            var globals = this.Globals;

            _logger?.Log($"SymbolManager: Ensuring symbols for cluster '{clusterName}', database '{databaseName}'");

            try
            {
                var clusterSymbol = globals.GetCluster(clusterName);
                if (clusterSymbol == null || clusterSymbol.IsOpen)
                {
                    globals = await this.AddClusterAsync(globals, clusterName, contextCluster, useThisCancellationToken).ConfigureAwait(false);
                    clusterSymbol = globals.GetCluster(clusterName);
                }

                if (clusterSymbol != null)
                {
                    var databaseSymbol = clusterSymbol.GetDatabase(databaseName);
                    if (databaseSymbol == null || databaseSymbol.IsOpen)
                    {
                        globals = await this.AddDatabaseAsync(globals, clusterName, databaseName, contextCluster, cancellationToken: useThisCancellationToken).ConfigureAwait(false);
                    }
                }

                SetGlobals(globals);
            }
            catch (Exception ex)
            {
                _logger?.Log($"SymbolManager: Error loading symbols for cluster '{clusterName}', database '{databaseName}': {ex.Message}");
            }
        });
    }

    private async Task<GlobalState> AddClusterAsync(GlobalState globals, string clusterName, string? contextCluster, CancellationToken cancellationToken)
    {
        var clusterSymbol = globals.GetCluster(clusterName);
        if (clusterSymbol == null || clusterSymbol.IsOpen)
        {
            var clusterInfo = await _schemaManager.GetClusterInfoAsync(clusterName, contextCluster, cancellationToken).ConfigureAwait(false);
            if (clusterInfo != null)
            {
                var openDatabases = clusterInfo.Databases.Select(db => new DatabaseSymbol(db.Name, db.AlternateName, null, isOpen: true)).ToList();
                // Schema is fetched with the full routing name (which may be a resource-scoped
                // proxy URI), but the symbol is named by host - see GetClusterSymbolName for the
                // GlobalState.GetCluster constraint that forces this and its known consequence.
                var newCluster = new ClusterSymbol(ConnectionFacts.GetClusterSymbolName(clusterName), openDatabases);
                globals = globals.AddOrReplaceCluster(newCluster);

                _logger?.Log($"SymbolManager: Added cluster symbol: {clusterName} databases: {openDatabases.Count}");
            }
            else
            {
                _logger?.Log($"SymbolManager: No cluster info found for cluster '{clusterName}'");
            }
        }

        return globals;
    }

    private async Task<GlobalState> AddDatabaseAsync(GlobalState globals, string clusterName, string databaseName, string? contextCluster, CancellationToken cancellationToken)
    {
        var clusterSymbol = globals.GetCluster(clusterName);
        if (clusterSymbol != null)
        {
            var databaseSymbol = clusterSymbol.GetDatabase(databaseName);
            if (databaseSymbol == null || databaseSymbol.IsOpen)
            {
                var databaseInfo = await _schemaManager.GetDatabaseInfoAsync(clusterName, databaseName, contextCluster, cancellationToken).ConfigureAwait(false);
                if (databaseInfo != null)
                {
                    var newDatabaseSymbol = databaseInfo.ToSymbol();
                    clusterSymbol = clusterSymbol.AddOrUpdateDatabase(newDatabaseSymbol);
                    globals = globals.AddOrReplaceCluster(clusterSymbol);

                    _logger?.Log($"SymbolManager: Added database symbol: {databaseInfo.Name} tables: {newDatabaseSymbol.Tables.Count}");
                }
                else
                {
                    _logger?.Log($"SymbolManager: No database info found for cluster '{clusterName}' database '{databaseName}'");
                }
            }
        }

        return globals;
    }

    /// <summary>
    /// Ensures cluster symbols exist for all the clusters listed.
    /// This is used to keep the global state synchronized with the client's connection panel.
    /// </summary>
    public Task EnsureClustersAsync(ImmutableList<string> clusterNames, string? contextCluster, CancellationToken cancellationToken)
    {
        return _taskQueue.Run(cancellationToken, async (useThisCancellationToken) =>
        {
            var globals = this.Globals;
            bool changed = false;

            foreach (var clusterName in clusterNames)
            {
                try
                {
                    var clusterSymbol = globals.GetCluster(clusterName);
                    if (clusterSymbol == null)
                    {
                        _logger?.Log($"SymbolManager: Ensuring cluster symbol for '{clusterName}'");
                        globals = await this.AddClusterAsync(globals, clusterName, contextCluster, useThisCancellationToken).ConfigureAwait(false);
                        changed = true;
                    }
                }
                catch (Exception ex)
                {
                    _logger?.Log($"SymbolManager: Error ensuring cluster for '{clusterName}': {ex.Message}");
                }
            }

            if (changed)
            {
                SetGlobals(globals);
            }
        });
    }
}