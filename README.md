# PX SQL Tools

PX SQL Tools brings Redgate-inspired productivity features directly into Visual Studio Code. It layers intelligent completions, metadata-rich hovers, wildcard expansion, snippets, history, and scripting utilities on top of the official MSSQL extension—no external tools required.

## Prerequisites

- **VS Code 1.85.0+**
- **[MSSQL extension](https://marketplace.visualstudio.com/items?itemName=ms-mssql.mssql)** installed and connected to a SQL Server instance. PX SQL Tools reuses its active connection for every feature.

## Feature Highlights

- **Schema-aware completions** – Suggest schemas, tables, views, columns, stored procedures, and functions from the active database. After typing `FROM`, tables surface; after `alias.`, only relevant columns appear. Optional JOIN hints draw from foreign key metadata.
- **Parameter hints & hovers** – Hover any identifier to view column data types, extended descriptions, or summarized routine definitions and signatures.
- **Expand wildcard** – Command palette entry and `Ctrl+Alt+W` (`Cmd+Alt+W` on macOS) replace `*` with a formatted column list, optionally filtered through a Quick Pick.
- **Snippets** – Built-in patterns (`ssf`, `ii`, `ue`, `ct`) accelerate SELECT, INSERT, UPDATE, and CREATE TABLE boilerplate. Add custom snippets via configuration or the global storage file.
- **SQL history & recovery** – Every executed query is logged with timestamp and connection details. Browse, search, favorite, reopen, copy, or delete items from the SQL History view. Optionally restore unsaved editors on startup.
- **Script objects** – Script objects under the cursor as `ALTER` or `CREATE` statements in fresh untitled editors. Works for procedures, functions, and views via `OBJECT_DEFINITION`.

## Commands

| Command | Description |
| --- | --- |
| `pxSqlTools.expandWildcard` | Expand `SELECT *` into an explicit column list. |
| `pxSqlTools.scriptAsAlter` | Script the object beneath the caret as `ALTER`. |
| `pxSqlTools.scriptAsCreate` | Script the object beneath the caret as `CREATE`. |
| `pxSqlTools.openHistory` | Focus the PX SQL Tools activity view and show history. |
| `pxSqlTools.reopenFromHistory` | Open the highlighted history entry in a new editor. |
| `pxSqlTools.toggleFavoriteHistory` | Star or unstar a history entry. |
| `pxSqlTools.copyHistory` | Copy the selected history query to the clipboard. |
| `pxSqlTools.deleteHistory` | Remove the selected history entry. |
| `pxSqlTools.clearHistory` | Remove all history entries after confirmation. |
| `pxSqlTools.history.search` | Prompt for filter text applied to the SQL history view. |

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `pxSqlTools.history.maxItems` | `1000` | Cap the number of history entries retained. |
| `pxSqlTools.history.restoreOnStartup` | `true` | Reopen unsaved SQL buffers logged on shutdown. |
| `pxSqlTools.snippets.customFile` | `""` | Absolute path to a JSON file describing additional snippets. Leave blank to use the auto-managed file in extension storage. |
| `pxSqlTools.completion.enableJoinHints` | `false` | Offer JOIN snippets inferred from foreign keys. |
| `pxSqlTools.expandWildcard.quickPick` | `false` | Ask which columns to insert when expanding wildcards (recommended for wide tables). |

### Custom Snippets Format

Point `pxSqlTools.snippets.customFile` to a JSON object shaped like the VS Code snippet schema:

```json
{
	"SelectTopCustomers": {
		"body": "SELECT TOP (10) * FROM Sales.Customers;",
		"description": "List top 10 customers"
	}
}
```

If you omit the setting, PX SQL Tools creates `custom-snippets.json` under the extension’s global storage folder. Populate it with the same structure.

## Usage Tips

- Activate the extension by opening a `.sql` document connected through the MSSQL extension.
- Use the SQL History tree view (Activity Bar → PX SQL Tools) to browse, search, and manage previously executed statements. Favorites surface in a dedicated group.
- Unsaved SQL editors closed during the last session are restored automatically when `restoreOnStartup` is enabled.
- Script commands rely on `OBJECT_DEFINITION`. Ensure the executing account has sufficient permissions to inspect metadata.

## Development

- Install dependencies: `npm install`
- Compile the extension: `npm run compile`
- Launch the extension host (F5) and choose “PX SQL Tools” when prompted.

## Release Notes

### 0.1.0

- Initial release with intelligent completions, hovers, wildcard expansion, history view, scripting commands, and snippet enhancements.
