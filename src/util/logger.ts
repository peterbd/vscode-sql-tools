import * as vscode from 'vscode';

class ExtensionLogger {
  private readonly channel = vscode.window.createOutputChannel('PX SQL Tools');

  info(message: string): void {
    this.channel.appendLine(`[INFO ${new Date().toISOString()}] ${message}`);
  }

  warn(message: string): void {
    this.channel.appendLine(`[WARN ${new Date().toISOString()}] ${message}`);
  }

  error(message: string, error?: unknown): void {
    this.channel.appendLine(`[ERROR ${new Date().toISOString()}] ${message}`);
    if (error) {
      const details = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : JSON.stringify(error);
      this.channel.appendLine(details);
    }
  }

  dispose(): void {
    this.channel.dispose();
  }
}

const logger = new ExtensionLogger();

export function getLogger(): ExtensionLogger {
  return logger;
}

export type Logger = ExtensionLogger;
