// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using Kusto.Language;
using KLE=Kusto.Language.Editor;

namespace Kusto.Vscode;

public class OptionsManager : IOptionsManager
{
    private readonly ISettingSource _settingSource;

    private string _defaultDomain = KustoFacts.KustoWindowsNet;
    private KLE.FormattingOptions _formattingOptions = KLE.FormattingOptions.Default;

    public OptionsManager(ISettingSource settingSource)
    {
        _settingSource = settingSource;

        _settingSource.SettingsChanged += _settingSource_SettingsChanged;
    }

    public event EventHandler? OptionsChanged;

    public string DefaultDomain => _defaultDomain;
    public KLE.FormattingOptions FormattingOptions => _formattingOptions;

    private void _settingSource_SettingsChanged(object? sender, EventArgs e)
    {
        _ = this.RefreshAsync(CancellationToken.None);
    }

    private async Task RefreshAsync(CancellationToken cancellationToken)
    {
        _defaultDomain = await _settingSource.GetSettingAsync(ConnectionSettings.DefaultDomain, cancellationToken).ConfigureAwait(false);
        _formattingOptions = await GetFormattingOptionsAsync(cancellationToken).ConfigureAwait(false);

        // raise event after refresh
        this.OptionsChanged?.Invoke(this, EventArgs.Empty);
    }

    private async Task<KLE.FormattingOptions> GetFormattingOptionsAsync(CancellationToken cancellationToken)
    {
        var settings = await _settingSource.GetSettingsAsync(FormatSettings.All, cancellationToken).ConfigureAwait(false);

        return Kusto.Language.Editor.FormattingOptions.Default
            .WithIndentationSize(FormatSettings.TabSize.GetValue(settings))
            .WithInsertMissingTokens(FormatSettings.InsertMissingTokens.GetValue(settings))
            .WithBrackettingStyle(FormatSettings.DefaultBrackettingStyle.GetValue(settings))
            .WithSchemaStyle(FormatSettings.SchemaBrackettingStyle.GetValue(settings))
            .WithDataTableValueStyle(FormatSettings.DataTableBrackettingStyle.GetValue(settings))
            .WithFunctionBodyStyle(FormatSettings.FunctionBodyBrackettingStyle.GetValue(settings))
            .WithFunctionParameterStyle(FormatSettings.FunctionParameterBrackettingStyle.GetValue(settings))
            .WithFunctionArgumentStyle(FormatSettings.FunctionArgumentBrackettingStyle.GetValue(settings))
            .WithPipeOperatorStyle(FormatSettings.PipeOperatorPlacementStyle.GetValue(settings))
            .WithExpressionStyle(FormatSettings.ExpressionPlacementStyle.GetValue(settings))
            .WithStatementStyle(FormatSettings.StatementPlacementStyle.GetValue(settings))
            .WithSemicolonStyle(FormatSettings.SemicolonPlacementStyle.GetValue(settings))
            .WithGeneralSpacing(FormatSettings.GeneralSpacing.GetValue(settings))
            .WithPrefixOperatorSpacing(FormatSettings.PrefixOperatorSpacing.GetValue(settings))
            .WithInfixOperatorSpacing(FormatSettings.InfixOperatorSpacing.GetValue(settings))
            .WithPipeOperatorSpacing(FormatSettings.PipeOperatorSpacing.GetValue(settings))
            .WithCommaSpacing(FormatSettings.CommaSpacing.GetValue(settings))
            .WithColonSpacing(FormatSettings.ColonSpacing.GetValue(settings))
            .WithAssignmentSpacing(FormatSettings.AssignmentSpacing.GetValue(settings))
            .WithRangeOperatorSpacing(FormatSettings.RangeOperatorSpacing.GetValue(settings))
            .WithSemicolonSpacing(FormatSettings.SemicolonSpacing.GetValue(settings))
            .WithExpressionParenSpacing(FormatSettings.ParenthesizedExpressionSpacing.GetValue(settings))
            .WithArgumentListSpacing(FormatSettings.ArgumentListSpacing.GetValue(settings))
            .WithEmptyArgumentListSpacing(FormatSettings.EmptyArgumentListSpacing.GetValue(settings))
            .WithParameterListSpacing(FormatSettings.ParameterListSpacing.GetValue(settings))
            .WithEmptyParameterListSpacing(FormatSettings.EmptyParameterListSpacing.GetValue(settings))
            .WithJsonArraySpacing(FormatSettings.JsonArraySpacing.GetValue(settings))
            .WithEmptyJsonArraySpacing(FormatSettings.EmptyJsonArraySpacing.GetValue(settings))
            .WithJsonObjectSpacing(FormatSettings.JsonObjectSpacing.GetValue(settings))
            .WithEmptyJsonObjectSpacing(FormatSettings.EmptyJsonObjectSpacing.GetValue(settings))
            .WithDataTableValueSpacing(FormatSettings.DataTableValueSpacing.GetValue(settings))
            .WithEmptyDataTableValueSpacing(FormatSettings.EmptyDataTableValueSpacing.GetValue(settings))
            .WithFunctionBodySpacing(FormatSettings.FunctionBodySpacing.GetValue(settings))
            .WithEmptyFunctionBodySpacing(FormatSettings.EmptyFunctionBodySpacing.GetValue(settings))
            .WithBeforeFunctionBodySpacing(FormatSettings.BeforeFunctionBodySpacing.GetValue(settings))
            .WithBeforeParameterListSpacing(FormatSettings.BeforeParameterListSpacing.GetValue(settings))
            .WithBeforeArgumentListSpacing(FormatSettings.BeforeArgumentListSpacing.GetValue(settings))
            .WithBeforeDataTableValueSpacing(FormatSettings.BeforeDataTableValueSpacing.GetValue(settings));
    }

}
