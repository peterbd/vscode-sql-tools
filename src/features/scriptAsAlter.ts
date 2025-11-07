import * as vscode from 'vscode';
import { MssqlApi } from '../mssqlApi';
import { SqlParser } from '../util/sqlParser';
import { routineDefinitionQuery } from '../metadata/queries';
import { SchemaCache } from '../metadata/schemaCache';

export function registerScriptCommands(context: vscode.ExtensionContext, api: MssqlApi, schemaCache?: SchemaCache): void {
  const alter = vscode.commands.registerCommand('pxSqlTools.scriptAsAlter', () => scriptObject('alter', api, schemaCache));
  const create = vscode.commands.registerCommand('pxSqlTools.scriptAsCreate', () => scriptObject('create', api, schemaCache));

  context.subscriptions.push(alter, create);
}

async function scriptObject(mode: 'alter' | 'create', api: MssqlApi, schemaCache?: SchemaCache): Promise<void> {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  status.text = mode === 'alter' ? '$(loading~spin) PX SQL Tools: Generating ALTER script…' : '$(loading~spin) PX SQL Tools: Generating CREATE script…';
  status.show();

  try {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'sql') {
      vscode.window.showInformationMessage('Place the cursor on a SQL object name to script it.');
      return;
    }

    console.log('[pxSqlTools][scriptAsAlter] Ensuring connection with prompt=false');
    const connection = await api.ensureConnection({ prompt: false });
    console.log('[pxSqlTools][scriptAsAlter] Connection result:', connection);
    if (!connection) {
      vscode.window.showWarningMessage('Connect this file to a database before scripting objects.');
      return;
    }

    const identifier = SqlParser.getIdentifierAtPosition(editor.document, editor.selection.active);
    console.log('[pxSqlTools][scriptAsAlter] Identifier at cursor:', identifier?.text, identifier?.range);
    if (!identifier) {
      vscode.window.showInformationMessage('No SQL object detected under the cursor.');
      return;
    }

    const qualified = SqlParser.parseQualifiedIdentifier(identifier.text);
    console.log('[pxSqlTools][scriptAsAlter] Parsed identifier:', qualified);
    if (!qualified.object) {
      vscode.window.showWarningMessage('Unable to determine object name to script.');
      return;
    }

    const schema = qualified.schema ?? 'dbo';
    const objectName = qualified.object;
    const database = qualified.database ?? connection.database;
    console.log('[pxSqlTools][scriptAsAlter] Using target:', { schema, objectName, database });

    let definition = await api.runScalar<string>(
      routineDefinitionQuery(schema, objectName, database),
      { useLegacyFallback: false }
    );
    console.log('[pxSqlTools][scriptAsAlter] Definition fetched via direct query:', Boolean(definition));
    if (!definition && schemaCache && !qualified.database) {
      const routine = await schemaCache.getRoutine(connection, schema, objectName);
      console.log('[pxSqlTools][scriptAsAlter] Fallback routine metadata found:', Boolean(routine));
      definition = routine?.definition;
    }
    if (!definition) {
      const schemaPart = schema ?? 'dbo';
      const prefix = database ? `${database}.` : '';
      vscode.window.showWarningMessage(`Definition not found for ${prefix}${schemaPart}.${objectName}.`);
      return;
    }

    const content = mode === 'alter' ? convertToAlter(definition) : definition;
    const replaced =
      mode === 'alter'
        ? await tryReplaceInline(statementRange(editor.document, identifier.range), content, editor)
        : false;
    if (!replaced) {
      const document = await vscode.workspace.openTextDocument({ content, language: 'sql' });
      await vscode.window.showTextDocument(document, { preview: false });
    }
  } finally {
    status.dispose();
  }
}

function convertToAlter(definition: string): string {
  const regex = /^\s*create\s+(view|procedure|proc|function)/i;
  if (!regex.test(definition)) {
    return definition;
  }

  return definition.replace(regex, (_match, objectType: string) => `ALTER ${normalizeObjectType(objectType)}`);
}

async function tryReplaceInline(range: vscode.Range | undefined, content: string, editor: vscode.TextEditor): Promise<boolean> {
  if (!range) {
    return false;
  }

  const result = await editor.edit((editBuilder) => {
    editBuilder.replace(range, content.trimStart());
  });
  return result;
}

function statementRange(document: vscode.TextDocument, identifierRange: vscode.Range): vscode.Range | undefined {
  const line = document.lineAt(identifierRange.start.line);
  const beforeIdentifier = line.text.substring(0, identifierRange.start.character);
  const match = /alter\s+(procedure|proc|function|view)\s*$/i.exec(beforeIdentifier);
  if (!match) {
    return undefined;
  }

  const startCharacter = match.index;
  const start = new vscode.Position(identifierRange.start.line, startCharacter);
  const end = new vscode.Position(identifierRange.end.line, line.text.length);
  return new vscode.Range(start, end);
}

function normalizeObjectType(objectType: string): string {
  const type = objectType.toLowerCase();
  switch (type) {
    case 'proc':
      return 'PROCEDURE';
    case 'procedure':
      return 'PROCEDURE';
    case 'function':
      return 'FUNCTION';
    case 'view':
      return 'VIEW';
    default:
      return objectType.toUpperCase();
  }
}
