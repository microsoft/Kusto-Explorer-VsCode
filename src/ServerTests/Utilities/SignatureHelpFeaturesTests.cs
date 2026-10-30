// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using Kusto.Language;
using Kusto.Vscode;

namespace Tests.Utilities;

using static TestHelpers;

[TestClass]
public class SignatureHelpFeaturesTests
{
    [TestMethod]
    public void CursorRightAfterOpenParen_FirstParameterActive()
    {
        var info = GetHelp("print substring($");
        Assert.AreEqual("substring", NameOf(info));
        Assert.AreEqual(0, info.ActiveParameter);
    }

    [TestMethod]
    public void CursorAfterComma_SecondParameterActive()
    {
        var info = GetHelp("print substring(\"abc\", $");
        Assert.AreEqual(1, info.ActiveParameter);
    }

    [TestMethod]
    public void CursorInLastArgumentOfClosedCall_ThirdParameterActive()
    {
        var info = GetHelp("print substring(\"abc\", 1, $2)");
        Assert.AreEqual(2, info.ActiveParameter);
    }

    [TestMethod]
    public void CursorBeforeCloseParen_IsInsideCall()
    {
        var info = GetHelp("print substring(\"abc\", 1$)");
        Assert.AreEqual(1, info.ActiveParameter);
    }

    [TestMethod]
    public void CursorInsideFirstArgumentText_FirstParameterActive()
    {
        var info = GetHelp("print substring(\"a$bc\", 1)");
        Assert.AreEqual(0, info.ActiveParameter);
    }

    [TestMethod]
    public void NestedCall_InnermostCallWins()
    {
        var info = GetHelp("print substring(tolower($");
        Assert.AreEqual("tolower", NameOf(info));
        Assert.AreEqual(0, info.ActiveParameter);
    }

    [TestMethod]
    public void NestedCall_AfterInnerCallCloses_OuterCallResumes()
    {
        var info = GetHelp("print substring(tolower(\"a\"), $");
        Assert.AreEqual("substring", NameOf(info));
        Assert.AreEqual(1, info.ActiveParameter);
    }

    [TestMethod]
    public void CommaInsideNestedCall_DoesNotAdvanceOuterArgument()
    {
        var info = GetHelp("print substring(strcat(\"a\", \"b\")$, 1)");
        Assert.AreEqual("substring", NameOf(info));
        Assert.AreEqual(0, info.ActiveParameter);
    }

    [TestMethod]
    public void RepeatableParameter_StaysActiveForExtraArguments()
    {
        var info = GetHelp("print strcat(\"a\", \"b\", \"c\", $");
        Assert.AreEqual("strcat", NameOf(info));
        Assert.AreEqual(0, info.ActiveParameter);
        StringAssert.Contains(info.Signatures[info.ActiveSignature].Label, ", ...");
    }

    [TestMethod]
    public void NamedArgument_ActivatesParameterByName()
    {
        var info = GetHelp("let f = (x: long, y: string = 'a') { print x }; print f(y = $");
        Assert.AreEqual("f", NameOf(info));
        Assert.AreEqual(1, info.ActiveParameter);
    }

    [TestMethod]
    public void NamedArgumentWithUnknownName_NoParameterActive()
    {
        var info = GetHelp("let f = (x: long, y: string = 'a') { print x }; print f(z = $");
        Assert.AreEqual(-1, info.ActiveParameter);
    }

    [TestMethod]
    public void LocalFunction_LabelAndParameterOffsets()
    {
        var info = GetHelp("let f = (x: long, y: string = 'a') { print x }; print f($");
        var signature = info.Signatures.Single();

        Assert.AreEqual("f(x: long, y: string = 'a')", signature.Label);
        CollectionAssert.AreEqual(
            new[] { "x: long", "y: string = 'a'" },
            signature.Parameters.Select(p => signature.Label.Substring(p.LabelStart, p.LabelLength)).ToArray());
        CollectionAssert.AreEqual(new[] { "x", "y" }, signature.Parameters.Select(p => p.Name).ToArray());
    }

    [TestMethod]
    public void BuiltInFunction_OptionalParameterBracketedAndOffsetsMatchNames()
    {
        var info = GetHelp("print substring($");
        var signature = info.Signatures[info.ActiveSignature];

        Assert.AreEqual("substring(string: scalar, start: int | long, [length: int | long]): string", signature.Label);
        foreach (var parameter in signature.Parameters)
        {
            var text = signature.Label.Substring(parameter.LabelStart, parameter.LabelLength);
            StringAssert.StartsWith(text.TrimStart('['), parameter.Name + ":");
        }
        Assert.AreEqual("[length: int | long]", signature.Label.Substring(signature.Parameters[2].LabelStart, signature.Parameters[2].LabelLength));
    }

    [TestMethod]
    public void DatabaseFunction_DocumentationFromDocString()
    {
        var function = new Kusto.Language.Symbols.FunctionSymbol("MyFunc", "(x: long)", "{ print x }", "Adds things.");
        var globals = GlobalState.Default.WithDatabase(new Kusto.Language.Symbols.DatabaseSymbol("db", function));
        var (query, position) = ExtractPosition("MyFunc($");
        var code = KustoCode.ParseAndAnalyze(query, globals);

        var info = SignatureHelpFeatures.GetSignatureHelp(code, position, CancellationToken.None).Value;

        Assert.IsNotNull(info);
        Assert.AreEqual("MyFunc(x: long)", info.Signatures[0].Label);
        Assert.AreEqual("Adds things.", info.Signatures[0].Documentation);
    }

    [TestMethod]
    public void Overloads_ActiveSignatureIsTheBoundOne()
    {
        var info = GetHelp("print bin(now(), 1h$)");
        Assert.IsTrue(info.Signatures.Count > 1);
        Assert.AreEqual("bin(value: datetime, roundTo: timespan): datetime", info.Signatures[info.ActiveSignature].Label);
        Assert.AreEqual(1, info.ActiveParameter);
    }

    [TestMethod]
    public void OutsideAnyCall_ReturnsNone()
    {
        AssertNone("print x = 1$");
    }

    [TestMethod]
    public void AfterCloseParen_ReturnsNone()
    {
        AssertNone("print strcat(\"a\")$");
    }

    [TestMethod]
    public void BeforeOpenParen_ReturnsNone()
    {
        AssertNone("print strcat$(\"a\")");
    }

    [TestMethod]
    public void UnclosedCallFollowedByOtherText_ReturnsNone()
    {
        AssertNone("print strcat(\"a\"\n| extend y = 1$");
    }

    [TestMethod]
    public void UnknownFunction_ReturnsNone()
    {
        AssertNone("print nosuchfunction($");
    }

    [TestMethod]
    public void SectionedDocument_SectionCodeIsBlockRelative()
    {
        var (text, position) = ExtractPosition("print 1\n\nprint substring(\"abc\", $");
        var document = new SectionedDocument(new Uri("inmemory://sighelp"), text, GlobalState.Default);

        Assert.IsTrue(document.TryGetSectionCode(position, CancellationToken.None, out var code, out var sectionStart));
        Assert.AreEqual(text.IndexOf("print substring"), sectionStart);
        Assert.IsTrue(code.Text.StartsWith("print substring"));

        var info = SignatureHelpFeatures.GetSignatureHelp(code, position - sectionStart, CancellationToken.None).Value;
        Assert.IsNotNull(info);
        Assert.AreEqual(1, info.ActiveParameter);
    }

    [TestMethod]
    public void CancelledToken_Throws()
    {
        var (query, position) = ExtractPosition("print substring($");
        var code = KustoCode.ParseAndAnalyze(query, GlobalState.Default);
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        Assert.ThrowsExactly<OperationCanceledException>(() => SignatureHelpFeatures.GetSignatureHelp(code, position, cts.Token));
    }

    private static SignatureHelpInfo GetHelp(string queryWithCursor)
    {
        var result = Run(queryWithCursor);
        Assert.IsNull(result.Error, result.Error);
        Assert.IsNotNull(result.Value, "expected signature help");
        return result.Value;
    }

    private static void AssertNone(string queryWithCursor)
    {
        var result = Run(queryWithCursor);
        Assert.IsNull(result.Error, result.Error);
        Assert.IsNull(result.Value);
    }

    private static FeatureResult<SignatureHelpInfo> Run(string queryWithCursor)
    {
        var (query, position) = ExtractPosition(queryWithCursor);
        var code = KustoCode.ParseAndAnalyze(query, GlobalState.Default);
        return SignatureHelpFeatures.GetSignatureHelp(code, position, CancellationToken.None);
    }

    private static string NameOf(SignatureHelpInfo info)
    {
        var label = info.Signatures[info.ActiveSignature].Label;
        return label.Substring(0, label.IndexOf('('));
    }
}
