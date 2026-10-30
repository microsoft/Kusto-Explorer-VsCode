// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using System.Collections.Immutable;

using Kusto.Language;
using Kusto.Language.Symbols;
using Kusto.Language.Syntax;

namespace Kusto.Vscode;

public enum DocumentSymbolKind
{
    /// <summary>A let of a scalar value.</summary>
    ScalarVariable,

    /// <summary>A let of a tabular value.</summary>
    TabularVariable,

    /// <summary>A let of any other value (database, cluster, function alias, ...).</summary>
    Variable,

    /// <summary>A let function or a <c>.create function</c> command.</summary>
    Function,

    /// <summary>A let view.</summary>
    View,

    /// <summary>A <c>declare pattern</c> statement.</summary>
    Pattern,

    /// <summary>A parameter of a <c>declare query_parameters</c> statement.</summary>
    QueryParameter,

    /// <summary>A <c>.create table</c> (or <c>.alter table</c>) command.</summary>
    Table,

    /// <summary>A <c>.create materialized-view</c> (or <c>.alter materialized-view</c>) command.</summary>
    MaterializedView,
}

/// <summary>
/// A symbol declared in a block of Kusto code.
/// <see cref="Start"/>/<see cref="Length"/> span the declaring statement and
/// <see cref="NameStart"/>/<see cref="NameLength"/> the declared name, in characters within <see cref="KustoCode.Text"/>.
/// </summary>
public sealed record DocumentSymbolInfo(
    string Name,
    DocumentSymbolKind Kind,
    string? Detail,
    int Start,
    int Length,
    int NameStart,
    int NameLength,
    ImmutableList<DocumentSymbolInfo> Children);

/// <summary>
/// Host-independent document symbols (outline) over one parsed and bound <see cref="KustoCode"/> block.
/// </summary>
public static class DocumentSymbolFeatures
{
    /// <summary>
    /// Gets the symbols declared by the block's statements, with symbols declared inside function bodies as children.
    /// </summary>
    public static FeatureResult<ImmutableList<DocumentSymbolInfo>> GetDocumentSymbols(KustoCode code, CancellationToken cancellationToken)
    {
        try
        {
            var statements = code.Syntax switch
            {
                QueryBlock query => query.Statements,
                CommandBlock command => command.Statements,
                _ => null
            };

            var symbols = statements != null
                ? GetStatementSymbols(statements, cancellationToken)
                : ImmutableList<DocumentSymbolInfo>.Empty;

            return FeatureResult<ImmutableList<DocumentSymbolInfo>>.Success(symbols);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            return FeatureResult<ImmutableList<DocumentSymbolInfo>>.Failure(ex.Message);
        }
    }

    private static ImmutableList<DocumentSymbolInfo> GetStatementSymbols(SyntaxList<SeparatedElement<Statement>> statements, CancellationToken cancellationToken)
    {
        var builder = ImmutableList.CreateBuilder<DocumentSymbolInfo>();

        foreach (var element in statements)
        {
            cancellationToken.ThrowIfCancellationRequested();

            switch (element.Element)
            {
                case LetStatement let:
                    AddLet(builder, let, cancellationToken);
                    break;

                case PatternStatement pattern:
                    Add(builder, pattern, pattern.Name, DocumentSymbolKind.Pattern, detail: null);
                    break;

                case QueryParametersStatement queryParameters:
                    foreach (var parameter in queryParameters.Parameters)
                    {
                        var nameAndType = parameter.Element.NameAndType;
                        Add(builder, parameter.Element, nameAndType.Name, DocumentSymbolKind.QueryParameter, nameAndType.Type?.ToString(IncludeTrivia.Minimal));
                    }
                    break;

                case ExpressionStatement { Expression: CustomCommand command }:
                    AddCommand(builder, command, cancellationToken);
                    break;
            }
        }

        return builder.ToImmutable();
    }

    private static void AddLet(ImmutableList<DocumentSymbolInfo>.Builder builder, LetStatement let, CancellationToken cancellationToken)
    {
        if (let.Expression is FunctionDeclaration function)
        {
            var isView = function.ViewKeyword is { IsMissing: false, Width: > 0 };
            AddFunction(builder, let, let.Name, isView ? DocumentSymbolKind.View : DocumentSymbolKind.Function, function, cancellationToken);
            return;
        }

        var (kind, detail) = (let.Name.ReferencedSymbol as VariableSymbol)?.Type switch
        {
            ScalarSymbol scalar => (DocumentSymbolKind.ScalarVariable, scalar.Name),
            TableSymbol => (DocumentSymbolKind.TabularVariable, "table"),
            FunctionSymbol => (DocumentSymbolKind.Function, null),
            TypeSymbol other => (DocumentSymbolKind.Variable, other.Kind.ToString().ToLowerInvariant()),
            _ => (DocumentSymbolKind.Variable, (string?)null)
        };

        Add(builder, let, let.Name, kind, detail);
    }

    private static readonly ImmutableDictionary<string, DocumentSymbolKind> CommandKinds = new Dictionary<string, DocumentSymbolKind>
    {
        ["CreateTable"] = DocumentSymbolKind.Table,
        ["CreateMergeTable"] = DocumentSymbolKind.Table,
        ["AlterTable"] = DocumentSymbolKind.Table,
        ["AlterMergeTable"] = DocumentSymbolKind.Table,
        ["CreateFunction"] = DocumentSymbolKind.Function,
        ["AlterFunction"] = DocumentSymbolKind.Function,
        ["CreateOrAlterFunction"] = DocumentSymbolKind.Function,
        ["CreateMaterializedView"] = DocumentSymbolKind.MaterializedView,
        ["AlterMaterializedView"] = DocumentSymbolKind.MaterializedView,
        ["CreateOrAlterMaterializedView"] = DocumentSymbolKind.MaterializedView,
    }.ToImmutableDictionary();

    private static void AddCommand(ImmutableList<DocumentSymbolInfo>.Builder builder, CustomCommand command, CancellationToken cancellationToken)
    {
        if (!CommandKinds.TryGetValue(command.CommandKind, out var kind) || command.Custom is not SyntaxNode custom)
            return;

        // The entity name is a direct child of the command's syntax: a declaration for .create,
        // a reference to the existing entity for .alter. Nested names (e.g. with-properties) are not it.
        SyntaxNode? name = null;
        FunctionDeclaration? function = null;
        for (int i = 0; i < custom.ChildCount; i++)
        {
            switch (custom.GetChild(i))
            {
                case NameDeclaration declaration when name == null:
                    name = declaration;
                    break;
                case NameReference reference when name == null:
                    name = reference;
                    break;
                case FunctionDeclaration declaration:
                    function = declaration;
                    break;
            }
        }

        if (name == null)
            return;

        if (kind == DocumentSymbolKind.Function && function != null)
            AddFunction(builder, command, name, kind, function, cancellationToken);
        else
            Add(builder, command, name, kind, detail: null);
    }

    private static void AddFunction(
        ImmutableList<DocumentSymbolInfo>.Builder builder,
        SyntaxNode declaringNode,
        SyntaxNode name,
        DocumentSymbolKind kind,
        FunctionDeclaration function,
        CancellationToken cancellationToken)
    {
        var children = function.Body != null
            ? GetStatementSymbols(function.Body.Statements, cancellationToken)
            : ImmutableList<DocumentSymbolInfo>.Empty;

        Add(builder, declaringNode, name, kind, function.Parameters.ToString(IncludeTrivia.Minimal), children);
    }

    private static void Add(
        ImmutableList<DocumentSymbolInfo>.Builder builder,
        SyntaxNode declaringNode,
        SyntaxNode name,
        DocumentSymbolKind kind,
        string? detail,
        ImmutableList<DocumentSymbolInfo>? children = null)
    {
        var text = name switch
        {
            NameDeclaration declaration => declaration.SimpleName,
            NameReference reference => reference.SimpleName,
            _ => null
        };

        // skip names still being typed (e.g. "let = 1")
        if (string.IsNullOrEmpty(text) || name.Width == 0)
            return;

        builder.Add(new DocumentSymbolInfo(
            text,
            kind,
            string.IsNullOrEmpty(detail) ? null : detail,
            declaringNode.TextStart,
            declaringNode.Width,
            name.TextStart,
            name.Width,
            children ?? ImmutableList<DocumentSymbolInfo>.Empty));
    }
}
