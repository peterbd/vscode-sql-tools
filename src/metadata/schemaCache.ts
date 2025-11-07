import * as vscode from 'vscode';
import { MssqlApi, MssqlConnection, QueryResult } from '../mssqlApi';
import { getLogger } from '../util/logger';
import {
  allObjectsQuery,
  columnsForObjectQuery,
  extendedPropertyDescriptionQuery,
  routineDefinitionQuery,
  routineParametersQuery,
  foreignKeysQuery
} from './queries';

export type TableType = 'TABLE' | 'VIEW';
export type RoutineType = 'PROCEDURE' | 'FUNCTION';

export interface TableMetadata {
  readonly schema: string;
  readonly name: string;
  readonly type: TableType;
  description?: string;
  columns?: ColumnMetadata[];
}

export interface ColumnMetadata {
  readonly name: string;
  readonly dataType: string;
  readonly maxLength?: number;
  readonly precision?: number;
  readonly scale?: number;
  readonly isNullable: boolean;
  readonly description?: string;
  readonly isIdentity: boolean;
  readonly isComputed: boolean;
  readonly isRowGuid: boolean;
  readonly defaultExpression?: string;
}

export interface RoutineMetadata {
  readonly schema: string;
  readonly name: string;
  readonly type: RoutineType;
  definition?: string;
  parameters?: RoutineParameter[];
}

export interface RoutineParameter {
  readonly name: string;
  readonly dataType: string;
  readonly maxLength?: number;
  readonly precision?: number;
  readonly scale?: number;
  readonly isOutput: boolean;
}

export interface ForeignKeyRelation {
  readonly constraint: string;
  readonly parentSchema: string;
  readonly parentTable: string;
  readonly parentColumn: string;
  readonly referencedSchema: string;
  readonly referencedTable: string;
  readonly referencedColumn: string;
}

interface CacheEntry {
  readonly tables: Map<string, TableMetadata>;
  readonly routines: Map<string, RoutineMetadata>;
  readonly foreignKeys: ForeignKeyRelation[];
  readonly timestamp: number;
}

export class SchemaCache implements vscode.Disposable {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly logger = getLogger();

  constructor(private readonly api: MssqlApi) {}

  dispose(): void {
    this.cache.clear();
  }

  invalidate(connection: MssqlConnection | undefined): void {
    const key = this.api.getConnectionKey(connection);
    if (key) {
      this.cache.delete(key);
    }
  }

  async getTables(connection: MssqlConnection | undefined, token?: vscode.CancellationToken): Promise<TableMetadata[]> {
    const entry = await this.ensureCache(connection, token);
    return entry ? [...entry.tables.values()].filter((t) => t.type === 'TABLE' || t.type === 'VIEW') : [];
  }

  async getTable(
    connection: MssqlConnection | undefined,
    schema: string,
    name: string,
    token?: vscode.CancellationToken,
    options?: { database?: string }
  ): Promise<TableMetadata | undefined> {
    if (options?.database && connection?.database && options.database.toLowerCase() !== connection.database.toLowerCase()) {
      return this.loadTableCrossDatabase(connection, options.database, schema, name);
    }

    const entry = await this.ensureCache(connection, token);
    if (!entry) {
      return this.loadTableOnDemand(connection, schema, name, options);
    }

    const key = toObjectKey(schema, name);
    let table = entry.tables.get(key);
    if (!table) {
      table = await this.loadTableOnDemand(connection, schema, name, options);
      if (!table) {
        this.logger.warn(`Table metadata not found for ${schema}.${name}.`);
        return undefined;
      }
      entry.tables.set(key, table);
    }

    if (!table.columns) {
      table = await this.populateColumns(connection, table, options);
      entry.tables.set(key, table);
    }

    if (!table.description) {
      table = await this.populateDescription(connection, table, options);
      entry.tables.set(key, table);
    }

    return table;
  }

  async getRoutines(connection: MssqlConnection | undefined): Promise<RoutineMetadata[]> {
    const entry = await this.ensureCache(connection);
    return entry ? [...entry.routines.values()] : [];
  }

  async getRoutine(connection: MssqlConnection | undefined, schema: string, name: string): Promise<RoutineMetadata | undefined> {
    const entry = await this.ensureCache(connection);
    if (!entry) {
      return undefined;
    }

    const key = toObjectKey(schema, name);
    let routine = entry.routines.get(key);
    if (!routine) {
      return undefined;
    }

    if (!routine.definition) {
      routine = await this.populateRoutineDefinition(connection, routine);
      entry.routines.set(key, routine);
    }

    if (!routine.parameters) {
      routine = await this.populateRoutineParameters(connection, routine);
      entry.routines.set(key, routine);
    }

    return routine;
  }

  async getForeignKeys(connection: MssqlConnection | undefined): Promise<ForeignKeyRelation[]> {
    const entry = await this.ensureCache(connection);
    return entry ? entry.foreignKeys : [];
  }

  private async ensureCache(connection: MssqlConnection | undefined, token?: vscode.CancellationToken): Promise<CacheEntry | undefined> {
    const key = this.api.getConnectionKey(connection);
    if (!key) {
      return undefined;
    }

    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }

    const tables = new Map<string, TableMetadata>();
    const routines = new Map<string, RoutineMetadata>();
    const foreignKeys: ForeignKeyRelation[] = [];

    const result = await this.api.runQuery(allObjectsQuery(connection?.database), token, {
      useLegacyFallback: false
    });
    if (result) {
      for (const row of result.rows) {
        const objectSchema = String(row['schema_name'] ?? '').trim();
        const objectName = String(row['object_name'] ?? '').trim();
        const type = String(row['object_type'] ?? '').trim();

        if (!objectSchema || !objectName) {
          continue;
        }

        if (type === 'U' || type === 'V') {
          const table: TableMetadata = {
            schema: objectSchema,
            name: objectName,
            type: type === 'U' ? 'TABLE' : 'VIEW'
          };
          tables.set(toObjectKey(objectSchema, objectName), table);
          continue;
        }

        if (['P', 'FN', 'IF', 'TF'].includes(type)) {
          const routine: RoutineMetadata = {
            schema: objectSchema,
            name: objectName,
            type: type === 'P' ? 'PROCEDURE' : 'FUNCTION'
          };
          routines.set(toObjectKey(objectSchema, objectName), routine);
        }
      }

      const fkResult = await this.api.runQuery(foreignKeysQuery(connection?.database), token, {
        useLegacyFallback: false
      });
      if (fkResult) {
        for (const row of fkResult.rows) {
          foreignKeys.push({
            constraint: String(row['constraint_name'] ?? ''),
            parentSchema: String(row['parent_schema'] ?? ''),
            parentTable: String(row['parent_table'] ?? ''),
            parentColumn: String(row['parent_column'] ?? ''),
            referencedSchema: String(row['referenced_schema'] ?? ''),
            referencedTable: String(row['referenced_table'] ?? ''),
            referencedColumn: String(row['referenced_column'] ?? '')
          });
        }
      }
    } else {
      this.logger.warn('Failed to load database object list. Falling back to on-demand metadata lookups.');
    }

    const entry: CacheEntry = {
      tables,
      routines,
      foreignKeys,
      timestamp: Date.now()
    };

    this.cache.set(key, entry);
    return entry;
  }

  private async populateColumns(
    connection: MssqlConnection | undefined,
    table: TableMetadata,
    options?: { database?: string }
  ): Promise<TableMetadata> {
    const queryDatabase = options?.database ?? connection?.database;
    this.logger.info(
      `[SchemaCache] Loading columns for ${queryDatabase ?? '<default>'}.${table.schema}.${table.name}`
    );
    const query = columnsForObjectQuery(table.schema, table.name, queryDatabase);
    const result = await this.api.runQuery(query, undefined, { useLegacyFallback: false });
    if (!result) {
  this.logger.warn(`Failed to load columns for ${queryDatabase ?? '<default>'}.${table.schema}.${table.name}.`);
      return table;
    }

    const columns: ColumnMetadata[] = result.rows.map((row: QueryResult['rows'][number]) => ({
      name: String(row['column_name'] ?? ''),
      dataType: formatDataType(row),
      maxLength: toNumber(row['max_length']),
      precision: toNumber(row['precision']),
      scale: toNumber(row['scale']),
      isNullable: toBoolean(row['is_nullable']),
      description: row['description'] ? String(row['description']) : undefined,
      isIdentity: toBoolean(row['is_identity']),
      isComputed: toBoolean(row['is_computed']),
      isRowGuid: toBoolean(row['is_rowguidcol']),
      defaultExpression: row['default_definition'] ? String(row['default_definition']) : undefined
    }));

    return { ...table, columns };
  }

  private async populateDescription(
    connection: MssqlConnection | undefined,
    table: TableMetadata,
    options?: { database?: string }
  ): Promise<TableMetadata> {
  const queryDatabase = options?.database ?? connection?.database;
  const query = extendedPropertyDescriptionQuery(table.schema, table.name, queryDatabase);
    const description = await this.api.runScalar<string>(query, { useLegacyFallback: false });
    return description ? { ...table, description } : table;
  }

  private async populateRoutineDefinition(connection: MssqlConnection | undefined, routine: RoutineMetadata): Promise<RoutineMetadata> {
    const definition = await this.api.runScalar<string>(
      routineDefinitionQuery(routine.schema, routine.name, connection?.database),
      { useLegacyFallback: false }
    );
    return definition ? { ...routine, definition } : routine;
  }

  private async populateRoutineParameters(connection: MssqlConnection | undefined, routine: RoutineMetadata): Promise<RoutineMetadata> {
    const result = await this.api.runQuery(
      routineParametersQuery(routine.schema, routine.name, connection?.database),
      undefined,
      { useLegacyFallback: false }
    );
    if (!result) {
      return routine;
    }

    const parameters: RoutineParameter[] = result.rows.map((row: QueryResult['rows'][number]) => ({
      name: String(row['parameter_name'] ?? ''),
      dataType: formatDataType(row),
      maxLength: toNumber(row['max_length']),
      precision: toNumber(row['precision']),
      scale: toNumber(row['scale']),
      isOutput: toBoolean(row['is_output'])
    }));

    return { ...routine, parameters };
  }

  private async loadTableOnDemand(
    connection: MssqlConnection | undefined,
    schema: string,
    name: string,
    options?: { database?: string }
  ): Promise<TableMetadata | undefined> {
    if (!connection) {
      return undefined;
    }

    let table: TableMetadata = {
      schema,
      name,
      type: 'TABLE'
    };

    table = await this.populateColumns(connection, table, options);
    if (!table.columns || table.columns.length === 0) {
      return undefined;
    }

    table = await this.populateDescription(connection, table, options);
    return table;
  }

  private async loadTableCrossDatabase(
    connection: MssqlConnection,
    database: string,
    schema: string,
    name: string
  ): Promise<TableMetadata | undefined> {
    const clone: MssqlConnection = {
      ...connection,
      database
    };

    const table = await this.loadTableOnDemand(clone, schema, name, { database });
    if (!table) {
      this.logger.warn(`Cross-database metadata not found for ${database}.${schema}.${name}.`);
    }
    return table;
  }
}

function toObjectKey(schema: string, name: string): string {
  return `${schema.toLowerCase()}.${name.toLowerCase()}`;
}

function toNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function toBoolean(value: unknown): boolean {
  if (typeof value === 'number') {
    return value !== 0;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true';
  }

  return Boolean(value);
}

function formatDataType(row: QueryResult['rows'][number]): string {
  const baseType = String(row['data_type'] ?? '');
  const precision = toNumber(row['precision']);
  const scale = toNumber(row['scale']);
  const maxLength = toNumber(row['max_length']);

  if (precision !== undefined && scale !== undefined && precision > 0) {
    return `${baseType}(${precision}, ${scale})`;
  }

  if (maxLength !== undefined && maxLength > 0 && !['ntext', 'text', 'image'].includes(baseType)) {
    if (maxLength === -1) {
      return `${baseType}(max)`;
    }
    return `${baseType}(${maxLength})`;
  }

  return baseType;
}
