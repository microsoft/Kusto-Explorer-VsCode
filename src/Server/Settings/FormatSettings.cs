// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using System.Collections.Immutable;
using Kusto.Language.Editor;

namespace Kusto.Vscode;

public static class FormatSettings
{
    public static readonly Setting<int> TabSize =
        new Setting<int>("editor.tabSize", 4);

    public static readonly Setting<bool> InsertMissingTokens = 
        new Setting<bool>("msKustoExplorer.format.insertMissingTokens", false);

    public static ImmutableDictionary<string, BrackettingStyle> BrackettingStyles { get; } =
        new Dictionary<string, BrackettingStyle>
        {
            { "none", BrackettingStyle.None },
            { "vertical", BrackettingStyle.Vertical },
            { "diagonal", BrackettingStyle.Diagonal }
        }
        .ToImmutableDictionary();

    public static readonly Setting<BrackettingStyle> DefaultBrackettingStyle = 
        new StringMappedSetting<BrackettingStyle>(
            "msKustoExplorer.format.bracketStyle", BrackettingStyle.Vertical, BrackettingStyles);

    public static readonly Setting<BrackettingStyle> SchemaBrackettingStyle = 
        new StringMappedSetting<BrackettingStyle>(
            "msKustoExplorer.format.schemaBracketStyle", BrackettingStyle.None, BrackettingStyles);

    public static readonly Setting<BrackettingStyle> DataTableBrackettingStyle =
        new StringMappedSetting<BrackettingStyle>(
            "msKustoExplorer.format.dataTableBracketStyle", BrackettingStyle.Vertical, BrackettingStyles);

    public static readonly Setting<BrackettingStyle> FunctionBodyBrackettingStyle =
        new StringMappedSetting<BrackettingStyle>(
            "msKustoExplorer.format.functionBodyBracketStyle", BrackettingStyle.Vertical, BrackettingStyles);

    public static readonly Setting<BrackettingStyle> FunctionParameterBrackettingStyle =
        new StringMappedSetting<BrackettingStyle>(
            "msKustoExplorer.format.functionParameterBracketStyle", BrackettingStyle.None, BrackettingStyles);

    public static readonly Setting<BrackettingStyle> FunctionArgumentBrackettingStyle =
        new StringMappedSetting<BrackettingStyle>(
            "msKustoExplorer.format.functionArgumentBracketStyle", BrackettingStyle.None, BrackettingStyles);

    public static ImmutableDictionary<string, PlacementStyle> PlacementStyles { get; } =
        new Dictionary<string, PlacementStyle>
        {
            { "asIs", PlacementStyle.None },
            { "none", PlacementStyle.None  },
            { "newLine", PlacementStyle.NewLine },
            { "smart", PlacementStyle.Smart },
        }
        .ToImmutableDictionary();

    public static readonly Setting<PlacementStyle> PipeOperatorPlacementStyle =
        new StringMappedSetting<PlacementStyle>(
            "msKustoExplorer.format.pipeOperatorPlacementStyle", PlacementStyle.Smart, PlacementStyles);

    public static readonly Setting<PlacementStyle> ExpressionPlacementStyle =
        new StringMappedSetting<PlacementStyle>(
            "msKustoExplorer.format.expressionListPlacementStyle", PlacementStyle.Smart, PlacementStyles);

    public static readonly Setting<PlacementStyle> StatementPlacementStyle =
        new StringMappedSetting<PlacementStyle>(
            "msKustoExplorer.format.statementListPlacementStyle", PlacementStyle.Smart, PlacementStyles);

    public static readonly Setting<PlacementStyle> SemicolonPlacementStyle =
        new StringMappedSetting<PlacementStyle>(
            "msKustoExplorer.format.semicolonPlacementStyle", PlacementStyle.None, PlacementStyles);

    public static ImmutableDictionary<string, SpacingStyle> SpacingStyles { get; } =
        new Dictionary<string, SpacingStyle>
        {
            { "asIs", SpacingStyle.AsIs },
            { "minimal", SpacingStyle.Minimal },
            { "one", SpacingStyle.One },
        }
        .ToImmutableDictionary();

    public static ImmutableDictionary<string, DualSpacingStyle> DualSpacingStyles { get; } =
        new Dictionary<string, DualSpacingStyle>
        {
            { "asIs", DualSpacingStyle.AsIs },
            { "neither", DualSpacingStyle.Neither },
            { "before", DualSpacingStyle.Before },
            { "after", DualSpacingStyle.After },
            { "both", DualSpacingStyle.Both },
        }
        .ToImmutableDictionary();

    private static Setting<SpacingStyle> Spacing(string suffix, SpacingStyle defaultValue) =>
        new StringMappedSetting<SpacingStyle>(
            "msKustoExplorer.format." + suffix, defaultValue, SpacingStyles);

    private static Setting<DualSpacingStyle> DualSpacing(string suffix, DualSpacingStyle defaultValue) =>
        new StringMappedSetting<DualSpacingStyle>(
            "msKustoExplorer.format." + suffix, defaultValue, DualSpacingStyles);

    public static readonly Setting<SpacingStyle> GeneralSpacing =
        Spacing("generalSpacing", SpacingStyle.One);

    public static readonly Setting<SpacingStyle> PrefixOperatorSpacing =
        Spacing("prefixOperatorSpacing", SpacingStyle.Minimal);

    public static readonly Setting<DualSpacingStyle> InfixOperatorSpacing =
        DualSpacing("infixOperatorSpacing", DualSpacingStyle.Both);

    public static readonly Setting<DualSpacingStyle> PipeOperatorSpacing =
        DualSpacing("pipeOperatorSpacing", DualSpacingStyle.Both);

    public static readonly Setting<DualSpacingStyle> CommaSpacing =
        DualSpacing("commaSpacing", DualSpacingStyle.After);

    public static readonly Setting<DualSpacingStyle> ColonSpacing =
        DualSpacing("colonSpacing", DualSpacingStyle.After);

    public static readonly Setting<DualSpacingStyle> AssignmentSpacing =
        DualSpacing("assignmentSpacing", DualSpacingStyle.Both);

    public static readonly Setting<DualSpacingStyle> RangeOperatorSpacing =
        DualSpacing("rangeOperatorSpacing", DualSpacingStyle.Both);

    public static readonly Setting<DualSpacingStyle> SemicolonSpacing =
        DualSpacing("semicolonSpacing", DualSpacingStyle.After);

    public static readonly Setting<SpacingStyle> ParenthesizedExpressionSpacing =
        Spacing("parenthesizedExpressionSpacing", SpacingStyle.Minimal);

    public static readonly Setting<SpacingStyle> ArgumentListSpacing =
        Spacing("argumentListSpacing", SpacingStyle.Minimal);

    public static readonly Setting<SpacingStyle> EmptyArgumentListSpacing =
        Spacing("emptyArgumentListSpacing", SpacingStyle.Minimal);

    public static readonly Setting<SpacingStyle> ParameterListSpacing =
        Spacing("parameterListSpacing", SpacingStyle.Minimal);

    public static readonly Setting<SpacingStyle> EmptyParameterListSpacing =
        Spacing("emptyParameterListSpacing", SpacingStyle.Minimal);

    public static readonly Setting<SpacingStyle> JsonArraySpacing =
        Spacing("jsonArraySpacing", SpacingStyle.Minimal);

    public static readonly Setting<SpacingStyle> EmptyJsonArraySpacing =
        Spacing("emptyJsonArraySpacing", SpacingStyle.Minimal);

    public static readonly Setting<SpacingStyle> JsonObjectSpacing =
        Spacing("jsonObjectSpacing", SpacingStyle.Minimal);

    public static readonly Setting<SpacingStyle> EmptyJsonObjectSpacing =
        Spacing("emptyJsonObjectSpacing", SpacingStyle.Minimal);

    public static readonly Setting<SpacingStyle> DataTableValueSpacing =
        Spacing("dataTableValueSpacing", SpacingStyle.Minimal);

    public static readonly Setting<SpacingStyle> EmptyDataTableValueSpacing =
        Spacing("emptyDataTableValueSpacing", SpacingStyle.Minimal);

    public static readonly Setting<SpacingStyle> FunctionBodySpacing =
        Spacing("functionBodySpacing", SpacingStyle.One);

    public static readonly Setting<SpacingStyle> EmptyFunctionBodySpacing =
        Spacing("emptyFunctionBodySpacing", SpacingStyle.One);

    public static readonly Setting<SpacingStyle> BeforeFunctionBodySpacing =
        Spacing("beforeFunctionBodySpacing", SpacingStyle.One);

    public static readonly Setting<SpacingStyle> BeforeParameterListSpacing =
        Spacing("beforeParameterListSpacing", SpacingStyle.Minimal);

    public static readonly Setting<SpacingStyle> BeforeArgumentListSpacing =
        Spacing("beforeArgumentListSpacing", SpacingStyle.Minimal);

    public static readonly Setting<SpacingStyle> BeforeDataTableValueSpacing =
        Spacing("beforeDataTableValueSpacing", SpacingStyle.One);

    public static readonly ImmutableList<Setting> All =
        [
            TabSize,
            InsertMissingTokens,
            DefaultBrackettingStyle,
            SchemaBrackettingStyle,
            DataTableBrackettingStyle,
            FunctionBodyBrackettingStyle,
            FunctionParameterBrackettingStyle,
            FunctionArgumentBrackettingStyle,
            PipeOperatorPlacementStyle,
            ExpressionPlacementStyle,
            StatementPlacementStyle,
            SemicolonPlacementStyle,
            GeneralSpacing,
            PrefixOperatorSpacing,
            InfixOperatorSpacing,
            PipeOperatorSpacing,
            CommaSpacing,
            ColonSpacing,
            AssignmentSpacing,
            RangeOperatorSpacing,
            SemicolonSpacing,
            ParenthesizedExpressionSpacing,
            ArgumentListSpacing,
            EmptyArgumentListSpacing,
            ParameterListSpacing,
            EmptyParameterListSpacing,
            JsonArraySpacing,
            EmptyJsonArraySpacing,
            JsonObjectSpacing,
            EmptyJsonObjectSpacing,
            DataTableValueSpacing,
            EmptyDataTableValueSpacing,
            FunctionBodySpacing,
            EmptyFunctionBodySpacing,
            BeforeFunctionBodySpacing,
            BeforeParameterListSpacing,
            BeforeArgumentListSpacing,
            BeforeDataTableValueSpacing,
        ];
}
