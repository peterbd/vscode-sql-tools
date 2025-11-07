import * as vscode from 'vscode';
import { SchemaCache } from '../metadata/schemaCache';
import { MssqlApi } from '../mssqlApi';
import { SqlParser } from '../util/sqlParser';

export class SqlHoverProvider implements vscode.HoverProvider {
  constructor(private readonly schemaCache: SchemaCache, private readonly api: MssqlApi) {}

  async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    const identifier = SqlParser.getIdentifierAtPosition(document, position);
    if (!identifier) {
      return undefined;
    }

    const connection = await this.api.ensureConnection();
    if (!connection) {
      return undefined;
    }

    const qualified = SqlParser.parseQualifiedIdentifier(identifier.text);
    if (!qualified.object) {
      return undefined;
    }

    const schema = qualified.schema ?? 'dbo';
    const objectName = qualified.object;

    const table = await this.schemaCache.getTable(connection, schema, objectName);
    if (table) {
      const markdown = new vscode.MarkdownString();
      markdown.appendMarkdown(`**${table.schema}.${table.name}** (${table.type})\n\n`);
      if (table.description) {
        markdown.appendMarkdown(`${table.description}\n\n`);
      }
      if (table.columns?.length) {
        markdown.appendMarkdown('| Column | Type | Nullable | Description |\n');
        markdown.appendMarkdown('| ------ | ---- | -------- | ----------- |\n');
        table.columns.forEach((column) => {
          markdown.appendMarkdown(`| ${column.name} | ${column.dataType} | ${column.isNullable ? 'YES' : 'NO'} | ${column.description ?? ''} |\n`);
        });
      }
      markdown.isTrusted = true;
      return new vscode.Hover(markdown, identifier.range);
    }

    const routine = await this.schemaCache.getRoutine(connection, schema, objectName);
    if (routine) {
      const markdown = new vscode.MarkdownString();
      const parameters = routine.parameters?.map((p) => `${p.name} ${p.dataType}${p.isOutput ? ' OUTPUT' : ''}`) ?? [];
      markdown.appendMarkdown(`**${routine.schema}.${routine.name}** (${routine.type})\n\n`);
      if (parameters.length) {
        markdown.appendMarkdown(`Parameters: ${parameters.join(', ')}\n\n`);
      }
      if (routine.definition) {
        const definitionPreview = routine.definition.split('\n').slice(0, 20).join('\n');
        markdown.appendCodeblock(definitionPreview, 'sql');
      }
      markdown.isTrusted = true;
      return new vscode.Hover(markdown, identifier.range);
    }

    return undefined;
  }
}
