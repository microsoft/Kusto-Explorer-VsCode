# Copilot / AI agent instructions for the Kusto Explorer VS Code repo

These instructions guide AI coding agents (and the developers driving them) when working **on this
codebase**. They are not the end-user KQL assistant prompt — that lives in
[`src/Client/instructions.md`](../src/Client/instructions.md) and is shipped to users at runtime. Keep
the two separate.

For the full "why" behind everything below, read [`ARCHITECTURE.md`](../ARCHITECTURE.md). When a change
contradicts these rules, prefer the architecture doc and update both.

## What this project is

A VS Code extension that mimics the desktop **Kusto Explorer** app: edit multi-query `.kql` files, run
queries, and view results as tables and charts. Scope is intentionally **partial**; the roadmap is
driven by community feedback, not a fixed plan. Don't invent features — match how the desktop app feels
and prefer small, focused changes.

## Architecture rules an agent must respect

- **Two processes, on purpose.** A TypeScript extension host (`src/Client`) talks to a C# .NET
  language server (`src/Server`) over LSP (StreamJsonRpc on stdio) plus custom `kusto/*` JSON-RPC
  methods. KQL parsing/analysis lives in the **C# server** because the native `Kusto.Language` parser
  is ~50x faster than the JS translation. **Do not** reimplement KQL parsing/analysis in TypeScript,
  and add cross-process calls through the existing LSP / `kusto/*` seam — not new side channels.
- **Data model vs. UI component split.** Each feature is usually two modules: a testable
  `*Manager`-style **data model** (state + logic, no VS Code UI) and a `*Panel` / `*Editor` / `*Provider`
  **UI component**. Put new logic where it can be unit-tested without a webview. A filename like
  `panel`, `editor`, `viewer`, or `statusBar` means it's the UI half.
- **Provider model for result content.** The results editor delegates visually distinct content
  (tabular, chart, query text) to providers that each emit HTML into their own `<div>`. Charts sit
  behind a single `IChartProvider` seam with multiple implementations (`plotly`, `timePivot`, `graph`)
  joined by `compositeChartProvider`. Add new result/chart surfaces behind this seam — don't bolt them
  onto the editor.
- **Webview house style.** Webview UIs build an HTML **string** with inline `<script>`, use
  `acquireVsCodeApi()` + document-level click delegation, and post messages back to the extension.
  There is **no React/bundler** for webview content; CDN libraries (Plotly, Cytoscape, simple-datatables)
  are loaded directly. Match this pattern; don't introduce a webview framework.
- **Interface-first seams.** `IServer`, `IConnection`, `ISchemaSource`, `IChartProvider`,
  `IDataTableProvider`, etc. exist so implementations can be swapped or stubbed. Preserve them and
  provide Null/test variants for new seams.
- **Schema is cached at two levels.** In-memory (session) in `SchemaManager` plus VS Code storage
  (cross-session, via the `kusto/getData`/`kusto/setData` → `globalState` bridge) so startup is usable
  immediately, with background reconciliation updating both copies. Don't bypass this cache.

## Build, run, and test

Client commands run from `src/Client`:

- Build the extension: `npm run compile`
- Type-check: `npm run type-check`
- Lint (zero warnings): `npm run lint`
- Unit tests (vitest): `npm test` (or `npm run test:unit`)
- Integration tests: `npm run test:integration`
- Build the debug server: `npm run build-debug-server` (release: `build-release-server`)
- `F5` builds the client + debug server and launches the Extension Development Host.

Server commands run from `src/Server` (build) and `ServerTests` (tests):

- Build the server: `dotnet build`
- Run server tests: `dotnet test` from the `ServerTests` project.

Always run the relevant tests and ensure the build passes before considering a change done.

## Working style

- Read [`ARCHITECTURE.md`](../ARCHITECTURE.md) before structural changes; keep it in sync when you
  change components, seams, or conventions.
- Keep changes minimal and focused; don't refactor or add abstractions that weren't asked for.
- Prefer editing existing modules over adding new ones, and keep logic in the testable data-model half.
- Validate your own work with the build + tests above rather than assuming success.
