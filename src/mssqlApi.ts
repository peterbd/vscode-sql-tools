import * as vscode from 'vscode';
import { getLogger } from './util/logger';

export interface MssqlConnection {
  readonly connectionId?: string;
  readonly server?: string;
  readonly database?: string;
  readonly user?: string;
}

export interface QueryRow {
  readonly [column: string]: unknown;
}

export interface QueryResult {
  readonly columns: string[];
  readonly rows: QueryRow[];
}

export interface EnsureConnectionOptions {
  readonly prompt?: boolean;
}

export interface RunQueryOptions {
  readonly useLegacyFallback?: boolean;
}

const COMMAND_GET_ACTIVE_CONNECTION = 'mssql.getActiveConnection';
const COMMAND_RUN_QUERY_CANDIDATES = ['mssql.query', 'mssql.runQuery', 'mssql.executeQuery'];
const MSSQL_EXTENSION_ID = 'ms-mssql.mssql';
const PERMISSION_PROMPT_COOLDOWN_MS = 15000;
const CONNECTION_PROMPT_COOLDOWN_MS = 5000;

interface ConnectionSharingService {
  getActiveEditorConnectionId(extensionId: string): Promise<string | undefined>;
  getActiveDatabase(extensionId: string): Promise<string | undefined>;
  getDatabaseForConnectionId(extensionId: string, connectionId: string): Promise<string | undefined>;
  connect(extensionId: string, connectionId: string, databaseName?: string): Promise<string | undefined>;
  disconnect(connectionUri: string): void;
  isConnected(connectionUri: string): boolean;
  executeSimpleQuery(connectionUri: string, query: string): Promise<SimpleExecuteResult | undefined>;
  getServerInfo?(connectionUri: string): Promise<ServerInfo | undefined> | ServerInfo | undefined;
  getConnectionString?(extensionId: string, connectionId: string): Promise<string | undefined>;
}

interface SimpleExecuteResult {
  readonly columnInfo?: SimpleColumnInfo[];
  readonly rows?: DbCellValue[][];
}

interface SimpleColumnInfo {
  readonly columnName?: string;
  readonly columnNameFriendly?: string;
  readonly displayName?: string;
}

interface DbCellValue {
  readonly displayValue?: string;
  readonly invariantCultureDisplayValue?: string;
  readonly isNull?: boolean;
  readonly value?: unknown;
  readonly [key: string]: unknown;
}

interface ServerInfo {
  readonly serverName?: string;
  readonly [key: string]: unknown;
}

interface CachedConnection extends MssqlConnection {
  readonly connectionId: string;
  readonly connectionUri: string;
}

type ConnectionAcquisitionResult =
  | { status: 'ok'; connection: MssqlConnection }
  | { status: 'permission-required' }
  | { status: 'no-active-connection' }
  | { status: 'error'; error: unknown };

export class MssqlApi implements vscode.Disposable {
  private readonly logger = getLogger();
  private connectionSharing?: ConnectionSharingService;
  private cachedConnection?: CachedConnection;
  private permissionPromptTimestamp?: number;
  private connectionPromptTimestamp?: number;
  private missingExtensionWarned = false;

  constructor(private readonly extensionId: string) {}

  dispose(): void {
    if (this.cachedConnection?.connectionUri && this.connectionSharing) {
      try {
        this.connectionSharing.disconnect(this.cachedConnection.connectionUri);
      } catch (error) {
        this.logger.warn('Failed to dispose MSSQL shared connection.');
        this.logger.error('Disconnect error details', error);
      }
    }
    this.cachedConnection = undefined;
  }

  async getActiveConnection(): Promise<MssqlConnection | undefined> {
    const sharing = await this.getConnectionSharingService();
    if (sharing) {
      const result = await this.tryGetActiveConnectionViaSharing(sharing);
      if (result.status === 'ok') {
        return result.connection;
      }
    }

    return this.getActiveConnectionLegacy();
  }

  async ensureConnection(options?: EnsureConnectionOptions): Promise<MssqlConnection | undefined> {
    const sharing = await this.getConnectionSharingService();
    if (sharing) {
      const shared = await this.ensureConnectionViaSharing(sharing);
      if (shared) {
        return shared;
      }
    }

    if (options?.prompt === false) {
      return undefined;
    }

    return this.ensureConnectionLegacy();
  }

  async runQuery(query: string, token?: vscode.CancellationToken, options?: RunQueryOptions): Promise<QueryResult | undefined> {
    const sharing = await this.getConnectionSharingService();
    if (sharing) {
      const sharedResult = await this.runQueryViaSharing(sharing, query, token);
      if (sharedResult) {
        return sharedResult;
      }
    }

    if (options?.useLegacyFallback === false) {
      return undefined;
    }

    return this.runQueryLegacy(query, token);
  }

  async runScalar<T>(query: string, options?: RunQueryOptions): Promise<T | undefined> {
    const result = await this.runQuery(query, undefined, options);
    if (!result || result.rows.length === 0 || result.columns.length === 0) {
      return undefined;
    }

    const firstRow = result.rows[0];
    const firstColumn = result.columns[0];
    return firstRow[firstColumn] as T | undefined;
  }

  getConnectionKey(connection: MssqlConnection | undefined): string | undefined {
    if (!connection) {
      return undefined;
    }

    const parts = [connection.connectionId, connection.server, connection.database, connection.user]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0);

    return parts.length ? parts.join('|') : undefined;
  }

  private async getActiveConnectionLegacy(): Promise<MssqlConnection | undefined> {
    try {
      return await vscode.commands.executeCommand<MssqlConnection | undefined>(COMMAND_GET_ACTIVE_CONNECTION);
    } catch (error) {
      this.logger.error('Failed to obtain active MSSQL connection via legacy command.', error);
      return undefined;
    }
  }

  private async ensureConnectionLegacy(): Promise<MssqlConnection | undefined> {
    const connection = await this.getActiveConnectionLegacy();
    if (connection) {
      return connection;
    }

    if (!this.shouldPromptForConnection()) {
      return undefined;
    }

    const choice = await vscode.window.showInformationMessage(
      'SQL Toolbelt Lite requires an active MSSQL connection. Connect now?',
      'Connect',
      'Cancel'
    );

    if (choice === 'Connect') {
      await vscode.commands.executeCommand('mssql.connect');
      return this.getActiveConnectionLegacy();
    }

    return undefined;
  }

  private async runQueryLegacy(query: string, token?: vscode.CancellationToken): Promise<QueryResult | undefined> {
    const connection = await this.ensureConnectionLegacy();
    if (!connection) {
      return undefined;
    }

    for (const command of COMMAND_RUN_QUERY_CANDIDATES) {
      if (token?.isCancellationRequested) {
        return undefined;
      }

      try {
        const result = await vscode.commands.executeCommand<unknown>(command, query, connection);
        const normalized = this.normalizeResult(result);
        if (normalized) {
          return normalized;
        }
      } catch (error) {
        const message = (error as Error)?.message ?? '';
        if (message.includes('command')) {
          continue;
        }
        this.logger.error(`Failed to execute metadata query via ${command}.`, error);
      }
    }

    this.logger.warn('MSSQL metadata query command not available.');
    return undefined;
  }

  private async getConnectionSharingService(): Promise<ConnectionSharingService | undefined> {
    if (this.connectionSharing) {
      return this.connectionSharing;
    }

    const extension = vscode.extensions.getExtension(MSSQL_EXTENSION_ID);
    if (!extension) {
      if (!this.missingExtensionWarned) {
        this.missingExtensionWarned = true;
        this.logger.warn('Microsoft SQL Server (mssql) extension not found.');
        void vscode.window.showWarningMessage(
          'SQL Toolbelt Lite requires the Microsoft SQL Server (mssql) extension. Install or enable it to use all features.'
        );
      }
      return undefined;
    }

    try {
      const api = extension.isActive ? extension.exports : await extension.activate();
      const sharing = (api?.connectionSharing ?? api?.default?.connectionSharing) as ConnectionSharingService | undefined;
      if (!sharing) {
        this.logger.warn('MSSQL connection sharing API is unavailable.');
        return undefined;
      }
      this.connectionSharing = sharing;
      return sharing;
    } catch (error) {
      this.logger.error('Failed to activate MSSQL extension.', error);
      return undefined;
    }
  }

  private async ensureConnectionViaSharing(service: ConnectionSharingService): Promise<MssqlConnection | undefined> {
    const result = await this.tryGetActiveConnectionViaSharing(service);
    if (result.status === 'ok') {
      return result.connection;
    }

    if (result.status === 'permission-required') {
      return this.promptForConnectionSharingPermission(service);
    }

    if (result.status === 'error') {
      this.logger.error('Unexpected error while acquiring MSSQL connection via sharing API.', result.error);
      void vscode.window.showErrorMessage('SQL Toolbelt Lite could not access the MSSQL connection. Check the output log for details.');
    }

    return undefined;
  }

  private async tryGetActiveConnectionViaSharing(service: ConnectionSharingService): Promise<ConnectionAcquisitionResult> {
    try {
      const connectionId = await service.getActiveEditorConnectionId(this.extensionId);
      if (!connectionId) {
        this.disconnectCachedConnection(service);
        return { status: 'no-active-connection' };
      }

      const database = await this.getPreferredDatabase(service, connectionId);
      const cached = await this.ensureCachedConnection(service, connectionId, database);
      return { status: 'ok', connection: this.stripConnectionData(cached) };
    } catch (error) {
      const code = this.getConnectionSharingErrorCode(error);
      if (code === 'PERMISSION_REQUIRED' || code === 'PERMISSION_DENIED') {
        this.disconnectCachedConnection(service);
        return { status: 'permission-required' };
      }

      if (code === 'NO_ACTIVE_EDITOR' || code === 'NO_ACTIVE_CONNECTION' || code === 'INVALID_CONNECTION_URI') {
        this.disconnectCachedConnection(service);
        return { status: 'no-active-connection' };
      }

      if (code === 'EXTENSION_NOT_FOUND') {
        this.disconnectCachedConnection(service);
        return { status: 'error', error };
      }

      this.logger.error('Failed to retrieve active MSSQL connection via sharing API.', error);
      this.disconnectCachedConnection(service);
      return { status: 'error', error };
    }
  }

  private async promptForConnectionSharingPermission(service: ConnectionSharingService): Promise<MssqlConnection | undefined> {
    if (!this.shouldPromptForPermission()) {
      return undefined;
    }

    const choice = await vscode.window.showWarningMessage(
      'SQL Toolbelt Lite needs permission to access your MSSQL connections. Manage permissions now?',
      'Manage Permissions',
      'Cancel'
    );

    if (choice !== 'Manage Permissions') {
      return undefined;
    }

    await vscode.commands.executeCommand('mssql.connectionSharing.editConnectionSharingPermissions', this.extensionId);

    const retry = await this.tryGetActiveConnectionViaSharing(service);
    if (retry.status === 'ok') {
      return retry.connection;
    }

    return undefined;
  }

  private async runQueryViaSharing(
    service: ConnectionSharingService,
    query: string,
    token?: vscode.CancellationToken
  ): Promise<QueryResult | undefined> {
    if (token?.isCancellationRequested) {
      return undefined;
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const connection = await this.ensureConnectionViaSharing(service);
      if (!connection) {
        return undefined;
      }

      if (token?.isCancellationRequested) {
        return undefined;
      }

      const cached = this.cachedConnection;
      if (!cached?.connectionUri) {
        return undefined;
      }

      try {
        const result = await service.executeSimpleQuery(cached.connectionUri, query);
        if (token?.isCancellationRequested) {
          return undefined;
        }
        const normalized = this.normalizeSimpleExecuteResult(result);
        if (normalized) {
          return normalized;
        }
        return undefined;
      } catch (error) {
        const code = this.getConnectionSharingErrorCode(error);
        if (code === 'NO_ACTIVE_CONNECTION' || code === 'INVALID_CONNECTION_URI' || code === 'CONNECTION_FAILED') {
          if (attempt === 0) {
            this.logger.warn('Shared MSSQL connection was invalid. Attempting to reconnect.');
            this.disconnectCachedConnection(service);
            continue;
          }
        }

        if (code === 'PERMISSION_REQUIRED' || code === 'PERMISSION_DENIED') {
          await this.promptForConnectionSharingPermission(service);
          return undefined;
        }

        this.logger.error('Failed to execute MSSQL query via connection sharing API.', error);
        return undefined;
      }
    }

    return undefined;
  }

  private async ensureCachedConnection(
    service: ConnectionSharingService,
    connectionId: string,
    targetDatabase?: string
  ): Promise<CachedConnection> {
    const cached = this.cachedConnection;
    const needsReconnect =
      !cached ||
      cached.connectionId !== connectionId ||
      !cached.connectionUri ||
      !service.isConnected(cached.connectionUri) ||
      (targetDatabase && cached.database !== targetDatabase);

    if (!needsReconnect) {
      if (targetDatabase && cached.database !== targetDatabase) {
        this.cachedConnection = { ...cached, database: targetDatabase };
      }
      return this.cachedConnection!;
    }

    this.disconnectCachedConnection(service);

    const connectionUri = await service.connect(this.extensionId, connectionId, targetDatabase);
    if (!connectionUri) {
      throw new Error('Failed to establish shared MSSQL connection.');
    }

    const metadata = await this.resolveConnectionMetadata(service, connectionId, connectionUri);
    this.cachedConnection = {
      connectionId,
      connectionUri,
      server: metadata.server,
      database: targetDatabase ?? metadata.database,
      user: metadata.user
    };

    return this.cachedConnection;
  }

  private disconnectCachedConnection(service?: ConnectionSharingService): void {
    if (!this.cachedConnection?.connectionUri) {
      this.cachedConnection = undefined;
      return;
    }

    const sharing = service ?? this.connectionSharing;
    if (sharing) {
      try {
        sharing.disconnect(this.cachedConnection.connectionUri);
      } catch (error) {
        this.logger.warn('Failed to disconnect shared MSSQL connection.');
        this.logger.error('Disconnect error details', error);
      }
    }
    this.cachedConnection = undefined;
  }

  private stripConnectionData(cached: CachedConnection): MssqlConnection {
    const { connectionUri: _uri, ...rest } = cached;
    return rest;
  }

  private async getPreferredDatabase(service: ConnectionSharingService, connectionId: string): Promise<string | undefined> {
    try {
      const active = await service.getActiveDatabase(this.extensionId);
      if (active) {
        return active;
      }
    } catch (error) {
      const code = this.getConnectionSharingErrorCode(error);
      if (code && code !== 'NO_ACTIVE_EDITOR' && code !== 'NO_ACTIVE_CONNECTION') {
        this.logger.error('Failed to determine active database via connection sharing API.', error);
      }
    }

    try {
      const configured = await service.getDatabaseForConnectionId(this.extensionId, connectionId);
      if (configured) {
        return configured;
      }
    } catch (error) {
      this.logger.error('Failed to retrieve configured database for connection.', error);
    }

    if (typeof service.getConnectionString === 'function') {
      try {
        const connectionString = await service.getConnectionString(this.extensionId, connectionId);
        if (connectionString) {
          const parsed = this.parseConnectionString(connectionString);
          if (parsed.database) {
            return parsed.database;
          }
        }
      } catch (error) {
        this.logger.error('Failed to parse database name from MSSQL connection string.', error);
      }
    }

    return undefined;
  }

  private async resolveConnectionMetadata(
    service: ConnectionSharingService,
    connectionId: string,
    connectionUri: string
  ): Promise<{ server?: string; database?: string; user?: string }> {
    let server: string | undefined;
    let database: string | undefined;
    let user: string | undefined;

    if (typeof service.getConnectionString === 'function') {
      try {
        const connectionString = await service.getConnectionString(this.extensionId, connectionId);
        if (connectionString) {
          const parsed = this.parseConnectionString(connectionString);
          server = parsed.server ?? server;
          database = parsed.database ?? database;
          user = parsed.user ?? user;
        }
      } catch (error) {
        this.logger.error('Failed to retrieve connection string from MSSQL extension.', error);
      }
    }

    if (!server && typeof service.getServerInfo === 'function') {
      try {
        const info = await Promise.resolve(service.getServerInfo(connectionUri));
        if (info && typeof info.serverName === 'string' && info.serverName.trim()) {
          server = info.serverName.trim();
        }
      } catch (error) {
        this.logger.error('Failed to read server info for shared MSSQL connection.', error);
      }
    }

    return { server, database, user };
  }

  private parseConnectionString(connectionString: string): { server?: string; database?: string; user?: string } {
    const segments = connectionString
      .split(';')
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);

    const values = new Map<string, string>();
    for (const segment of segments) {
      const index = segment.indexOf('=');
      if (index <= 0) {
        continue;
      }
      const key = segment.slice(0, index).trim().toLowerCase();
      const rawValue = segment.slice(index + 1).trim();
      const value = rawValue.replace(/^['"]|['"]$/g, '');
      values.set(key, value);
    }

    const server =
      values.get('data source') ??
      values.get('server') ??
      values.get('address') ??
      values.get('addr') ??
      values.get('network address');

    const database = values.get('initial catalog') ?? values.get('database');
    const user = values.get('user id') ?? values.get('user') ?? values.get('uid');

    return { server, database, user };
  }

  private normalizeSimpleExecuteResult(result: SimpleExecuteResult | undefined): QueryResult | undefined {
    if (!result) {
      return undefined;
    }

    const columns: string[] = [];
    const columnInfo = Array.isArray(result.columnInfo) ? result.columnInfo : [];

    columnInfo.forEach((info, index) => {
      const baseName = this.getColumnName(info, index);
      let name = baseName;
      let suffix = 1;
      while (columns.includes(name)) {
        name = `${baseName}_${suffix++}`;
      }
      columns.push(name);
    });

    if (columns.length === 0 && Array.isArray(result.rows) && result.rows[0]) {
      for (let i = 0; i < result.rows[0].length; i += 1) {
        columns.push(`Column${i + 1}`);
      }
    }

    const rows = (result.rows ?? []).map((row) => this.convertRow(columns, row));
    return { columns, rows };
  }

  private getColumnName(info: SimpleColumnInfo | undefined, index: number): string {
    if (!info) {
      return `Column${index + 1}`;
    }

    const candidates = [info.columnName, info.columnNameFriendly, info.displayName]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim());

    return candidates[0] ?? `Column${index + 1}`;
  }

  private convertRow(columns: string[], row: DbCellValue[]): QueryRow {
    const record: Record<string, unknown> = {};

    columns.forEach((columnName, index) => {
      const cell = row?.[index];
      if (!cell) {
        record[columnName] = undefined;
        return;
      }

      if (cell.isNull) {
        record[columnName] = null;
        return;
      }

      if (cell.displayValue !== undefined) {
        record[columnName] = cell.displayValue;
        return;
      }

      if (cell.invariantCultureDisplayValue !== undefined) {
        record[columnName] = cell.invariantCultureDisplayValue;
        return;
      }

      if (cell.value !== undefined) {
        record[columnName] = cell.value;
        return;
      }

      record[columnName] = cell;
    });

    return record;
  }

  private normalizeResult(result: unknown): QueryResult | undefined {
    if (!result) {
      return undefined;
    }

    if (isQueryResult(result)) {
      return result;
    }

    if (Array.isArray(result)) {
      const rows = result as QueryRow[];
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      return { columns, rows };
    }

    if (typeof result === 'object') {
      const obj = result as { rows?: unknown; columns?: unknown; recordset?: unknown[] };
      if (Array.isArray(obj.rows) && Array.isArray(obj.columns)) {
        const rows = (obj.rows as unknown[]).map((row) => {
          if (typeof row === 'object' && row !== null) {
            return row as QueryRow;
          }
          return { value: row } as QueryRow;
        });
        const columns = (obj.columns as unknown[]).map((col) => {
          if (typeof col === 'string') {
            return col;
          }
          if (typeof col === 'object' && col !== null && 'name' in col) {
            return String((col as Record<string, unknown>).name);
          }
          return 'value';
        });
        return { columns, rows };
      }

      if (Array.isArray(obj.recordset)) {
        const rows = obj.recordset as QueryRow[];
        const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
        return { columns, rows };
      }
    }

    return undefined;
  }

  private getConnectionSharingErrorCode(error: unknown): string | undefined {
    if (!error || typeof error !== 'object') {
      return undefined;
    }

    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }

  private shouldPromptForPermission(): boolean {
    const now = Date.now();
    if (this.permissionPromptTimestamp && now - this.permissionPromptTimestamp < PERMISSION_PROMPT_COOLDOWN_MS) {
      return false;
    }
    this.permissionPromptTimestamp = now;
    return true;
  }

  private shouldPromptForConnection(): boolean {
    const now = Date.now();
    if (this.connectionPromptTimestamp && now - this.connectionPromptTimestamp < CONNECTION_PROMPT_COOLDOWN_MS) {
      return false;
    }
    this.connectionPromptTimestamp = now;
    return true;
  }
}

function isQueryResult(value: unknown): value is QueryResult {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as QueryResult;
  return Array.isArray(candidate.columns) && Array.isArray(candidate.rows);
}
