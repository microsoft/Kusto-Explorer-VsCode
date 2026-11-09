// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using System.Collections.Immutable;
using System.Diagnostics.CodeAnalysis;
using System.Runtime.CompilerServices;

using Kusto.Language;
using Kusto.Language.Editor;
using Kusto.Language.Symbols;

namespace Kusto.Vscode;

/// <summary>
/// A Kusto document that contains multiple query sections separated by blank lines. 
/// </summary>
public class SectionedDocument : IDocument
{
    private readonly Uri _id;
    private readonly CodeScript _script;

    private SectionedDocument(Uri id, CodeScript script)
    {
        _id = id;
        _script = script ?? throw new ArgumentNullException(nameof(script));
    }

    public SectionedDocument(Uri id, string text, GlobalState globals)
        : this(id, CodeScript.From(text, globals))
    {
    }

    public CodeScript Script => _script;

    public Uri Id => _id;
    public string Text => _script.Text;
    public GlobalState Globals => _script.Globals;

    public IDocument WithText(string text)
    {
        return new SectionedDocument(_id, _script.WithText(text));
    }

    public IDocument WithGlobals(GlobalState globals)
    {
        return new SectionedDocument(_id, _script.WithGlobals(globals));
    }

    // use codeservice as key, since it does not change across edits of other blocks.
    private static readonly ConditionalWeakTable<CodeService, ISection> _blockSections =
        new ConditionalWeakTable<CodeService, ISection>();

    private record BlockSection(CodeService Service) : ISection
    {
        public string Text => this.Service.Text;
    }

    public ISection? GetSection(int position)
    {
        var block = _script.GetBlockAtPosition(position);
        if (block != null)
        {
            if (!_blockSections.TryGetValue(block.Service, out var section))
            {
                section = _blockSections.GetValue(block.Service, _service => new BlockSection(_service));
            }
            return section;
        }

        return null;
    }

    public TextRange? GetSectionRange(int position)
    {
        var block = _script.GetBlockAtPosition(position);
        if (block != null)
        {
            return new TextRange(block.Start, block.Length);
        }
        return null;
    }

    public IReadOnlyList<TextRange> GetSectionRanges()
    {
        return _script.Blocks.Select(b => new TextRange(b.Start, b.Length)).ToImmutableList();
    }

    public bool TryGetSectionCode(int position, CancellationToken cancellationToken, [NotNullWhen(true)] out KustoCode? code, out int sectionStart)
    {
        var block = _script.GetBlockAtPosition(position);
        if (block != null && block.Service.TryGetCode(cancellationToken, out code))
        {
            sectionStart = block.Start;
            return true;
        }

        code = null;
        sectionStart = 0;
        return false;
    }

    public string? GetMinimalText(int position, MinimalTextKind kind)
    {
        var block = _script.GetBlockAtPosition(position);
        if (block != null)
        {
            return block.Service.GetMinimalText(kind);
        }
        return null;
    }

    public CodeActionResult ApplyCodeAction(ApplyAction action, int caretPosition, CodeActionOptions? options = null, CancellationToken cancellationToken = default)
    {
        var block = _script.GetBlockAtPosition(caretPosition);
        if (block != null)
        {
            var result = block.Service.ApplyCodeAction(action, caretPosition, options, cancellationToken);
            var adjusted = result.Actions.Select(a =>
            {
                switch (a)
                {
                    case ChangeTextAction ca:
                        var edits = ca.Changes.Select(c => new TextEdit(c.Start + block.Start, c.DeleteLength, c.InsertText)).ToImmutableList();
                        var changedText = new EditString(_script.Text).ApplyAll(edits);
                        return (ResultAction)new ChangeTextAction(changedText);
                    case MoveCaretAction ma:
                        return new MoveCaretAction(ma.NewCaretPosition + block.Start);
                    default:
                        return a;
                }
            }).ToImmutableList();
            return new CodeActionResult(adjusted);
        }
        return CodeActionResult.Nothing;
    }

    private ImmutableList<Diagnostic>? _analyzerDiagnostics;
    public IReadOnlyList<Diagnostic> GetAnalyzerDiagnostics(bool waitForAnalysis = true, CancellationToken cancellationToken = default)
    {
        if (_analyzerDiagnostics == null)
        {
            var list = new List<Diagnostic>();
            foreach (var block in _script.Blocks)
            {
                var dx = block.Service.GetAnalyzerDiagnostics(waitForAnalysis, cancellationToken);
                list.AddRange(dx);
            }

            _analyzerDiagnostics = list.ToImmutableList();
        }

        return _analyzerDiagnostics;
    }

    public ClassificationInfo GetClassifications(int start, int length, bool clipToRange = true, bool waitForAnalysis = true, CancellationToken cancellationToken = default)
    {
        var range = new TextRange(start, length);
        var classifiedRanges = new List<ClassifiedRange>();

        foreach (var block in _script.Blocks)
        {
            var blockRange = new TextRange(block.Start, block.Length);
            if (range.Intersects(blockRange))
            {
                var info = block.Service.GetClassifications(start, length, clipToRange, waitForAnalysis, cancellationToken);
                classifiedRanges.AddRange(info.Classifications);
            }
        }

        return new ClassificationInfo(classifiedRanges);
    }

    public IReadOnlyList<ClientParameter> GetQueryClientParameters(int position)
    {
        var block = _script.GetBlockAtPosition(position);
        if (block != null)
            return block.Service.GetClientParameters();
        return Array.Empty<ClientParameter>();
    }

    public CodeActionInfo GetCodeActions(int position, int selectionStart, int selectionLength, CodeActionOptions? options = null, bool waitForAnalysis = true, CancellationToken cancellationToken = default)
    {
        var block = _script.GetBlockAtPosition(position);
        if (block != null)
            return block.Service.GetCodeActions(position, selectionStart, selectionLength, options, waitForAnalysis, actorName: null, cancellationToken);
        return CodeActionInfo.NoActions;
    }

    public CompletionInfo GetCompletionItems(int position, string? trigger, CompletionOptions? options = null, CancellationToken cancellationToken = default)
    {
        // don't trigger on space if the caret is on a non-whitespace character

        if (trigger == " " && !CanTriggerOnSpace(this.Text, position))
            return CompletionInfo.Empty;

        if (trigger == "=" && !CanTriggerOnEquals(this.Text, position))
            return CompletionInfo.Empty;

        var block = _script.GetBlockAtPosition(position);
        if (block != null 
            && (string.IsNullOrEmpty(trigger) || block.Service.ShouldAutoComplete(position, trigger[0], cancellationToken)))
        {
            return block.Service.GetCompletionItems(position, options, cancellationToken);
        }

        return CompletionInfo.Empty;
    }

    private static bool CanTriggerOnEquals(string text, int position)
    {
        if (position > 1 && position < text.Length)
        {
            // if the equals is added immediately after a possible identifier
            var prev = text[position - 2]; // @-1 is the triggering =
            var next = GetNextNonWhitespaceCharacterOnSameLine(text, position);
            if (char.IsLetterOrDigit(prev)
                && _canTriggerWithSpaceBefore.Contains(next))  // re-use space triggerins rules
                return true;
        }

        return false;
    }

    private static bool CanTriggerOnSpace(string text, int position)
    {
        // space can trigger at end of document
        if (position >= text.Length)
            return true;

        // space can trigger at end of line
        var nextLineBreakStart = Kusto.Language.Parsing.TextFacts.GetNextLineBreakStart(text, position);
        if (nextLineBreakStart == position)
            return true;

        // space can trigger if the rest of the line is whitespace
        if (Kusto.Language.Parsing.TextFacts.IsWhitespaceOnly(text, position, nextLineBreakStart - position))
            return true;

        if (position > 1 && position < text.Length)
        {
            // if the space is added immediately after a punctuation that expects to have a value after it
            // and the current non-whitespace character is not already the start of a value
            var prev = text[position - 2];  // @-1 is the triggering space
            var next = GetNextNonWhitespaceCharacterOnSameLine(text, position);
            if (_canTriggerWithSpaceAfter.Contains(prev)
                && _canTriggerWithSpaceBefore.Contains(next))
                return true;
        }

        return false;
    }

    private static char GetNextNonWhitespaceCharacterOnSameLine(string text, int position)
    {
        var nextLineBreakStart = Kusto.Language.Parsing.TextFacts.GetNextLineBreakStart(text, position);
        if (nextLineBreakStart < 0)
            nextLineBreakStart = text.Length;
        for (int i = position; i < nextLineBreakStart; i++)
        {
            if (char.IsWhiteSpace(text[i]))
                continue;
            return text[i];
        }
        return '\0';
    }

    private static ImmutableList<char> _canTriggerWithSpaceAfter = ['=', ',', ':', '|'];
    private static ImmutableList<char> _canTriggerWithSpaceBefore = [')', ']', ',', '}', ':', '|', '\0'];

    private ImmutableList<Diagnostic>? _diagnostics;
    public IReadOnlyList<Diagnostic> GetDiagnostics(bool waitForAnalysis = true, CancellationToken cancellationToken = default)
    {
        if (_diagnostics == null)
        {
            var list = new List<Diagnostic>();
            foreach (var block in _script.Blocks)
            {
                var dx = block.Service.GetDiagnostics(waitForAnalysis, cancellationToken);
                list.AddRange(dx);
            }
            _diagnostics = list.ToImmutableList();
        }

        return _diagnostics;
    }

    public TextRange GetElement(int position, CancellationToken cancellationToken = default)
    {
        var block = _script.GetBlockAtPosition(position);
        if (block != null)
            return block.Service.GetElement(position, cancellationToken);
        return default;
    }

    public DocumentEdits GetFormattedText(TextRange range, FormattingOptions? options = null, CancellationToken cancellationToken = default)
    {
        var edits = new List<TextEdit>();

        foreach (var block in _script.Blocks)
        {
            var blockRange = new TextRange(block.Start, block.Length);
            if (range.Intersects(blockRange))
            {
                var formattedBlock = block.Service.GetFormattedText(options, caretPosition: 0, cancellationToken);
                if (formattedBlock.Text != block.Text)
                {
                    edits.Add(TextEdit.Replacement(block.Start, block.Length, formattedBlock.Text));
                }
            }
        }

        return new DocumentEdits { OriginalText = _script.Text, Edits = edits.ToImmutableList() };
    }

    public OutlineInfo GetOutlines(OutliningOptions options, CancellationToken cancellationToken = default)
    {
        var ranges = new List<OutlineRange>();
        foreach (var block in _script.Blocks)
        {
            var info = block.Service.GetOutlines(options, cancellationToken);
            ranges.AddRange(info.Ranges);
        }
        return new OutlineInfo(ranges);
    }

    public QuickInfo GetQuickInfo(int position, QuickInfoOptions? options = null, CancellationToken cancellationToken = default)
    {
        var block = _script.GetBlockAtPosition(position);
        if (block != null)
            return block.Service.GetQuickInfo(position, options, cancellationToken);
        return QuickInfo.Empty;
    }

    public RelatedInfo GetRelatedElements(int position, FindRelatedOptions options = FindRelatedOptions.None, CancellationToken cancellationToken = default)
    {
        var block = _script.GetBlockAtPosition(position);
        if (block != null)
            return block.Service.GetRelatedElements(position, options, cancellationToken);
        return RelatedInfo.Empty;
    }

    public Symbol? GetReferencedSymbol(int position, CancellationToken cancellationToken)
    {
        var block = _script.GetBlockAtPosition(position);
        if (block != null)
        {
            return block.Service.GetReferencedSymbol(position - block.Start, cancellationToken);
        }
        return null;
    }

    public Symbol? GetResultType(int position, CancellationToken cancellationToken)
    {
        var block = _script.GetBlockAtPosition(position);
        if (block != null)
        {
            return block.Service.GetResultType(position - block.Start, cancellationToken);
        }
        return null;
    }

    public Symbol? GetQueryResultType(int position, CancellationToken cancellationToken)
    {
        var block = _script.GetBlockAtPosition(position);
        if (block != null)
        {
            return block.Service.GetQueryResultType(position - block.Start, cancellationToken);
        }
        return null;
    }

    public ImmutableList<DeclarationLocation> GetDeclarationLocations(int position, CancellationToken cancellationToken)
    {
        var block = _script.GetBlockAtPosition(position);
        if (block != null)
        {
            var symbol = this.GetReferencedSymbol(position, cancellationToken);
            if (symbol != null)
            {
                // this is a cluster, database or direct database entity
                if (symbol is ClusterSymbol
                    || symbol is DatabaseSymbol 
                    || this.Globals.GetDatabase(symbol) != null)
                {
                    return [new DeclarationLocation { Entity = symbol }];
                }

                // otherwise search the source and find to find the database entity that declares this symbol
                if (block.Service.TryGetCode(cancellationToken, out var code))
                {
                    var locations = DeclarationFinder.GetSourceDeclarations(this.Globals, code.Syntax, symbol);
                    if (locations.Count > 0)
                    {
                        return locations.Select(loc => new DeclarationLocation
                        {
                            Range = new TextRange(block.Start + loc.Range.Start, loc.Range.Length),
                            Entity = loc.Entity
                        }).ToImmutableList();
                    }
                }
            }
        }

        return ImmutableList<DeclarationLocation>.Empty;
    }

    public ImmutableList<ClusterReference> GetClusterReferences(CancellationToken cancellationToken = default)
    {
        var refs = new List<ClusterReference>();
        foreach (var block in _script.Blocks)
        {
            refs.AddRange(block.Service.GetClusterReferences(cancellationToken));
        }
        return refs.ToImmutableList();
    }

    public ImmutableList<DatabaseReference> GetDatabaseReferences(CancellationToken cancellationToken = default)
    {
        var refs = new List<DatabaseReference>();
        foreach (var block in _script.Blocks)
        {
            refs.AddRange(block.Service.GetDatabaseReferences(cancellationToken));
        }
        return refs.ToImmutableList();
    }

    /// <summary>
    /// Gets the inferred connection information for the document, if available.
    /// </summary>
    public InferredConnection? GetInferredConnection(CancellationToken cancellationToken = default)
    {
        if (_script.Blocks.Count > 0)
        {
            if (ClientDirective.TryParse(_script.Blocks[0].Text, out var directive))
            {
                // if the first line is just a connection directive with no other text, we can infer the connection information for the document
                if (directive.Name == "connect"
                    && directive.TryGetConnectionInfo(out var connection, out var clusterName, out var databaseName)
                    && Kusto.Language.Parsing.TextFacts.IsWhitespaceOnly(directive.AfterDirectiveText))
                {
                    return new InferredConnection
                    {
                        Connection = connection,
                        ClusterName = clusterName,
                        DatabaseName = databaseName
                    };
                }
            }
        }

        return null;
    }
}