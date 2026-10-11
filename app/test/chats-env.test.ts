import { describe, expect, it } from 'vitest'
import { agentEnv, LEAKED, prependPath } from '../server/chat/env.ts'

// THE CREDENTIAL BOUNDARY, pinned (ported from machine/test/agent-env.test.ts). Every clause of
// LEAKED gets a case; adding a venue means adding a row here in the same commit.
describe('agentEnv', () => {
  const base: Record<string, string> = {
    AGENTMAIL_API_KEY: 'am_secret', MAIL_BOT_TOKEN: '111:mail', TELEGRAM_BOT_TOKEN: '222:office',
    BINANCE_API_KEY: 'bn', BINANCE_API_SECRET: 'bn_s', BYBIT_API_KEY: 'by', OKX_PASSPHRASE: 'okx_p',
    HYPERLIQUID_PRIVATE_KEY: '0xdead', MEXC_KEY: 'mx', GATE_SECRET_KEY: 'gt', KUCOIN_API_PASSPHRASE: 'kc',
    BITGET_TOKEN: 'bg', IBKR_PASSWORD: 'ib', IBKR_ACCOUNT: 'U123', COINGECKO_API_KEY: 'cg', EODHD_API_KEY: 'eo',
    ANTHROPIC_API_KEY: 'sk-ant-x', ANTHROPIC_AUTH_TOKEN: 'tok', CLAUDE_CODE_OAUTH_TOKEN: 'cc',
    FUND_AGENT: 'fund', FUND_CONVERSATION: 'c-1', FUND_ROOT: 'C:\\dev\\fund',
    PATH: '/usr/bin', HOME: '/home/c', NODE_ENV: 'development', npm_config_x: '1', INIT_CWD: '/somewhere',
  }

  it('strips every venue and broker credential', () => {
    const out = agentEnv(base)
    for (const k of ['BINANCE_API_KEY', 'BINANCE_API_SECRET', 'BYBIT_API_KEY', 'OKX_PASSPHRASE', 'HYPERLIQUID_PRIVATE_KEY',
      'MEXC_KEY', 'GATE_SECRET_KEY', 'KUCOIN_API_PASSPHRASE', 'BITGET_TOKEN', 'IBKR_PASSWORD', 'IBKR_ACCOUNT', 'EODHD_API_KEY'])
      expect(out[k], `${k} reached the agent`).toBeUndefined()
  })

  it('strips a credential-shaped var from a venue nobody has named yet', () => {
    const out = agentEnv({ ...base, DERIBIT_API_KEY: 'x', SOME_SECRET_KEY: 'y', RANDOM_TOKEN: 'z', DB_PASSWORD: 'p' })
    for (const k of ['DERIBIT_API_KEY', 'SOME_SECRET_KEY', 'RANDOM_TOKEN', 'DB_PASSWORD', 'COINGECKO_API_KEY']) expect(out[k]).toBeUndefined()
  })

  it('strips the named rails', () => {
    const out = agentEnv(base)
    expect(out.AGENTMAIL_API_KEY).toBeUndefined()
    expect(out.MAIL_BOT_TOKEN).toBeUndefined()
    expect(out.TELEGRAM_BOT_TOKEN).toBeUndefined()
  })

  it('keeps ANTHROPIC_*/CLAUDE_* - the one exemption, and it is narrow', () => {
    const out = agentEnv(base)
    expect(out.ANTHROPIC_API_KEY).toBe('sk-ant-x')
    expect(out.ANTHROPIC_AUTH_TOKEN).toBe('tok')
    expect(out.CLAUDE_CODE_OAUTH_TOKEN).toBe('cc')
    expect(LEAKED('XANTHROPIC_API_KEY')).toBe(true)
  })

  it('keeps the FUND_* identity', () => {
    const out = agentEnv(base)
    expect(out.FUND_AGENT).toBe('fund')
    expect(out.FUND_CONVERSATION).toBe('c-1')
    expect(out.FUND_ROOT).toBe('C:\\dev\\fund')
  })

  it('strips the npm/dev noise and keeps the rest', () => {
    const out = agentEnv(base)
    expect(out.NODE_ENV).toBeUndefined()
    expect(out.npm_config_x).toBeUndefined()
    expect(out.INIT_CWD).toBeUndefined()
    expect(out.PATH).toBe('/usr/bin')
    expect(out.HOME).toBe('/home/c')
  })

  it('leaves an env with no secrets in it untouched', () => {
    expect(agentEnv({ PATH: '/bin', HOME: '/h' })).toEqual({ PATH: '/bin', HOME: '/h' })
  })
})

describe('prependPath', () => {
  it('puts the directories first, in order, keeping what was there', () => {
    expect(prependPath({ PATH: 'C:\\bin;C:\\other' }, ['C:\\dev\\fund', 'C:\\venv'], ';').PATH).toBe('C:\\dev\\fund;C:\\venv;C:\\bin;C:\\other')
  })
  it('rewrites the EXISTING key rather than adding a second spelling (Windows says `Path`)', () => {
    const out = prependPath({ Path: 'C:\\bin' }, ['C:\\dev\\fund'], ';')
    expect(out.Path).toBe('C:\\dev\\fund;C:\\bin')
    expect(out.PATH).toBeUndefined()
  })
  it('never duplicates a directory that is already on PATH', () => {
    expect(prependPath({ PATH: 'C:\\dev\\fund;C:\\bin' }, ['C:\\dev\\fund\\', 'C:\\venv'], ';').PATH).toBe('C:\\venv;C:\\dev\\fund;C:\\bin')
  })
  it('works from an env with no PATH at all', () => {
    expect(prependPath({}, ['C:\\dev\\fund'], ';').PATH).toBe('C:\\dev\\fund')
  })
})
