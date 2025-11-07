import * as vscode from 'vscode';
import { HistoryStore, HistoryEntry } from './historyStore';

export class HistoryView implements vscode.Disposable {
  private readonly treeDataProvider: HistoryTreeDataProvider;
  private readonly treeView: vscode.TreeView<HistoryTreeItem>;

  constructor(private readonly store: HistoryStore) {
    this.treeDataProvider = new HistoryTreeDataProvider(store);
    this.treeView = vscode.window.createTreeView('sqlToolbelt.historyView', {
      treeDataProvider: this.treeDataProvider,
      showCollapseAll: true
    });
  }

  dispose(): void {
    this.treeView.dispose();
    this.treeDataProvider.dispose();
  }

  reveal(entry: HistoryEntry): void {
    const item = this.treeDataProvider.getItemById(entry.id);
    if (item) {
      this.treeView.reveal(item, { focus: true, select: true });
    }
  }

  setFilter(text: string): void {
    this.treeDataProvider.setFilter(text);
  }

  getSelectedEntry(): HistoryEntry | undefined {
    const item = this.treeView.selection[0];
    if (!item || !(item instanceof HistoryTreeLeaf)) {
      return undefined;
    }
    return item.entry;
  }
}

type HistoryTreeItem = HistoryTreeLeaf | HistoryGroupItem;

class HistoryTreeDataProvider implements vscode.TreeDataProvider<HistoryTreeItem>, vscode.Disposable {
  private readonly changeEvent = new vscode.EventEmitter<HistoryTreeItem | undefined>();
  private filterText = '';
  private readonly disposables: vscode.Disposable[] = [];
  private readonly itemCache = new Map<string, HistoryTreeLeaf>();

  constructor(private readonly store: HistoryStore) {
    this.disposables.push(
      store.onDidChange(() => this.changeEvent.fire(undefined)),
      vscode.commands.registerCommand('sqlToolbelt.historyView.refresh', () => this.changeEvent.fire(undefined))
    );
  }

  dispose(): void {
    this.disposables.forEach((disposable) => disposable.dispose());
    this.changeEvent.dispose();
  }

  get onDidChangeTreeData(): vscode.Event<HistoryTreeItem | undefined> {
    return this.changeEvent.event;
  }

  getTreeItem(element: HistoryTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: HistoryTreeItem): vscode.ProviderResult<HistoryTreeItem[]> {
    if (!element) {
      const entries = filterEntries(this.store.getAll(), this.filterText);
      const favorites = entries.filter((entry) => entry.favorite);
      const others = entries.filter((entry) => !entry.favorite);

      const nodes: HistoryTreeItem[] = [];
      if (favorites.length) {
        nodes.push(new HistoryGroupItem('Favorites', favorites.length));
      }
      nodes.push(...others.map((entry) => this.createLeaf(entry)));
      return nodes;
    }

    if (element instanceof HistoryGroupItem) {
      const entries = filterEntries(this.store.getAll(), this.filterText).filter((entry) => entry.favorite);
      return entries.map((entry) => this.createLeaf(entry));
    }

    return [];
  }

  setFilter(text: string): void {
    this.filterText = text;
    this.itemCache.clear();
    this.changeEvent.fire(undefined);
  }

  getItemById(id: string): HistoryTreeLeaf | undefined {
    return this.itemCache.get(id);
  }

  private createLeaf(entry: HistoryEntry): HistoryTreeLeaf {
    let leaf = this.itemCache.get(entry.id);
    if (!leaf) {
      leaf = new HistoryTreeLeaf(entry);
      this.itemCache.set(entry.id, leaf);
    } else {
      leaf.refresh(entry);
    }
    return leaf;
  }
}

class HistoryTreeLeaf extends vscode.TreeItem {
  private _entry: HistoryEntry;

  constructor(entry: HistoryEntry) {
    super(new Date(entry.timestamp).toLocaleString(), vscode.TreeItemCollapsibleState.None);
    this._entry = entry;
    this.refresh(entry);
  }

  get entry(): HistoryEntry {
    return this._entry;
  }

  refresh(entry: HistoryEntry): void {
    this._entry = entry;
    this.label = new Date(entry.timestamp).toLocaleString();
    this.tooltip = entry.query;
    this.description = `${entry.server ?? ''}${entry.database ? `/${entry.database}` : ''}`;
    this.command = {
      title: 'Reopen Query',
      command: 'sqlToolbelt.reopenFromHistory',
      arguments: [entry]
    };
    this.contextValue = entry.favorite ? 'historyItem.favorite' : 'historyItem';
  }
}

class HistoryGroupItem extends vscode.TreeItem {
  constructor(label: string, count: number) {
    super(`${label} (${count})`, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'historyGroup';
  }
}

function filterEntries(entries: HistoryEntry[], filterText: string): HistoryEntry[] {
  if (!filterText) {
    return entries;
  }

  const lowered = filterText.toLowerCase();
  return entries.filter((entry) => entry.query.toLowerCase().includes(lowered));
}
