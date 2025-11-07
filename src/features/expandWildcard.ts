import * as vscode from 'vscode';
import { SchemaCache } from '../metadata/schemaCache';
import { MssqlApi } from '../mssqlApi';
import { SqlParser } from '../util/sqlParser';

const COLUMN_PICK_THRESHOLD = 12;

export function registerExpandWildcardCommand(context: vscode.ExtensionContext, schemaCache: SchemaCache, api: MssqlApi): void {
  const disposable = vscode.commands.registerCommand('sqlToolbelt.expandWildcard', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'sql') {
      vscode.window.showInformationMessage('Place the cursor on a wildcard in a SQL file to expand it.');
      return;
    }

    const connection = await api.ensureConnection({ prompt: false });
    if (!connection) {
      vscode.window.showWarningMessage('Connect this file to a database before expanding wildcards.');
      return;
    }

    const wildcard = SqlParser.findWildcardContext(editor.document, editor.selection.active);
    if (!wildcard) {
      vscode.window.showInformationMessage('No wildcard detected at the current cursor position.');
      return;
    }

    const table = await schemaCache.getTable(connection, wildcard.target.schema ?? 'dbo', wildcard.target.object);
    if (!table?.columns || table.columns.length === 0) {
      vscode.window.showWarningMessage(`No column metadata found for ${wildcard.target.object}.`);
      return;
    }

    let columns = table.columns;
    const useQuickPick = vscode.workspace.getConfiguration('sqlToolbelt').get<boolean>('expandWildcard.quickPick');

    if (useQuickPick && columns.length >= COLUMN_PICK_THRESHOLD) {
      const picked = await vscode.window.showQuickPick(
        columns.map((column) => ({ label: column.name, picked: true })),
        {
          canPickMany: true,
          placeHolder: 'Select columns to include in the expansion'
        }
      );

      if (!picked) {
        return;
      }

      const selectedNames = new Set(picked.map((item) => item.label));
      columns = columns.filter((column) => selectedNames.has(column.name));
    }

    const qualifier = wildcard.target.alias ?? '';
    const indent = ' '.repeat(wildcard.asteriskRange.start.character);
    const formattedColumns = columns.map((column) =>
      qualifier ? `${qualifier}.[${column.name}]` : `[${column.name}]`
    );
    const columnText = formattedColumns
      .map((text, index) => (index === 0 ? text : `${indent}${text}`))
      .join(',\n');

    await editor.edit((editBuilder) => {
      editBuilder.replace(wildcard.asteriskRange, columnText);
    });
  });

  context.subscriptions.push(disposable);
}
