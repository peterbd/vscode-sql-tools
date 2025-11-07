import * as vscode from 'vscode';
import { getLogger } from './logger';

export interface CustomSnippet {
  readonly name: string;
  readonly body: string;
  readonly description?: string;
}

const DEFAULT_FILENAME = 'custom-snippets.json';

export class SnippetLoader {
  private readonly logger = getLogger();

  constructor(private readonly context: vscode.ExtensionContext) {}

  async loadCustomSnippets(): Promise<CustomSnippet[]> {
    const configuration = vscode.workspace.getConfiguration('sqlToolbelt');
    const configuredPath = configuration.get<string>('snippets.customFile');

    const targetUri = configuredPath
      ? vscode.Uri.file(configuredPath)
      : vscode.Uri.joinPath(this.context.globalStorageUri, DEFAULT_FILENAME);

    if (!configuredPath) {
      await this.ensureGlobalSnippetFile(targetUri);
    }

    try {
      const buffer = await vscode.workspace.fs.readFile(targetUri);
      const text = Buffer.from(buffer).toString('utf8').trim();
      if (!text) {
        return [];
      }
      const json = JSON.parse(text) as Record<string, { body: string | string[]; description?: string }>;
      return Object.entries(json).map(([name, value]) => ({
        name,
        body: Array.isArray(value.body) ? value.body.join('\n') : value.body,
        description: value.description
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      this.logger.error('Failed to load custom SQL snippets.', error);
      return [];
    }
  }

  private async ensureGlobalSnippetFile(target: vscode.Uri): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
      await vscode.workspace.fs.stat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const placeholder = Buffer.from(
          JSON.stringify(
            {
              exampleSnippet: {
                body: 'SELECT 1 AS example;',
                description: 'Replace with your custom snippet.'
              }
            },
            null,
            2
          ),
          'utf8'
        );
        await vscode.workspace.fs.writeFile(target, placeholder);
      }
    }
  }
}
