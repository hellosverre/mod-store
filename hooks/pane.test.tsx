import { expect, mock, test } from 'claude-code/testing'

import { slim } from './register'

const mod = slim({
  id: 'a/b:spot', kind: 'mod', name: 'spot', repo: 'a/b', description: 'A spotify band', stars: 7,
  reach: { level: 0, name: 'draws', labels: [] }, sees: [], draws: ['AbovePrompt'],
  validate: { status: 'passed' }, marketplaces: [{ path: '.claude-plugin/marketplace.json', name: 'b', status: 'passed' }],
})!

test('clicking a mod opens its page', async ($, on) => {
  mock.clock(on, { now: 1000 })
  mock.store(on, { 'catalog-v2': { at: 1000, mods: [mod] } })
  on('ui.open', async () => ({ value: { isOpen: true } }) as any)
  on('process.run', async () => ({ value: { exitCode: 0, stdout: '[]', stderr: '' } }) as any)
  await $.command.run({ command: 'mods', args: '' } as any)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'mod-store', surface, component: 'Pane', requestId: 'mod-store', props: {} } as any)
    await ui.press({ key: `more-${mod.id}` })
    expect(await ui.find({ key: 'back' })).toBeDefined()
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
})

test('Claude can search the catalogue and open a mod', async ($, on) => {
  mock.clock(on, { now: 1000 })
  mock.store(on, { 'catalog-v2': { at: 1000, mods: [mod] } })
  on('ui.open', async () => ({ value: { isOpen: true } }) as any)
  on('process.run', async () => ({ value: { exitCode: 0, stdout: '[]', stderr: '' } }) as any)
  await $.classic.SessionStart({ source: 'startup' } as any).catch(() => {})
  const found: any = await $.tool.call({ tool: 'mcp__mod-store__search_mods', query: 'spotify' } as any)
  expect(String(found.result)).toContain('spot (id a/b:spot)')
  const shown: any = await $.tool.call({ tool: 'mcp__mod-store__show_mod', id: 'a/b:spot' } as any)
  expect(String(shown.result)).toContain('Opened spot')
  const ui = await $.ui.mount({ plugin: 'mod-store', surface: 'terminal', component: 'Pane', requestId: 'mod-store', props: {} } as any)
  expect(await ui.find({ key: 'back' })).toBeDefined()
})
