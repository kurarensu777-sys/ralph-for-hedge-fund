/**
 * The generic, validated table layer under the ops functions - the node twin of fund_db.ops.table.
 * Every table and column name is checked against the GENERATED registry (rows.ts TABLES) before it
 * is quoted into SQL, and every value is bound as a parameter.
 *
 *   insert(table, row)            upsert(table, row, { update })     get(table, pk)
 *   select(table, { where, orderBy, limit })   update(table, pk, fields)   del(table, pk)   count(table, where)
 *
 * `del` is python's `delete` (a reserved word here). Rows come back as the generated Row types:
 * jsonb parsed, booleans as boolean, bigint (ms, ids) as number.
 */
import { one, query, exec, type Queryable } from './db.ts'
import { TABLES, type Rows, type TableName, type TableSpec } from './rows.ts'

export const SCHEMA = 'ops'
export const nowMs = (): number => Date.now()

export type Where<T> = { [K in keyof T]?: T[K] | T[K][] | null }

export function spec(table: string): TableSpec {
  const s = (TABLES as Record<string, TableSpec>)[table]
  if (!s) throw new Error(`no ops table ${JSON.stringify(table)} (known: ${Object.keys(TABLES).sort().join(', ')})`)
  return s
}

export function checkCols(table: string, cols: string[], writable = false): string[] {
  const s = spec(table)
  const bad = cols.filter(c => !s.columns.includes(c))
  if (bad.length) throw new Error(`ops.${table} has no column(s) ${JSON.stringify(bad)}`)
  if (writable) {
    const gen = cols.filter(c => s.generated.includes(c))
    if (gen.length) throw new Error(`ops.${table}: ${JSON.stringify(gen)} is generated and cannot be written`)
  }
  return cols
}

export const qi = (name: string): string => `"${name.replace(/"/g, '""')}"`
export const ident = (table: string): string => { spec(table); return `${SCHEMA}.${qi(table)}` }
export const readable = (table: string): string => {
  const s = spec(table)
  return s.columns.filter(c => !s.generated.includes(c)).map(qi).join(', ')
}

/** jsonb as JSON text (node-postgres would turn a JS array into a PG array), 0/1 flags as boolean */
export function adapt(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const s = spec(table)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue
    if (v !== null && s.json.includes(k)) out[k] = JSON.stringify(v)
    else if (v !== null && s.bool.includes(k)) out[k] = Boolean(v)
    else out[k] = v
  }
  return out
}

function defined(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined))
}

export function whereSql(table: string, where: Record<string, unknown> | undefined, args: unknown[]): string {
  if (!where) return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined) continue
    checkCols(table, [k])
    if (v === null) parts.push(`${qi(k)} IS NULL`)
    else if (Array.isArray(v)) { args.push(v); parts.push(`${qi(k)} = ANY($${args.length})`) }
    else { args.push(spec(table).bool.includes(k) ? Boolean(v) : v); parts.push(`${qi(k)} = $${args.length}`) }
  }
  return parts.length ? ` WHERE ${parts.join(' AND ')}` : ''
}

export function orderSql(table: string, orderBy: string | string[] | undefined): string {
  if (!orderBy) return ''
  const items = Array.isArray(orderBy) ? orderBy : [orderBy]
  return ' ORDER BY ' + items.map(o => {
    const desc = o.startsWith('-')
    const col = desc ? o.slice(1) : o
    checkCols(table, [col])
    return `${qi(col)} ${desc ? 'DESC' : 'ASC'}`
  }).join(', ')
}

function pkWhere(table: string, pk: unknown[], args: unknown[]): string {
  const keys = spec(table).pk
  if (pk.length !== keys.length) throw new Error(`ops.${table} primary key is (${keys.join(', ')}); got ${pk.length} value(s)`)
  return ' WHERE ' + keys.map((k, i) => { args.push(pk[i]); return `${qi(k)} = $${args.length}` }).join(' AND ')
}

const asPk = (pk: unknown): unknown[] => (Array.isArray(pk) ? pk : [pk])

export async function insert<T extends TableName>(table: T, row: Partial<Rows[T]>, q?: Queryable): Promise<Rows[T]> {
  const r = defined(row as Record<string, unknown>)
  const cols = checkCols(table, Object.keys(r), true)
  const missing = spec(table).required.filter(c => !(c in r))
  if (missing.length) throw new Error(`ops.${table}: required column(s) ${JSON.stringify(missing)} missing`)
  const v = adapt(table, r)
  const sql = `INSERT INTO ${ident(table)} (${cols.map(qi).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING ${readable(table)}`
  return (await one<Rows[T]>(sql, cols.map(c => v[c]), q))!
}

/** INSERT, or on a primary-key conflict UPDATE `update` (default: every non-key column given) */
export async function upsert<T extends TableName>(table: T, row: Partial<Rows[T]>, opts: { update?: string[] } = {}, q?: Queryable): Promise<Rows[T]> {
  const r = defined(row as Record<string, unknown>)
  const cols = checkCols(table, Object.keys(r), true)
  const s = spec(table)
  if (s.pk.some(k => !(k in r) && !s.identity.includes(k))) throw new Error(`ops.${table}: upsert needs the primary key ${JSON.stringify(s.pk)}`)
  const upd = checkCols(table, opts.update ?? cols.filter(c => !s.pk.includes(c)), true)
  const v = adapt(table, r)
  const action = upd.length ? `DO UPDATE SET ${upd.map(c => `${qi(c)} = EXCLUDED.${qi(c)}`).join(', ')}` : 'DO NOTHING'
  const sql = `INSERT INTO ${ident(table)} (${cols.map(qi).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) ` +
    `ON CONFLICT (${s.pk.map(qi).join(', ')}) ${action} RETURNING ${readable(table)}`
  const got = await one<Rows[T]>(sql, cols.map(c => v[c]), q)
  return got ?? (await get(table, s.pk.map(k => r[k]), q))!
}

export async function get<T extends TableName>(table: T, pk: unknown, q?: Queryable): Promise<Rows[T] | null> {
  const args: unknown[] = []
  const w = pkWhere(table, asPk(pk), args)
  return one<Rows[T]>(`SELECT ${readable(table)} FROM ${ident(table)}${w}`, args, q)
}

export async function select<T extends TableName>(table: T, opts: { where?: Where<Rows[T]>; orderBy?: string | string[]; limit?: number } = {}, q?: Queryable): Promise<Rows[T][]> {
  const args: unknown[] = []
  let sql = `SELECT ${readable(table)} FROM ${ident(table)}${whereSql(table, opts.where as Record<string, unknown>, args)}${orderSql(table, opts.orderBy)}`
  if (opts.limit !== undefined) { args.push(Math.trunc(opts.limit)); sql += ` LIMIT $${args.length}` }
  return query<Rows[T]>(sql, args, q)
}

/** set `fields` on the row with primary key `pk` (a value, or an array for a composite key) */
export async function update<T extends TableName>(table: T, pk: unknown, fields: Partial<Rows[T]>, q?: Queryable): Promise<Rows[T] | null> {
  const f = defined(fields as Record<string, unknown>)
  if (!Object.keys(f).length) return get(table, pk, q)
  const cols = checkCols(table, Object.keys(f), true)
  if (cols.some(c => spec(table).pk.includes(c))) throw new Error(`ops.${table}: the primary key is not updatable here`)
  const v = adapt(table, f)
  const args: unknown[] = cols.map(c => v[c])
  const set = cols.map((c, i) => `${qi(c)} = $${i + 1}`).join(', ')
  const w = pkWhere(table, asPk(pk), args)
  return one<Rows[T]>(`UPDATE ${ident(table)} SET ${set}${w} RETURNING ${readable(table)}`, args, q)
}

export async function del(table: TableName, pk: unknown, q?: Queryable): Promise<number> {
  const args: unknown[] = []
  const w = pkWhere(table, asPk(pk), args)
  return exec(`DELETE FROM ${ident(table)}${w}`, args, q)
}

export async function count<T extends TableName>(table: T, where?: Where<Rows[T]>, q?: Queryable): Promise<number> {
  const args: unknown[] = []
  const r = await one<{ n: number }>(`SELECT count(*) AS n FROM ${ident(table)}${whereSql(table, where as Record<string, unknown>, args)}`, args, q)
  return r!.n
}
