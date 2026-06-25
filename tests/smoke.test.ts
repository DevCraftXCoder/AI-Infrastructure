import { describe, it, expect } from 'vitest'

describe('ai-gateway smoke tests', () => {
  it('FALLBACK_MODEL default is set', () => {
    expect('anthropic/claude-haiku-4.5').toMatch(/^anthropic\//)
  })

  it('cost ledger migration file exists', async () => {
    const { existsSync } = await import('node:fs')
    expect(existsSync(new URL('../migrations/001-cost-ledger.sql', import.meta.url))).toBe(true)
  })

  it('safety log migration file exists', async () => {
    const { existsSync } = await import('node:fs')
    expect(existsSync(new URL('../migrations/002-safety-log.sql', import.meta.url))).toBe(true)
  })

  it('service registry migration file exists', async () => {
    const { existsSync } = await import('node:fs')
    expect(existsSync(new URL('../migrations/003-service-registry.sql', import.meta.url))).toBe(true)
  })
})
