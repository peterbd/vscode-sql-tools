import * as vscode from 'vscode';
import { MssqlApi } from '../mssqlApi';
import { SchemaCache, ColumnMetadata } from '../metadata/schemaCache';
import { SqlParser } from '../util/sqlParser';
import { SnippetLoader } from '../util/snippetLoader';
import { getLogger } from '../util/logger';

const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL OUTER JOIN', 'CROSS APPLY',
  'GROUP BY', 'ORDER BY', 'INSERT INTO', 'VALUES', 'UPDATE', 'DELETE', 'MERGE', 'DECLARE', 'SET', 'EXEC', 'BEGIN', 'END'
];

export class SqlCompletionProvider implements vscode.CompletionItemProvider {
  private readonly logger = getLogger();
  private readonly metadata = new WeakMap<vscode.CompletionItem, { type: 'table' | 'routine'; schema: string; name: string }>();

  constructor(
    private readonly schemaCache: SchemaCache,
    private readonly api: MssqlApi,
    private readonly snippetLoader: SnippetLoader
  ) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.CompletionItem[]> {
    const connection = await this.api.ensureConnection();
    if (!connection) {
      return [];
    }

    const analysis = SqlParser.analyzeCompletionContext(document, position);
    const items: vscode.CompletionItem[] = [];

    switch (analysis.type) {
      case 'table': {
        const tables = await this.schemaCache.getTables(connection, token);
        const prefix = analysis.prefix.toLowerCase();
        for (const table of tables) {
          if (prefix && !table.name.toLowerCase().startsWith(prefix) && !table.schema.toLowerCase().startsWith(prefix)) {
            continue;
          }
          const item = new vscode.CompletionItem(`${table.schema}.${table.name}`, vscode.CompletionItemKind.Struct);
          item.detail = table.type;
          item.documentation = table.description;
          this.metadata.set(item, { type: 'table', schema: table.schema, name: table.name });
          items.push(item);
        }
        break;
      }

      case 'column': {
        const columns = await this.getColumnsForContext(document, connection, analysis);
        const prefix = analysis.prefix.toLowerCase();
        for (const column of columns) {
          if (prefix && !column.name.toLowerCase().startsWith(prefix)) {
            continue;
          }
          const item = new vscode.CompletionItem(column.name, vscode.CompletionItemKind.Field);
          item.detail = column.dataType;
          if (column.description) {
            item.documentation = column.description;
          }
          items.push(item);
        }
        break;
      }

      case 'routine': {
        const prefix = analysis.prefix.toLowerCase();
        const schemaFilter = analysis.owner ? analysis.owner.toLowerCase() : undefined;
        const category = analysis.routineCategory ?? 'any';

        const includeProcedures = category === 'any' || category === 'procedure';
        const includeFunctions = category === 'any' || category === 'function';
        const includeViews = category === 'any' || category === 'view';

        if (includeProcedures || includeFunctions) {
          const routines = await this.schemaCache.getRoutines(connection);
          for (const routine of routines) {
            const routineSchema = routine.schema.toLowerCase();
            if (schemaFilter && routineSchema !== schemaFilter) {
              continue;
            }
            if (!includeProcedures && routine.type === 'PROCEDURE') {
              continue;
            }
            if (!includeFunctions && routine.type === 'FUNCTION') {
              continue;
            }
            if (prefix && !routine.name.toLowerCase().startsWith(prefix)) {
              continue;
            }

            const completion = new vscode.CompletionItem(`${routine.schema}.${routine.name}`, vscode.CompletionItemKind.Function);
            completion.detail = routine.type;
            this.metadata.set(completion, { type: 'routine', schema: routine.schema, name: routine.name });
            items.push(completion);
          }
        }

        if (includeViews) {
          const tables = await this.schemaCache.getTables(connection, token);
          for (const view of tables) {
            if (view.type !== 'VIEW') {
              continue;
            }
            const viewSchema = view.schema.toLowerCase();
            if (schemaFilter && viewSchema !== schemaFilter) {
              continue;
            }
            if (prefix && !view.name.toLowerCase().startsWith(prefix)) {
              continue;
            }

            const completion = new vscode.CompletionItem(`${view.schema}.${view.name}`, vscode.CompletionItemKind.Struct);
            completion.detail = 'VIEW';
            completion.documentation = view.description;
            this.metadata.set(completion, { type: 'table', schema: view.schema, name: view.name });
            items.push(completion);
          }
        }
        break;
      }

      case 'keyword': {
        KEYWORDS.forEach((keyword) => {
          const completion = new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Keyword);
          completion.insertText = keyword;
          items.push(completion);
        });
        break;
      }

      default:
        break;
    }

    const allowJoinHints = vscode.workspace.getConfiguration('sqlToolbelt').get<boolean>('completion.enableJoinHints');
    if (allowJoinHints && analysis.type === 'table') {
      const joinHints = await this.createJoinHints(document, connection);
      items.push(...joinHints);
    }

    const customSnippets = await this.snippetLoader.loadCustomSnippets();
    for (const snippet of customSnippets) {
      const completion = new vscode.CompletionItem(snippet.name, vscode.CompletionItemKind.Snippet);
      completion.insertText = new vscode.SnippetString(snippet.body);
      completion.detail = 'Custom Snippet';
      completion.documentation = snippet.description;
      items.push(completion);
    }

    return items;
  }

  async resolveCompletionItem(item: vscode.CompletionItem): Promise<vscode.CompletionItem> {
    const connection = await this.api.getActiveConnection();
    const metadata = this.metadata.get(item);

    if (!connection || !metadata) {
      return item;
    }

    if (metadata.type === 'routine') {
      const routine = await this.schemaCache.getRoutine(connection, metadata.schema, metadata.name);
      if (routine?.parameters) {
        const signature = routine.parameters.map((p) => `${p.name} ${p.dataType}${p.isOutput ? ' OUTPUT' : ''}`).join(', ');
        item.detail = `${routine.type}(${signature})`;
        if (routine.definition) {
          item.documentation = (item.documentation as vscode.MarkdownString | string | undefined) ??
            routine.definition.split('\n').slice(0, 20).join('\n');
        }
      }
    }

    if (metadata.type === 'table') {
      const table = await this.schemaCache.getTable(connection, metadata.schema, metadata.name);
      if (table?.columns) {
        item.documentation = formatTableDocumentation(table.columns);
      }
    }

    return item;
  }

  private async getColumnsForContext(
    document: vscode.TextDocument,
    connection: Awaited<ReturnType<MssqlApi['ensureConnection']>>,
    analysis: ReturnType<typeof SqlParser.analyzeCompletionContext>
  ): Promise<ColumnMetadata[]> {
    if (!connection) {
      return [];
    }

    const alias = analysis.alias ?? analysis.owner;
    if (alias) {
      const tableRef = resolveAlias(document, alias);
      if (tableRef) {
        const table = await this.schemaCache.getTable(connection, tableRef.schema ?? 'dbo', tableRef.object);
        if (table?.columns) {
          return table.columns;
        }
      }
    }

    const firstTable = resolveFirstTable(document);
    if (firstTable) {
      const table = await this.schemaCache.getTable(connection, firstTable.schema ?? 'dbo', firstTable.object);
      if (table?.columns) {
        return table.columns;
      }
    }

    this.logger.warn('Unable to resolve table for column completion context.');
    return [];
  }

  private async createJoinHints(
    document: vscode.TextDocument,
    connection: Awaited<ReturnType<MssqlApi['ensureConnection']>>
  ): Promise<vscode.CompletionItem[]> {
    const existingAliases = collectAliases(document);
    const foreignKeys = await this.schemaCache.getForeignKeys(connection);

    return foreignKeys
      .filter((fk) => existingAliases.has(fk.parentTable) || existingAliases.has(fk.referencedTable))
      .map((fk) => {
        const completion = new vscode.CompletionItem(
          `JOIN ${fk.referencedSchema}.${fk.referencedTable}`,
          vscode.CompletionItemKind.Snippet
        );
        completion.insertText = new vscode.SnippetString(
          `JOIN ${fk.referencedSchema}.${fk.referencedTable} ${fk.referencedTable} ON ${fk.parentTable}.${fk.parentColumn} = ${fk.referencedTable}.${fk.referencedColumn}`
        );
        completion.detail = 'Join hint based on foreign key';
        completion.documentation = `${fk.constraint}: ${fk.parentTable}.${fk.parentColumn} -> ${fk.referencedTable}.${fk.referencedColumn}`;
        return completion;
      });
  }
}

interface AliasTarget {
  readonly schema?: string;
  readonly object: string;
}

function resolveAlias(document: vscode.TextDocument, alias: string): AliasTarget | undefined {
  const text = document.getText();
  const pattern = new RegExp(
    `(?:from|join)\s+([\w\[\]]+\.)?([\w\[\]]+)(?:\s+(?:as\s+)?)${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
    'gi'
  );
  const match = pattern.exec(text);
  if (!match) {
    return undefined;
  }

  const schema = match[1] ? match[1].replace(/\.|[\[\]]/g, '') : undefined;
  const object = match[2].replace(/[\[\]]/g, '');
  return { schema, object };
}

function resolveFirstTable(document: vscode.TextDocument): AliasTarget | undefined {
  const text = document.getText();
  const match = /from\s+([\w\[\]]+\.)?([\w\[\]]+)/i.exec(text);
  if (!match) {
    return undefined;
  }

  const schema = match[1] ? match[1].replace(/\.|[\[\]]/g, '') : undefined;
  const object = match[2].replace(/[\[\]]/g, '');
  return { schema, object };
}

function collectAliases(document: vscode.TextDocument): Set<string> {
  const text = document.getText();
  const regex = /(?:from|join)\s+([\w\[\]]+)(?:\.([\w\[\]]+))?(?:\s+(?:as\s+)?([\w\[\]]+))?/gi;
  const aliases = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) {
    const objectPart = match[2] ?? match[1];
    const aliasPart = match[3];

    if (objectPart) {
      aliases.add(objectPart.replace(/[\[\]]/g, ''));
    }
    if (aliasPart) {
      aliases.add(aliasPart.replace(/[\[\]]/g, ''));
    }
  }
  return aliases;
}

function formatTableDocumentation(columns: ColumnMetadata[]): string {
  const header = '| Column | Type | Nullable |\n| ------ | ---- | -------- |\n';
  const rows = columns
    .map((column) => `| ${column.name} | ${column.dataType} | ${column.isNullable ? 'YES' : 'NO'} |`)
    .join('\n');
  return `${header}${rows}`;
}
