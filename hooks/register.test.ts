import { describe, expect, test } from 'claude-code/testing'

import { select, slim } from './register'

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
    expect(slim(record())?.labels).toEqual(['draws'])
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
