// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using Kusto.Cloud.Platform.Data;
using Kusto.Cloud.Platform.Utils;
using Kusto.Data;
using Kusto.Data.Common;
using Kusto.Data.Common.Impl;
using Kusto.Data.Data;
using Kusto.Data.Exceptions;
using Kusto.Data.Net.Client;
using Kusto.Language;
using Kusto.Language.Editor;
using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Data;
using System.Diagnostics.CodeAnalysis;

namespace Kusto.Vscode;

/// <summary>
/// Keeps track of connections to servers and databases, to allow reuse of <see cref="KustoConnectionStringBuilder"/> instances.
/// The consumer of the builder must not modify it.
/// </summary>
public class ConnectionManager : IConnectionManager
{
    private readonly IAuthenticationProvider? _authProvider;

    private ImmutableDictionary<string, ConnectionInfo> _connectionStringsToInfoMap =
        ImmutableDictionary<string, ConnectionInfo>.Empty;

    private ImmutableDictionary<string, ConnectionInfo> _clusterToInfoMap =
        ImmutableDictionary<string, ConnectionInfo>.Empty;

    private string _defaultDomain = KustoFacts.KustoWindowsNet;

    // Tracks which clusters have been observed to fail native authentication.
    // Once a cluster is in this set, we route its connections through the
    // host-bridged auth provider (e.g. VS Code) without first re-attempting
    // native auth. The set is per-process and reset on restart.
    private readonly ConcurrentDictionary<string, bool> _fallbackRequiredByCluster =
        new(StringComparer.OrdinalIgnoreCase);

    // Carries the caller's CancellationToken into the
    // WithAadTokenProviderAuthentication callback that Kusto.Data invokes
    // synchronously while servicing a query. The callback signature has no
    // CancellationToken parameter, so we use AsyncLocal to flow it through
    // the same async context as ExecuteCoreAsync.
    private static readonly AsyncLocal<CancellationToken> _ambientAuthToken = new();

    public ConnectionManager(IAuthenticationProvider? authProvider = null)
    {
        _authProvider = authProvider;
    }

    private class ConnectionInfo
    {
        public required KustoConnection Connection { get; set; }

        public ImmutableDictionary<string, KustoConnection> DatabaseConnections =
            ImmutableDictionary<string, KustoConnection>.Empty;
    }

    public class ShowVersionResult
    {
        public string BuildVersion = default!;
        public DateTime BuildTime;
        public string ServiceType = default!;
        public string ProductVersion = default!;
        public string ServiceSubType = default!;
    }

    public IConnection GetOrAddConnection(string connectionString)
    {
        if (!_connectionStringsToInfoMap.TryGetValue(connectionString, out var info))
        {
            info = CreateConnectionInfo(connectionString);
            ImmutableInterlocked.GetOrAdd(ref _connectionStringsToInfoMap, connectionString, info);

            var cluster = info.Connection.Cluster;
            ImmutableInterlocked.GetOrAdd(ref _clusterToInfoMap, cluster, info);

            var shortName = KustoFacts.GetShortHostName(cluster, _defaultDomain);
            if (shortName != cluster)
            {
                ImmutableInterlocked.GetOrAdd(ref _clusterToInfoMap, shortName, info);
            }
        }

        return info.Connection;

        ConnectionInfo CreateConnectionInfo(string connectionString)
        {
            var builder = new KustoConnectionStringBuilder(connectionString);

            // if no schema is provided, default to https
            if (string.IsNullOrEmpty(builder.ConnectionScheme))
            {
                builder.ConnectionScheme = "https://";
            }

            // if is not explicitly a connection string, add federated security
            if (!connectionString.Contains(";"))
            {
                builder.FederatedSecurity = true;
            }

            // The "primary" builder always uses Kusto.Data's native auth path,
            // which on a normal Windows desktop transparently does WAM/SSO with
            // the user's signed-in work account - no prompt at all. When that
            // path can't proceed (remote-SSH / WSL / Codespaces / dev tunnels,
            // or a stuck local cache) it throws KustoClientAuthenticationException
            // and we fall back to host-bridged auth via the IAuthenticationProvider.
            // See KustoConnection.ExecuteAsync for the retry logic.
            var connection = new KustoConnection(this, builder);
            return new ConnectionInfo { Connection = connection };
        }
    }

    /// <summary>
    /// Returns true if a previous query against the given cluster failed
    /// native authentication and the cluster has been promoted to use the
    /// host-bridged auth path.
    /// </summary>
    internal bool ShouldUseFallback(string clusterHostName)
        => _fallbackRequiredByCluster.ContainsKey(clusterHostName);

    /// <summary>
    /// Marks a cluster as requiring host-bridged authentication for the
    /// remainder of this server process. Called by <see cref="KustoConnection.ExecuteAsync"/>
    /// after observing a <see cref="KustoClientAuthenticationException"/> from
    /// the native auth path.
    /// </summary>
    internal void MarkFallbackRequired(string clusterHostName)
        => _fallbackRequiredByCluster[clusterHostName] = true;

    /// <summary>
    /// Builds a host-bridged variant of the supplied builder that routes AAD
    /// token acquisition through the registered <see cref="IAuthenticationProvider"/>.
    /// Returns null if no provider is registered or the supplied builder
    /// already specifies an explicit authentication method.
    /// </summary>
    internal KustoConnectionStringBuilder? CreateFallbackBuilder(KustoConnectionStringBuilder primary)
    {
        if (_authProvider == null || HasExplicitAuthentication(primary))
        {
            return null;
        }

        var fallback = new KustoConnectionStringBuilder(primary);
        var clusterUri = fallback.DataSource;
        var provider = _authProvider;
        return fallback.WithAadTokenProviderAuthentication(async () =>
        {
            // Pick up the caller's CancellationToken if one was published into
            // the ambient async context by ExecuteCoreAsync. Falls back to
            // None if Kusto.Data invokes the callback outside our query path
            // (e.g. background metadata refresh).
            var token = await provider
                .GetAccessTokenAsync(clusterUri, _ambientAuthToken.Value)
                .ConfigureAwait(false);
            return token ?? throw new InvalidOperationException(
                $"Authentication failed: no access token was returned for '{clusterUri}'.");
        });
    }

    private static bool HasExplicitAuthentication(KustoConnectionStringBuilder builder)
    {
        // Treat the connection as having explicit auth if any credential-bearing
        // field has been set, or if an interactive auth flow was already requested.
        return builder.AzCliInteractiveLogin
            || !string.IsNullOrEmpty(builder.ApplicationClientId)
            || !string.IsNullOrEmpty(builder.ApplicationKey)
            || builder.ApplicationCertificateBlob != null
            || !string.IsNullOrEmpty(builder.ApplicationCertificateThumbprint)
            || !string.IsNullOrEmpty(builder.ApplicationToken)
            || !string.IsNullOrEmpty(builder.UserToken)
            || !string.IsNullOrEmpty(builder.UserID)
            || builder.TokenProviderCallback != null
            || builder.KustoTokenCredentialsProvider != null;
    }

    public bool TryGetConnection(string cluster, [NotNullWhen(true)] out IConnection? connection)
    {
        if (_clusterToInfoMap.TryGetValue(cluster, out var info))
        {
            connection = info.Connection;
            return true;
        }

        connection = null;
        return false;
    }

    private class KustoConnection : IConnection
    {
        private readonly ConnectionManager _manager;
        private readonly KustoConnectionStringBuilder _primaryBuilder;
        private KustoConnectionStringBuilder? _fallbackBuilder; // lazily built on first need

        public KustoConnection(ConnectionManager manager, KustoConnectionStringBuilder builder)
        {
            _manager = manager;
            _primaryBuilder = builder;
        }

        /// <summary>
        /// Exposed for tests. Returns the currently active connection-string builder,
        /// which is the fallback (host-bridged) builder if this cluster has been
        /// promoted to fallback mode, otherwise the primary (native auth) builder.
        /// </summary>
        internal KustoConnectionStringBuilder Builder => ActiveBuilder;

        /// <summary>
        /// Exposed for tests. Returns the primary (native auth) builder.
        /// </summary>
        internal KustoConnectionStringBuilder PrimaryBuilder => _primaryBuilder;

        /// <summary>
        /// Exposed for tests. Returns the fallback (host-bridged auth) builder,
        /// constructing it on demand. May be null if no <see cref="IAuthenticationProvider"/>
        /// is registered or the connection string already specifies explicit auth.
        /// </summary>
        internal KustoConnectionStringBuilder? FallbackBuilder => GetFallbackBuilder();

        private KustoConnectionStringBuilder ActiveBuilder
            => UseFallback ? (GetFallbackBuilder() ?? _primaryBuilder) : _primaryBuilder;

        private bool UseFallback => _manager.ShouldUseFallback(_primaryBuilder.Hostname);

        private KustoConnectionStringBuilder? GetFallbackBuilder()
        {
            if (_fallbackBuilder == null)
            {
                var fb = _manager.CreateFallbackBuilder(_primaryBuilder);
                if (fb != null)
                {
                    Interlocked.CompareExchange(ref _fallbackBuilder, fb, null);
                }
            }
            return _fallbackBuilder;
        }

        public string Cluster => _primaryBuilder.Hostname;
        public string? Database => _primaryBuilder.InitialCatalog;

        public IConnection WithCluster(string clusterName)
        {
            var clusterUri = KustoFacts.GetFullHostName(clusterName, _manager._defaultDomain);

            if (!clusterUri.Contains("://")
                && !string.IsNullOrEmpty(_primaryBuilder.ConnectionScheme))
            {
                clusterUri = _primaryBuilder.ConnectionScheme + "://" + clusterUri;
            }

            // borrow most security settings from default cluster connection
            var builder = new KustoConnectionStringBuilder(_primaryBuilder);

            builder.DataSource = clusterUri;
            builder.ApplicationCertificateBlob = _primaryBuilder.ApplicationCertificateBlob;
            builder.ApplicationKey = _primaryBuilder.ApplicationKey;
            builder.InitialCatalog = "NetDefaultDB";

            return new KustoConnection(_manager, builder);
        }

        public IConnection WithDatabase(string database)
        {
            var newBuilder = new KustoConnectionStringBuilder(_primaryBuilder) { InitialCatalog = database };
            return new KustoConnection(_manager, newBuilder);
        }

        // Cached providers. Kept per auth-mode so that switching from primary
        // to fallback after an auth failure produces a fresh provider built
        // from the fallback builder. These providers are IDisposable but are
        // intentionally not disposed - they are cached for the lifetime of
        // the server process and cleaned up on exit.
        private ICslQueryProvider? _primaryQueryProvider;
        private ICslQueryProvider? _fallbackQueryProvider;
        private ICslAdminProvider? _primaryAdminProvider;
        private ICslAdminProvider? _fallbackAdminProvider;

        public ICslQueryProvider QueryProvider
        {
            get
            {
                if (UseFallback && GetFallbackBuilder() is { } fb)
                {
                    if (_fallbackQueryProvider == null)
                    {
                        Interlocked.CompareExchange(ref _fallbackQueryProvider,
                            KustoClientFactory.CreateCslQueryProvider(fb), null);
                    }
                    return _fallbackQueryProvider;
                }

                if (_primaryQueryProvider == null)
                {
                    Interlocked.CompareExchange(ref _primaryQueryProvider,
                        KustoClientFactory.CreateCslQueryProvider(_primaryBuilder), null);
                }
                return _primaryQueryProvider;
            }
        }

        public ICslAdminProvider AdminProvider
        {
            get
            {
                if (UseFallback && GetFallbackBuilder() is { } fb)
                {
                    if (_fallbackAdminProvider == null)
                    {
                        Interlocked.CompareExchange(ref _fallbackAdminProvider,
                            KustoClientFactory.CreateCslAdminProvider(fb), null);
                    }
                    return _fallbackAdminProvider;
                }

                if (_primaryAdminProvider == null)
                {
                    Interlocked.CompareExchange(ref _primaryAdminProvider,
                        KustoClientFactory.CreateCslAdminProvider(_primaryBuilder), null);
                }
                return _primaryAdminProvider;
            }
        }

        public async Task<ExecuteResult> ExecuteAsync(
            EditString query,
            ImmutableDictionary<string, string>? options = null,
            ImmutableDictionary<string, string>? parameters = null,
            string? clientRequestId = null,
            CancellationToken cancellationToken = default
            )
        {
            try
            {
                return await ExecuteCoreAsync(query, options, parameters, clientRequestId, cancellationToken)
                    .ConfigureAwait(false);
            }
            catch (KustoClientAuthenticationException) when (CanRetryWithFallback())
            {
                // Native authentication failed (e.g. Kusto.Data could not run
                // its WAM/MSAL prompt because the server process is hosted in
                // a non-interactive environment, or its cached token is stuck).
                // Promote this cluster to host-bridged auth and retry once.
                _manager.MarkFallbackRequired(_primaryBuilder.Hostname);
                try
                {
                    return await ExecuteCoreAsync(query, options, parameters, clientRequestId, cancellationToken)
                        .ConfigureAwait(false);
                }
                catch (Exception retryEx)
                {
                    return new ExecuteResult
                    {
                        Diagnostics = [ErrorDecoder.GetDiagnostic(retryEx, query)]
                    };
                }
            }
            catch (Exception ex)
            {
                return new ExecuteResult
                {
                    Diagnostics = [ErrorDecoder.GetDiagnostic(ex, query)]
                };
            }
        }

        private bool CanRetryWithFallback()
            => !UseFallback && GetFallbackBuilder() != null;

        private async Task<ExecuteResult> ExecuteCoreAsync(
            EditString query,
            ImmutableDictionary<string, string>? options,
            ImmutableDictionary<string, string>? parameters,
            string? clientRequestId,
            CancellationToken cancellationToken)
        {
            // Publish the caller's CancellationToken into the ambient async
            // context so the WithAadTokenProviderAuthentication callback (if
            // Kusto.Data triggers fallback auth during this call) can observe
            // and respect query cancellation. Save and restore the previous
            // value so a later token request (e.g. a background metadata
            // refresh) doesn't observe a stale/cancelled token from this
            // query's context.
            var previousAuthToken = _ambientAuthToken.Value;
            _ambientAuthToken.Value = cancellationToken;
            try
            {
                var properties = CreateClientRequestProperties(
                    options ?? ImmutableDictionary<string, string>.Empty,
                    parameters ?? ImmutableDictionary<string, string>.Empty,
                    clientRequestId);
                var resultReader = (Kusto.Language.KustoCode.GetKind(query) == CodeKinds.Command)
                    ? await this.AdminProvider.ExecuteControlCommandAsync(this.Database, query, properties).ConfigureAwait(false)
                    : await this.QueryProvider.ExecuteQueryAsync(this.Database, query, properties, cancellationToken).ConfigureAwait(false);
                using (resultReader)
                {
                    var dataSet = KustoDataReaderParser.ParseV1(resultReader, null);
                    var mainResult = dataSet?.GetMainResultsOrNull();
                    var tables = dataSet != null
                        ? dataSet.Tables.Where(t => t.TableKind == WellKnownDataSet.PrimaryResult).Select(t => (DataTable)t.TableData).ToImmutableList()
                        : null;
                    var chartOptions = mainResult?.VisualizationOptions != null && mainResult.VisualizationOptions.Visualization != Data.Utils.VisualizationKind.None
                        ? ChartOptions.FromChartVisualizationOptions(mainResult.VisualizationOptions)
                        : null;
                    var charts = chartOptions != null
                        ? ImmutableList.Create(new ResultChart { Options = chartOptions })
                        : null;
                    return new ExecuteResult
                    {
                        Tables = tables,
                        Charts = charts
                    };
                }
            }
            finally
            {
                _ambientAuthToken.Value = previousAuthToken;
            }
        }

        public async Task<ExecuteResult<T>> ExecuteAsync<T>(
            EditString query,
            ImmutableDictionary<string, string>? options = null,
            ImmutableDictionary<string, string>? parameters = null,
            CancellationToken cancellationToken = default
            )
        {
            try
            {
                var results = await ExecuteAsync(query, options, parameters, cancellationToken: cancellationToken).ConfigureAwait(false);
                if (results.Tables != null
                    && results.Tables.Count > 0)
                {
                    var reader = new ObjectReader<T>(results.Tables[0].CreateDataReader());
                    return new ExecuteResult<T> { Values = reader.ToImmutableList() };
                }
                else
                {
                    return new ExecuteResult<T> { Values = ImmutableList<T>.Empty };
                }

            }
            catch (Exception e)
            {
                return new ExecuteResult<T>
                {
                    Diagnostics = [ErrorDecoder.GetDiagnostic(e, query)]
                };
            }
        }

        private ClientRequestProperties CreateClientRequestProperties(
            ImmutableDictionary<string, string> options,
            ImmutableDictionary<string, string> parameters,
            string? clientRequestId)
        {
            var crp = new ClientRequestProperties();
            if (!string.IsNullOrWhiteSpace(clientRequestId))
            {
                crp.ClientRequestId = clientRequestId;
            }

            foreach (var kvp in options)
            {
                SetQueryOption(crp, kvp.Key, kvp.Value);
            }

            crp.SetParameters(parameters);

            return crp;
        }

        private void SetQueryOption(ClientRequestProperties crp, string name, string value)
        {
            if (value != null && value == "##null")
            {
                crp.ClearOption(name);
                return;
            }

            switch (name)
            {
                // Booleans
                case ClientRequestProperties_Debugging.OptionNoExecute:
                case ClientRequestProperties_Debugging.OptionPerfTrace:
                case ClientRequestProperties.OptionValidatePermissions:
                case ClientRequestProperties.OptionQueryResultsApplyGetSchema:
                case ClientRequestProperties.OptionNoTruncation:
                case ClientRequestProperties.OptionDeferPartialQueryFailures:
                case ClientRequestProperties.OptionNoRequestTimeout:
                case ClientRequestProperties.OptionAllowProjectionAndExtensionUnderSearch:
                case ClientRequestProperties.OptionRequestCalloutDisabled:
                case ClientRequestProperties_FaultInjection.OptionDebugQueryExecutionEnableExpiry:
                case ClientRequestProperties_FaultInjection.OptionDebugQueryExecutionEnableOom:
                case ClientRequestProperties.OptionDoNotImpersonate:
                    crp.SetOption(name, Boolean.Parse(value!));
                    break;

                // Long
                case ClientRequestProperties.OptionTruncationMaxSize:
                case ClientRequestProperties.OptionTruncationMaxRecords:
                case ClientRequestProperties.OptionTakeMaxRecords:
                case ClientRequestProperties.OptionMaxMemoryConsumptionPerIterator:
                case ClientRequestProperties.OptionMaxMemoryConsumptionPerQueryPerNode:
                case ClientRequestProperties_FaultInjection.OptionDebugQueryPlanBurnCpuMsec:
                case ClientRequestProperties.OptionMaxOutputColumns:
                case ClientRequestProperties.OptionMaxEntitiesToUnion:
                case ClientRequestProperties.OptionSqlMaxStringSize:
                    crp.SetOption(name, CslLongLiteral.Parse(value!));
                    break;

                // TimeSpan
                case ClientRequestProperties.OptionServerTimeout:
                    if (CslTimeSpanLiteral.TryParse(value, out var timeSpan))
                    {
                        crp.SetOption(name, timeSpan);
                    }
                    else
                    {
                        value = value.TrimBalancedSingleAndDoubleQuotes();
                        crp.SetOption(name, ExtendedTimeSpan.Parse(value));
                    }
                    return;

                // DateTime
                case ClientRequestProperties.OptionQueryDateTimeScopeFrom:
                case ClientRequestProperties.OptionQueryDateTimeScopeTo:
                case ClientRequestProperties.OptionQueryNow:
                    if (CslDateTimeLiteral.TryParse(value, out var dateTime))
                    {
                        crp.SetOption(name, dateTime);
                    }
                    else
                    {
                        value = value.TrimBalancedSingleAndDoubleQuotes();
                        crp.SetOption(name, ExtendedDateTime.ParseInexactUtc(value));
                    }
                    break;

                // All others are strings
                default:
                    crp.SetOption(name, value);
                    break;
            }
        }

        public async Task<string> GetServerKindAsync(CancellationToken cancellationToken)
        {
            var results = await this.ExecuteAsync<ShowVersionResult>(".show version", cancellationToken: cancellationToken).ConfigureAwait(false);
            var version = results.Values?.FirstOrDefault();
            return version != null ? version.ServiceType : "Unknown";
        }
    }
}
