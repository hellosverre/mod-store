import { describe, expect, test } from 'claude-code/testing'

import { fetchCatalogText, noLabels, select, slim } from './register'

const record = (over: Record<string, unknown> = {}) => ({
  id: 'a/b:x',
  kind: 'mod',
  name: 'x',
  repo: 'a/b',
  description: 'A spotify band',
  stars: 3,
  createdAt: '2026-10-01T00:00:00Z',
  reach: { level: 0, name: 'draws and remembers', labels: ['draws', 'other: $.state.get'] },
  sees: [],
  draws: ['AbovePrompt'],
  validate: { status: 'passed' },
  marketplaces: [{ path: '.claude-plugin/marketplace.json', name: 'b', status: 'passed' }],
  ...over,
})

describe('slim', () => {
  test('keeps mods, drops fixtures and archived repos', async () => {
    expect(slim(record())?.name).toBe('x')
    expect(slim(record({ kind: 'fixture' }))).toBeNull()
    expect(slim(record({ archived: true }))).toBeNull()
  })

  test('installs only from a root marketplace, and hides internal labels', async () => {
    expect(slim(record())?.marketplace).toBe('b')
    const nested = record({ marketplaces: [{ path: 'x/.claude-plugin/marketplace.json', name: 'n', status: 'passed' }] })
    expect(slim(nested)?.marketplace).toBeNull()
    expect(slim(record())?.labels).toEqual(['draws', 'also uses $.state.get'])
  })
})

describe('select', () => {
  const mods = [
    slim(record({ id: '1', name: 'alpha', stars: 1, description: 'git branches', draws: ['Pane'] }))!,
    slim(record({ id: '2', name: 'beta', stars: 9, reach: { level: 3, name: 'network', labels: [] } }))!,
    slim(record({ id: '3', name: 'gamma', stars: 5, marketplaces: [] }))!,
  ]

  test('sorts by stars by default and searches every word', async () => {
    expect(select(mods, '', 'all', 'stars').map(m => m.name)).toEqual(['beta', 'gamma', 'alpha'])
    expect(select(mods, 'GIT bran', 'all', 'stars').map(m => m.name)).toEqual(['alpha'])
  })

  test('filters', async () => {
    expect(select(mods, '', 'safe', 'name').map(m => m.name)).toEqual(['alpha', 'gamma'])
    expect(select(mods, '', 'installable', 'name').map(m => m.name)).toEqual(['alpha', 'beta'])
    expect(select(mods, '', 'pane', 'name').map(m => m.name)).toEqual(['alpha'])
  })

  test('one big repo does not fill the top of the star sort', async () => {
    const big = ['b1', 'b2', 'b3'].map(n => slim(record({ id: n, name: n, repo: 'big/r', stars: 900 }))!)
    const small = slim(record({ id: 's', name: 's', repo: 'small/r', stars: 4 }))!
    expect(select([...big, small], '', 'all', 'stars').map(m => m.name)).toEqual(['b1', 's', 'b2', 'b3'])
  })
})

describe('access labels', () => {
  test('an ungraded API stays in the labels, so a spawner never reads as draw only', async () => {
    const spawner = slim(record({ reach: { level: 0, name: 'draws', labels: ['draws', 'other: $.process.spawn'] } }))!
    expect(spawner.labels).toEqual(['draws', 'also uses $.process.spawn'])
    expect(spawner.labels.join(', ')).not.toBe('draw only')
  })

  test('only a display-only mod with no labels is called draw only', async () => {
    const quiet = slim(record({ reach: { level: 0, name: 'draws', labels: [] } }))!
    const runner = slim(record({ reach: { level: 2, name: 'runs', labels: [] } }))!
    expect(noLabels(quiet)).toBe('draw only')
    expect(noLabels(runner)).toBe('writes & runs (the catalogue lists no details)')
  })
})

describe('fetchCatalogText', () => {
  // A host that decodes each range on its own, the way $.http.fetch does.
  const host = (body: string, chunk: number) => {
    const bytes = new TextEncoder().encode(body)
    return {
      http: {
        fetch: async (_url: string, init: { headers: Record<string, string> }) => {
          const [from, to] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range)!.slice(1).map(Number) as [number, number]
          const slice = bytes.slice(from, Math.min(to + 1, from + chunk))
          return {
            status: 206,
            ok: true,
            headers: { 'content-range': `bytes ${from}-${from + slice.length - 1}/${bytes.length}` },
            text: new TextDecoder().decode(slice),
          }
        },
      },
    } as any
  }

  test('a character split across two ranges comes through whole', async () => {
    // 2,000,000 bytes per range: put a 3-byte and a 4-byte character across the boundary.
    const body = `${'a'.repeat(1_999_999)}č${'b'.repeat(1_999_998)}é漢😀 end`
    expect(await fetchCatalogText(host(body, 2_000_000))).toBe(body)
  })

  test('a body that splits nothing comes through as is', async () => {
    const body = JSON.stringify({ mods: [{ name: 'x', description: '한국어 설명' }] })
    expect(await fetchCatalogText(host(body, 2_000_000))).toBe(body)
  })
})
