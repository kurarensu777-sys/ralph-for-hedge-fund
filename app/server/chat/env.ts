// THE CREDENTIAL BOUNDARY (ported from machine/server/agent.ts, where it was measured and pinned).
//
// Every agent here works on a repo whose whole subject is EXCHANGES, and this machine's operator
// may keep venue keys or a broker login in the environment fundd inherits. An agent that can read
// BINANCE_API_SECRET can place an order; one that can read IBKR_PASSWORD can place a stock trade.
// Nothing in the cockpit has an armed execution path, and the way it stays that way is that
// credentials NEVER CROSS THE SPAWN BOUNDARY - not that the call sites are careful.
//
// The pattern is deliberately broad (any *_KEY, any TOKEN, any PASSPHRASE, every venue name, IBKR)
// and the exemption deliberately narrow: ANTHROPIC_* / CLAUDE_* are the only vars a hand needs to
// exist at all. NODE_ENV / INIT_CWD / npm_* describe fundd's own `npm run dev` and are false about
// the folder the agent sits in (NODE_ENV=development broke every `next build` from an agent shell
// at the old cockpit), so they go too.
//
// The same scrub runs over the `env` of every MCP server a seat carries (launch.ts mcpServers), so
// a .mcp.json cannot hand a credential across the boundary either.
//
// test/chats-env.test.ts pins every clause - extend it in the same commit as this list.

const RAIL_SECRETS = new Set(['AGENTMAIL_API_KEY', 'MAIL_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN'])
const VENUE_SECRET = /(API|SECRET|PRIVATE)_?KEY|TOKEN|PASSPHRASE|PASSWORD|IBKR|BINANCE|BYBIT|OKX|HYPERLIQUID|MEXC|GATE|KUCOIN|BITGET|DERIBIT|EODHD/i
const KEEP_ALWAYS = /^(ANTHROPIC|CLAUDE)_/

export const LEAKED = (k: string): boolean =>
  k === 'NODE_ENV' || k === 'INIT_CWD' || k.startsWith('npm_') ||
  RAIL_SECRETS.has(k) ||
  (!KEEP_ALWAYS.test(k) && VENUE_SECRET.test(k))

export function agentEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) if (!LEAKED(k)) out[k] = v
  return out
}

/** Prepend dirs to PATH, rewriting the EXISTING key (Windows spells it `Path`), never duplicating. */
export function prependPath(env: Record<string, string | undefined>, dirs: string[], sep = process.platform === 'win32' ? ';' : ':'): Record<string, string | undefined> {
  const out = { ...env }
  const key = Object.keys(out).find(k => k.toUpperCase() === 'PATH') ?? 'PATH'
  const cur = out[key] ?? ''
  const norm = (d: string) => d.trim().replace(/[\\/]+$/, '').toLowerCase()
  const have = new Set(cur.split(sep).filter(Boolean).map(norm))
  const add = dirs.filter(d => !have.has(norm(d)))
  out[key] = [...add, ...(cur ? [cur] : [])].join(sep)
  return out
}
