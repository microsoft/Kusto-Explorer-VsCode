# Kusto Explorer for VS Code

[![VS Marketplace](https://img.shields.io/badge/VS%20Marketplace-Kusto%20Explorer-blue?logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=ms-kusto.kusto-explorer-vscode)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Edit, run, and chart Kusto queries (KQL) right from VS Code. Explore databases and results, and use Copilot to help author and diagnose your queries. Works on Windows, macOS, and Linux.

## Features

- **Query editor** — IntelliSense, formatting, go-to-definition, find references, code actions and quick fixes
- **Results panel** — browse tabular results, copy cells, drag-and-drop as `datatable` expressions
- **Charts** — create and customize charts from query results; copy as image or save as `.kqr` files
- **Database explorer** — browse clusters, databases, tables, functions and more
- **Copilot integration** — ask Copilot to help create, run and diagnose your queries
- **Scratch pads** — jot down queries without creating files
- **Query history** — revisit previously executed queries and results

## Install

**[Install from the VS Code Marketplace →](https://marketplace.visualstudio.com/items?itemName=ms-kusto.kusto-explorer-vscode)**

Or search for **"Kusto Explorer"** in the VS Code Extensions view (`Ctrl+Shift+X`).

Alternatively, download the `.vsix` from [GitHub Releases](https://github.com/microsoft/Kusto-Explorer-VsCode/releases) and install manually:

```sh
code --install-extension <vsix-file>
```

## Getting Started

For a full walkthrough of the extension's features, see the [User Guide](src/Client/README.md).

1. Select the **Kusto Explorer** icon in the VS Code Activity Bar
2. Use an existing scratch pad (already open) or create a `.kql` file
3. Connect the query document to a Kusto cluster and database (while the document has focus):
   - Add a cluster connection in the **Connections** sidebar (if it doesn't exist yet)
   - Select a database to set the active cluster and database for the focused document
4. Write a Kusto query (or ask Copilot for help)
5. Press **F5** to execute the query and view results in the Results panel
6. Use the chart button to visualize your results — customize chart type, axes, legend, and more
7. Revisit prior queries and results in the **History** sidebar

----

## Contributing

This project welcomes contributions and suggestions. For development setup, debugging, and build instructions, see [CONTRIBUTING.md](CONTRIBUTING.md).

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Security

If you believe you have found a security vulnerability in this repository, please report it to us through coordinated disclosure.

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report them to the Microsoft Security Response Center (MSRC) at [https://msrc.microsoft.com/create-report](https://msrc.microsoft.com/create-report).

For more information, see [SECURITY.md](SECURITY.md) or visit [Microsoft's Security Policy](https://github.com/microsoft/Kusto-Explorer-VsCode/security/policy).

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft 
trademarks or logos is subject to and must follow 
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos are subject to those third-party's policies.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

