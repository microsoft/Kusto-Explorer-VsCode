// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using System.Collections.Immutable;

using Kusto.Language;
using Kusto.Vscode;

namespace Tests.Utilities;

[TestClass]
public class DocumentSymbolFeaturesTests
{
    [TestMethod]
    public void LetStatements_ScalarTabularAndOther()
    {
        var symbols = GetSymbols("let a = 1; let t = datatable(x: long)[1]; let db = database('x'); t");

        AssertShapes(symbols,
            ("a", DocumentSymbolKind.ScalarVariable, "long"),
            ("t", DocumentSymbolKind.TabularVariable, "table"),
            ("db", DocumentSymbolKind.Variable, "database"));
    }

    [TestMethod]
    public void LetFunctionAndView_DetailIsParameterList()
    {
        var symbols = GetSymbols("let f = (x: long, y: string = 'a') { print x }; let v = view () { print 1 }; print 1");

        AssertShapes(symbols,
            ("f", DocumentSymbolKind.Function, "(x: long, y: string = 'a')"),
            ("v", DocumentSymbolKind.View, "()"));
    }

    [TestMethod]
    public void LetInsideFunctionBody_IsChildOfFunction()
    {
        var symbols = GetSymbols("let f = () { let inner = 1; print inner }; let outer = 2; print outer");

        AssertShapes(symbols,
            ("f", DocumentSymbolKind.Function, "()"),
            ("outer", DocumentSymbolKind.ScalarVariable, "long"));
        AssertShapes(symbols[0].Children, ("inner", DocumentSymbolKind.ScalarVariable, "long"));
    }

    [TestMethod]
    public void PatternAndQueryParameters()
    {
        var symbols = GetSymbols("declare pattern p; declare query_parameters(qp: string = 'a', n: long); print 1");

        AssertShapes(symbols,
            ("p", DocumentSymbolKind.Pattern, null),
            ("qp", DocumentSymbolKind.QueryParameter, "string"),
            ("n", DocumentSymbolKind.QueryParameter, "long"));
    }

    [TestMethod]
    public void Ranges_SpanStatementAndName()
    {
        var text = "print 0;\nlet abc = 1; print abc";
        var symbol = GetSymbols(text).Single();

        Assert.AreEqual("let abc = 1", text.Substring(symbol.Start, symbol.Length));
        Assert.AreEqual("abc", text.Substring(symbol.NameStart, symbol.NameLength));
    }

    [TestMethod]
    public void QuotedName_IsUnescaped()
    {
        var symbol = GetSymbols("let ['my name'] = 1; print 1").Single();
        Assert.AreEqual("my name", symbol.Name);
    }

    [TestMethod]
    public void CreateTableCommand()
    {
        AssertShapes(GetSymbols(".create table T (a: int, b: string)"), ("T", DocumentSymbolKind.Table, null));
    }

    [TestMethod]
    public void AlterMergeTableCommand_UsesReferencedName()
    {
        AssertShapes(GetSymbols(".alter-merge table T (a: int)"), ("T", DocumentSymbolKind.Table, null));
    }

    [TestMethod]
    public void CreateOrAlterFunctionCommand_SkipsWithPropertiesAndHasBodyChildren()
    {
        var symbols = GetSymbols(".create-or-alter function with (docstring='x', folder='y') F(x: long) { let z = x; print z }");

        AssertShapes(symbols, ("F", DocumentSymbolKind.Function, "(x: long)"));
        AssertShapes(symbols[0].Children, ("z", DocumentSymbolKind.ScalarVariable, "long"));
    }

    [TestMethod]
    public void AlterFunctionCommand()
    {
        AssertShapes(GetSymbols(".alter function F() { print 1 }"), ("F", DocumentSymbolKind.Function, "()"));
    }

    [TestMethod]
    public void CreateMaterializedViewCommand()
    {
        AssertShapes(
            GetSymbols(".create-or-alter materialized-view with (backfill=true) MV on table T { T | summarize count() by a }"),
            ("MV", DocumentSymbolKind.MaterializedView, null));
    }

    [TestMethod]
    public void NonDeclaringCommandsAndQueries_HaveNoSymbols()
    {
        Assert.AreEqual(0, GetSymbols(".show tables").Count);
        Assert.AreEqual(0, GetSymbols(".drop table T").Count);
        Assert.AreEqual(0, GetSymbols("print x = 1").Count);
        Assert.AreEqual(0, GetSymbols("").Count);
    }

    [TestMethod]
    public void IncompleteLet_SkipsMissingName()
    {
        var symbols = GetSymbols("let = 5; let b = 1; print b");
        Assert.IsFalse(symbols.Any(s => string.IsNullOrEmpty(s.Name)));
    }

    [TestMethod]
    public void SectionedDocument_SymbolsPerSectionAreBlockRelative()
    {
        var text = "let a = 1; print a\n\nlet b = 2; print b";
        var document = new SectionedDocument(new Uri("inmemory://docsym"), text, GlobalState.Default);

        var found = new List<(string Name, string Text)>();
        foreach (var section in document.GetSectionRanges())
        {
            Assert.IsTrue(document.TryGetSectionCode(section.Start, CancellationToken.None, out var code, out var sectionStart));
            foreach (var symbol in DocumentSymbolFeatures.GetDocumentSymbols(code, CancellationToken.None).Value!)
                found.Add((symbol.Name, text.Substring(sectionStart + symbol.NameStart, symbol.NameLength)));
        }

        CollectionAssert.AreEqual(new[] { ("a", "a"), ("b", "b") }, found);
    }

    [TestMethod]
    public void CancelledToken_Throws()
    {
        var code = KustoCode.ParseAndAnalyze("let a = 1; print a", GlobalState.Default);
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        Assert.ThrowsExactly<OperationCanceledException>(() => DocumentSymbolFeatures.GetDocumentSymbols(code, cts.Token));
    }

    private static ImmutableList<DocumentSymbolInfo> GetSymbols(string text)
    {
        var code = KustoCode.ParseAndAnalyze(text, GlobalState.Default);
        var result = DocumentSymbolFeatures.GetDocumentSymbols(code, CancellationToken.None);
        Assert.IsNull(result.Error, result.Error);
        Assert.IsNotNull(result.Value);
        return result.Value;
    }

    private static void AssertShapes(IReadOnlyList<DocumentSymbolInfo> actual, params (string Name, DocumentSymbolKind Kind, string? Detail)[] expected)
    {
        CollectionAssert.AreEqual(
            expected,
            actual.Select(s => (s.Name, s.Kind, s.Detail)).ToArray(),
            "actual: " + string.Join("; ", actual.Select(s => $"{s.Name}/{s.Kind}/{s.Detail}")));
    }
}
