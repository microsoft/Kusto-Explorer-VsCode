// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using Kusto.Cloud.Platform.Data;
using Kusto.Cloud.Platform.Utils;
using Kusto.Data;
using Kusto.Data.Common;
using Kusto.Data.Common.Impl;
using Kusto.Data.Data;
using Kusto.Data.Net.Client;
using Kusto.Language;
using Kusto.Language.Editor;
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
    private ImmutableDictionary<string, ConnectionInfo> _connectionStringsToInfoMap =
        ImmutableDictionary<string, ConnectionInfo>.Empty;

    private ImmutableDictionary<string, ConnectionInfo> _clusterToInfoMap =
        ImmutableDictionary<string, ConnectionInfo>.Empty;

    private string _defaultDomain = KustoFacts.KustoWindowsNet;

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

            var connection = new KustoConnection(this, builder);

            return new ConnectionInfo { Connection = connection };
        }
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
        private readonly KustoConnectionStringBuilder _builder;

        public KustoConnection(ConnectionManager manager, KustoConnectionStringBuilder builder)
        {
            _manager = manager;
            _builder = builder;
        }

        public string Cluster => _builder.Hostname;
        public string? Database => _builder.InitialCatalog;

        public IConnection WithCluster(string clusterName)
        {
            var clusterUri = KustoFacts.GetFullHostName(clusterName, _manager._defaultDomain);

            if (!clusterUri.Contains("://")
                && !string.IsNullOrEmpty(_builder.ConnectionScheme))
            {
                clusterUri = _builder.ConnectionScheme + "://" + clusterUri;
            }

            // borrow most security settings from default cluster connection
            var builder = new KustoConnectionStringBuilder(_builder);

            builder.DataSource = clusterUri;
            builder.ApplicationCertificateBlob = _builder.ApplicationCertificateBlob;
            builder.ApplicationKey = _builder.ApplicationKey;
            builder.InitialCatalog = "NetDefaultDB";

            return new KustoConnection(_manager, builder);
        }

        public IConnection WithDatabase(string database)
        {
            var newBuilder = new KustoConnectionStringBuilder(_builder) { InitialCatalog = database };
            return new KustoConnection(_manager, newBuilder);
        }

        // These providers are IDisposable but are intentionally not disposed.
        // They are cached for the lifetime of the server process and cleaned up on exit.
        private ICslQueryProvider? _queryProvider;
        public ICslQueryProvider QueryProvider
        {
            get
            {
                if (_queryProvider == null)
                {
                    Interlocked.CompareExchange(ref _queryProvider, KustoClientFactory.CreateCslQueryProvider(_builder), null);
                }
                return _queryProvider;
            }
        }

        private ICslAdminProvider? _adminProvider;
        public ICslAdminProvider AdminProvider
        {
            get 
            { 
                if (_adminProvider == null)
                {
                    Interlocked.CompareExchange(ref _adminProvider, KustoClientFactory.CreateCslAdminProvider(_builder), null);
                }
                return _adminProvider;
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
                var properties = CreateClientRequestProperties(options ?? ImmutableDictionary<string, string>.Empty, parameters ?? ImmutableDictionary<string, string>.Empty, clientRequestId);
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
            catch (Exception ex)
            {
                return new ExecuteResult
                {
                    Diagnostics = [ErrorDecoder.GetDiagnostic(ex, query)]
                };
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
