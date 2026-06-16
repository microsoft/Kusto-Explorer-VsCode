// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using System.Collections.Immutable;
using System.Runtime.CompilerServices;
using Kusto.Language;
using Kusto.Language.Editor;

namespace Kusto.Vscode;

public record DiagnosticInfo(Uri Id, string Text, ImmutableList<Diagnostic> Diagnostics);

/// <summary>
/// Turns document changes into published diagnostics. It listens to
/// <see cref="IDocumentManager"/> add/change events, recomputes parse + analyzer diagnostics for
/// the affected document, and raises <see cref="DiagnosticsUpdated"/> for the server to forward as an
/// LSP <c>publishDiagnostics</c> notification. Recomputation is debounced/serialized so a burst of
/// keystrokes collapses into a single up-to-date result rather than a flood of stale ones.
/// </summary>
public class DiagnosticsManager : IDiagnosticsManager
{
    private readonly IDocumentManager _documentManager;
    private readonly ILogger? _logger;

    public DiagnosticsManager(
        IDocumentManager scriptManager,
        ILogger? logger = null)
    {
        _documentManager = scriptManager;
        _logger = logger;

        _documentManager.DocumentAdded += (s, id) =>
        {
            RecomputeDiagnostics(id);
        };

        _documentManager.DocumentChanged += (s, id) =>
        {
            // TODO: find a way to delay this if the document is not currently visible in the editor
            RecomputeDiagnostics(id);
        };
    }

    /// <summary>
    /// An event raised when new diagnostics are available for a script.
    /// </summary>
    public event EventHandler<DiagnosticInfo>? DiagnosticsUpdated;


    private void SendDiagnosticsUpdated(DiagnosticInfo diagnostics)
    {
        if (this.DiagnosticsUpdated != null)
        {
            Task.Run(() => DiagnosticsUpdated?.Invoke(this, diagnostics));
        }
    }

    private readonly ConditionalWeakTable<Uri, DiagnosticsState> _idToDiagnosticState =
        new ConditionalWeakTable<Uri, DiagnosticsState>();

    class DiagnosticsState
    {
        public LatestRequestQueue DiagnosticQueue { get; } = new LatestRequestQueue();

        /// <summary>
        /// Previously computed diagnostics.
        /// </summary>
        public ImmutableList<Diagnostic> Diagnostics { get; set; } = ImmutableList<Diagnostic>.Empty;
    }

    private DiagnosticsState GetDiagnosticState(Uri documentId)
    {
        return _idToDiagnosticState.GetOrCreateValue(documentId);
    }

    private void RecomputeDiagnostics(Uri documentId)
    {
        if (_documentManager.TryGetDocument(documentId, out var document))
        {
            var state = GetDiagnosticState(documentId);

            var _ = state.DiagnosticQueue.Run(async (useThisCancellationToken) =>
            {
                // wait for delay before starting work (to batch up multiple changes)
                await Task.Delay(10, useThisCancellationToken);
                useThisCancellationToken.ThrowIfCancellationRequested();

                _logger?.Log($"Recomputed diagnostics for: {documentId}");

                var diagnostics = new List<Diagnostic>();

                // add normal diagnostics
                var dx = document.GetDiagnostics(waitForAnalysis: true, useThisCancellationToken);
                if (dx.Count > 0)
                {
                    diagnostics.AddRange(dx.Where(d => d.Severity != DiagnosticSeverity.Hidden));
                }

                // add analyzer diagnostics
                var adx = document.GetAnalyzerDiagnostics(waitForAnalysis: true, useThisCancellationToken);
                if (adx.Count > 0)
                {
                    diagnostics.AddRange(adx.Where(d => d.Severity != DiagnosticSeverity.Hidden));
                }

                useThisCancellationToken.ThrowIfCancellationRequested();

                var newDiagnostics = diagnostics.ToImmutableList();
                state.Diagnostics = newDiagnostics;
                SendDiagnosticsUpdated(new DiagnosticInfo(documentId, document.Text, newDiagnostics));
            });
        }
    }
}
