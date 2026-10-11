// The DATA room's formats. No number here is computed about the store: every count is the data
// layer's (fund_db); this file only prints them. Tests: test/data.test.ts.

export const fmtInt = (n: number | null | undefined) => (n == null ? '-' : Math.round(n).toLocaleString('en-US'))
/** bytes as the CLI prints them (decimal KB/MB/GB), so the room and `fund_db cache --usage` agree on the same cache */
export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '-'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0, v = n
  while (v >= 1000 && i < u.length - 1) { v /= 1000; i++ }   // decimal, as `fund_db cache --usage` prints it: the 500 MB budget reads 500 MB
  return i ? `${v.toFixed(v >= 100 ? 0 : 1)} ${u[i]}` : `${v} B`
}
