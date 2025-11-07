import * as vscode from 'vscode';
import { SchemaCache, ColumnMetadata } from '../metadata/schemaCache';
import { MssqlApi } from '../mssqlApi';
import { SqlParser } from '../util/sqlParser';
import { getLogger } from '../util/logger';

interface InsertCommandArgs {
  readonly schema?: string;
  readonly name?: string;
  readonly database?: string;
}

export function registerInsertGenerator(context: vscode.ExtensionContext, api: MssqlApi, schemaCache: SchemaCache): void {
  const logger = getLogger();
  let suppressDocumentChanges = false;

  const generateInsert = async (args?: InsertCommandArgs): Promise<boolean> => {
    try {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'sql') {
        return false;
      }

      const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
      status.text = '$(loading~spin) PX SQL Tools: Generating INSERT statement…';
      status.show();

      try {
        console.log('[pxSqlTools][insertGenerator] Ensuring connection with prompt=false');
        const connection = await api.ensureConnection({ prompt: false });
        console.log('[pxSqlTools][insertGenerator] Connection result:', connection);
        if (!connection) {
          void vscode.window.showWarningMessage('Connect to a database before generating an INSERT statement.');
          return false;
        }

        let targetSchema = args?.schema;
        let targetName = args?.name;
        let targetDatabase = args?.database ?? connection.database;
        console.log('[pxSqlTools][insertGenerator] Initial target args:', args);

        if (!targetName) {
          const identifier = SqlParser.getIdentifierAtPosition(editor.document, editor.selection.active);
          console.log('[pxSqlTools][insertGenerator] Identifier at cursor:', identifier?.text, identifier?.range);
          if (identifier) {
            const qualified = SqlParser.parseQualifiedIdentifier(identifier.text);
            console.log('[pxSqlTools][insertGenerator] Parsed identifier:', qualified);
            targetName = qualified.object;
            targetSchema = targetSchema ?? qualified.schema;
            targetDatabase = targetDatabase ?? qualified.database ?? connection.database;
          }
        }

        if (!targetName) {
          void vscode.window.showInformationMessage('Unable to determine the table name for INSERT generation.');
          return false;
        }

        const schemaName = targetSchema ?? 'dbo';
        console.log('[pxSqlTools][insertGenerator] Using target:', { schemaName, targetName, targetDatabase });

        const table = await schemaCache.getTable(connection, schemaName, targetName, undefined, { database: targetDatabase });
        console.log('[pxSqlTools][insertGenerator] Table metadata found:', Boolean(table));
        if (!table || !table.columns) {
          void vscode.window.showWarningMessage(`Column metadata not found for ${schemaName}.${targetName}.`);
          return false;
        }

        const insertableColumns = table.columns.filter((column) => !column.isIdentity && !column.isComputed && !column.isRowGuid);
        console.log('[pxSqlTools][insertGenerator] Insertable column count:', insertableColumns.length);
        if (insertableColumns.length === 0) {
          void vscode.window.showWarningMessage(
            `No insertable columns were found for ${schemaName}.${targetName}. All columns are identity, computed, or rowguid.`
          );
          return false;
        }

        const snippet = buildInsertSnippet(insertableColumns);

        suppressDocumentChanges = true;
        try {
          const inserted = await editor.insertSnippet(snippet, editor.selection.active);
          if (!inserted) {
            logger.warn('Failed to insert INSERT statement snippet.');
          }
          return inserted;
        } finally {
          suppressDocumentChanges = false;
        }
      } finally {
        status.dispose();
      }
    } catch (error) {
      logger.error('Failed to generate INSERT statement.', error);
      void vscode.window.showErrorMessage('PX SQL Tools was unable to generate the INSERT statement. Check the logs for details.');
      suppressDocumentChanges = false;
      return false;
    }
  };

  const disposable = vscode.commands.registerCommand('pxSqlTools.generateInsertStatement', async (args?: InsertCommandArgs) => {
    if (suppressDocumentChanges) {
      return;
    }
    await generateInsert(args);
  });

  const changeListener = vscode.workspace.onDidChangeTextDocument(async (event) => {
    if (suppressDocumentChanges) {
      return;
    }

    if (event.document.languageId !== 'sql') {
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== event.document) {
      return;
    }

    for (const change of event.contentChanges) {
      if (!change.text.includes('\n') || change.rangeLength !== 0) {
        continue;
      }

      const lineIndex = change.range.start.line;
      if (lineIndex < 0 || lineIndex >= event.document.lineCount) {
        continue;
      }

      const lineText = event.document.lineAt(lineIndex).text.trim();
      const match = /^insert\s+into\s+(.+?)$/i.exec(lineText);
      if (!match) {
        continue;
      }

      const identifierText = match[1].replace(/--.*$/, '').trim().replace(/[;,]+$/, '');
      if (!identifierText || identifierText.includes('(')) {
        continue;
      }

      const identifierPattern = /^(\[(?:[^\]]|\]\])+\]|[A-Za-z_][\w$@#]*)(\s*\.\s*(\[(?:[^\]]|\]\])+\]|[A-Za-z_][\w$@#]*)){0,2}\s*$/;
      if (!identifierPattern.test(identifierText)) {
        continue;
      }

      const qualified = SqlParser.parseQualifiedIdentifier(identifierText);
      if (!qualified.object) {
        continue;
      }

      await generateInsert({ schema: qualified.schema, name: qualified.object, database: qualified.database });
      break;
    }
  });

  context.subscriptions.push(disposable, changeListener);
}

function buildInsertSnippet(columns: ColumnMetadata[]): vscode.SnippetString {
  const snippet = new vscode.SnippetString();
  const indent = '    ';

  snippet.appendText('\n(');
  columns.forEach((column, index) => {
    snippet.appendText(`\n${indent}${wrapIdentifier(column.name)}`);
    if (index < columns.length - 1) {
      snippet.appendText(',');
    }
  });

  snippet.appendText('\n)\nVALUES\n(');

  let placeholderIndex = 1;
  columns.forEach((column, index) => {
    snippet.appendText(`\n${indent}`);
    if (column.defaultExpression) {
      snippet.appendText('DEFAULT');
    } else {
      snippet.appendPlaceholder(`@${column.name}`, placeholderIndex++);
    }
    if (index < columns.length - 1) {
      snippet.appendText(',');
    }
  });

  snippet.appendText('\n);\n');
  return snippet;
}

function wrapIdentifier(identifier: string): string {
  if (/^[A-Za-z_][\w]*$/.test(identifier)) {
    return identifier;
  }
  return `[${identifier.replace(/]/g, ']]')}]`;
}
