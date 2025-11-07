import * as vscode from 'vscode';
import { HistoryStore, HistoryEntry } from './historyStore';
import { HistoryView } from './historyView';
import { MssqlApi } from '../mssqlApi';
import { getLogger } from '../util/logger';

interface CommandExecution {
  readonly command: string;
  readonly arguments?: unknown[];
}

const QUERY_COMMANDS = ['mssql.query', 'mssql.runQuery', 'mssql.executeQuery', 'mssql.runCurrentStatement', 'mssql.runQueryString'];

export function registerHistoryCommands(
  context: vscode.ExtensionContext,
  store: HistoryStore,
  view: HistoryView,
  api: MssqlApi
): void {
  const logger = getLogger();

  context.subscriptions.push(
    vscode.commands.registerCommand('sqlToolbelt.openHistory', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.sqlToolbelt');
    }),

    vscode.commands.registerCommand('sqlToolbelt.reopenFromHistory', async (entry?: HistoryEntry) => {
      const target = entry ?? view.getSelectedEntry();
      if (!target) {
        vscode.window.showInformationMessage('Select a history entry to reopen.');
        return;
      }
      await openQueryInUntitled(target.query);
      view.reveal(target);
    }),

    vscode.commands.registerCommand('sqlToolbelt.toggleFavoriteHistory', async (entry?: HistoryEntry) => {
      const target = entry ?? view.getSelectedEntry();
      if (!target) {
        return;
      }
      await store.toggleFavorite(target.id);
    }),

    vscode.commands.registerCommand('sqlToolbelt.copyHistory', (entry?: HistoryEntry) => {
      const target = entry ?? view.getSelectedEntry();
      if (!target) {
        return;
      }
      void vscode.env.clipboard.writeText(target.query);
      vscode.window.showInformationMessage('Query copied to clipboard.');
    }),

    vscode.commands.registerCommand('sqlToolbelt.deleteHistory', async (entry?: HistoryEntry) => {
      const target = entry ?? view.getSelectedEntry();
      if (!target) {
        return;
      }
      await store.delete(target.id);
    }),

    vscode.commands.registerCommand('sqlToolbelt.clearHistory', async () => {
      const answer = await vscode.window.showWarningMessage('Clear all SQL history entries?', { modal: true }, 'Clear');
      if (answer === 'Clear') {
        await store.clear();
      }
    }),

    vscode.commands.registerCommand('sqlToolbelt.history.search', async () => {
      const search = await vscode.window.showInputBox({
        placeHolder: 'Filter history...',
        prompt: 'Enter text to filter SQL history entries'
      });
      view.setFilter(search ?? '');
    })
  );

  const commandEvents = (vscode.commands as { onDidExecuteCommand?: vscode.Event<CommandExecution> }).onDidExecuteCommand;
  if (commandEvents) {
    const executionListener = commandEvents(async (event) => {
      if (!QUERY_COMMANDS.includes(event.command)) {
        return;
      }

      const queryText = extractQueryText(event.arguments);
      if (!queryText) {
        return;
      }

      const connection = await api.getActiveConnection();
      try {
        await store.add(queryText, { server: connection?.server, database: connection?.database });
      } catch (error) {
        logger.error('Failed to log SQL query to history.', error);
      }
    });

    context.subscriptions.push(executionListener);
  }
}

async function openQueryInUntitled(query: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument({ content: query, language: 'sql' });
  await vscode.window.showTextDocument(document, { preview: false });
}

function extractQueryText(args: unknown[] | undefined): string | undefined {
  if (!args || args.length === 0) {
    return undefined;
  }

  for (const arg of args) {
    if (typeof arg === 'string') {
      return arg;
    }

    if (typeof arg === 'object' && arg) {
      if ('query' in arg && typeof (arg as { query: unknown }).query === 'string') {
        return (arg as { query: string }).query;
      }
      if ('selection' in arg && typeof (arg as { selection: { text: unknown } }).selection?.text === 'string') {
        return (arg as { selection: { text: string } }).selection.text;
      }
    }
  }

  return undefined;
}
