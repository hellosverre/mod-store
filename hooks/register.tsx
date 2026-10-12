import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Filter, Mod, Sort } from '../types'

const PANE = 'mod-store'
const CATALOG_URL = 'https://mods.aidojo.si/mods.json'
// v2: v1 copies dropped the catalogue's `other:` access labels.
const CACHE_KEY = 'catalog-v2'
const MAX_AGE_MS = 6 * 60 * 60 * 1000
/** The host cuts long bodies short, so the 7.5 MB catalogue comes in ranges. */
const CHUNK_BYTES = 2_000_000
const PER_PAGE = 12

const query = atom({ plugin: 'mod-store', key: 'query' } as const, '')
const sort = atom({ plugin: 'mod-store', key: 'sort' } as const, 'stars')
const filter = atom({ plugin: 'mod-store', key: 'filter' } as const, 'all')
const page = atom({ plugin: 'mod-store', key: 'page' } as const, 0)
const selected = atom({ plugin: 'mod-store', key: 'selected' } as const, null)
const isConfirming = atom({ plugin: 'mod-store', key: 'isConfirming' } as const, false)
const isBusy = atom({ plugin: 'mod-store', key: 'isBusy' } as const, false)
const status = atom({ plugin: 'mod-store', key: 'status' } as const, '')
const loadedAt = atom({ plugin: 'mod-store', key: 'loadedAt' } as const, 0)
const installed = atom({ plugin: 'mod-store', key: 'installed' } as const, [])

/** Access levels, least to most: what the badge says and its color. */
const LEVELS = [
  { badge: 'Display only', color: 'green' },
  { badge: 'Reads', color: 'cyan' },
  { badge: 'Writes & runs', color: 'yellow' },
  { badge: 'Network', color: 'red' },
]

const SORTS = [
  { value: 'stars', label: 'Most stars' },
  { value: 'new', label: 'Newest' },
  { value: 'name', label: 'A to Z' },
]
const CHIPS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'installable', label: 'One-click' },
  { value: 'safe', label: 'Display only' },
  { value: 'pane', label: 'Panes' },
  { value: 'band', label: 'Bands' },
]

/** Where a mod shows up, in words. */
const PLACES: Record<string, string> = {
  Pane: 'a side pane',
  AbovePrompt: 'a band above the prompt',
  PromptHint: 'the prompt hint',
  SessionMode: 'the session mode line',
  AssistantMessage: "Claude's replies",
  UserMessage: 'your messages',
  Spinner: 'the spinner',
  ToolUse: 'tool rows',
  ToolResult: 'tool results',
  CommandOutput: 'command output',
}

/** The catalogue, slimmed. A module variable: rebuilt from the store on reload. */
let catalog: Mod[] = []

/**
 * The catalogue files APIs it has no grade for under `other: $.api`. They are kept,
 * reworded, so a mod that spawns processes never reads as "draw only".
 */
export const accessLabel = (label: string): string =>
  label.startsWith('other:') ? `also uses ${label.slice('other:'.length).trim()}` : label

/** Turns one catalogue record into the fields the pane draws. */
export function slim(record: any): Mod | null {
  if (record?.kind !== 'mod' || record.archived) return null
  const root = (record.marketplaces ?? []).find(
    (m: any) => m.path === '.claude-plugin/marketplace.json' && m.status !== 'failed',
  )
  return {
    id: String(record.id),
    name: String(record.name),
    repo: String(record.repo),
    description: String(record.description ?? '').slice(0, 240),
    author: String(record.author ?? record.repo.split('/')[0]),
    url: String(record.url ?? `https://github.com/${record.repo}`),
    stars: Number(record.stars ?? 0),
    createdAt: String(record.createdAt ?? ''),
    level: Number(record.reach?.level ?? 2),
    levelName: String(record.reach?.name ?? 'unknown'),
    labels: (record.reach?.labels ?? []).map(accessLabel),
    sees: record.sees ?? [],
    draws: record.draws ?? [],
    validate: String(record.validate?.status ?? 'unknown'),
    marketplace: root ? String(root.name) : null,
  }
}

/** The mods a query, filter and sort select, in order. */
export function select(mods: Mod[], q: string, f: Filter, s: Sort): Mod[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const kept = mods.filter(mod => {
    if (f === 'installable' && !mod.marketplace) return false
    if (f === 'safe' && mod.level > 0) return false
    if (f === 'pane' && !mod.draws.includes('Pane')) return false
    if (f === 'band' && !mod.draws.includes('AbovePrompt')) return false
    const hay = `${mod.name} ${mod.description} ${mod.author} ${mod.repo}`.toLowerCase()
    return words.every(w => hay.includes(w))
  })
  const order: Record<Sort, (a: Mod, b: Mod) => number> = {
    stars: (a, b) => b.stars - a.stars || a.name.localeCompare(b.name),
    new: (a, b) => b.createdAt.localeCompare(a.createdAt),
    name: (a, b) => a.name.localeCompare(b.name),
  }
  const sorted = kept.sort(order[s])
  if (s !== 'stars') return sorted
  // Stars belong to a repo, not a mod: one big repo with 45 mods would fill
  // every page. Take each repo's best first, then each one's second, and so on.
  const seen = new Map<string, number>()
  const turn = new Map(sorted.map(mod => {
    const n = seen.get(mod.repo) ?? 0
    seen.set(mod.repo, n + 1)
    return [mod, n] as const
  }))
  return sorted.sort((a, b) => turn.get(a)! - turn.get(b)! || order.stars(a, b))
}

/** The id `claude plugin list` names an installed mod by. */
const pluginId = (mod: Mod) => `${mod.name}@${mod.marketplace}`

const level = (mod: Mod) => LEVELS[mod.level] ?? LEVELS[2]!

/** What the confirmation says when the catalogue lists no access. Only a display-only mod is "draw only". */
export const noLabels = (mod: Mod): string =>
  mod.level === 0 ? 'draw only' : `${(LEVELS[mod.level] ?? LEVELS[2]!).badge.toLowerCase()} (the catalogue lists no details)`

const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)

/** UTF-8 bytes `text` takes. */
const utf8Bytes = (text: string): number => {
  let n = 0
  for (const char of text) {
    const code = char.codePointAt(0)!
    n += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return n
}

/**
 * Reads the whole catalogue a range at a time, since one body is cut short. The host
 * decodes each range on its own, so a character split across two ranges comes back as
 * U+FFFD at the end of the first. That tail is dropped and the next range starts at the
 * first byte not yet read whole.
 */
export async function fetchCatalogText($: Pick<EngineInterface, 'http'>): Promise<string> {
  let text = ''
  let total = Infinity
  let start = 0
  while (start < total) {
    const res = await $.http.fetch(CATALOG_URL, {
      headers: { Range: `bytes=${start}-${start + CHUNK_BYTES - 1}`, 'Accept-Encoding': 'identity' },
    })
    if (res.status === 200) return res.text
    if (res.status !== 206) throw new Error(`HTTP ${res.status}`)
    const size = /\/(\d+)\s*$/.exec(res.headers['content-range'] ?? '')
    if (!size) throw new Error('the server sent no Content-Range')
    total = Number(size[1])
    const isLast = start + CHUNK_BYTES >= total
    const whole = isLast ? res.text : res.text.replace(/�+$/, '')
    if (whole === '') throw new Error(`no readable text at byte ${start}`)
    text += whole
    start += isLast ? CHUNK_BYTES : utf8Bytes(whole)
  }
  return text
}

async function loadCatalog($: EngineInterface, force = false) {
  const cached = (await $.store.get(CACHE_KEY)) as { at: number; mods: Mod[] } | undefined
  if (cached && catalog.length === 0) {
    catalog = cached.mods
    await update($, loadedAt, () => cached.at)
  }
  const now = await $.clock.now()
  if (!force && cached && now - cached.at < MAX_AGE_MS) return

  await update($, status, () => (catalog.length ? 'Refreshing…' : ''))
  try {
    const data = JSON.parse(await fetchCatalogText($))
    const mods: Mod[] = []
    const seen = new Set<string>()
    for (const record of data.mods ?? []) {
      const mod = slim(record)
      if (!mod || seen.has(mod.id)) continue
      seen.add(mod.id)
      mods.push(mod)
    }
    catalog = mods
    await $.store.set(CACHE_KEY, { at: now, mods })
    await update($, loadedAt, () => now)
    await update($, status, () => '')
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    await update($, status, () => `Couldn't load the catalogue (${why})`)
  }
}

async function loadInstalled($: EngineInterface) {
  try {
    const { exitCode, stdout } = await $.process.run(['claude', 'plugin', 'list', '--json'])
    if (exitCode !== 0) return
    const ids = (JSON.parse(stdout) as { id: string }[]).map(p => p.id)
    await update($, installed, () => ids)
  } catch {
    // Not fatal: the pane just shows no "installed" marks.
  }
}

async function install($: EngineInterface, mod: Mod) {
  if (!mod.marketplace) return
  await update($, isBusy, () => true)
  await update($, status, () => '')
  try {
    const { exitCode, stdout, stderr } = await $.process.run(
      ['claude', 'plugin', 'install', mod.name, '--marketplace', mod.repo],
      { timeoutMs: 120_000 },
    )
    if (exitCode === 0) {
      $.ui.toast(`Installed ${mod.name}. Run /reload-plugins to load it.`)
      await loadInstalled($)
    } else {
      const why = (stderr || stdout).trim().split('\n').slice(-3).join(' ')
      await update($, status, () => `Install failed: ${why}`)
    }
  } catch (error) {
    await update($, status, () => `Install failed: ${error instanceof Error ? error.message : error}`)
  }
  await update($, isConfirming, () => false)
  await update($, isBusy, () => false)
}

/** One mod as Claude reads it in a tool result. */
function describe(mod: Mod, owned: Set<string>): string {
  const tier = level(mod)
  const how = !mod.marketplace ? 'manual install' : owned.has(pluginId(mod)) ? 'installed' : 'one-click install'
  return [
    `- ${mod.name} (id ${mod.id}) by ${mod.author}, ★${mod.stars} for ${mod.repo}, ${how}`,
    `  access: ${tier.badge}${mod.labels.length ? ` (${mod.labels.join(', ')})` : ''}${mod.draws.length ? `; shows in ${mod.draws.map(d => PLACES[d] ?? d).join(', ')}` : ''}`,
    `  ${mod.description || 'No description.'}`,
  ].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'mods',
      description: 'Browse and install community Claude Code mods',
      argumentHint: '[search]',
    })
    await $.tool.register({
      name: 'search_mods',
      description:
        'Search the community catalogue of Claude Code mods (plugins that add panes, bands, commands and hooks). ' +
        'Use it when the person wants a mod for something, or asks what mods exist. Every word of the query must match ' +
        "a mod's name, description, author or repo, so search with one or two short keywords and try synonyms. " +
        "Results list each mod's id, stars (the whole repo's, shared by its mods), what it can access, and whether it installs in one click. " +
        'Then call show_mod with the best fit, so the person can read it and press Install themselves.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords, e.g. "spotify" or "git branch". Empty lists the most starred.' },
          filter: {
            type: 'string',
            enum: ['all', 'installable', 'safe', 'pane', 'band'],
            description: 'installable: one-click only; safe: display-only mods; pane: side panes; band: bands above the prompt',
          },
          limit: { type: 'number', description: 'How many to return, 1 to 25 (default 10)' },
        },
        required: ['query'],
      },
    })
    await $.tool.register({
      name: 'show_mod',
      description:
        "Opens a mod's page in the Mod Store pane, where the person sees what it can access and installs it with a button. " +
        'Takes an id from search_mods. It never installs anything.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    })
    void loadCatalog($)

    return next(e)
  })

  on('tool.call', { tool: 'mcp__mod-store__search_mods' }, async ($, e) => {
    const input = e as unknown as { query?: string; filter?: Filter; limit?: number }
    await loadCatalog($)
    if (catalog.length === 0) return { deny: (await read($, status)) || 'The mod catalogue is not loaded yet.' }
    const limit = Math.min(25, Math.max(1, Math.round(input.limit ?? 10)))
    const found = select(catalog, input.query ?? '', input.filter ?? 'all', 'stars')
    const owned = new Set(await read($, installed))
    const text = found.length
      ? `${found.length} match${found.length === 1 ? '' : 'es'}, best ${Math.min(limit, found.length)}:\n` +
        found.slice(0, limit).map(mod => describe(mod, owned)).join('\n')
      : 'No mods match. Try one shorter keyword or a synonym.'
    return { result: text }
  })

  on('tool.call', { tool: 'mcp__mod-store__show_mod' }, async ($, e) => {
    const { id } = e as unknown as { id: string }
    await loadCatalog($)
    const mod = catalog.find(m => m.id === id) ?? catalog.find(m => m.name === id)
    if (!mod) return { deny: `No mod with id ${id}. Use an id from search_mods.` }
    await update($, isConfirming, () => false)
    await update($, selected, () => mod.id)
    await $.ui.open({ id: PANE, title: 'Mod Store', columns: 96, rows: 32 })
    return { result: `Opened ${mod.name} in the Mod Store pane. The person installs it from there.` }
  })

  on('command.run', { command: 'mods' }, async ($, e) => {
    const q = (e.args ?? '').trim()
    await update($, query, () => q)
    await update($, page, () => 0)
    await update($, selected, () => null)
    await $.ui.open({ id: PANE, title: 'Mod Store', focus: true, columns: 96, rows: 32 })
    void loadCatalog($)
    void loadInstalled($)

    return { text: q ? `Mod Store: searching "${q}".` : 'Mod Store opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Link } = elements
    // The mobile app draws no fields yet: it gets the list and paging alone.
    const Input = 'Input' in elements ? elements.Input : undefined
    const Select = 'Select' in elements ? elements.Select : undefined

    await read($, loadedAt)
    const note = await read($, status)
    const isTerminal = e.surface === 'terminal'
    const width = Math.max(30, e.props.bodyColumns ?? e.viewport?.columns ?? 60)
    const owned = new Set(await read($, installed))
    const pickedId = await read($, selected)
    const picked = pickedId ? catalog.find(m => m.id === pickedId) : undefined

    // ── Details ──────────────────────────────────────────────────────────
    if (picked) {
      const tier = level(picked)
      const isOwned = picked.marketplace !== null && owned.has(pluginId(picked))
      const confirming = await read($, isConfirming)
      const busy = await read($, isBusy)
      const places = picked.draws.map(d => PLACES[d] ?? d)

      return (
        <Box flexDirection="column" gap={1}>
          <Button
            key="back"
            label="← All mods"
            plain
            dimColor
            hotkey="b"
            onPress={async () => {
              await update($, isConfirming, () => false)
              await update($, selected, () => null)
              await update($, status, () => '')
            }}
          />

          <Box flexDirection="column">
            <Text bold>{picked.name}</Text>
            <Text dimColor>
              {picked.author} · <Text color="yellow">★ {picked.stars.toLocaleString('en-US')}</Text>
              {picked.createdAt ? ` · ${picked.createdAt.slice(0, 10)}` : ''}
            </Text>
          </Box>

          <Text wrap="wrap">{picked.description}</Text>

          <Box gap={2} alignItems="center">
            {isOwned ? (
              <Text color="green" bold>
                ✓ Installed
              </Text>
            ) : !picked.marketplace ? (
              <Text dimColor>Manual install: see its README</Text>
            ) : busy ? (
              <Text color="cyan">Installing…</Text>
            ) : confirming ? (
              <Button key="confirm" label="Confirm install" variant="primary" hotkey="y" autoFocus onPress={() => install($, picked)} />
            ) : (
              <Button key="install" label="Install" variant="primary" hotkey="i" onPress={() => update($, isConfirming, () => true)} />
            )}
            {confirming && !busy && (
              <Button key="cancel" label="Cancel" plain dimColor onPress={() => update($, isConfirming, () => false)} />
            )}
            <Link href={picked.url} label="View source ↗" />
          </Box>

          {confirming && (
            <Box flexDirection="column" borderStyle="round" borderColor={tier.color} paddingX={1}>
              <Text bold>Install {picked.name}?</Text>
              <Text dimColor wrap="wrap">
                Runs: claude plugin install {picked.name} --marketplace {picked.repo}
              </Text>
              <Text wrap="wrap">
                It will be able to: <Text color={tier.color}>{picked.labels.join(', ') || noLabels(picked)}</Text>
              </Text>
            </Box>
          )}

          {note !== '' && (
            <Text color="red" wrap="wrap">
              {note}
            </Text>
          )}

          <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
            <Box justifyContent="space-between">
              <Text bold>What it can access</Text>
              <Text color={tier.color} bold>
                ● {tier.badge}
              </Text>
            </Box>
            {picked.labels.length === 0 && <Text dimColor>{picked.level === 0 ? 'Nothing beyond drawing.' : `${tier.badge}: the catalogue lists no details.`}</Text>}
            {picked.labels.map(label => (
              <Text key={`can-${label}`} dimColor>
                {'  '}• {label}
              </Text>
            ))}
            {picked.sees.length > 0 && (
              <Text dimColor wrap="wrap">
                {'  '}• sees {picked.sees.join(', ')}
              </Text>
            )}
            {places.length > 0 && (
              <Text dimColor wrap="wrap">
                {'  '}• shows up in {places.join(', ')}
              </Text>
            )}
            <Text dimColor>
              {'  '}• validation{' '}
              <Text color={picked.validate === 'passed' ? 'green' : 'yellow'}>{picked.validate}</Text>
            </Text>
          </Box>
        </Box>
      )
    }

    // ── List ─────────────────────────────────────────────────────────────
    const q = await read($, query)
    const f = (await read($, filter)) as Filter
    const s = (await read($, sort)) as Sort
    const matches = select(catalog, q, f, s)
    const pages = Math.max(1, Math.ceil(matches.length / PER_PAGE))
    const at = Math.min(await read($, page), pages - 1)
    const shown = matches.slice(at * PER_PAGE, (at + 1) * PER_PAGE)
    const isLoading = catalog.length === 0 && note === ''
    // A card's inside: the pane less its border and padding. Labels are padded to
    // it so the whole card, not just the words, is a click target.
    const inner = width - 4
    const fill = (text: string, cells: number) => (isTerminal ? text.padEnd(cells, '\u00a0') : text)

    return (
      <Box flexDirection="column" gap={1}>
        {Input && (
          <Box flexDirection="column" width="100%">
            <Input
              key="search"
              placeholder="Search 2,700 mods…  spotify, usage, git, pet"
              value={q}
              submitLabel="search"
              autoFocus
              onInput={async value => {
                await update($, query, () => value)
                await update($, page, () => 0)
              }}
              onSubmit={value => update($, query, () => value)}
            />
          </Box>
        )}

        <Box flexWrap="wrap" columnGap={1}>
          <Button
            key="ask"
            label="✦ Ask Claude"
            onPress={() =>
              q.trim()
                ? $.prompt.submit({
                    text: `Help me find a Claude Code mod for: ${q.trim()}. Search the mod catalogue, compare the best few (what each does and can access), then open your top pick.`,
                  })
                : $.prompt.fill({ text: 'Find me a Claude Code mod that ', mode: 'replace' })
            }
          />
          {CHIPS.map(chip =>
            chip.value === f ? (
              <Button key={`chip-${chip.value}`} label={chip.label} variant="primary" onPress={() => {}} />
            ) : (
              <Button
                key={`chip-${chip.value}`}
                label={chip.label}
                plain
                dimColor
                onPress={async () => {
                  await update($, filter, () => chip.value)
                  await update($, page, () => 0)
                }}
              />
            ),
          )}
        </Box>

        <Box justifyContent="space-between" alignItems="center">
          <Text dimColor>
            {isLoading ? 'Loading the catalogue…' : catalog.length === 0 ? '' : plural(matches.length, 'mod')}
          </Text>
          {Select && (
            <Select
              key="sort"
              options={SORTS}
              value={s}
              onSelect={async v => {
                await update($, sort, () => v as Sort)
                await update($, page, () => 0)
              }}
            />
          )}
        </Box>

        {note !== '' && (
          <Box gap={2}>
            <Text color={catalog.length ? 'yellow' : 'red'} wrap="wrap">
              {note}
            </Text>
            {catalog.length === 0 && <Button key="retry" label="Retry" onPress={() => loadCatalog($, true)} />}
          </Box>
        )}

        {!isLoading && catalog.length > 0 && matches.length === 0 && (
          <Text dimColor>No mods match. Try fewer words or another filter.</Text>
        )}

        <Box flexDirection="column" gap={0}>
          {shown.map(mod => {
            const tier = level(mod)
            const isOwned = mod.marketplace !== null && owned.has(pluginId(mod))
            const open = () => update($, selected, () => mod.id)
            const stars = `★ ${mod.stars.toLocaleString('en-US')}`
            const badge = `● ${tier.badge}   `
            const owns = isOwned ? '✓ Installed   ' : ''
            const footRoom = inner - badge.length - owns.length
            return (
              <Box
                key={`card-${mod.id}`}
                flexDirection="column"
                borderStyle="round"
                borderDimColor
                paddingX={1}
                hover={{ borderColor: 'cyan', borderDimColor: false }}
              >
                {!isTerminal ? (
                  <>
                    <Box justifyContent="space-between">
                      <Button key={`open-${mod.id}`} label={clip(mod.name, 40)} plain onPress={open} />
                      <Text color="yellow">{stars}</Text>
                    </Box>
                    <Text dimColor wrap="wrap">
                      {clip(mod.description || 'No description.', 140)}
                    </Text>
                    <Box justifyContent="space-between">
                      <Box columnGap={2}>
                        <Text color={tier.color}>● {tier.badge}</Text>
                        <Text dimColor>{clip(mod.author, 22)}</Text>
                        {isOwned && <Text color="green">✓ Installed</Text>}
                      </Box>
                      <Button key={`more-${mod.id}`} label="Details ›" plain dimColor onPress={open} />
                    </Box>
                  </>
                ) : (
                  <>
                <Box>
                  <Button key={`open-${mod.id}`} label={fill(clip(mod.name, inner - stars.length - 2), inner - stars.length)} plain onPress={open} />
                  <Text color="yellow">{stars}</Text>
                </Box>
                <Button
                  key={`desc-${mod.id}`}
                  label={fill(clip(mod.description || 'No description.', inner), inner)}
                  plain
                  dimColor
                  onPress={open}
                />
                <Box>
                  <Text color={tier.color}>{badge}</Text>
                  {isOwned && <Text color="green">{owns}</Text>}
                  <Button
                    key={`more-${mod.id}`}
                    label={fill(clip(mod.author, Math.max(4, footRoom - 12)), footRoom - 9) + 'Details ›'}
                    plain
                    dimColor
                    onPress={open}
                  />
                </Box>
                  </>
                )}
              </Box>
            )
          })}
        </Box>

        {pages > 1 && (
          <Box justifyContent="space-between" alignItems="center">
            <Button
              key="prev"
              label="‹ Prev"
              plain
              dimColor={at === 0}
              onPress={() => update($, page, n => Math.max(0, n - 1))}
            />
            <Text dimColor>
              {at * PER_PAGE + 1}–{Math.min(matches.length, (at + 1) * PER_PAGE)} of {matches.length.toLocaleString('en-US')}
            </Text>
            <Button
              key="next"
              label="Next ›"
              plain
              dimColor={at >= pages - 1}
              onPress={() => update($, page, n => Math.min(pages - 1, n + 1))}
            />
          </Box>
        )}

        {catalog.length > 0 && (
          <Box justifyContent="space-between">
            <Text dimColor>
              Catalogue by <Link href="https://mods.aidojo.si" label="mods.aidojo.si" />
            </Text>
            <Button key="refresh" label="↻ Refresh" plain dimColor onPress={() => loadCatalog($, true)} />
          </Box>
        )}
      </Box>
    )
  })
}
