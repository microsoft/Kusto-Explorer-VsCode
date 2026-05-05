// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using System.Collections.Immutable;
using System.Data;
using System.Runtime.CompilerServices;
using System.Runtime.Serialization;
using StreamJsonRpc;
using LSP = Microsoft.VisualStudio.LanguageServer.Protocol;

using Kusto.Data.Common;
using Kusto.Language;
using Kusto.Language.Editor;
using Kusto.Language.Symbols;
using Lsp.Common;

namespace Kusto.Vscode;

public class Server : LspServer, ILogger, ISettingSource, IStorage
{
    private readonly ILogger _logger;
    private readonly ISettingSource _settingSource;
    private readonly IStorage _storage;
    private readonly IOptionsManager _optionsManager;
    private readonly IConnectionManager _connectionManager;
    private readonly ISchemaManager _schemaManager;
    private readonly ISymbolManager _symbolManager;
    private readonly IDocumentManager _documentManager;
    private readonly IDiagnosticsManager _diagnosticsManager;
    private readonly IQueryManager _queryManager;
    private readonly IEntityManager _entityManager;
    private readonly ImmutableList<string> _args;

    public Server(
        Stream input, 
        Stream output, 
        string[] args,
        IOptionsManager optionsManager,
        IConnectionManager connectionManager,
        ISchemaManager schemaManager,
        ISymbolManager symbolManager,
        IDocumentManager documentManager,
        IDiagnosticsManager diagnosticsManager,
        IQueryManager queryManager,
        IEntityManager entityManager)
        : base(input, output)
    {
        _args = args.ToImmutableList();
        _logger = this;
        _settingSource = this;
        _storage = this;
        _optionsManager = optionsManager;
        _schemaManager = schemaManager;
        _connectionManager = connectionManager;
        _symbolManager = symbolManager;
        _documentManager = documentManager;
        _diagnosticsManager = diagnosticsManager;
        _queryManager = queryManager;
        _entityManager = entityManager;
        InitEvents();
    }

    public Server(
        Stream input,
        Stream output,
        string[] args)
        : base(input, output)
    {
        _args = args.ToImmutableList();
        _logger = this;
        _settingSource = this;
        _storage = this;
        _optionsManager = new OptionsManager(_settingSource);
        _connectionManager = new ConnectionManager();
        var schemaSource = new ServerSchemaSource(_connectionManager, _logger);
        _schemaManager = new SchemaManager(schemaSource, _storage, _logger);
        _symbolManager = new SymbolManager(_schemaManager, _optionsManager, _logger);
        _documentManager = new DocumentManager(_symbolManager, _logger);
        _diagnosticsManager = new DiagnosticsManager(_documentManager, _logger);
        _queryManager = new QueryManager(_connectionManager, _symbolManager, _documentManager, _optionsManager, _logger);
        _entityManager = new EntityManager(_schemaManager, _optionsManager);
        InitEvents();
    }

    private void InitEvents()
    {
        _symbolManager.GlobalsChanged += _symbolManager_GlobalsChanged;
        _diagnosticsManager.DiagnosticsUpdated += _diagnosticsManager_DiagnosticsUpdated;
    }

    void ILogger.Log(string message)
    {
        var _ = this.SendWindowLogMessageAsync(message);
    }

    /// <summary>
    /// The client settings supplied during initialization.
    /// </summary>
    protected LSP.InitializeParams ClientSettings { get; private set; } = null!;

    /// <summary>
    /// The server settings reported to client during initialization.
    /// </summary>
    protected LSP.InitializeResult ServerSettings { get; private set; } = null!;

    #region Events

    private async void _symbolManager_GlobalsChanged(object? sender, GlobalState e)
    {
        // since globals changed it is possible that some semantic tokens are now different, so request client to refresh them
        try
        {
            await this.SendWorkspaceSemanticTokensRefresh();
        }
        catch (Exception ex)
        {
            _logger?.Log($"Error refreshing semantic tokens: {ex.Message}");
        }
    }

    private async void _diagnosticsManager_DiagnosticsUpdated(object? sender, DiagnosticInfo diagnostics)
    {
        try
        {
            await PublishDiagnosticsAsync(diagnostics);
        }
        catch (Exception ex)
        {
            _logger?.Log($"Error publishing diagnostics: {ex.Message}");
        }
    }

    #endregion

    #region LSP Implementation

    #region Initialize

    /// <summary>
    /// Initialize the language server document & settings.
    /// </summary>
    public override async Task<LSP.InitializeResult> OnInitializeAsync(LSP.InitializeParams @params, CancellationToken cancellationToken)
    {
        this.ClientSettings = @params;

        var semanticTokenOptions = @params.Capabilities?.TextDocument?.SemanticTokens != null
            ? new LSP.SemanticTokensOptions
                {
                    Legend = new LSP.SemanticTokensLegend
                    {
                        TokenTypes = Enum.GetValues<ClassificationKind>().Select(ck => GetSemanticTokenKind(ck)).Where(tk => tk != null).OfType<string>().ToArray() ?? [],
                        TokenModifiers = []
                        //TokenTypes = @params.Capabilities.TextDocument.SemanticTokens.TokenTypes ?? [],
                        //TokenModifiers = @params.Capabilities.TextDocument.SemanticTokens.TokenModifiers ?? []
                    },
                    Full = true,
                    Range = true
                }
            : null;

        var completionOptions = new LSP.CompletionOptions
        {
            ResolveProvider = false,
            TriggerCharacters = ["(", "[", ".", " ", "="],
            // will always commit when these are typed, even if no other typing has narrowed the selection
            AllCommitCharacters = ["\t"]
        };

        this.ServerSettings = new LSP.InitializeResult
        {
            Capabilities = new LSP.ServerCapabilities
            {
                TextDocumentSync = new LSP.TextDocumentSyncOptions
                {
                    OpenClose = true,
                    Change = LSP.TextDocumentSyncKind.Full,
                    Save = new LSP.SaveOptions { IncludeText = true }
                },
                SemanticTokensOptions = semanticTokenOptions, // kusto classifications
                CompletionProvider = completionOptions,
                HoverProvider = true,  // kusto quick infos
                FoldingRangeProvider = true, // kusto outlining
                DocumentFormattingProvider = true,
                DocumentRangeFormattingProvider = true,
                DocumentHighlightProvider = true, // highlights matching elements (brackets, names, etc)
                ReferencesProvider = true, // find references
                DefinitionProvider = true, // goto definition
                CodeActionProvider = new LSP.CodeActionOptions
                {
                    CodeActionKinds =
                    [
                        LSP.CodeActionKind.QuickFix,
                        LSP.CodeActionKind.Refactor,
                        LSP.CodeActionKind.RefactorExtract,
                        LSP.CodeActionKind.RefactorInline,
                        LSP.CodeActionKind.RefactorRewrite,
                        LSP.CodeActionKind.Source,
                        //LSP.CodeActionKind.SourceOrganizeImports
                    ],
                    ResolveProvider = true
                },
                RenameProvider = new LSP.RenameOptions { PrepareProvider = false },
                //ExecuteCommandProvider = new LSP.ExecuteCommandOptions
                //{
                //    Commands = 
                //    [
                //        "Connect",
                //        "Query" 
                //    ]
                //},
#if false
                //DocumentSymbolProvider = true,  // mabye?
                //WorkspaceSymbolProvider = true,  // maybe?
                //SignatureHelpProvider = new SignatureHelpOptions
                //{
                //    TriggerCharacters = new[] { "(", "," }
                //},
                //CodeLensProvider = new CodeLensOptions { ResolveProvider = true },
                //DocumentOnTypeFormattingProvider = new DocumentOnTypeFormattingOptions
                //{
                //    FirstTriggerCharacter = ";",
                //    MoreTriggerCharacter = new[] { "}", "\n" }
                //},
                //DocumentLinkProvider = new DocumentLinkOptions { ResolveProvider = true },
                //DocumentColorProvider = true,
                //CallHierarchyProvider = true,     // a call hierarchy of functions?
                //LinkedEditingRangeProvider = true,
                //TypeDefinitionProvider = true,   // kusto does not have types that can be declared
                //ImplementationProvider = true,   // goto implementation?  Maybe have this open a source file that shows the database function declaration?
                //InlayHintProvider = new InlayHintOptions { ResolveProvider = true }
#endif
            }
        };

        return this.ServerSettings;
    }

    public override async Task OnInitializedAsync(LSP.InitializedParams @params, CancellationToken cancellationToken)
    {
        // Trigger initial settings load via SettingsChanged event
        this.SettingsChanged?.Invoke(this, EventArgs.Empty);
    }

    #endregion

    #region Diagnostics Publishing

    private async Task PublishDiagnosticsAsync(DiagnosticInfo info)
    {
        var lspDiagnostics = info.Diagnostics.Select(d =>
            new LSP.Diagnostic
            {
                Range = GetLspRange(info.Text, new TextRange(d.Start, d.Length)),
                Code = d.Code,
                Message = d.Message,
                Severity = GetSeverity(d.Severity)
            }).ToArray();

        var pdParams = new LSP.PublishDiagnosticParams
        {
            Uri = info.Id,
            Diagnostics = lspDiagnostics
        };

        // publish new diagnostics to the client
        await this.SendTextDocumentPublishDiagnosticsAsync(pdParams).ConfigureAwait(false);

        LSP.DiagnosticSeverity GetSeverity(string severity) =>
            severity switch
            {
                DiagnosticSeverity.Error => LSP.DiagnosticSeverity.Error,
                DiagnosticSeverity.Warning => LSP.DiagnosticSeverity.Warning,
                DiagnosticSeverity.Suggestion => LSP.DiagnosticSeverity.Hint,
                DiagnosticSeverity.Information => LSP.DiagnosticSeverity.Information,
                _ => LSP.DiagnosticSeverity.Information
            };
    }

    #endregion

    #region Document Open/Close/Change

    public override Task OnTextDocumentOpenedAsync(LSP.DidOpenTextDocumentParams @params)
    {
        try
        {
            _documentManager.AddDocument(@params.TextDocument.Uri, @params.TextDocument.Text);

            // temporary telemetry
            _ = this.SendWindowLogMessageAsync($"text document opened: {@params.TextDocument.Uri}");

            // Notify client that the document is ready
            _ = this.SendNotificationAsync("kusto/documentReady", new
            {
                uri = @params.TextDocument.Uri.ToString()
            });
        }
        catch (Exception ex)
        {
            _ = this.SendWindowLogMessageAsync(ex);
        }

        return Task.CompletedTask;
    }

    public override Task OnTextDocumentDidCloseAsync(LSP.DidCloseTextDocumentParams @params)
    {
        try
        {
            _documentManager.RemoveDocument(@params.TextDocument.Uri);
            this.SendWindowLogMessageAsync($"text document closed: {@params.TextDocument.Uri}");
        }
        catch (Exception ex)
        {
            this.SendWindowLogMessageAsync(ex);
        }

        return Task.CompletedTask;
    }

    public override Task OnTextDocumentDidChangeAsync(LSP.DidChangeTextDocumentParams @params)
    {
        try
        {
            if (_documentManager.TryGetDocument(@params.TextDocument.Uri, out var document))
            {
                // apply edits to current script text
                var edits = @params.ContentChanges.Select(c =>
                {
                    if (c.Range != null)
                    {
                        document.Text.TryGetTextPosition(c.Range.Start.Line, c.Range.Start.Character, out var position);
                        return TextEdit.Replacement(position, c.RangeLength ?? 0, c.Text);
                    }
                    else
                    {
                        return TextEdit.Replacement(0, document.Text.Length, c.Text);
                    }
                }).ToImmutableList();

                var newText = new EditString(document.Text).ApplyAll(edits);

                _documentManager.UpdateTextAsync(@params.TextDocument.Uri, newText);
            }
        }
        catch (Exception ex)
        {
            this.SendWindowLogMessageAsync(ex);
        }

        return Task.CompletedTask;
    }

    #endregion

    #region Workspace Configuration

    public override Task OnWorkspaceDidChangeConfigurationAsync(LSP.DidChangeConfigurationParams @params)
    {
        // pass on to ISettingSource listeners
        this.SettingsChanged?.Invoke(this, EventArgs.Empty);
        return Task.CompletedTask;
    }

    public event EventHandler? SettingsChanged;

    public async Task<ImmutableDictionary<string, object?>> GetSettingsAsync(IReadOnlyList<Setting> settings, CancellationToken cancellationToken)
    {
        var sendParams = new LSP.ConfigurationParams();
        sendParams.Items = settings.Select(s => new LSP.ConfigurationItem { Section = s.Name }).ToArray();
        var values = await this.SendWorkspaceConfigurationAsync(sendParams, cancellationToken).ConfigureAwait(false);
        return values
            .Select((r, i) => (s: settings[i], value: r))
            .ToImmutableDictionary(t => t.s.Name, t => t.value)
            ?? ImmutableDictionary<string, object?>.Empty;
    }

    public async Task<T> GetSettingAsync<T>(Setting<T> setting, CancellationToken cancellationToken)
    {
        var map = await GetSettingsAsync([setting], cancellationToken).ConfigureAwait(false);
        return setting.GetValue(map);
    }

    #endregion

    #region Completion Lists

    private static readonly CompletionOptions _completionOptions = CompletionOptions.Default
        .WithIncludePunctuationOnlySyntax(false)
        .WithAutoAppendWhitespace(false)
        .WithIncludeExtendedSyntax(false)
        .WithIncludeFunctions(true)
        .WithIncludeSymbols(true)
        .WithIncludeSyntax(true);

    public override async Task<LSP.SumType<LSP.CompletionItem[], LSP.CompletionList>?> OnTextDocumentCompletionAsync(LSP.CompletionParams @params, CancellationToken cancellationToken)
    {
        try
        {
            if (_documentManager.TryGetDocument(@params.TextDocument.Uri, out var document))
            {
                var position = GetTextPosition(document.Text, @params.Position);
                var elementRange = document.GetElement(position, cancellationToken);
                var info = document.GetCompletionItems(position, @params.Context?.TriggerCharacter, _completionOptions, cancellationToken);

                return info.Items.Select(CreateItem).ToArray();

                LSP.CompletionItem CreateItem(CompletionItem item)
                {
                    LSP.CompletionItem lspItem;

                    var displayText = item.DisplayText;
                    var kind = GetCompletionItemKind(item.Kind);

                    if (!string.IsNullOrEmpty(item.AfterText))
                    {
                        // Use snippet to control cursor position
                        var snippetText = $"{item.BeforeText}$0{item.AfterText}";

                        lspItem = new LSP.CompletionItem
                        {
                            Kind = kind,
                            Label = displayText,
                            SortText = item.OrderText,
                            FilterText = item.MatchText,
                            InsertTextFormat = LSP.InsertTextFormat.Snippet,
                            InsertText = snippetText
                        };
                    }
                    else
                    {
                        lspItem = new LSP.CompletionItem
                        {
                            Kind = kind,
                            Label = displayText,
                            SortText = item.OrderText,
                            FilterText = item.MatchText,
                            InsertText = item.BeforeText,
                        };
                    }

                    // Retrigger completion after insertion?
                    if (ShouldRetriggerCompletion(item))
                    {
                        lspItem.Command = new LSP.Command
                        {
                            Title = "Trigger Suggest",
                            CommandIdentifier = "editor.action.triggerSuggest"
                        };
                    }

                    return lspItem;
                }

                bool ShouldRetriggerCompletion(CompletionItem item)
                {
                    // Retrigger after function calls, member access, etc.
                    return item.BeforeText.EndsWith("(") ||
                            item.BeforeText.EndsWith("[") ||
                            item.BeforeText.EndsWith(".") ||
                            item.BeforeText.EndsWith("=") ||
                            item.BeforeText.EndsWith(" ");
                }
            }
        }
        catch (Exception ex)
        {
            var _ = this.SendWindowLogMessageAsync(ex);
        }

        return null;
    }

    private static LSP.CompletionItemKind GetCompletionItemKind(CompletionKind kind) =>
        kind switch
        {
            CompletionKind.Keyword => LSP.CompletionItemKind.Keyword,
            CompletionKind.Punctuation => LSP.CompletionItemKind.Text,
            CompletionKind.Syntax => LSP.CompletionItemKind.Text,
            CompletionKind.Identifier => LSP.CompletionItemKind.Variable,
            CompletionKind.Example => LSP.CompletionItemKind.Constant,
            CompletionKind.ScalarPrefix => LSP.CompletionItemKind.Operator,
            CompletionKind.TabularPrefix => LSP.CompletionItemKind.Keyword,
            CompletionKind.TabularSuffix => LSP.CompletionItemKind.Keyword,
            CompletionKind.QueryPrefix => LSP.CompletionItemKind.Keyword,
            CompletionKind.CommandPrefix => LSP.CompletionItemKind.Keyword,
            CompletionKind.ScalarInfix => LSP.CompletionItemKind.Operator,
            CompletionKind.RenderChart => LSP.CompletionItemKind.Template,
            CompletionKind.Column => LSP.CompletionItemKind.Property,
            CompletionKind.Table => LSP.CompletionItemKind.Class,
            CompletionKind.BuiltInFunction => LSP.CompletionItemKind.Function,
            CompletionKind.LocalFunction => LSP.CompletionItemKind.Method,
            CompletionKind.DatabaseFunction => LSP.CompletionItemKind.Method,
            CompletionKind.AggregateFunction => LSP.CompletionItemKind.Function,
            CompletionKind.Parameter => LSP.CompletionItemKind.Property,
            CompletionKind.Variable => LSP.CompletionItemKind.Variable,
            CompletionKind.Database => LSP.CompletionItemKind.Module,
            CompletionKind.Cluster => LSP.CompletionItemKind.Module,
            CompletionKind.MaterialiedView => LSP.CompletionItemKind.Class,
            CompletionKind.EntityGroup => LSP.CompletionItemKind.Class,
            CompletionKind.Graph => LSP.CompletionItemKind.Class,
            CompletionKind.ScalarType => LSP.CompletionItemKind.Keyword,
            CompletionKind.Option => LSP.CompletionItemKind.Text,
            CompletionKind.StoredQueryResult => LSP.CompletionItemKind.Class,
            _ =>  LSP.CompletionItemKind.None
        };
#endregion

    #region Semantic Tokens

    public override Task<LSP.SemanticTokens?> OnTextDocumentTokensFullAsync(LSP.SemanticTokensParams @params, CancellationToken cancellationToken)
    {
        return GetSemanticTokens(@params, null, cancellationToken);
    }

    public override Task<LSP.SemanticTokens?> OnTextDocumentSemanticTokensRangeAsync(LSP.SemanticTokensRangeParams @params, CancellationToken cancellationToken)
    {
        return GetSemanticTokens(@params, @params.Range, cancellationToken);
    }

    private Task<LSP.SemanticTokens?> GetSemanticTokens(LSP.SemanticTokensParams @params, LSP.Range? range, CancellationToken cancellationToken)
    {
        try
        {
            if (_documentManager.TryGetDocument(@params.TextDocument.Uri, out var document))
            {
                var textRange = range != null
                    ? GetTextRange(document.Text, range)
                    : new TextRange(0, document.Text.Length);

                var semanticTokens = new List<SemanticToken>();

                var result = document.GetClassifications(textRange.Start, textRange.Length, clipToRange: true, waitForAnalysis: true, cancellationToken);
                var tokens = result.Classifications.Select(Create).Where(t => t != null).OfType<SemanticToken>().ToList();
                semanticTokens.AddRange(tokens);

                if (_semanticEncoder == null)
                {
                    // make encode with the legend supplied by client during initialization, so we only encode token types/modifiers that client supports
                    _semanticEncoder = new SemanticTokenEncoder(
                        this.ServerSettings?.Capabilities?.SemanticTokensOptions?.Legend.TokenTypes.ToImmutableList() ?? ImmutableList<string>.Empty,
                        this.ServerSettings?.Capabilities?.SemanticTokensOptions?.Legend.TokenModifiers.ToImmutableList() ?? ImmutableList<string>.Empty
                        );
                }

                var data = _semanticEncoder.Encode(semanticTokens);
                var semanticResults = new LSP.SemanticTokens { Data = data };
                return Task.FromResult<LSP.SemanticTokens?>(semanticResults);
            }

            SemanticToken? Create(ClassifiedRange cr)
            {
                var kind = GetSemanticTokenKind(cr.Kind);
                if (kind != null)
                {
                    var position = GetLspPosition(document.Text, cr.Start);
                    return new SemanticToken
                    {
                        Line = position.Line,
                        Character = position.Character,
                        Length = cr.Length,
                        Type = kind,
                        Modifiers = ImmutableList<string>.Empty
                    };
                }
                else
                {
                    return null;
                }
            }
        }
        catch (Exception ex)
        {
            var _ = this.SendWindowLogMessageAsync(ex);
        }

        return Task.FromResult<LSP.SemanticTokens?>(null);
    }

    private SemanticTokenEncoder? _semanticEncoder;

    private static string? GetSemanticTokenKind(ClassificationKind kind) =>
        kind switch
        {
            //ClassificationKind.Comment => LSP.SemanticTokenTypes.Comment,
            //ClassificationKind.Directive => LSP.SemanticTokenTypes.Macro, //"directive",
            //ClassificationKind.Literal => LSP.SemanticTokenTypes.Number,
            //ClassificationKind.StringLiteral => LSP.SemanticTokenTypes.String,
            ClassificationKind.Type => LSP.SemanticTokenTypes.Type,
            ClassificationKind.Column => LSP.SemanticTokenTypes.Property, //"column",
            ClassificationKind.Table => LSP.SemanticTokenTypes.Class, //"table",
            ClassificationKind.Database => LSP.SemanticTokenTypes.Namespace, //"database",
            ClassificationKind.Function => LSP.SemanticTokenTypes.Function,
            ClassificationKind.Parameter => LSP.SemanticTokenTypes.Parameter,
            ClassificationKind.Variable => LSP.SemanticTokenTypes.Variable,
            //ClassificationKind.Identifier => LSP.SemanticTokenTypes.Variable,
            //ClassificationKind.ClientParameter => LSP.SemanticTokenTypes.String, //"clientParameter",
            ClassificationKind.QueryParameter => LSP.SemanticTokenTypes.Parameter, //"queryParameter",
            //ClassificationKind.ScalarOperator => LSP.SemanticTokenTypes.Operator,
            //ClassificationKind.MathOperator => LSP.SemanticTokenTypes.Operator,
            //ClassificationKind.QueryOperator => LSP.SemanticTokenTypes.Keyword, //"queryOperator",
            //ClassificationKind.Command => LSP.SemanticTokenTypes.Keyword, //"command",
            //ClassificationKind.Keyword => LSP.SemanticTokenTypes.Keyword,
            ClassificationKind.MaterializedView => LSP.SemanticTokenTypes.Class, //"materializedView",
            ClassificationKind.SchemaMember => LSP.SemanticTokenTypes.Property, // "schemaMember",
            ClassificationKind.SignatureParameter => LSP.SemanticTokenTypes.Parameter, //"signatureParameter",
            //ClassificationKind.Option => LSP.SemanticTokenTypes.Keyword, //"option",
            _ => null
        };

#endregion

    #region Hover Tips

    private static readonly QuickInfoOptions _quickInfoOptions =
        QuickInfoOptions.Default
        .WithShowDiagnostics(false); // already shown in vs code editor

    public override Task<LSP.Hover?> OnTextDocumentHoverAsync(LSP.TextDocumentPositionParams @params, CancellationToken cancellationToken)
    {
        try
        {
            if (_documentManager.TryGetDocument(@params.TextDocument.Uri, out var document))
            {
                var position = GetTextPosition(document.Text, @params.Position);
                var textRange = document.GetElement(position, cancellationToken);
                var info = document.GetQuickInfo(position, _quickInfoOptions, cancellationToken);

                if (info != null)
                {
                    var hover = new LSP.Hover
                    {
                        Contents = new LSP.MarkupContent
                        {
                            Kind = LSP.MarkupKind.Markdown,
                            Value = ToMarkdown(info)
                        },
                        Range = GetLspRange(document.Text, textRange)
                    };
                    return Task.FromResult<LSP.Hover?>(hover);
                }
            }
        }
        catch (Exception ex)
        {
            var _ = this.SendWindowLogMessageAsync(ex);
        }

        return base.OnTextDocumentHoverAsync(@params, cancellationToken);
    }

    private static string ToMarkdown(QuickInfo info)
    {
        return string.Join("\n-----\n", info.Items.Select(ToMarkdown));
    }

    private static string ToMarkdown(QuickInfoItem item)
    {
        return $"{ToMarkdownGlyph(item.Kind)}\t{string.Concat(item.Parts.Select(ToMarkdown))}";
    }

    private static string ToMarkdownGlyph(QuickInfoKind kind)
    {
        return kind switch
        {
            QuickInfoKind.BuiltInFunction => "ƒ",
            QuickInfoKind.LocalFunction => "ƒ",
            QuickInfoKind.DatabaseFunction => "ƒ",
            QuickInfoKind.Column => "🔤",
            QuickInfoKind.Cluster => "🏢",
            QuickInfoKind.Command => "💻",
            QuickInfoKind.Database => "🗄️",
            QuickInfoKind.Error => "❗",
            QuickInfoKind.Graph => "📊",
            QuickInfoKind.Literal => "🔢",
            QuickInfoKind.Operator => "➗",
            QuickInfoKind.Option => "⚙️",
            QuickInfoKind.Parameter => "🎯",
            QuickInfoKind.Pattern => "📐",
            QuickInfoKind.Scalar => "🔢",
            QuickInfoKind.Suggestion => "💡",
            QuickInfoKind.Table => "📋",
            QuickInfoKind.Type => "🏷️",
            QuickInfoKind.Variable => "🔣",
            QuickInfoKind.Warning => "⚠️",
            _ => ""
        };
    }

    private static string ToMarkdown(ClassifiedText classyText)
    {
        switch (classyText.Kind)
        {
            case ClassificationKind.Column:
            case ClassificationKind.Table:
            case ClassificationKind.Database:
            case ClassificationKind.Function:
            case ClassificationKind.Parameter:
            case ClassificationKind.Variable:
            case ClassificationKind.Identifier:
            case ClassificationKind.ClientParameter:
            case ClassificationKind.QueryParameter:
                return $"*{classyText.Text}*"; // name like things are italic

            case ClassificationKind.QueryOperator:
            case ClassificationKind.ScalarOperator:
            case ClassificationKind.Command:
            case ClassificationKind.Type:
            case ClassificationKind.Keyword:
            case ClassificationKind.MaterializedView:
            case ClassificationKind.SchemaMember:
            case ClassificationKind.SignatureParameter:
                return $"**{classyText.Text}**"; // keyword like things are bold

            default:
                return classyText.Text;
        }
    }
    #endregion

    #region Folding Ranges (Outlining)

    public override Task<LSP.FoldingRange[]?> OnTextDocumentFoldingAsync(LSP.FoldingRangeParams @params, CancellationToken cancellationToken)
    {
        try
        {
            if (_documentManager.TryGetDocument(@params.TextDocument.Uri, out var document))
            {
                var foldingRanges = new List<LSP.FoldingRange>();
                var info = document.GetOutlines(OutliningOptions.Default, cancellationToken);
                foreach (var fr in info.Ranges)
                {
                    var lspRange = GetLspRange(document.Text, new TextRange(fr.Start, fr.Length));
                    foldingRanges.Add(
                        new LSP.FoldingRange
                        {
                            StartLine = lspRange.Start.Line,
                            StartCharacter = lspRange.Start.Character,
                            EndLine = lspRange.End.Line,
                            EndCharacter = lspRange.End.Character,
                            Kind = LSP.FoldingRangeKind.Region
                        });
                }

                return Task.FromResult<LSP.FoldingRange[]?>(foldingRanges.ToArray());
            }
            
        }
        catch (Exception ex)
        {
            var _ = this.SendWindowLogMessageAsync(ex);
        }

        return Task.FromResult<LSP.FoldingRange[]?>(null);
    }

    #endregion

    #region Formatting

    public override Task<LSP.TextEdit[]?> OnTextDocumentFormattingAsync(LSP.DocumentFormattingParams @params, CancellationToken cancellationToken)
    {
        return FormatDocumentAsync(@params.TextDocument.Uri, @params.Options, null, cancellationToken);
    }

    public override Task<LSP.TextEdit[]?> OnTextDocumentRangeFormattingAsync(LSP.DocumentRangeFormattingParams @params, CancellationToken cancellationToken)
    {
        return FormatDocumentAsync(@params.TextDocument.Uri, @params.Options, @params.Range, cancellationToken);
    }

    private async Task<LSP.TextEdit[]?> FormatDocumentAsync(
        Uri docId,
        LSP.FormattingOptions lspOptions,
        LSP.Range? lspRange, 
        CancellationToken cancellationToken)
    {
        try
        {
            if (_documentManager.TryGetDocument(docId, out var document))
            {
                var textRange = lspRange != null
                    ? GetTextRange(document.Text, lspRange)
                    : new TextRange(0, document.Text.Length);

                var formatted = document.GetFormattedText(textRange, _optionsManager.FormattingOptions, cancellationToken);
                var edits = formatted.Edits.Select(e => GetLspTextEdit(document.Text, e)).ToArray();
                return edits;
            }
        }
        catch (Exception ex)
        {
            var _ = this.SendWindowLogMessageAsync(ex);
        }

        return null;
    }

    #endregion

    #region Rename

    public override Task<LSP.RenameRange?> OnTextDocumentPrepareRenameAsync(LSP.PrepareRenameParams @params, CancellationToken cancellation)
    {
        try
        {
            if (_documentManager.TryGetDocument(@params.TextDocument.Uri, out var document))
            {
                var position = GetTextPosition(document.Text, @params.Position);

                //// Use Kusto.Language to find the symbol at this position
                //var symbol = document.GetReferencedSymbol(position);

                //if (symbol == null || !CanRename(symbol))
                //{
                //    // Return null to indicate rename is not supported here
                //    return Task.FromResult<RenameRange?>(null);
                //}

                //// Get the range of the symbol name
                //var symbolRange = document.GetSymbolNameRange(position);

                //return Task.FromResult<RenameRange?>(new RenameRange
                //{
                //    Range = GetLspRange(document.Text, symbolRange),
                //    Placeholder = symbol.Name
                //});
            }
        }
        catch (Exception ex)
        {
            _ = SendWindowLogMessageAsync(ex);
        }

        return Task.FromResult<LSP.RenameRange?>(null);
    }

    public override Task<LSP.WorkspaceEdit?> OnTextDocumentRenameAsync(LSP.RenameParams @params, CancellationToken cancellationToken)
    {
        if (_documentManager.TryGetDocument(@params.TextDocument.Uri, out var document))
        {
            var position = GetTextPosition(document.Text, @params.Position);

            RelatedInfo relatedInfo = document.GetRelatedElements(position, _defaultFindRelatedOptions, cancellationToken);

            // only rename if a declaration is present, so we don't try renaming columns from database tables, etc.
            if (relatedInfo.Elements.Any(e => e.Kind == RelatedElementKind.Declaration))
            {
                var edits = relatedInfo.Elements
                    .Where(elem => elem.Kind == RelatedElementKind.Declaration || elem.Kind == RelatedElementKind.Reference)
                    .Select(elem =>
                        new LSP.TextEdit
                        {
                            Range = GetLspRange(document.Text, elem.Range),
                            NewText = @params.NewName
                        }).ToArray();
                var workspaceEdit = new LSP.WorkspaceEdit
                {
                    Changes = new Dictionary<string, LSP.TextEdit[]>
                    {
                        [@params.TextDocument.Uri.ToString()] = edits
                    }
                };
                return Task.FromResult<LSP.WorkspaceEdit?>(workspaceEdit);
            }
        }
        return base.OnTextDocumentRenameAsync(@params, cancellationToken);
    }

    #endregion

    #region Document Highlighting

    private static readonly FindRelatedOptions _defaultFindRelatedOptions =
        FindRelatedOptions.None;

    public override Task<LSP.DocumentHighlight[]?> OnTextDocumentHighlightAsync(LSP.TextDocumentPositionParams @params, CancellationToken cancellationToken)
    {
        try
        {
            if (_documentManager.TryGetDocument(@params.TextDocument.Uri, out var document))
            {
                var position = GetTextPosition(document.Text, @params.Position);

                RelatedInfo relatedInfo = document.GetRelatedElements(position, _defaultFindRelatedOptions, cancellationToken);
                var lspHighlights = relatedInfo.Elements.Select(elem =>
                    new LSP.DocumentHighlight
                    {
                        Range = GetLspRange(document.Text, new TextRange(elem.Start, elem.Length)),
                        Kind = elem.Kind switch
                        {
                            RelatedElementKind.Reference => LSP.DocumentHighlightKind.Read,
                            RelatedElementKind.Declaration => LSP.DocumentHighlightKind.Write,
                            _ => LSP.DocumentHighlightKind.Text
                        }
                    }).ToArray();

                return Task.FromResult<LSP.DocumentHighlight[]?>(lspHighlights);
            }
            
        }
        catch (Exception ex)
        {
            var _ = this.SendWindowLogMessageAsync(ex);
        }

        return Task.FromResult<LSP.DocumentHighlight[]?>(null);
    }

    #endregion

    #region Find References

    public override Task<LSP.Location[]?> OnTextDocumentReferencesAsync(LSP.ReferenceParams @params, CancellationToken cancellationToken)
    {
        try
        {
            if (_documentManager.TryGetDocument(@params.TextDocument.Uri, out var document))
            {
                var position = GetTextPosition(document.Text, @params.Position);
                RelatedInfo relatedInfo = document.GetRelatedElements(position, _defaultFindRelatedOptions, cancellationToken);
                if (relatedInfo.Elements.Any(e => e.Kind == RelatedElementKind.Declaration || e.Kind == RelatedElementKind.Reference))
                {
                    var lspLocations = relatedInfo.Elements
                        .Where(elem => elem.Kind == RelatedElementKind.Reference
                            || (@params.Context.IncludeDeclaration && elem.Kind == RelatedElementKind.Declaration))
                        .Select(elem =>
                            new LSP.Location
                            {
                                Uri = @params.TextDocument.Uri,
                                Range = GetLspRange(document.Text, elem.Range)
                            }).ToArray();
                    return Task.FromResult<LSP.Location[]?>(lspLocations);
                }
            }
        }
        catch (Exception ex)
        {
            var _ = this.SendWindowLogMessageAsync(ex);
        }

        return Task.FromResult<LSP.Location[]?>(null);
    }


    #endregion

    #region Goto Definition

    /// <summary>
    /// Custom URI scheme for virtual entity definition documents.
    /// </summary>
    private const string EntityDefinitionScheme = "kusto-entity";

    public override async Task<LSP.SumType<LSP.Location, LSP.Location[]>?> OnTextDocumentDefinitionAsync(LSP.TextDocumentPositionParams @params, CancellationToken cancellationToken)
    {
        try
        {
            if (_documentManager.TryGetDocument(@params.TextDocument.Uri, out var document))
            {
                var position = GetTextPosition(document.Text, @params.Position);

                // Get the referenced symbol at the position
                var referencedSymbol = document.GetReferencedSymbol(position, cancellationToken);
                if (referencedSymbol == null)
                    return null;

                var declarations = document.GetDeclarationLocations(position, cancellationToken);
                if (declarations.Count > 0)
                {
                    var lspLocations = new List<LSP.Location>(declarations.Count);

                    foreach (var decl in declarations)
                    {
                        var lspLocation = await GetLocationAsync(document, referencedSymbol, decl, cancellationToken).ConfigureAwait(false);
                        lspLocations.Add(lspLocation);
                    }

                    return lspLocations.ToArray();
                }

                return null;
            }
        }
        catch (Exception ex)
        {
            var _ = this.SendWindowLogMessageAsync(ex);
        }

        return null;
    }

    private async Task<LSP.Location> GetLocationAsync(IDocument document, Symbol symbol, DeclarationLocation location, CancellationToken cancellationToken)
    {
        if (location.Entity != null)
        {
            var databaseSymbol = document.Globals.GetDatabase(location.Entity);
            var clusterSymbol = document.Globals.GetCluster(databaseSymbol);
            var databaseName = databaseSymbol.Name;
            var clusterName = clusterSymbol.Name;
            var entityType = GetEntityType(location.Entity);
            var entityName = location.Entity.Name;

            // Create the virtual URI for the entity
            var virtualUri = CreateEntityDefinitionUri(clusterName, databaseName, entityType, entityName);

            // Get the table definition content to find the column's location
            var entityId = new EntityId
            {
                ClusterName = clusterName,
                DatabaseName = databaseName,
                EntityType = entityType,
                EntityName = entityName
            };

            // is the the one in the location itself?
            if (symbol == location.Entity)
            {
                return new LSP.Location { Range = GetLspRange(document.Text, location.Range), Uri = virtualUri };
            }

            // find the correct location in the definition text
            var definitionContent = await _entityManager.GetDefinition(entityId, cancellationToken).ConfigureAwait(false);
            if (definitionContent != null)
            {
                var declarationRange = FindRangeInDefinition(definitionContent, document.Globals, symbol);
                return new LSP.Location
                {
                    Uri = virtualUri,
                    Range = GetLspRange(definitionContent, declarationRange)
                };
            }

            // Fall back to pointing to the start of the table definition
            return
                new LSP.Location
                {
                    Uri = virtualUri,
                    Range = new LSP.Range
                    {
                        Start = new LSP.Position { Line = 0, Character = 0 },
                        End = new LSP.Position { Line = 0, Character = 0 }
                    }
                };
        }
        else
        {
            return new LSP.Location
            {
                Uri = document.Id,
                Range = GetLspRange(document.Text, location.Range)
            };
        }
    }

    private static TextRange FindRangeInDefinition(string definition, GlobalState globals, Symbol symbol)
    {
        var code = KustoCode.ParseAndAnalyze(definition, globals);

        // look for declarations in the definition with this name and same symbol type
        var decl = DeclarationFinder.GetLocalDeclarations(code.Syntax, symbol.Name)
            .Where(d => d.ReferencedSymbol?.GetType() == symbol.GetType())
            .FirstOrDefault();
        if (decl != null)
        {
            return new TextRange(decl.TextStart, decl.Width);
        }

        // otherwise, look for any declaration with this name..
        // this happens with table create commands and maybe other command syntax
        var name = KustoFacts.BracketNameIfNecessary(symbol.Name, KustoDialect.EngineCommand);
        var pos = 0;
        do
        {
            var index = definition.IndexOf(name, pos);
            if (index >= pos && index < definition.Length)
            {
                var token = code.Syntax.GetTokenAt(index);
                if (token != null 
                    && token.Parent != null
                    && token.Parent.GetAncestorsOrSelf<Kusto.Language.Syntax.Name>().FirstOrDefault() is { } nameNode
                    && nameNode.Parent is Kusto.Language.Syntax.NameDeclaration nd)
                {
                    return new TextRange(nameNode.TextStart, nameNode.Width);
                }
            }

            // continue searching
            pos = index + 1;
        }
        while (pos < definition.Length);

        return default;
    }

    private static EntityType GetEntityType(Symbol symbol) =>   
        symbol switch
        {
            ExternalTableSymbol => EntityType.ExternalTable,
            MaterializedViewSymbol => EntityType.MaterializedView,
            StoredQueryResultSymbol => EntityType.StoredQueryResult,
            TableSymbol => EntityType.Table,
            FunctionSymbol => EntityType.Function,
            EntityGroupSymbol => EntityType.EntityGroup,
            GraphModelSymbol => EntityType.Graph,
            _ => EntityType.Table // Default fallback, should not happen
        };

    /// <summary>
    /// Creates a virtual document URI for an entity definition.
    /// Format: kusto-entity://cluster/database/entityType/entityName.kql
    /// </summary>
    private static Uri CreateEntityDefinitionUri(string cluster, string database, EntityType entityType, string entityName)
    {
        var encodedCluster = Uri.EscapeDataString(cluster);
        var encodedDatabase = Uri.EscapeDataString(database);
        var encodedEntityType = Uri.EscapeDataString(entityType.FastToString());
        var encodedEntityName = Uri.EscapeDataString(entityName);
        return new Uri($"{EntityDefinitionScheme}://{encodedCluster}/{encodedDatabase}/{encodedEntityType}/{encodedEntityName}.kql");
    }

    /// <summary>
    /// Parses an entity definition URI to extract entity information.
    /// </summary>
    private static bool TryParseEntityDefinitionUri(Uri uri, out string cluster, out string database, out string entityType, out string entityName)
    {
        cluster = database = entityType = entityName = "";

        if (uri.Scheme != EntityDefinitionScheme)
            return false;

        try
        {
            cluster = Uri.UnescapeDataString(uri.Host);
            var segments = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
            if (segments.Length >= 3)
            {
                database = Uri.UnescapeDataString(segments[0]);
                entityType = Uri.UnescapeDataString(segments[1]);
                entityName = Uri.UnescapeDataString(Path.GetFileNameWithoutExtension(segments[2]));
                return true;
            }
        }
        catch
        {
            // Parsing failed
        }

        return false;
    }

#endregion

    #region Code Actions

    /// <summary>
    /// CodeActions created for this script so far
    /// </summary>
    private class DocumentActions
    {
        // a map from action id to action
        public ImmutableDictionary<string, ApplyAction> Actions = ImmutableDictionary<string, ApplyAction>.Empty;
    }

    /// <summary>
    /// Table of actions per script.
    /// </summary>
    private readonly ConditionalWeakTable<IDocument, DocumentActions> _scriptActions =
        new ConditionalWeakTable<IDocument, DocumentActions>();

    private static readonly CodeActionOptions _codeActionOptions =
        CodeActionOptions.Default;

    public override Task<LSP.SumType<LSP.Command, LSP.CodeAction>[]?> OnTextDocumentCodeActionAsync(LSP.CodeActionParams @params, CancellationToken cancellationToken)
    {
        try
        {
            if (_documentManager.TryGetDocument(@params.TextDocument.Uri, out var document))
            {
                var range = GetTextRange(document.Text, @params.Range);
                var position = range.Start;

                var lspActions = new List<LSP.SumType<LSP.Command, LSP.CodeAction>>();

                var info = document.GetCodeActions(position, range.Start, range.Length, _codeActionOptions, cancellationToken: cancellationToken);

                var scriptActions = _scriptActions.GetOrCreateValue(document);
                foreach (var action in info.Actions)
                {
                    AddAction(action, action.Title);
                }

                 return Task.FromResult<LSP.SumType<LSP.Command, LSP.CodeAction>[]?>(lspActions.ToArray());

                void AddAction(CodeAction action, string title)
                {
                    switch (action)
                    {
                        case ApplyAction apply:
                            // add to map so we can look this action back when resolved.
                            var id = $"Action{scriptActions.Actions.Count + 1}";
                            scriptActions.Actions = scriptActions.Actions.Add(id, apply);
                            lspActions.Add(new LSP.CodeAction
                            {
                                Title = action.Title,
                                Kind = LSP.CodeActionKind.QuickFix,
                                Data = $"{@params.TextDocument.Uri}|{position}|{id}"  // combine uri, text position and action id so we can look up later
                            });
                            break;
                        case MenuAction menu:
                            // LSP cannot describe nested actions, so flatten them out
                            foreach (var subAction in menu.Actions)
                            {
                                AddAction(subAction, $"{menu.Title}: {subAction.Title}" );
                            }
                            break;
                    }
                }
            }

        }
        catch (Exception ex)
        {
            var _ = this.SendWindowLogMessageAsync(ex);
        }

        return Task.FromResult<LSP.SumType<LSP.Command, LSP.CodeAction>[]?>(null);
    }

    public override async Task<LSP.CodeAction> OnCodeActionResolveAsync(LSP.CodeAction lspAction, CancellationToken cancellationToken)
    {
        try
        {
            if (lspAction.Data is string stringData)
            {
                var dataParts = stringData.Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                if (dataParts.Length == 3)
                {
                    var docUriText = dataParts[0];
                    var docUri = new Uri(docUriText);
                    var position = int.Parse(dataParts[1]);
                    var actionId = dataParts[2];

                    if (_documentManager.TryGetDocument(docUri, out var document)
                        && _scriptActions.TryGetValue(document, out var scriptActions)
                        && scriptActions.Actions.TryGetValue(actionId, out var action))
                    {
                        var applyOptions = _codeActionOptions.WithFormattingOptions(_optionsManager.FormattingOptions);

                        var result = document.ApplyCodeAction(action, position, applyOptions, cancellationToken);

                        var changes = new Dictionary<string, LSP.TextEdit[]>();

                        foreach (var resultAction in result.Actions)
                        {
                            switch (resultAction)
                            {
                                case ChangeTextAction changeText:
                                    changes[docUriText] = changeText.Changes
                                        .Select(edit => GetLspTextEdit(document.Text, TextEdit.Replacement(edit.Start, edit.DeleteLength, edit.InsertText)))
                                        .ToArray();
                                    break;
                                case MoveCaretAction:
                                    break;
                                case RenameAction:
                                    break;
                                default:
                                    break;
                            }
                        }

                        lspAction.Edit = new LSP.WorkspaceEdit
                        {
                            Changes = changes
                        };
                    }
                }
            }
        }
        catch (Exception ex)
        {
            var _ = this.SendWindowLogMessageAsync(ex);
        }

        return lspAction;
    }
    #endregion

#endregion

    #region Kusto Extensions

    #region Schema

    [JsonRpcMethod("kusto/getServerInfo", UseSingleObjectParameterDeserialization = true)]
    public async Task<GetServerInfoResult?> OnGetServerInfoAsync(GetServerInfoParams @params, CancellationToken cancellationToken)
    {
        try
        {
            var clusterName = _connectionManager.GetOrAddConnection(@params.Connection).Cluster;

            // ensure server databases are loaded
            var clusterInfo = await _schemaManager.GetClusterInfoAsync(clusterName, null, cancellationToken).ConfigureAwait(false);
            if (clusterInfo != null)
            {
                var dbs = clusterInfo.Databases.Select(db => new ServerDatabase
                {
                    Name = db.Name,
                    AlternateName = db.AlternateName ?? ""
                }).ToArray();
                return new GetServerInfoResult
                {
                    Cluster = clusterName,
                    Databases = dbs
                };
            }
        }
        catch (Exception ex)
        {
            _ = this.SendWindowLogMessageAsync(ex);
        }

        return null;
    }

    [DataContract]
    public class GetServerInfoParams
    {
        [DataMember(Name = "connection")]
        public required string Connection { get; set; }

        [DataMember(Name = "serverKind")]
        public string? ServerKind { get; set; }
    }

    [DataContract]
    public class GetServerInfoResult
    {
        [DataMember(Name = "cluster")]
        public required string Cluster { get; set; }

        [DataMember(Name = "databases")]
        public required ServerDatabase[] Databases { get; set; }
    }

    [DataContract]
    public class ServerDatabase
    {
        [DataMember(Name = "name")]
        public required string Name { get; set; }

        [DataMember(Name = "alternateName")]
        public required string AlternateName { get; set; }
    }

    [JsonRpcMethod("kusto/getServerKind", UseSingleObjectParameterDeserialization = true)]
    public async Task<GetServerKindResult?> OnGetServerKindAsync(GetServerKindParams @params, CancellationToken cancellationToken)
    {
        try
        {
            var connection = _connectionManager.GetOrAddConnection(@params.Connection);
            var serverKind = await connection.GetServerKindAsync(cancellationToken).ConfigureAwait(false);
            return new GetServerKindResult
            {
                ServerKind = serverKind
            };
        }
        catch (Exception ex)
        {
            _ = this.SendWindowLogMessageAsync(ex);
            return null;
        }
    }

    [DataContract]
    public class GetServerKindParams
    {
        [DataMember(Name = "connection")]
        public required string Connection { get; set; }
    }

    [DataContract]
    public class GetServerKindResult
    {
        [DataMember(Name = "serverKind")]
        public required string ServerKind { get; set; }
    }

    [JsonRpcMethod("kusto/decodeConnectionString", UseSingleObjectParameterDeserialization = true)]
    public Task<DecodeConnectionStringResult?> OnDecodeConnectionStringAsync(DecodeConnectionStringParams @params, CancellationToken cancellationToken)
    {
        try
        {
            var connection = _connectionManager.GetOrAddConnection(@params.ConnectionString);
            return Task.FromResult<DecodeConnectionStringResult?>(new DecodeConnectionStringResult
            {
                Cluster = connection.Cluster,
                Database = connection.Database
            });
        }
        catch (Exception ex)
        {
            _ = this.SendWindowLogMessageAsync(ex);
            return Task.FromResult<DecodeConnectionStringResult?>(null);
        }
    }

    [DataContract]
    public class DecodeConnectionStringParams
    {
        [DataMember(Name = "connectionString")]
        public required string ConnectionString { get; set; }
    }

    [DataContract]
    public class DecodeConnectionStringResult
    {
        [DataMember(Name = "cluster")]
        public required string Cluster { get; set; }

        [DataMember(Name = "database")]
        public string? Database { get; set; }
    }

    [JsonRpcMethod("kusto/getDatabaseInfo", UseSingleObjectParameterDeserialization = true)]
    public async Task<DatabaseInfo?> OnGetDatabaseInfo(GetDatabaseInfoParams @params, CancellationToken cancellationToken)
    {
        try
        {
            var clusterName = @params.Cluster;
            var databaseName = @params.Database;

            return await _schemaManager.GetDatabaseInfoAsync(clusterName, databaseName, contextCluster: null, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _ = this.SendWindowLogMessageAsync(ex);
        }

        return null;
    }

    [DataContract]
    public class GetDatabaseInfoParams
    {
        [DataMember(Name = "cluster")]
        public required string Cluster { get; init; }

        [DataMember(Name = "database")]
        public required string Database { get; init; }
    }

    [JsonRpcMethod("kusto/refreshSchema", UseSingleObjectParameterDeserialization = true)]
    public async Task OnRefreshSchemaAsync(RefreshSchemaParams @params, CancellationToken cancellationToken)
    {
        try
        {
            var clusterName = @params.Cluster;
            var databaseName = @params.Database;

            _ = this.SendWindowLogMessageAsync($"RefreshSchema: refreshing schema for cluster: {clusterName}, database: {databaseName ?? "(all)"}");

            await _symbolManager.RefreshAsync(clusterName, databaseName, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _ = this.SendWindowLogMessageAsync(ex);
        }
    }

    [DataContract]
    public class RefreshSchemaParams
    {
        [DataMember(Name = "cluster")]
        public required string Cluster { get; init; }

        [DataMember(Name = "database")]
        public string? Database { get; init; }
    }

    /// <summary>
    /// Refreshes the database schemas specifically referenced by the document.
    /// </summary>
    [JsonRpcMethod("kusto/refreshDocumentSchema", UseSingleObjectParameterDeserialization = true)]
    public async Task OnRefreshDocumentSchemaAsync(RefreshDocumentSchemaParams @params, CancellationToken cancellationToken)
    {
        try
        {
            await _documentManager.RefreshReferencedSymbolsAsync(@params.Uri, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _ = this.SendWindowLogMessageAsync(ex);
        }
    }

    [DataContract]
    public class RefreshDocumentSchemaParams
    {
        [DataMember(Name = "uri")]
        public required Uri Uri { get; init; }
    }

    #endregion

    #region Document Connections

    /// <summary>
    /// Ensures the server has a document. If the document is not known to the server,
    /// it will be added with the provided text. Always sends a documentReady notification.
    /// This handles the VS Code case where closing a tab may send didClose but reopening
    /// doesn't always send didOpen.
    /// </summary>
    [JsonRpcMethod("kusto/ensureDocument", UseSingleObjectParameterDeserialization = true)]
    public Task OnEnsureDocumentAsync(EnsureDocumentParams @params, CancellationToken cancellationToken)
    {
        try
        {
            var uri = new Uri(@params.Uri);
            
            if (!_documentManager.TryGetDocument(uri, out _))
            {
                // Document not known to server - add it
                _documentManager.AddDocument(uri, @params.Text);
                _ = this.SendWindowLogMessageAsync($"ensureDocument: added document {@params.Uri}");
            }
            
            // Always send documentReady notification
            _ = this.SendNotificationAsync("kusto/documentReady", new
            {
                uri = @params.Uri
            });
        }
        catch (Exception ex)
        {
            _ = this.SendWindowLogMessageAsync(ex);
        }

        return Task.CompletedTask;
    }

    [DataContract]
    public class EnsureDocumentParams
    {
        [DataMember(Name = "uri")]
        public required string Uri { get; set; }

        [DataMember(Name = "text")]
        public required string Text { get; set; }
    }

    [JsonRpcMethod("kusto/connectionsUpdated", UseSingleObjectParameterDeserialization = true)]
    public async Task OnConnectionsUpdatedAsync(ConnectionsUpdatedParams @params, CancellationToken cancellationToken)
    {
        try
        {
            var clusterNames = new List<string>();

            // ensure all connections are known by the connection manager
            foreach (var connectionString in @params.Connections)
            {
                var conn = _connectionManager.GetOrAddConnection(connectionString);
                clusterNames.Add(conn.Cluster);
            }

            // Ensure cluster symbols exist for all configured connections
            await _symbolManager.EnsureClustersAsync(clusterNames.ToImmutableList(), contextCluster: null, cancellationToken);
        }
        catch (Exception ex)
        {
            _ = this.SendWindowLogMessageAsync(ex);
        }
    }

    [DataContract]
    public class ConnectionsUpdatedParams
    {
        [DataMember(Name = "connections")]
        public required string[] Connections { get; set; }
    }

    [JsonRpcMethod("kusto/documentConnectionChanged", UseSingleObjectParameterDeserialization = true)]
    public Task OnDocumentConnectionChangedAsync(DocumentConnectionChangedParams @params, CancellationToken cancellationToken)
    {
        try
        {
            var uri = new Uri(@params.Uri);
            _documentManager.UpdateConnectionAsync(uri, @params.Cluster, @params.Database, @params.ServerKind);
        }
        catch (Exception ex)
        {
            _ = this.SendWindowLogMessageAsync(ex);
        }

        return Task.CompletedTask;
    }

    [DataContract]
    public class DocumentConnectionChangedParams
    {
        [DataMember(Name = "uri")]
        public required string Uri { get; set; }

        [DataMember(Name = "cluster")]
        public string? Cluster { get; set; }

        [DataMember(Name = "database")]
        public string? Database { get; set; }

        [DataMember(Name = "serverKind")]
        public string? ServerKind { get; set; }
    }


    [JsonRpcMethod("kusto/inferDocumentConnection", UseSingleObjectParameterDeserialization = true)]
    public async Task<InferDocumentConnectionResult?> OnInferDocumentConnectionAsync(InferDocumentConnectionParams @params, CancellationToken cancellationToken)
    {
        try
        {
            // Check if this is a virtual entity definition document
            // These have the cluster and database encoded in the URI
            if (TryParseEntityDefinitionUri(@params.Uri, out var cluster, out var database, out _, out _))
            {
                return new InferDocumentConnectionResult
                {
                    Cluster = cluster,
                    Database = database
                };
            }

            if (_documentManager.TryGetDocument(@params.Uri, out var document))
            {
                var info = document.GetInferredConnection(cancellationToken);
                if (info != null)
                {
                    return new InferDocumentConnectionResult
                    {
                        Connection = info.Connection,
                        Cluster = info.ClusterName,
                        Database = info.DatabaseName
                    };
                }
            }
        }
        catch (Exception ex)
        {
            _ = this.SendWindowLogMessageAsync(ex);
        }

        return null;
    }

    [DataContract]
    public class InferDocumentConnectionParams
    {
        [DataMember(Name = "uri")]
        public required Uri Uri { get; set; }
    }

    [DataContract]
    public class InferDocumentConnectionResult
    {
        [DataMember(Name = "connection")]
        public string? Connection { get; set; }

        [DataMember(Name = "cluster")]
        public string? Cluster { get; set; }

        [DataMember(Name = "database")]
        public string? Database { get; set; }
    }

    #endregion

    #region Query

    #region Ranges

    [JsonRpcMethod("kusto/getQueryRanges", UseSingleObjectParameterDeserialization = true)]
    public Task<QueryRangesResult?> OnGetQueryRangesAsync(QueryRangesParams @params, CancellationToken cancellationToken)
    {
        try
        {
            var uri = new Uri(@params.Uri);
            if (_documentManager.TryGetDocument(uri, out var document))
            {
                var ranges = document.GetSectionRanges().Select(r => GetLspRange(document.Text, r)).ToArray();
                return Task.FromResult<QueryRangesResult?>(new QueryRangesResult
                {
                    Uri = @params.Uri,
                    Ranges = ranges
                });
            }
        }
        catch (Exception ex)
        {
            _ = this.SendWindowLogMessageAsync(ex);
        }

        return Task.FromResult<QueryRangesResult?>(null);
    }

    [DataContract]
    public class QueryRangesParams
    {
        [DataMember(Name = "uri")]
        public required string Uri { get; init; }
    }

    [DataContract]
    public class QueryRangesResult
    {
        [DataMember(Name = "uri")]
        public required string Uri { get; init; }

        [DataMember(Name = "ranges")]
        public required LSP.Range[] Ranges { get; init; }
    }

    [JsonRpcMethod("kusto/getQueryRange", UseSingleObjectParameterDeserialization = true)]
    public Task<LSP.Range?> OnGetQueryRangeAsync(QueryRangeParams @params, CancellationToken cancellationToken)
    {
        try
        {
            var uri = new Uri(@params.Uri);
            if (_documentManager.TryGetDocument(uri, out var document))
            {
                var position = GetTextPosition(document.Text, @params.Position);
                if (document.GetSectionRange(position) is { } textRange)
                {
                    var lspRange = GetLspRange(document.Text, textRange);
                    return Task.FromResult<LSP.Range?>(lspRange);
                }
            }
        }
        catch (Exception ex)
        {
            _ = this.SendWindowLogMessageAsync(ex);
        }

        return Task.FromResult<LSP.Range?>(null);
    }

    [DataContract]
    public class QueryRangeParams
    {
        [DataMember(Name = "uri")]
        public required string Uri { get; init; }

        [DataMember(Name = "position")]
        public required LSP.Position Position { get; init; }
    }

    #endregion

    #region Validate

    [JsonRpcMethod("kusto/validateQuery", UseSingleObjectParameterDeserialization = true)]
    public async Task<ValidateQueryResult> OnValidateQueryAsync(ValidateQueryParams @params, CancellationToken cancellationToken)
    {
        try
        {
            var diagnostics = await _queryManager.ValidateQueryAsync(
                @params.Query,
                @params.Cluster,
                @params.Database,
                cancellationToken)
                .ConfigureAwait(false);

            var lspDiagnostics = diagnostics.Select(d =>
                new LSP.Diagnostic
                {
                    Range = GetLspRange(@params.Query, new TextRange(d.Start, d.Length)),
                    Code = d.Code,
                    Message = d.Message,
                    Severity = GetSeverity(d.Severity)
                }).ToArray();

            return new ValidateQueryResult
            {
                Diagnostics = lspDiagnostics
            };
        }
        catch (Exception ex)
        {
            _ = this.SendWindowLogMessageAsync(ex);
            return new ValidateQueryResult
            {
                Diagnostics = []
            };
        }

        LSP.DiagnosticSeverity GetSeverity(string severity) =>
            severity switch
            {
                DiagnosticSeverity.Error => LSP.DiagnosticSeverity.Error,
                DiagnosticSeverity.Warning => LSP.DiagnosticSeverity.Warning,
                DiagnosticSeverity.Suggestion => LSP.DiagnosticSeverity.Hint,
                DiagnosticSeverity.Information => LSP.DiagnosticSeverity.Information,
                _ => LSP.DiagnosticSeverity.Information
            };
    }


    [DataContract]
    public class ValidateQueryParams
    {
        [DataMember(Name = "query")]
        public required string Query { get; set; }

        [DataMember(Name = "cluster")]
        public required string Cluster { get; set; }

        [DataMember(Name = "database")]
        public string? Database { get; set; }
    }

    [DataContract]
    public class ValidateQueryResult
    {
        [DataMember(Name = "diagnostics")]
        public required LSP.Diagnostic[] Diagnostics { get; set; }
    }

    #endregion

    #region Minify

    [JsonRpcMethod("kusto/getMinifiedQuery", UseSingleObjectParameterDeserialization = true)]
    public Task<GetMinifiedQueryResult?> OnGetMinifiedQueryAsync(GetMinifiedQueryParams @params, CancellationToken cancellationToken)
    {
        try
        {
            // Create a temporary sectioned document with the query text
            var tempUri = new Uri("temp://minify");
            var document = new SectionedDocument(tempUri, @params.Query, _symbolManager.Globals);

            // Get the minified text using SingleLine kind (same as ResultsManager.GetKey)
            var minifiedText = document.GetMinimalText(0, Language.Editor.MinimalTextKind.SingleLine);

            return Task.FromResult<GetMinifiedQueryResult?>(new GetMinifiedQueryResult
            {
                MinifiedQuery = minifiedText
            });
        }
        catch (Exception ex)
        {
            _ = this.SendWindowLogMessageAsync(ex);
            return Task.FromResult<GetMinifiedQueryResult?>(null);
        }
    }

    [DataContract]
    public class GetMinifiedQueryParams
    {
        [DataMember(Name = "query")]
        public required string Query { get; set; }
    }

    [DataContract]
    public class GetMinifiedQueryResult
    {
        [DataMember(Name = "minifiedQuery")]
        public string? MinifiedQuery { get; set; }
    }

    #endregion

    #region Result Type

    [JsonRpcMethod("kusto/getQueryResultType", UseSingleObjectParameterDeserialization = true)]
    public async Task<GetQueryResultTypeResult?> OnGetQueryResultTypeAsync(GetQueryResultTypeParams @params, CancellationToken cancellationToken)
    {
        try
        {
            var resultType = await _queryManager.GetQueryResultTypeAsync(
                @params.Query,
                @params.Cluster,
                @params.Database,
                cancellationToken)
                .ConfigureAwait(false);

            return new GetQueryResultTypeResult { ResultType = resultType };
        }
        catch (Exception ex)
        {
            _ = this.SendWindowLogMessageAsync(ex);
            return null;
        }
    }

    [DataContract]
    public class GetQueryResultTypeParams
    {
        [DataMember(Name = "query")]
        public required string Query { get; set; }

        [DataMember(Name = "cluster")]
        public required string Cluster { get; set; }

        [DataMember(Name = "database")]
        public string? Database { get; set; }
    }

    [DataContract]
    public class GetQueryResultTypeResult
    {
        [DataMember(Name = "resultType")]
        public string? ResultType { get; set; }
    }

    [JsonRpcMethod("kusto/getFunctionResultType", UseSingleObjectParameterDeserialization = true)]
    public async Task<GetFunctionResultTypeResult?> OnGetFunctionResultTypeAsync(GetFunctionResultTypeParams @params, CancellationToken cancellationToken)
    {
        try
        {
            // Get globals with cluster/database context
            var globals = _symbolManager.Globals;
            if (@params.Cluster != null)
            {
                await _symbolManager.EnsureClustersAsync([@params.Cluster], contextCluster: null, cancellationToken).ConfigureAwait(false);
                globals = _symbolManager.Globals;
                if (globals.GetCluster(@params.Cluster) is { } clusterSymbol)
                {
                    globals = globals.WithCluster(clusterSymbol);
                    if (@params.Database != null)
                    {
                        await _symbolManager.EnsureDatabaseAsync(@params.Cluster, @params.Database, contextCluster: null, cancellationToken).ConfigureAwait(false);
                        globals = _symbolManager.Globals;
                        clusterSymbol = globals.GetCluster(@params.Cluster);
                        if (clusterSymbol?.GetDatabase(@params.Database) is { } databaseSymbol)
                        {
                            globals = globals.WithCluster(clusterSymbol).WithDatabase(databaseSymbol);

                            // Find the function in the database
                            var functionSymbol = databaseSymbol.GetFunction(@params.FunctionName);
                            if (functionSymbol != null)
                            {
                                // Get the return type using the globals context
                                var returnType = functionSymbol.GetReturnType(globals);

                                if (returnType != null)
                                {
                                    return new GetFunctionResultTypeResult
                                    {
                                        ResultType = FormatResultType(returnType)
                                    };
                                }
                            }
                        }
                    }
                }
            }

            return new GetFunctionResultTypeResult { ResultType = null };
        }
        catch (Exception ex)
        {
            _ = this.SendWindowLogMessageAsync(ex);
            return null;
        }
    }

    private static string? FormatResultType(TypeSymbol resultType)
    {
        if (resultType == null)
        {
            return null;
        }

        if (resultType is TableSymbol tableSymbol)
        {
            // Format as schema: (col1: type1, col2: type2, ...)
            var schema = string.Join(", ", tableSymbol.Columns.Select(c => $"{c.Name}: {c.Type.Name}"));
            return $"({schema})";
        }
        else
        {
            // Scalar type - just return the name
            return resultType.Name;
        }
    }

    [DataContract]
    public class GetFunctionResultTypeParams
    {
        [DataMember(Name = "cluster")]
        public required string Cluster { get; set; }

        [DataMember(Name = "database")]
        public required string Database { get; set; }

        [DataMember(Name = "functionName")]
        public required string FunctionName { get; set; }
    }

    [DataContract]
    public class GetFunctionResultTypeResult
    {
        [DataMember(Name = "resultType")]
        public string? ResultType { get; set; }
    }

    #endregion

    #region Run

    private static ImmutableDictionary<string, string> BuildQueryOptions(bool? isReadOnly, long? maxRows)
    {
        var options = ImmutableDictionary<string, string>.Empty;

        if (isReadOnly == true)
        {
            options = options.Add(ClientRequestProperties.OptionRequestReadOnly, "true");
        }

        if (maxRows.HasValue)
        {
            options = options.Add(ClientRequestProperties.OptionTakeMaxRecords, maxRows.Value.ToString());
        }

        return options;
    }

    [DataContract]
    public class RunQueryDiagnostic
    {
        [DataMember(Name = "message")]
        public required string Message { get; init; }

        [DataMember(Name = "details")]
        public string? Details { get; init; }

        [DataMember(Name = "range")]
        public LSP.Range? Range { get; init; }
    }

    [JsonRpcMethod("kusto/runQuery", UseSingleObjectParameterDeserialization = true)]
    public async Task<RunQueryResult?> OnRunQueryAsync(RunQueryParams @params, CancellationToken cancellationToken)
    {
        try
        {
            var queryOptions = BuildQueryOptions(@params.IsReadOnly, @params.MaxRows);
            var queryParameters = ImmutableDictionary<string, string>.Empty;

            var runResult = await _queryManager.RunQueryAsync(
                @params.Query,
                @params.Cluster,
                @params.Database,
                queryOptions,
                queryParameters,
                clientRequestId: @params.ClientRequestId,
                cancellationToken: cancellationToken)
                .ConfigureAwait(false);

            if (runResult.Error != null)
            {
                var errorRange = runResult.Error.HasLocation
                    ? GetLspRange(@params.Query, new TextRange(runResult.Error.Start, runResult.Error.Length))
                    : null;

                return new RunQueryResult
                {
                    Error = new RunQueryDiagnostic
                    {
                        Message = runResult.Error.Message,
                        Details = runResult.Error.Description,
                        Range = errorRange
                    }
                };
            }
            else
            {
                return new RunQueryResult
                {
                    Data = runResult.ExecuteResult != null ? ResultData.FromExecuteResult(runResult.ExecuteResult, @params.Query, runResult.Cluster ?? @params.Cluster, runResult.Database ?? @params.Database) : null,
                    Connection = runResult.Connection,
                    Cluster = runResult.Cluster,
                    Database = runResult.Database
                };
            }
        }
        catch (Exception ex)
        {
            _ = this.SendWindowLogMessageAsync(ex.Message);
            return new RunQueryResult
            {
                Error = new RunQueryDiagnostic
                {
                    Message = ex.Message
                }
            };
        }
    }

    [DataContract]
    public class RunQueryParams
    {
        [DataMember(Name = "query")]
        public required string Query { get; init; }

        [DataMember(Name = "cluster")]
        public string? Cluster { get; init; }

        [DataMember(Name = "database")]
        public string? Database { get; init; }

        [DataMember(Name = "isReadOnly")]
        public bool? IsReadOnly { get; init; }

        [DataMember(Name = "maxRows")]
        public long? MaxRows { get; init; }

        [DataMember(Name = "clientRequestId")]
        public string? ClientRequestId { get; init; }
    }

    [DataContract]
    public class RunQueryResult
    {
        [DataMember(Name = "data")]
        public ResultData? Data { get; init; }

        [DataMember(Name = "connection")]
        public string? Connection { get; init; }

        [DataMember(Name = "cluster")]
        public string? Cluster { get; init; }

        [DataMember(Name = "database")]
        public string? Database { get; init; }

        [DataMember(Name = "error")]
        public RunQueryDiagnostic? Error { get; init; }
    }

    #endregion

    #region Html
    [JsonRpcMethod("kusto/getQueryAsHtml", UseSingleObjectParameterDeserialization = true)]
    public async Task<GetQueryAsHtmlResult?> OnGetQueryAsHtmlAsync(GetQueryAsHtmlParams @params, CancellationToken cancellationToken)
    {
        try
        {
            // Get globals with cluster/database context for semantic coloring
            var globals = _symbolManager.Globals;
            if (@params.Cluster != null)
            {
                await _symbolManager.EnsureClustersAsync([@params.Cluster], contextCluster: null, cancellationToken).ConfigureAwait(false);
                globals = _symbolManager.Globals;
                if (globals.GetCluster(@params.Cluster) is { } clusterSymbol)
                {
                    globals = globals.WithCluster(clusterSymbol);
                    if (@params.Database != null)
                    {
                        await _symbolManager.EnsureDatabaseAsync(@params.Cluster, @params.Database, contextCluster: null, cancellationToken).ConfigureAwait(false);
                        globals = _symbolManager.Globals;
                        clusterSymbol = globals.GetCluster(@params.Cluster);
                        if (clusterSymbol != null)
                        {
                            globals = globals.WithCluster(clusterSymbol);
                            if (clusterSymbol.GetDatabase(@params.Database) is { } databaseSymbol)
                            {
                                globals = globals.WithDatabase(databaseSymbol);
                            }
                        }
                    }
                }
            }

            var tempUri = new Uri("temp://queryAsHtml");
            var document = new SectionedDocument(tempUri, @params.Query, globals);
            var queryFragment = document.ToHmtlFragment(0, document.Text.Length, @params.DarkMode == true);

            return new GetQueryAsHtmlResult
            {
                Html = $"<html><body>{queryFragment}</body></html>"
            };
        }
        catch (Exception ex)
        {
            _ = this.SendWindowLogMessageAsync(ex.Message);
        }

        return null;
    }

    [DataContract]
    public class GetQueryAsHtmlParams
    {
        [DataMember(Name = "query")]
        public required string Query { get; init; }

        [DataMember(Name = "cluster")]
        public string? Cluster { get; init; }

        [DataMember(Name = "database")]
        public string? Database { get; init; }

        [DataMember(Name = "darkMode")]
        public bool? DarkMode { get; init; }
    }

    [DataContract]
    public class GetQueryAsHtmlResult
    {
        [DataMember(Name = "html")]
        public required string Html { get; init; }
    }
    #endregion

    #endregion

    #region Results

    #region Kusto Expression

    [JsonRpcMethod("kusto/getDataAsExpression", UseSingleObjectParameterDeserialization = true)]
    public Task<GetDataAsExpressionResult?> OnGetDataAsExpression(GetDataAsExpressionParams @params, CancellationToken cancellationToken)
    {
        try
        {
            if (@params.Data != null)
            {
                var executeResult = @params.Data.ToExecuteResult();

                if (executeResult?.Tables != null && executeResult.Tables.Count > 0)
                {
                    var table = @params.TableName != null ? executeResult.Tables.FirstOrDefault(t => t.TableName == @params.TableName) : null;
                    if (table == null)
                        table = executeResult.Tables[0];

                    var statement = KustoGenerator.GenerateDataTableExpression(table);

                    return Task.FromResult<GetDataAsExpressionResult?>(
                        new GetDataAsExpressionResult { Expression = statement }
                        );
                }
            }
        }
        catch (Exception ex)
        {
            _ = this.SendWindowLogMessageAsync(ex.Message);
        }

        return Task.FromResult<GetDataAsExpressionResult?>(null);
    }

    [DataContract]
    public class GetDataAsExpressionParams
    {
        [DataMember(Name = "data")]
        public required ResultData Data { get; init; }

        [DataMember(Name = "tableName")]
        public string? TableName { get; init; }
    }

    [DataContract]
    public class GetDataAsExpressionResult
    {
        [DataMember(Name = "expression")]
        public required string Expression { get; init; }
    }
    #endregion

    #endregion

    #region Entities

    [JsonRpcMethod("kusto/getEntityAsCommand", UseSingleObjectParameterDeserialization = true)]
    public async Task<string?> OnGetEntityAsCommandAsync(GetEntityCreateCommandParams @params, CancellationToken cancellationToken)
    {
        try
        {
            if (Kusto.Data.Common.ExtendedEntityType.FastTryParse(@params.EntityType, out var entityType))
            {
                var entityId = new EntityId()
                {
                    ClusterName = @params.Cluster,
                    DatabaseName = @params.Database,
                    EntityType = entityType,
                    EntityName = @params.EntityName
                };

                return await _entityManager.GetDefinition(entityId, cancellationToken).ConfigureAwait(false);
            }
        }
        catch (Exception ex)
        {
            _ = this.SendWindowLogMessageAsync(ex);
        }

        return null;
    }

    [DataContract]
    public class GetEntityCreateCommandParams
    {
        [DataMember(Name="cluster")]
        public required string Cluster { get; init; }

        [DataMember(Name="database")]
        public required string Database { get; init; }

        [DataMember(Name = "entityType")]
        public required string EntityType { get; init; }

        [DataMember(Name="entityName")]
        public required string EntityName { get; init; }
    }

    [JsonRpcMethod("kusto/getEntityAsExpression", UseSingleObjectParameterDeserialization = true)]
    public async Task<string?> OnGetEntityAsExpressionAsync(GetEntityExpressionParams @params, CancellationToken cancellationToken)
    {
        try
        {
            if (Kusto.Data.Common.ExtendedEntityType.FastTryParse(@params.EntityType, out var entityType))
            {
                var entityId = new EntityId()
                {
                    ClusterName = @params.Cluster,
                    DatabaseName = @params.Database,
                    EntityType = entityType,
                    EntityName = @params.EntityName
                };

                IDocument? document = null;
                if (@params.Uri is { } uri)
                {
                    _documentManager.TryGetDocument(uri, out document);
                }

                return await _entityManager.GetQueryExpression(entityId, document, cancellationToken).ConfigureAwait(false);
            }
        }
        catch (Exception ex)
        {
            _ = this.SendWindowLogMessageAsync(ex);
        }

        return null;
    }

    [DataContract]
    public class GetEntityExpressionParams
    {
        [DataMember(Name="cluster")]
        public required string Cluster { get; init; }

        [DataMember(Name="database")]
        public required string Database { get; init; }

        [DataMember(Name = "entityType")]
        public required string EntityType { get; init; }

        [DataMember(Name="entityName")]
        public required string EntityName { get; init; }

        [DataMember(Name = "uri")]
        public Uri? Uri { get; init; }
    }

    /// <summary>
    /// Gets the content of a virtual entity definition document.
    /// Called by the VS Code extension's TextDocumentContentProvider.
    /// </summary>
    [JsonRpcMethod("kusto/getEntityDefinitionContent", UseSingleObjectParameterDeserialization = true)]
    public async Task<GetEntityDefinitionContentResult?> OnGetEntityDefinitionContentAsync(GetEntityDefinitionContentParams @params, CancellationToken cancellationToken)
    {
        try
        {
            var uri = new Uri(@params.Uri);
            if (TryParseEntityDefinitionUri(uri, out var cluster, out var database, out var entityType, out var entityName))
            {
                if (Kusto.Data.Common.ExtendedEntityType.FastTryParse(entityType, out var parsedEntityType))
                {
                    var entityId = new EntityId
                    {
                        ClusterName = cluster,
                        DatabaseName = database,
                        EntityType = parsedEntityType,
                        EntityName = entityName
                    };

                    var content = await _entityManager.GetDefinition(entityId, cancellationToken).ConfigureAwait(false);
                    if (content != null)
                    {
                        return new GetEntityDefinitionContentResult
                        {
                            Content = content
                        };
                    }
                }
            }
        }
        catch (Exception ex)
        {
            _ = this.SendWindowLogMessageAsync(ex);
        }

        return null;
    }

    [DataContract]
    public class GetEntityDefinitionContentParams
    {
        [DataMember(Name = "uri")]
        public required string Uri { get; init; }
    }

    [DataContract]
    public class GetEntityDefinitionContentResult
    {
        [DataMember(Name = "content")]
        public required string Content { get; init; }
    }

    #endregion

    #region Transform Paste

    [JsonRpcMethod("kusto/transformPaste", UseSingleObjectParameterDeserialization = true)]
    public async Task<string?> OnTransformPasteAsync(TransformPasteParams @params, CancellationToken cancellationToken)
    {
        var text = @params.Text;

        try
        {
            if (_documentManager.TryGetDocument(@params.TextDocument.Uri, out var document))
            {
                switch (@params.Kind)
                {
                    case "command":
                        if (document.Globals.Cluster.Name != @params.EntityCluster
                            || document.Globals.Database.Name != @params.EntityDatabase)
                        {
                            var conn = $"cluster({KustoFacts.GetSingleQuotedStringLiteral(@params.EntityCluster)})";
                            if (@params.EntityDatabase != null)
                                conn = $"{conn}.database({KustoFacts.GetSingleQuotedStringLiteral(@params.EntityDatabase)})";
                            text = $"#connect {conn}\n{text}";
                        }
                        break;
                    case "expression":
                        if (@params.EntityName != null
                            && Kusto.Data.Common.ExtendedEntityType.FastTryParse(@params.EntityType, out var entityType))
                        {
                            var entityId = new EntityId()
                            {
                                ClusterName = @params.EntityCluster,
                                DatabaseName = @params.EntityDatabase,
                                EntityType = entityType,
                                EntityName = @params.EntityName
                            };

                            // recreate expression text based on target document
                            text = await _entityManager.GetQueryExpression(entityId, document, cancellationToken).ConfigureAwait(false);
                        }
                        break;
                }
            }
        }
        catch (Exception ex)
        {
            _ = this.SendWindowLogMessageAsync(ex.Message);
        }

        return text;
    }

    [DataContract]
    public class TransformPasteParams
    {
        [DataMember(Name = "text")]
        public required string Text { get; init; }

        [DataMember(Name = "kind")]
        public required string Kind { get; init; }

        [DataMember(Name = "textDocument")]
        public required LSP.TextDocumentIdentifier TextDocument { get; init; }

        [DataMember(Name = "position")]
        public required LSP.Position Position { get; init; }

        [DataMember(Name = "entityCluster")]
        public string? EntityCluster { get; init; }

        [DataMember(Name = "entityDatabase")]
        public string? EntityDatabase { get; init; }

        [DataMember(Name = "entityType")]
        public string? EntityType { get; init; }

        [DataMember(Name = "entityName")]
        public string? EntityName { get; init; }
    }

    #endregion

    #endregion

    #region Position and Range Conversion
    public static LSP.Position GetLspPosition(string text, int textPosition)
    {
        if (text.TryGetLineAndOffset(textPosition, out var line, out var character))
        {
            return new LSP.Position
            {
                Line = line,
                Character = character
            };
        }
        else
        {
            return new LSP.Position
            {
                Line = 0,
                Character = 0
            };
        }
    }

    public static int GetTextPosition(string text, LSP.Position position)
    {
        if (text.TryGetTextPosition(position.Line, position.Character, out var textPosition))
        {
            return textPosition;
        }
        else
        {
            return 0;
        }
    }

    public static LSP.Range GetLspRange(string text, TextRange textRange)
    {
        var start = GetLspPosition(text, textRange.Start);
        var end = GetLspPosition(text, textRange.End);
        return new LSP.Range
        {
            Start = start,
            End = end
        };
    }

    public static TextRange GetTextRange(string text, LSP.Range range)
    {
        if (text.TryGetTextPosition(range.Start.Line, range.Start.Character, out var startPosition)
            && text.TryGetTextPosition(range.End.Line, range.End.Character, out var endPosition))
        {
            return TextRange.FromBounds(startPosition, endPosition);
        }
        else
        {
            return TextRange.Empty;
        }
    }

    public static LSP.TextEdit GetLspTextEdit(string text, TextEdit edit)
    {
        return new LSP.TextEdit
        {
            Range = GetLspRange(text, new TextRange(edit.Start, edit.DeleteLength)),
            NewText = edit.InsertText
        };
    }

    public static TextEdit GetTextEdit(string text, LSP.TextEdit edit)
    {
        var range = GetTextRange(text, edit.Range);
        return TextEdit.Replacement(range.Start, range.Length, edit.NewText);
    }

    #endregion

    #region Client Storage

    /// <summary>
    /// Requests stored data from the client.
    /// Returns default if no data exists for the given key.
    /// </summary>
    /// <typeparam name="T">The type to deserialize the data as</typeparam>
    /// <param name="key">A unique key identifying the stored data</param>
    /// <param name="cancellationToken">Cancellation token</param>
    /// <returns>The stored data deserialized as T, or default if not found</returns>
    public Task<T?> GetValueAsync<T>(string key, CancellationToken cancellationToken)
    {
        return SendRequestAsync<T?>(
            "kusto/getData",
            new GetDataParams { Key = key },
            cancellationToken);
    }

    /// <summary>
    /// Requests the client to store data in its persistent storage.
    /// Pass null for data to remove the key.
    /// </summary>
    /// <typeparam name="T">The type of data to store</typeparam>
    /// <param name="key">A unique key identifying the data</param>
    /// <param name="data">The data to store, or null to remove</param>
    /// <param name="cancellationToken">Cancellation token</param>
    public Task SetValueAsync<T>(string key, T? data, CancellationToken cancellationToken)
    {
        return SendRequestAsync<object?>(
            "kusto/setData",
            new SetDataParams<T> { Key = key, Data = data },
            cancellationToken);
    }

    [DataContract]
    public class GetDataParams
    {
        [DataMember(Name = "key")]
        public required string Key { get; set; }
    }

    [DataContract]
    public class SetDataParams<T>
    {
        [DataMember(Name = "key")]
        public required string Key { get; set; }

        [DataMember(Name = "data")]
        public T? Data { get; set; }
    }

    #endregion
}


