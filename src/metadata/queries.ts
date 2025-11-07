export function allObjectsQuery(database?: string): string {
  const scope = qualifyCatalogScope(database);
  return `
SELECT
    s.name AS schema_name,
    o.name AS object_name,
    o.type AS object_type,
    o.type_desc AS object_type_desc
FROM ${scope}sys.objects AS o
INNER JOIN ${scope}sys.schemas AS s ON s.schema_id = o.schema_id
WHERE o.type IN ('U', 'V', 'P', 'FN', 'IF', 'TF')
ORDER BY s.name, o.name;
`;
}

export function columnsForObjectQuery(schema: string, object: string, database?: string): string {
  const identifier = qualifyIdentifier(schema, object, database);
  const scope = qualifyCatalogScope(database);
  return `
SELECT
    c.name AS column_name,
    t.NAME AS data_type,
    c.max_length AS max_length,
    c.precision,
    c.scale,
    c.is_nullable,
    ep.value AS description
FROM ${scope}sys.columns AS c
INNER JOIN ${scope}sys.types AS t ON t.user_type_id = c.user_type_id
LEFT JOIN ${scope}sys.extended_properties AS ep ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description'
WHERE c.object_id = OBJECT_ID(N'${identifier}')
ORDER BY c.column_id;
`;
}

export function extendedPropertyDescriptionQuery(schema: string, object: string, database?: string): string {
  const scope = qualifyCatalogScope(database);
  return `
SELECT CAST(ep.value AS NVARCHAR(MAX)) AS description
FROM ${scope}sys.fn_listextendedproperty('MS_Description', 'SCHEMA', N'${escapeSqlLiteral(schema)}', 'TABLE', N'${escapeSqlLiteral(object)}', NULL, NULL);
`;
}

export function routineDefinitionQuery(schema: string, object: string, database?: string): string {
  const scope = qualifyCatalogScope(database);
  return `
SELECT
    sm.[definition]
FROM ${scope}sys.sql_modules AS sm
INNER JOIN ${scope}sys.objects AS o ON o.object_id = sm.object_id
INNER JOIN ${scope}sys.schemas AS sch ON sch.schema_id = o.schema_id
WHERE sch.name = N'${escapeSqlLiteral(schema)}'
  AND o.name = N'${escapeSqlLiteral(object)}';
`;
}

export function routineParametersQuery(schema: string, object: string, database?: string): string {
  const identifier = qualifyIdentifier(schema, object, database);
  const scope = qualifyCatalogScope(database);
  return `
SELECT
    p.parameter_id,
    p.name AS parameter_name,
    TYPE_NAME(p.user_type_id) AS data_type,
    p.max_length,
    p.precision,
    p.scale,
    p.is_output
FROM ${scope}sys.parameters AS p
WHERE p.object_id = OBJECT_ID(N'${identifier}')
ORDER BY p.parameter_id;
`;
}

export function foreignKeysQuery(database?: string): string {
  const scope = qualifyCatalogScope(database);
  return `
SELECT
    fk.name AS constraint_name,
    sch_parent.name AS parent_schema,
    parent_object.name AS parent_table,
    sch_ref.name AS referenced_schema,
    referenced_object.name AS referenced_table,
    parent_column.name AS parent_column,
    referenced_column.name AS referenced_column
FROM ${scope}sys.foreign_keys AS fk
INNER JOIN ${scope}sys.foreign_key_columns AS fkc ON fkc.constraint_object_id = fk.object_id
INNER JOIN ${scope}sys.tables AS parent_object ON parent_object.object_id = fk.parent_object_id
INNER JOIN ${scope}sys.schemas AS sch_parent ON sch_parent.schema_id = parent_object.schema_id
INNER JOIN ${scope}sys.tables AS referenced_object ON referenced_object.object_id = fk.referenced_object_id
INNER JOIN ${scope}sys.schemas AS sch_ref ON sch_ref.schema_id = referenced_object.schema_id
INNER JOIN ${scope}sys.columns AS parent_column ON parent_column.object_id = fk.parent_object_id AND parent_column.column_id = fkc.parent_column_id
INNER JOIN ${scope}sys.columns AS referenced_column ON referenced_column.object_id = fk.referenced_object_id AND referenced_column.column_id = fkc.referenced_column_id;
`;
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''").replace(/\]/g, ']]');
}

function escapeSqlIdentifier(value: string): string {
  return value.replace(/\]/g, ']]');
}

function qualifyIdentifier(schema: string, object: string, database?: string): string {
  const databasePart = database ? `[${escapeSqlIdentifier(database)}].` : '';
  const schemaPart = `[${escapeSqlIdentifier(schema)}]`;
  const objectPart = `[${escapeSqlIdentifier(object)}]`;
  return `${databasePart}${schemaPart}.${objectPart}`;
}

function qualifyCatalogScope(database?: string): string {
  return database ? `[${escapeSqlIdentifier(database)}].` : '';
}
