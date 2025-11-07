import * as vscode from 'vscode';
import { MssqlApi } from './mssqlApi';
import { SchemaCache } from './metadata/schemaCache';
import { SqlCompletionProvider } from './features/completionProvider';
import { SqlHoverProvider } from './features/hoverProvider';
import { registerExpandWildcardCommand } from './features/expandWildcard';
import { registerScriptCommands } from './features/scriptAsAlter';
import { HistoryStore } from './history/historyStore';
import { HistoryView } from './history/historyView';
import { registerHistoryCommands } from './history/historyCommands';
import { SnippetLoader } from './util/snippetLoader';
import { getLogger } from './util/logger';

interface CommandExecution {
  readonly command: string;
  readonly arguments?: unknown[];
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = getLogger();
  logger.info('Activating SQL Toolbelt Lite extension.');

  const api = new MssqlApi(context.extension.id);
  const schemaCache = new SchemaCache(api);
  const snippetLoader = new SnippetLoader(context);

  const completionProvider = new SqlCompletionProvider(schemaCache, api, snippetLoader);
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider({ language: 'sql' }, completionProvider, '.', ' ', '*')
  );

  const hoverProvider = new SqlHoverProvider(schemaCache, api);
  context.subscriptions.push(vscode.languages.registerHoverProvider({ language: 'sql' }, hoverProvider));

  registerExpandWildcardCommand(context, schemaCache, api);
  registerScriptCommands(context, api, schemaCache);

  const historyStore = new HistoryStore(context);
  await historyStore.initialize();
  const historyView = new HistoryView(historyStore);
  context.subscriptions.push(historyView);
  registerHistoryCommands(context, historyStore, historyView, api);

  if (vscode.workspace.getConfiguration('sqlToolbelt').get<boolean>('history.restoreOnStartup', true)) {
    await historyStore.restoreUnsavedQueries();
  }

  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument(async (document) => {
      if (document.languageId === 'sql' && document.isDirty) {
        await historyStore.saveUnsavedQuery(document.getText());
      }
    })
  );

  context.subscriptions.push(schemaCache);
  context.subscriptions.push(api);

  const commandEvents = (vscode.commands as { onDidExecuteCommand?: vscode.Event<CommandExecution> }).onDidExecuteCommand;
  if (commandEvents) {
    context.subscriptions.push(
      commandEvents(async (event) => {
        if (event.command === 'mssql.connect' || event.command === 'mssql.disconnect' || event.command === 'mssql.refreshObjects') {
          const connection = await api.getActiveConnection();
          schemaCache.invalidate(connection);
        }
      })
    );
  }
}

export function deactivate(): void {
  const logger = getLogger();
  logger.info('SQL Toolbelt Lite extension deactivated.');
}
