// The catalog fingerprint of a PostgreSQL database and the comparison of two of them, shared by the restore drill
// (scripts/restore-drill-lib.mjs re-exports it) and the migration CI test, which the public tree ships with packages/db.
// Pure: nothing here touches Docker, the network or the filesystem.

export function quoteIdent(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

export const USER_SCHEMA = (column) => `${column} !~ '^pg_' AND ${column} <> 'information_schema'`;
export const NOT_EXTENSION_MEMBER = (catalog, oid) =>
  `NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.classid = '${catalog}'::regclass AND e.objid = ${oid} AND e.deptype = 'e')`;
export const SORTED_STRINGS = (expression, from) =>
  `SELECT coalesce(jsonb_agg(x ORDER BY x), '[]'::jsonb)::text AS value FROM (SELECT ${expression} AS x ${from}) AS fingerprint`;

/** Catalog fingerprint categories. Each query returns one row with a `value`
 * column holding a JSON array of sorted strings. */
export const catalogFingerprintQueries = {
  database: SORTED_STRINGS(
    "concat_ws('|', pg_encoding_to_char(d.encoding), d.datcollate, d.datctype, d.datlocprovider, pg_get_userbyid(d.datdba))",
    "FROM pg_database d WHERE d.datname = current_database()"
  ),
  extensions: SORTED_STRINGS("concat_ws('|', e.extname, e.extversion, n.nspname)", "FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace"),
  columns: SORTED_STRINGS(
    `concat_ws('|', n.nspname, c.relname, c.relkind, row_number() OVER (PARTITION BY a.attrelid ORDER BY a.attnum), a.attname,
      format_type(a.atttypid, a.atttypmod), a.attnotnull, coalesce(pg_get_expr(d.adbin, d.adrelid, true), ''), a.attidentity, a.attgenerated)`,
    `FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND ${USER_SCHEMA("n.nspname")} AND ${NOT_EXTENSION_MEMBER("pg_class", "c.oid")}`
  ),
  constraints: SORTED_STRINGS(
    "concat_ws('|', n.nspname, coalesce(c.relname, ''), co.conname, co.contype, pg_get_constraintdef(co.oid, true), co.convalidated, co.condeferrable, co.condeferred)",
    `FROM pg_constraint co JOIN pg_namespace n ON n.oid = co.connamespace LEFT JOIN pg_class c ON c.oid = co.conrelid
      WHERE ${USER_SCHEMA("n.nspname")}`
  ),
  indexes: SORTED_STRINGS(
    "concat_ws('|', n.nspname, t.relname, i.relname, pg_get_indexdef(i.oid))",
    `FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE ${USER_SCHEMA("n.nspname")} AND ${NOT_EXTENSION_MEMBER("pg_class", "t.oid")}`
  ),
  triggers: SORTED_STRINGS(
    "concat_ws('|', n.nspname, c.relname, t.tgname, pg_get_triggerdef(t.oid, true), t.tgenabled)",
    `FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND ${USER_SCHEMA("n.nspname")}`
  ),
  functions: SORTED_STRINGS(
    "concat_ws('|', p.oid::regprocedure::text, p.prokind, md5(pg_get_functiondef(p.oid)))",
    `FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.prokind IN ('f', 'p') AND ${USER_SCHEMA("n.nspname")} AND ${NOT_EXTENSION_MEMBER("pg_proc", "p.oid")}`
  ),
  views: SORTED_STRINGS(
    "concat_ws('|', n.nspname, c.relname, c.relkind, md5(pg_get_viewdef(c.oid, true)))",
    `FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('v', 'm') AND ${USER_SCHEMA("n.nspname")} AND ${NOT_EXTENSION_MEMBER("pg_class", "c.oid")}`
  ),
  sequenceDefinitions: SORTED_STRINGS(
    "concat_ws('|', schemaname, sequencename, data_type, start_value, min_value, max_value, increment_by, cycle, cache_size)",
    `FROM pg_sequences WHERE ${USER_SCHEMA("schemaname")}`
  ),
  ownership: SORTED_STRINGS(
    "concat_ws('|', n.nspname, c.relname, c.relkind, pg_get_userbyid(c.relowner), coalesce(c.relacl::text, ''))",
    `FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') AND ${USER_SCHEMA("n.nspname")} AND ${NOT_EXTENSION_MEMBER("pg_class", "c.oid")}`
  )
};

export const CATALOG_CATEGORIES = Object.freeze(Object.keys(catalogFingerprintQueries));

/** Schema-only categories, comparable between two databases that were built
 * differently (for example an upgraded and a clean install): owners and ACLs
 * of the same objects are expected to match only for a restore. */
export const SCHEMA_CATEGORIES = Object.freeze(["extensions", "columns", "constraints", "indexes", "triggers", "functions", "views", "sequenceDefinitions"]);

export function migrationHistorySql(schema = "public") {
  return `SELECT jsonb_build_object(
      'count', count(*),
      'lastId', max(id),
      'rows', coalesce(jsonb_agg(concat_ws('|', id, filename, to_char(applied_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')) ORDER BY id), '[]'::jsonb)
    )::text AS value FROM ${quoteIdent(schema)}.space_schema_migrations`;
}

export function sample(values, limit = 20) {
  return values.length > limit ? [...values.slice(0, limit), `... ${values.length - limit} more`] : values;
}

/** Multiset difference of two sorted-string fingerprints for each category. */
export function compareCatalogs(source, restored, categories = CATALOG_CATEGORIES) {
  const differences = [];
  for (const category of categories) {
    const left = source[category] ?? [];
    const right = restored[category] ?? [];
    const remaining = new Map();
    for (const entry of right) remaining.set(entry, (remaining.get(entry) ?? 0) + 1);
    const onlyInSource = [];
    for (const entry of left) {
      const count = remaining.get(entry) ?? 0;
      if (count === 0) onlyInSource.push(entry);
      else remaining.set(entry, count - 1);
    }
    const onlyInRestored = [...remaining].flatMap(([entry, count]) => Array.from({ length: count }, () => entry));
    if (onlyInSource.length > 0 || onlyInRestored.length > 0) {
      differences.push({ category, onlyInSource: sample(onlyInSource), onlyInRestored: sample(onlyInRestored.sort()) });
    }
  }
  return differences;
}
