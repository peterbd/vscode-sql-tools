import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { getLogger } from '../util/logger';

export interface HistoryEntry {
  readonly id: string;
  readonly query: string;
  readonly timestamp: number;
  readonly server?: string;
  readonly database?: string;
  favorite?: boolean;
  unsaved?: boolean;
}

const HISTORY_FILENAME = 'history.json';

export class HistoryStore {
  private readonly logger = getLogger();
  private readonly entries: HistoryEntry[] = [];
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  private readonly historyUri: vscode.Uri;

  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.historyUri = vscode.Uri.joinPath(context.globalStorageUri, HISTORY_FILENAME);
  }

  async initialize(): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
      const content = await vscode.workspace.fs.readFile(this.historyUri);
      const parsed = JSON.parse(Buffer.from(content).toString('utf8')) as HistoryEntry[];
      this.entries.splice(0, this.entries.length, ...parsed);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.logger.error('Failed to read SQL history file.', error);
      }
    }
  }

  getAll(): HistoryEntry[] {
    return [...this.entries].sort((a, b) => b.timestamp - a.timestamp);
  }

  getById(id: string): HistoryEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  async add(
    query: string,
    connection?: { server?: string; database?: string },
    options?: { favorite?: boolean; unsaved?: boolean }
  ): Promise<void> {
    if (!query.trim()) {
      return;
    }

    const entry: HistoryEntry = {
      id: randomUUID(),
      query,
      timestamp: Date.now(),
      server: connection?.server,
      database: connection?.database,
      favorite: Boolean(options?.favorite),
      unsaved: Boolean(options?.unsaved)
    };

    const maxItems = vscode.workspace.getConfiguration('pxSqlTools').get<number>('history.maxItems', 1000);
    this.entries.unshift(entry);

    if (this.entries.length > maxItems) {
      this.entries.length = maxItems;
    }

    await this.persist();
  }

  async toggleFavorite(id: string): Promise<void> {
    const entry = this.getById(id);
    if (!entry) {
      return;
    }
    entry.favorite = !entry.favorite;
    await this.persist();
  }

  async delete(id: string): Promise<void> {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index >= 0) {
      this.entries.splice(index, 1);
      await this.persist();
    }
  }

  async clear(): Promise<void> {
    this.entries.length = 0;
    await this.persist();
  }

  async restoreUnsavedQueries(): Promise<void> {
    if (!vscode.workspace.getConfiguration('pxSqlTools').get<boolean>('history.restoreOnStartup', true)) {
      return;
    }

    const unsaved = this.entries.filter((entry) => entry.unsaved);
    for (const entry of unsaved) {
      await vscode.workspace.openTextDocument({ content: entry.query, language: 'sql' }).then((doc) =>
        vscode.window.showTextDocument(doc, { preview: false })
      );
      entry.unsaved = false;
    }

    if (unsaved.length) {
      await this.persist();
    }
  }

  async saveUnsavedQuery(text: string): Promise<void> {
    await this.add(text, undefined, { unsaved: true, favorite: true });
  }

  private async persist(): Promise<void> {
    try {
      const buffer = Buffer.from(JSON.stringify(this.entries, undefined, 2), 'utf8');
      await vscode.workspace.fs.writeFile(this.historyUri, buffer);
      this.onDidChangeEmitter.fire();
    } catch (error) {
      this.logger.error('Failed to persist SQL history file.', error);
    }
  }
}
