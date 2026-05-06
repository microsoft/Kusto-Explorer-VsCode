// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using System.Collections.Immutable;
using Kusto.Language;
using Kusto.Language.Editor;
using Kusto.Vscode;

namespace Tests.Features;

[TestClass]
public class OptionsManagerTests
{
    #region Constructor and Default Values Tests

    [TestMethod]
    public void Constructor_InitializesWithDefaultValues()
    {
        var settingSource = new TestSettingSource();
        var optionsManager = new OptionsManager(settingSource);

        // Default domain should be KustoWindowsNet
        Assert.AreEqual(KustoFacts.KustoWindowsNet, optionsManager.DefaultDomain);
        // FormattingOptions should be default
        Assert.IsNotNull(optionsManager.FormattingOptions);
    }

    #endregion

    #region SettingsChanged Triggers Refresh Tests

    [TestMethod]
    public void SettingsChanged_UpdatesDefaultDomain()
    {
        var settingSource = new TestSettingSource();
        settingSource.SetSetting(ConnectionSettings.DefaultDomain, ".kusto.azure.com");

        var optionsManager = new OptionsManager(settingSource);

        var eventFired = new ManualResetEventSlim(false);
        optionsManager.OptionsChanged += (sender, args) => eventFired.Set();

        settingSource.RaiseSettingsChanged();

        Assert.IsTrue(eventFired.Wait(TimeSpan.FromSeconds(5)));
        Assert.AreEqual(".kusto.azure.com", optionsManager.DefaultDomain);
    }

    [TestMethod]
    public void SettingsChanged_UpdatesFormattingOptions_TabSize()
    {
        var settingSource = new TestSettingSource();
        settingSource.SetSetting(FormatSettings.TabSize, 2);

        var optionsManager = new OptionsManager(settingSource);

        var eventFired = new ManualResetEventSlim(false);
        optionsManager.OptionsChanged += (sender, args) => eventFired.Set();

        settingSource.RaiseSettingsChanged();

        Assert.IsTrue(eventFired.Wait(TimeSpan.FromSeconds(5)));
        Assert.AreEqual(2, optionsManager.FormattingOptions.IndentationSize);
    }

    [TestMethod]
    public void SettingsChanged_UpdatesFormattingOptions_InsertMissingTokens()
    {
        var settingSource = new TestSettingSource();
        settingSource.SetSetting(FormatSettings.InsertMissingTokens, true);

        var optionsManager = new OptionsManager(settingSource);

        var eventFired = new ManualResetEventSlim(false);
        optionsManager.OptionsChanged += (sender, args) => eventFired.Set();

        settingSource.RaiseSettingsChanged();

        Assert.IsTrue(eventFired.Wait(TimeSpan.FromSeconds(5)));
        Assert.IsTrue(optionsManager.FormattingOptions.InsertMissingTokens);
    }

    [TestMethod]
    public void PlacementStyle_LegacyNoneAliasResolvesToNone()
    {
        // Legacy "none" string value in user settings should still map to PlacementStyle.None
        Assert.AreEqual(PlacementStyle.None, FormatSettings.PlacementStyles["none"]);
        Assert.AreEqual(PlacementStyle.None, FormatSettings.PlacementStyles["asIs"]);
    }

    [TestMethod]
    public void SettingsChanged_AcceptsLegacyNonePlacementValue()
    {
        var settingSource = new TestSettingSource();
        // Simulate an older user setting using the literal string "none"
        settingSource.SetSetting<object?>(
            new Setting<object?>(FormatSettings.PipeOperatorPlacementStyle.Name, null),
            "none");

        var optionsManager = new OptionsManager(settingSource);

        var eventFired = new ManualResetEventSlim(false);
        optionsManager.OptionsChanged += (sender, args) => eventFired.Set();

        settingSource.RaiseSettingsChanged();

        Assert.IsTrue(eventFired.Wait(TimeSpan.FromSeconds(5)));
        Assert.AreEqual(PlacementStyle.None, optionsManager.FormattingOptions.PipeOperatorStyle);
    }

    [TestMethod]
    public void SettingsChanged_AcceptsAsIsPlacementValue()
    {
        var settingSource = new TestSettingSource();
        settingSource.SetSetting<object?>(
            new Setting<object?>(FormatSettings.PipeOperatorPlacementStyle.Name, null),
            "asIs");

        var optionsManager = new OptionsManager(settingSource);

        var eventFired = new ManualResetEventSlim(false);
        optionsManager.OptionsChanged += (sender, args) => eventFired.Set();

        settingSource.RaiseSettingsChanged();

        Assert.IsTrue(eventFired.Wait(TimeSpan.FromSeconds(5)));
        Assert.AreEqual(PlacementStyle.None, optionsManager.FormattingOptions.PipeOperatorStyle);
    }

    [TestMethod]
    public void SettingsChanged_UpdatesFormattingOptions_BrackettingStyle()
    {
        var settingSource = new TestSettingSource();
        settingSource.SetSetting(FormatSettings.DefaultBrackettingStyle, BrackettingStyle.Diagonal);

        var optionsManager = new OptionsManager(settingSource);

        var eventFired = new ManualResetEventSlim(false);
        optionsManager.OptionsChanged += (sender, args) => eventFired.Set();

        settingSource.RaiseSettingsChanged();

        Assert.IsTrue(eventFired.Wait(TimeSpan.FromSeconds(5)));
        Assert.AreEqual(BrackettingStyle.Diagonal, optionsManager.FormattingOptions.BrackettingStyle);
    }

    [TestMethod]
    public void SettingsChanged_UpdatesFormattingOptions_PipeOperatorStyle()
    {
        var settingSource = new TestSettingSource();
        settingSource.SetSetting(FormatSettings.PipeOperatorPlacementStyle, PlacementStyle.NewLine);

        var optionsManager = new OptionsManager(settingSource);

        var eventFired = new ManualResetEventSlim(false);
        optionsManager.OptionsChanged += (sender, args) => eventFired.Set();

        settingSource.RaiseSettingsChanged();

        Assert.IsTrue(eventFired.Wait(TimeSpan.FromSeconds(5)));
        Assert.AreEqual(PlacementStyle.NewLine, optionsManager.FormattingOptions.PipeOperatorStyle);
    }

    [TestMethod]
    public void SettingsChanged_FiresOptionsChangedEvent()
    {
        var settingSource = new TestSettingSource();
        var optionsManager = new OptionsManager(settingSource);

        var eventFired = new ManualResetEventSlim(false);
        optionsManager.OptionsChanged += (sender, args) => eventFired.Set();

        settingSource.RaiseSettingsChanged();

        Assert.IsTrue(eventFired.Wait(TimeSpan.FromSeconds(5)), "OptionsChanged should fire after SettingsChanged");
    }

    #endregion

    #region Settings Update Tests

    [TestMethod]
    public void SettingsChanged_UpdatesAfterSettingChange()
    {
        var settingSource = new TestSettingSource();
        var optionsManager = new OptionsManager(settingSource);

        // Initial load
        var initialEventFired = new ManualResetEventSlim(false);
        optionsManager.OptionsChanged += (sender, args) => initialEventFired.Set();
        settingSource.RaiseSettingsChanged();
        Assert.IsTrue(initialEventFired.Wait(TimeSpan.FromSeconds(5)));

        // Change a setting
        settingSource.SetSetting(ConnectionSettings.DefaultDomain, ".newdomain.net");

        var updateEventFired = new ManualResetEventSlim(false);
        optionsManager.OptionsChanged += (sender, args) => updateEventFired.Set();

        // Raise settings changed event again
        settingSource.RaiseSettingsChanged();

        // Wait for the async refresh to complete
        Assert.IsTrue(updateEventFired.Wait(TimeSpan.FromSeconds(5)), "OptionsChanged should fire after SettingsChanged");
        Assert.AreEqual(".newdomain.net", optionsManager.DefaultDomain);
    }

    #endregion

    #region Multiple Settings Tests

    [TestMethod]
    public void SettingsChanged_UpdatesMultipleSettings()
    {
        var settingSource = new TestSettingSource();
        settingSource.SetSetting(ConnectionSettings.DefaultDomain, ".custom.domain");
        settingSource.SetSetting(FormatSettings.TabSize, 8);
        settingSource.SetSetting(FormatSettings.InsertMissingTokens, true);
        settingSource.SetSetting(FormatSettings.DefaultBrackettingStyle, BrackettingStyle.Diagonal);
        settingSource.SetSetting(FormatSettings.PipeOperatorPlacementStyle, PlacementStyle.NewLine);

        var optionsManager = new OptionsManager(settingSource);

        var eventFired = new ManualResetEventSlim(false);
        optionsManager.OptionsChanged += (sender, args) => eventFired.Set();

        settingSource.RaiseSettingsChanged();

        Assert.IsTrue(eventFired.Wait(TimeSpan.FromSeconds(5)));
        Assert.AreEqual(".custom.domain", optionsManager.DefaultDomain);
        Assert.AreEqual(8, optionsManager.FormattingOptions.IndentationSize);
        Assert.IsTrue(optionsManager.FormattingOptions.InsertMissingTokens);
        Assert.AreEqual(BrackettingStyle.Diagonal, optionsManager.FormattingOptions.BrackettingStyle);
        Assert.AreEqual(PlacementStyle.NewLine, optionsManager.FormattingOptions.PipeOperatorStyle);
    }

    [TestMethod]
    public void SettingsChanged_UsesDefaultsForMissingSettings()
    {
        var settingSource = new TestSettingSource();
        // Don't set any settings - should use defaults

        var optionsManager = new OptionsManager(settingSource);

        var eventFired = new ManualResetEventSlim(false);
        optionsManager.OptionsChanged += (sender, args) => eventFired.Set();

        settingSource.RaiseSettingsChanged();

        Assert.IsTrue(eventFired.Wait(TimeSpan.FromSeconds(5)));
        // Should have default values from Setting definitions
        Assert.AreEqual(ConnectionSettings.DefaultDomain.DefaultValue, optionsManager.DefaultDomain);
        Assert.AreEqual(FormatSettings.TabSize.DefaultValue, optionsManager.FormattingOptions.IndentationSize);
        Assert.AreEqual(FormatSettings.InsertMissingTokens.DefaultValue, optionsManager.FormattingOptions.InsertMissingTokens);
    }

    #endregion

    #region All Formatting Options Tests

    [TestMethod]
    public void SettingsChanged_UpdatesAllBrackettingStyles()
    {
        var settingSource = new TestSettingSource();
        settingSource.SetSetting(FormatSettings.SchemaBrackettingStyle, BrackettingStyle.Vertical);
        settingSource.SetSetting(FormatSettings.DataTableBrackettingStyle, BrackettingStyle.Diagonal);
        settingSource.SetSetting(FormatSettings.FunctionBodyBrackettingStyle, BrackettingStyle.Diagonal);
        settingSource.SetSetting(FormatSettings.FunctionParameterBrackettingStyle, BrackettingStyle.Vertical);
        settingSource.SetSetting(FormatSettings.FunctionArgumentBrackettingStyle, BrackettingStyle.Diagonal);

        var optionsManager = new OptionsManager(settingSource);

        var eventFired = new ManualResetEventSlim(false);
        optionsManager.OptionsChanged += (sender, args) => eventFired.Set();

        settingSource.RaiseSettingsChanged();

        Assert.IsTrue(eventFired.Wait(TimeSpan.FromSeconds(5)));
        Assert.AreEqual(BrackettingStyle.Vertical, optionsManager.FormattingOptions.SchemaStyle);
        Assert.AreEqual(BrackettingStyle.Diagonal, optionsManager.FormattingOptions.DataTableValueStyle);
        Assert.AreEqual(BrackettingStyle.Diagonal, optionsManager.FormattingOptions.FunctionBodyStyle);
        Assert.AreEqual(BrackettingStyle.Vertical, optionsManager.FormattingOptions.FunctionParameterStyle);
        Assert.AreEqual(BrackettingStyle.Diagonal, optionsManager.FormattingOptions.FunctionArgumentStyle);
    }

    [TestMethod]
    public void SettingsChanged_UpdatesAllPlacementStyles()
    {
        var settingSource = new TestSettingSource();
        settingSource.SetSetting(FormatSettings.PipeOperatorPlacementStyle, PlacementStyle.NewLine);
        settingSource.SetSetting(FormatSettings.ExpressionPlacementStyle, PlacementStyle.NewLine);
        settingSource.SetSetting(FormatSettings.StatementPlacementStyle, PlacementStyle.NewLine);
        settingSource.SetSetting(FormatSettings.SemicolonPlacementStyle, PlacementStyle.Smart);

        var optionsManager = new OptionsManager(settingSource);

        var eventFired = new ManualResetEventSlim(false);
        optionsManager.OptionsChanged += (sender, args) => eventFired.Set();

        settingSource.RaiseSettingsChanged();

        Assert.IsTrue(eventFired.Wait(TimeSpan.FromSeconds(5)));
        Assert.AreEqual(PlacementStyle.NewLine, optionsManager.FormattingOptions.PipeOperatorStyle);
        Assert.AreEqual(PlacementStyle.NewLine, optionsManager.FormattingOptions.ExpressionStyle);
        Assert.AreEqual(PlacementStyle.NewLine, optionsManager.FormattingOptions.StatementStyle);
        Assert.AreEqual(PlacementStyle.Smart, optionsManager.FormattingOptions.SemicolonStyle);
    }

    [TestMethod]
    public void SettingsChanged_UpdatesAllSpacingStyles()
    {
        var settingSource = new TestSettingSource();
        settingSource.SetSetting(FormatSettings.GeneralSpacing, SpacingStyle.AsIs);
        settingSource.SetSetting(FormatSettings.PrefixOperatorSpacing, SpacingStyle.One);
        settingSource.SetSetting(FormatSettings.ParenthesizedExpressionSpacing, SpacingStyle.One);
        settingSource.SetSetting(FormatSettings.ArgumentListSpacing, SpacingStyle.One);
        settingSource.SetSetting(FormatSettings.EmptyArgumentListSpacing, SpacingStyle.AsIs);
        settingSource.SetSetting(FormatSettings.ParameterListSpacing, SpacingStyle.One);
        settingSource.SetSetting(FormatSettings.EmptyParameterListSpacing, SpacingStyle.AsIs);
        settingSource.SetSetting(FormatSettings.JsonArraySpacing, SpacingStyle.One);
        settingSource.SetSetting(FormatSettings.EmptyJsonArraySpacing, SpacingStyle.AsIs);
        settingSource.SetSetting(FormatSettings.JsonObjectSpacing, SpacingStyle.One);
        settingSource.SetSetting(FormatSettings.EmptyJsonObjectSpacing, SpacingStyle.AsIs);
        settingSource.SetSetting(FormatSettings.DataTableValueSpacing, SpacingStyle.One);
        settingSource.SetSetting(FormatSettings.EmptyDataTableValueSpacing, SpacingStyle.AsIs);
        settingSource.SetSetting(FormatSettings.FunctionBodySpacing, SpacingStyle.Minimal);
        settingSource.SetSetting(FormatSettings.EmptyFunctionBodySpacing, SpacingStyle.Minimal);
        settingSource.SetSetting(FormatSettings.BeforeFunctionBodySpacing, SpacingStyle.Minimal);
        settingSource.SetSetting(FormatSettings.BeforeParameterListSpacing, SpacingStyle.One);
        settingSource.SetSetting(FormatSettings.BeforeArgumentListSpacing, SpacingStyle.One);
        settingSource.SetSetting(FormatSettings.BeforeDataTableValueSpacing, SpacingStyle.Minimal);

        var optionsManager = new OptionsManager(settingSource);

        var eventFired = new ManualResetEventSlim(false);
        optionsManager.OptionsChanged += (sender, args) => eventFired.Set();

        settingSource.RaiseSettingsChanged();

        Assert.IsTrue(eventFired.Wait(TimeSpan.FromSeconds(5)));
        var f = optionsManager.FormattingOptions;
        Assert.AreEqual(SpacingStyle.AsIs, f.GeneralSpacing);
        Assert.AreEqual(SpacingStyle.One, f.PrefixOperatorSpacing);
        Assert.AreEqual(SpacingStyle.One, f.ParenthesizedExpressionSpacing);
        Assert.AreEqual(SpacingStyle.One, f.ArgumentListSpacing);
        Assert.AreEqual(SpacingStyle.AsIs, f.EmptyArgumentListSpacing);
        Assert.AreEqual(SpacingStyle.One, f.ParameterListSpacing);
        Assert.AreEqual(SpacingStyle.AsIs, f.EmptyParameterListSpacing);
        Assert.AreEqual(SpacingStyle.One, f.JsonArraySpacing);
        Assert.AreEqual(SpacingStyle.AsIs, f.EmptyJsonArraySpacing);
        Assert.AreEqual(SpacingStyle.One, f.JsonObjectSpacing);
        Assert.AreEqual(SpacingStyle.AsIs, f.EmptyJsonObjectSpacing);
        Assert.AreEqual(SpacingStyle.One, f.DataTableValueSpacing);
        Assert.AreEqual(SpacingStyle.AsIs, f.EmptyDataTableValueSpacing);
        Assert.AreEqual(SpacingStyle.Minimal, f.FunctionBodySpacing);
        Assert.AreEqual(SpacingStyle.Minimal, f.EmptyFunctionBodySpacing);
        Assert.AreEqual(SpacingStyle.Minimal, f.BeforeFunctionBodySpacing);
        Assert.AreEqual(SpacingStyle.One, f.BeforeParameterListSpacing);
        Assert.AreEqual(SpacingStyle.One, f.BeforeArgumentListSpacing);
        Assert.AreEqual(SpacingStyle.Minimal, f.BeforeDataTableValueSpacing);
    }

    [TestMethod]
    public void SettingsChanged_UpdatesAllDualSpacingStyles()
    {
        var settingSource = new TestSettingSource();
        settingSource.SetSetting(FormatSettings.InfixOperatorSpacing, DualSpacingStyle.Neither);
        settingSource.SetSetting(FormatSettings.PipeOperatorSpacing, DualSpacingStyle.After);
        settingSource.SetSetting(FormatSettings.CommaSpacing, DualSpacingStyle.Both);
        settingSource.SetSetting(FormatSettings.ColonSpacing, DualSpacingStyle.Both);
        settingSource.SetSetting(FormatSettings.AssignmentSpacing, DualSpacingStyle.Neither);
        settingSource.SetSetting(FormatSettings.RangeOperatorSpacing, DualSpacingStyle.Neither);
        settingSource.SetSetting(FormatSettings.SemicolonSpacing, DualSpacingStyle.Both);

        var optionsManager = new OptionsManager(settingSource);

        var eventFired = new ManualResetEventSlim(false);
        optionsManager.OptionsChanged += (sender, args) => eventFired.Set();

        settingSource.RaiseSettingsChanged();

        Assert.IsTrue(eventFired.Wait(TimeSpan.FromSeconds(5)));
        var f = optionsManager.FormattingOptions;
        Assert.AreEqual(DualSpacingStyle.Neither, f.InfixOperatorSpacing);
        Assert.AreEqual(DualSpacingStyle.After, f.PipeOperatorSpacing);
        Assert.AreEqual(DualSpacingStyle.Both, f.CommaSpacing);
        Assert.AreEqual(DualSpacingStyle.Both, f.ColonSpacing);
        Assert.AreEqual(DualSpacingStyle.Neither, f.AssignmentSpacing);
        Assert.AreEqual(DualSpacingStyle.Neither, f.RangeOperatorSpacing);
        Assert.AreEqual(DualSpacingStyle.Both, f.SemicolonSpacing);
    }

    #endregion

    #region Test Setting Source

    private class TestSettingSource : ISettingSource
    {
        private ImmutableDictionary<string, object?> _settings =
            ImmutableDictionary<string, object?>.Empty;

        public event EventHandler? SettingsChanged;

        public void SetSetting<T>(Setting<T> setting, T value)
        {
            _settings = setting.WithValue(_settings, value);
        }

        public void RaiseSettingsChanged()
        {
            SettingsChanged?.Invoke(this, EventArgs.Empty);
        }

        public Task<T> GetSettingAsync<T>(Setting<T> setting, CancellationToken cancellation)
        {
            if (_settings.TryGetValue(setting.Name, out var value) && value is T typedValue)
            {
                return Task.FromResult(typedValue);
            }
            return Task.FromResult(setting.DefaultValue);
        }

        public Task<ImmutableDictionary<string, object?>> GetSettingsAsync(IReadOnlyList<Setting> settings, CancellationToken cancellationToken)
        {
            var result = ImmutableDictionary<string, object?>.Empty;

            foreach (var setting in settings)
            {
                if (_settings.TryGetValue(setting.Name, out var value))
                {
                    result = result.SetItem(setting.Name, value);
                }
            }

            return Task.FromResult(result);
        }
    }

    #endregion
}
