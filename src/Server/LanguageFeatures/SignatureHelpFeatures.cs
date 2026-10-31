// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using System.Collections.Immutable;
using System.Text;

using Kusto.Language;
using Kusto.Language.Symbols;
using Kusto.Language.Syntax;

namespace Kusto.Vscode;

/// <summary>
/// Signature help for the function call enclosing a position.
/// </summary>
/// <param name="Signatures">The visible signatures of the called function.</param>
/// <param name="ActiveSignature">The index of the signature that best matches the call.</param>
/// <param name="ActiveParameter">The index of the active signature's parameter at the position, or -1 when no parameter applies.</param>
public sealed record SignatureHelpInfo(
    ImmutableList<SignatureInfo> Signatures,
    int ActiveSignature,
    int ActiveParameter)
{
    /// <summary>
    /// No signatures: the position is not inside the arguments of a call to a known function.
    /// </summary>
    public static readonly SignatureHelpInfo None = new(ImmutableList<SignatureInfo>.Empty, -1, -1);
}

/// <summary>
/// One displayable signature, e.g. <c>substring(source: string, startingIndex: long, [length: long]): string</c>.
/// </summary>
public sealed record SignatureInfo(
    string Label,
    string? Documentation,
    ImmutableList<SignatureParameterInfo> Parameters);

/// <summary>
/// One parameter of a <see cref="SignatureInfo"/>.
/// <see cref="LabelStart"/> and <see cref="LabelLength"/> locate the parameter's text, in characters, within <see cref="SignatureInfo.Label"/>.
/// </summary>
public sealed record SignatureParameterInfo(
    string Name,
    int LabelStart,
    int LabelLength,
    string? Documentation);

/// <summary>
/// Host-independent signature help over one parsed and bound <see cref="KustoCode"/> block.
/// Positions are character offsets within <see cref="KustoCode.Text"/>.
/// </summary>
public static class SignatureHelpFeatures
{
    /// <summary>
    /// Gets the signature help for the innermost function call whose argument list contains the position.
    /// Succeeds with <see cref="SignatureHelpInfo.None"/> when the position is not inside a call to a known function.
    /// </summary>
    public static FeatureResult<SignatureHelpInfo> GetSignatureHelp(KustoCode code, int position, CancellationToken cancellationToken)
    {
        try
        {
            var call = FindEnclosingCall(code, position, cancellationToken);
            if (call == null || GetFunctionSymbol(call) is not { } function)
                return FeatureResult<SignatureHelpInfo>.Success(SignatureHelpInfo.None);

            var signatures = function.Signatures.Where(s => !s.IsHidden).ToList();
            if (signatures.Count == 0)
                return FeatureResult<SignatureHelpInfo>.Success(SignatureHelpInfo.None);

            var argumentList = call.ArgumentList.Expressions;
            var arguments = argumentList.Select(a => a.Element).ToList();
            var argumentIndex = GetArgumentIndex(argumentList, position);

            // The binder maps the implicit value of "T | invoke f(...)" onto f's first parameter,
            // so the arguments as written are one parameter further along.
            if (GetImplicitInvokeArgument(call) is { } implicitArgument)
            {
                arguments.Insert(0, implicitArgument);
                argumentIndex++;
            }

            var argumentCount = Math.Max(arguments.Count, argumentIndex + 1);

            var activeSignature = GetActiveSignature(call, signatures, argumentCount);
            var activeParameter = GetActiveParameter(signatures[activeSignature], arguments, argumentIndex);

            var infos = signatures.Select(s => CreateSignatureInfo(function, s)).ToImmutableList();
            return FeatureResult<SignatureHelpInfo>.Success(new SignatureHelpInfo(infos, activeSignature, activeParameter));
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            return FeatureResult<SignatureHelpInfo>.Failure(ex.Message);
        }
    }

    // Mirrors the binder: a dotted path leading to the call is part of the invoked function.
    private static Expression? GetImplicitInvokeArgument(FunctionCallExpression call)
    {
        Expression function = call;
        while (function.Parent is PathExpression path && path.Selector == function)
            function = path.Expression;

        if (function.Parent is not InvokeOperator invoke || invoke.Function != function)
            return null;

        return invoke.Parent is PipeExpression pipe && pipe.Operator == invoke
            ? pipe.Expression
            : call.Name;
    }

    /// <summary>
    /// Finds the innermost call whose argument list (after the open paren, up to the close paren) contains the position.
    /// </summary>
    private static FunctionCallExpression? FindEnclosingCall(KustoCode code, int position, CancellationToken cancellationToken)
    {
        FunctionCallExpression? innermost = null;

        foreach (var call in code.Syntax.GetDescendants<FunctionCallExpression>())
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (IsInsideArgumentList(code.Text, call, position)
                && (innermost == null || call.ArgumentList.OpenParen.TextStart > innermost.ArgumentList.OpenParen.TextStart))
            {
                innermost = call;
            }
        }

        return innermost;
    }

    private static bool IsInsideArgumentList(string text, FunctionCallExpression call, int position)
    {
        var openParen = call.ArgumentList.OpenParen;
        if (openParen.IsMissing || position < openParen.End)
            return false;

        var closeParen = call.ArgumentList.CloseParen;
        if (!closeParen.IsMissing)
            return position <= closeParen.TextStart;

        // An unclosed call extends to the position only across whitespace, so typing past
        // the call into unrelated text doesn't keep showing its signature.
        return position <= call.End
            || (position <= text.Length && string.IsNullOrWhiteSpace(text.Substring(call.End, position - call.End)));
    }

    private static FunctionSymbol? GetFunctionSymbol(FunctionCallExpression call)
    {
        return call.ReferencedSymbol switch
        {
            FunctionSymbol fs => fs,
            VariableSymbol { Type: FunctionSymbol fs } => fs,
            _ => null
        };
    }

    /// <summary>
    /// The index of the argument at the position: the number of separators (commas) before it.
    /// </summary>
    private static int GetArgumentIndex(SyntaxList<SeparatedElement<Expression>> arguments, int position)
    {
        var index = 0;
        foreach (var argument in arguments)
        {
            var separator = argument.Separator;
            if (separator != null && !separator.IsMissing && separator.End <= position)
                index++;
            else
                break;
        }
        return index;
    }

    private static int GetActiveSignature(FunctionCallExpression call, List<Signature> signatures, int argumentCount)
    {
        if (call.ReferencedSignature != null)
        {
            var bound = signatures.IndexOf(call.ReferencedSignature);
            if (bound >= 0)
                return bound;
        }

        var byCount = signatures.FindIndex(s => argumentCount >= s.MinArgumentCount && argumentCount <= s.MaxArgumentCount);
        return byCount >= 0 ? byCount : 0;
    }

    private static int GetActiveParameter(Signature signature, List<Expression> arguments, int argumentIndex)
    {
        var parameters = signature.Parameters;
        if (parameters.Count == 0)
            return -1;

        if (argumentIndex < arguments.Count)
        {
            if (arguments[argumentIndex] is SimpleNamedExpression named)
            {
                var name = named.Name.SimpleName;
                for (int i = 0; i < parameters.Count; i++)
                {
                    if (parameters[i].Name == name)
                        return i;
                }
                return -1;
            }

            var argumentParameters = signature.GetArgumentParameters(arguments);
            if (argumentIndex < argumentParameters.Count && argumentParameters[argumentIndex] is { } mapped)
            {
                for (int i = 0; i < parameters.Count; i++)
                {
                    if (ReferenceEquals(parameters[i], mapped))
                        return i;
                }
            }
        }

        // No argument (or no mapping) yet at the position: fall back to position order,
        // with any excess arguments landing on the last repeatable parameter.
        if (argumentIndex < parameters.Count)
            return argumentIndex;

        for (int i = parameters.Count - 1; i >= 0; i--)
        {
            if (parameters[i].IsRepeatable)
                return i;
        }

        return -1;
    }

    private static SignatureInfo CreateSignatureInfo(FunctionSymbol function, Signature signature)
    {
        var builder = new StringBuilder();
        var parameters = ImmutableList.CreateBuilder<SignatureParameterInfo>();

        builder.Append(function.Name).Append('(');

        for (int i = 0; i < signature.Parameters.Count; i++)
        {
            var parameter = signature.Parameters[i];
            if (i > 0)
                builder.Append(", ");

            var text = GetParameterText(parameter);
            parameters.Add(new SignatureParameterInfo(parameter.Name, builder.Length, text.Length, NullIfEmpty(parameter.Description)));
            builder.Append(text);

            if (parameter.IsRepeatable)
                builder.Append(", ...");
        }

        builder.Append(')');

        if (signature.ReturnKind == ReturnTypeKind.Declared && signature.DeclaredReturnType is ScalarSymbol returnType)
            builder.Append(": ").Append(returnType.Name);

        return new SignatureInfo(builder.ToString(), NullIfEmpty(function.Description), parameters.ToImmutable());
    }

    private static string GetParameterText(Parameter parameter)
    {
        var text = $"{parameter.Name}: {GetParameterTypeText(parameter)}";

        if (parameter.DefaultValue != null)
            return $"{text} = {parameter.DefaultValue.ToString(IncludeTrivia.Minimal)}";

        return parameter.IsOptional ? $"[{text}]" : text;
    }

    private static string GetParameterTypeText(Parameter parameter)
    {
        if (parameter.TypeKind == ParameterTypeKind.Declared && parameter.DeclaredTypes.Count > 0)
            return string.Join(" | ", parameter.DeclaredTypes.Select(GetTypeText));

        return parameter.TypeKind switch
        {
            ParameterTypeKind.Tabular => "table",
            ParameterTypeKind.Database => "database",
            ParameterTypeKind.Cluster => "cluster",
            ParameterTypeKind.Integer => "int | long",
            ParameterTypeKind.RealOrDecimal => "real | decimal",
            ParameterTypeKind.StringOrDynamic => "string | dynamic",
            ParameterTypeKind.StringOrArray => "string | dynamic",
            ParameterTypeKind.IntegerOrArray => "long | dynamic",
            ParameterTypeKind.DynamicArray => "dynamic",
            ParameterTypeKind.DynamicBag => "dynamic",
            ParameterTypeKind.Number or ParameterTypeKind.CommonNumber => "number",
            _ => "scalar"
        };
    }

    private static string GetTypeText(TypeSymbol type)
    {
        return type switch
        {
            ScalarSymbol scalar => scalar.Name,
            TableSymbol => "table",
            _ => type.Kind.ToString().ToLowerInvariant()
        };
    }

    private static string? NullIfEmpty(string? text) =>
        string.IsNullOrEmpty(text) ? null : text;
}
