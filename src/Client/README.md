# Kusto Explorer (VS Code Extension)

Edit, run, and chart Kusto queries (KQL) right from VS Code. Explore databases and results, and use Copilot to help author and diagnose your queries. Works on Windows, macOS, and Linux.

## Get Started

1. Select the **Kusto Explorer** icon in the VS Code Activity Bar
2. Use an existing scratch pad (already open) or create a `.kql` file
3. Connect the query document to a Kusto cluster and database (while the document has focus):
   - Add a cluster connection in the **Connections** sidebar (if it doesn't exist yet)
   - Select a database to set the active cluster and database for the focused document
4. Write a Kusto query (or ask Copilot for help)
5. Press **F5** to execute the query and view results in the Results panel
6. Use the chart button to visualize your results — customize chart type, axes, legend, and more
7. Revisit prior queries and results in the **History** sidebar

## Features

### Query Editor

- Edit queries like a source code document
- Multiple independent queries in a single document, separated by a blank line
- IntelliSense (auto-completions, hover tips)
- Formatting (pretty printing)
- Go-to-definition and find-all-references for tables, functions, columns, and more
- Code actions and quick fixes for common issues and refactorings
- Copy colorized query text to the clipboard for pasting into other documents

### Connections (sidebar)

- Maintain a list of Kusto clusters you connect to
- Select a cluster and database to set the defaults for your active query document
- Explore database entities — tables, functions, materialized views, and more

### Scratch Pads (sidebar)

- Scratch pad documents for jotting down queries without creating and naming a file

### History (sidebar)

- Browse previously executed queries and their results
- Re-open past results without re-running the query

### Results Panel (bottom panel)

- Copy cell contents or entire tables to the clipboard
- Drag and drop a table into your document as a KQL `datatable` expression
- Add or edit a chart to visualize your results
- Save data as a `.kqr` file (Kusto Query Results) to share with others

### Charts (document tab)

- Create and customize charts — choose chart type, axes, legend, and more
- Copy the chart as an image (light-mode or dark-mode) to the clipboard
- Save chart and data together as a `.kqr` file

### Results Viewer (document tab)

- Open saved `.kqr` files — chart, data, and query in a single view
- Add or edit charts, copy data, and export images just like the Results panel

### Copilot Integration

- Ask Copilot to help write, run, and diagnose your Kusto queries

## Requirements

- VS Code 1.90.0 or higher

## Links

- [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ms-kusto.kusto-explorer-vscode) — install the extension
- [GitHub Repository](https://github.com/microsoft/Kusto-Explorer-VsCode) — source code, issues, and contributions
- [KQL Reference](https://learn.microsoft.com/en-us/kusto/query/) — Kusto Query Language documentation