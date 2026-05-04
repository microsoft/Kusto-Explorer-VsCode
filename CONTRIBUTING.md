# Contributing to Kusto Explorer (VS Code Extension)

This project welcomes contributions and suggestions. Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit https://cla.opensource.microsoft.com.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide
a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions
provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## How to Contribute

This repository accepts pull requests, but not every type of change should start as a pull request.

### Changes That Usually Do Not Need Prior Approval

Small, scoped pull requests are generally welcome without prior discussion when they:

- Fix a clear bug
- Correct typos, broken links, or other documentation issues
- Add or improve tests for existing behavior
- Make low-risk maintenance changes that do not change product direction, architecture, or user experience

These changes should still be focused, easy to review, and aligned with the existing codebase.

### Changes That Require Prior Approval

Please do not open a pull request first for changes such as:

- New features or user-visible capabilities
- Large refactors or architectural changes
- Changes to public behavior, workflows, or UI patterns
- Significant dependency changes
- Broad performance, telemetry, or security-related changes that affect product direction

These kinds of changes need review and guidance from the Microsoft team responsible for the product roadmap and design direction.

### Proposal First for Larger Changes

If you want to propose a new feature or substantial change, start a GitHub Discussion in the `Ideas` category instead of opening a pull request immediately.

Your proposal should briefly cover:

- The problem you are trying to solve
- Why the current behavior is insufficient
- The user impact and expected benefit
- A rough implementation approach, if relevant
- Alternatives you considered

When you believe the discussion is ready for formal consideration, add the `design review` label. That label means a design review is requested. It does not mean the proposal has been approved.

The team may:

- Approve the proposal
- Decline the proposal
- Request changes to the scope or design
- Meet with the author to refine the design
- Decide to implement it internally
- Mark it as open for a community contribution

When a design is under review a corresponding issue will be opened for it that will track the proposal's progress. 
The issue may also revise the proposal or add detail for implementation.

Only after that process has resulted in an "open for contribution" status, should a pull request be opened.

### Pull Request Process

1. Fork the repository.
2. If the change is more than a small bug fix or documentation update, open a GitHub Discussion in `Ideas` first and wait for guidance.
3. If you are proposing a larger change, use the `design review` label when you are requesting formal design consideration.
4. If the design is accepted, wait for a member of the Microsoft design team to create the corresponding GitHub Issue for implementation tracking.
5. Create a branch for the approved or clearly scoped change.
6. Make the smallest change that fully addresses the issue.
7. Run relevant tests and ensure the build passes.
8. Update documentation when behavior or workflows change.
9. Submit a pull request with a clear description of the problem, approach, and validation.

If a pull request arrives without prior discussion for a change that needs design or roadmap approval, it may be closed and redirected to Discussions.

## Repository Structure

| Path | Description |
|------|-------------|
| `KustoExplorerVscode.slnx` | Visual Studio solution for the entire extension |
| `src/Client` | TypeScript VS Code extension (UI, LSP client, extension features) |
| `src/Server` | C# LSP server (Kusto parser integration, code services) |
| `src/ServerTests` | C# tests for the server |

### Client

The Client is written in TypeScript and contains the VS Code extension code, including the UI components, LSP client and other extension features that are not dependent on the Kusto parser library.

### Server

The Server is written in C# to interact with the .NET version of the Kusto parser library for better typing performance. It primarily contains LSP handlers and redirects requests to the parser library's code services.

## Development Setup

### Prerequisites

- [.NET 10 SDK](https://dotnet.microsoft.com/download)
- [Node.js](https://nodejs.org/) (LTS version recommended)
- [Visual Studio Code](https://code.visualstudio.com/)

### Building the Language Server

```bash
cd src/Server
dotnet build
```

### Building the VS Code Extension

```bash
cd src/Client
npm install
npm run compile
```

### Running Locally

1. Open the repository in VS Code
2. Press `F5` to launch the Extension Development Host
3. Open a `.kql` file to activate the extension

## Debugging

### Debugging the Client

1. Open the `src/Client` folder in VS Code
2. Build the client using the `compile` task in the **NPM SCRIPTS** explorer panel
3. Build the server using `build-debug-server` in the same panel
4. Press **F5** to launch the Extension Development Host with debugging enabled

### Debugging the Server

1. Launch the extension in debug mode (above) — the server starts automatically
2. Attach to the server process:
   - **Visual Studio** — open `KustoExplorerVscode.slnx` and attach to the `dotnet.exe` process for the extension
   - **VS Code** — from the repo root, run `Debug: Attach to a .NET 5+ or .NET Core process` (`Ctrl+Shift+P`) and select the `Server` process

## Packaging

```bash
# Requires vsce: npm install -g @vscode/vsce
cd src/Client
npm run package
```

This will create a `.vsix` file that can be installed in VS Code.

### Manual Install / Uninstall

```bash
code --install-extension <vsix-file> [--force]
code --uninstall-extension ms-kusto.kusto-explorer-vscode
```

## Reporting Issues

Please use [GitHub Issues](https://github.com/microsoft/Kusto-Explorer-VsCode/issues) to report bugs or request features.

When reporting a bug, please include:
- VS Code version
- Extension version
- Steps to reproduce
- Expected vs actual behavior
- Any relevant error messages from the Output panel (Kusto channel)

## Pull Request Guidelines

- Keep changes focused and atomic
- Follow existing code style and conventions
- Update documentation if needed
- Ensure the build passes before submitting
- Link the relevant GitHub Discussion when prior approval was required
