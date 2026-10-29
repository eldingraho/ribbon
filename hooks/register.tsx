import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CacheState, Fold, Saved, Ttl, Window } from '../types'
import { applyStep, cachedTokens, expiresAt, fromResume, hitRate, initial, status } from './cache'
import {
  BG, EMPTY, HUE, INK, LINE, MUTED, ORANGE, ROBO_SIZE, TEXT, WORD, YELLOW,
  bandPx, cardKind, cardSvg, chipShapes, chipSvg, costOf, familyOf, fmtIdle, mineModel, roboSvg, svgDoc, usd,
} from './cache-art'
import type { CacheView } from './cache-art'
import { ago, clock, percent, tokens } from './format'
import { pickLayout, widths } from './layout'
import type { WindowText } from './layout'
import { BY_HUE, BY_WORD, skillsSvg } from './skills-art'
import { addRun, commandName, totalRuns } from './skills'

// The band and its card are ported from Ribbon (github.com/robonuggets/ribbon),
// MIT License, Copyright (c) 2026 Jay E | RoboNuggets: a band above the prompt
// in a warm dark look, showing how much of each usage window is LEFT (7D orange,
// 5H yellow, a bold LOW under 15%), then the prompt cache, WARM (red, Robo
// bobbing) or COLD (blue, Robo frozen) with what the next message costs. Show /
// Hide folds the card; warm starts folded, cold starts open.
//
// Added here: the cache's lifetime is inferred (1h, or 5m once the responses
// show it), the state survives an app restart, and the card lists the skills
// run in this session, by you or by Claude.

const CELLS = 10
const LOW_AT = 15
const TIGHT_CELLS = 6
/** How often the band redraws, so the countdown and the warm-to-cold flip stay current. */
const TICK_MS = 30_000
const SHOWN_SKILLS = 3
const PLUGIN = 'cache-glance'
const PANE = 'cache-glance'
const PANE_TITLE = 'Cache and skills'
// Each pane card needs about this many columns; two fit side by side from 2x.
const CARD_COLUMNS = 44
// Sessions kept in $.store; older ones are dropped.
const KEPT_SESSIONS = 30
const INDEX_KEY = 'sessions'

const cache = atom({ plugin: 'cache-glance', key: 'cache' } as const, null, { shape: 'cache-2' })
const skills = atom({ plugin: 'cache-glance', key: 'skills' } as const, [], { shape: 'skills-1' })
const windows = atom({ plugin: 'cache-glance', key: 'windows' } as const, [] as Window[])
const fold = atom({ plugin: 'cache-glance', key: 'fold' } as const, null as Fold | null)
const isExpanded = atom({ plugin: 'cache-glance', key: 'isExpanded' } as const, false)

const NAMES: Record<string, string> = { seven_day: '7D', five_hour: '5H', spend_limit: 'SPEND' }
const ORDER: Record<string, number> = { seven_day: 0, five_hour: 1 }
const COLORS: Record<string, string> = { seven_day: ORANGE, five_hour: YELLOW }

const clean = (list: readonly Window[]): Window[] =>
  list
    .map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt }))
    .sort((a, b) => (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9))

const dots = (left: number, cells: number): { on: string; off: string } => {
  const n = Math.max(0, Math.min(cells, Math.round((left / 100) * cells)))
  return { on: '●'.repeat(n), off: '·'.repeat(cells - n) }
}

const fmtReset = (iso: string | undefined, now: number): string => {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  if (Number.isNaN(ms)) return ''
  if (ms <= 0) return 'resetting'
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ${mins % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

const ttlMinOf = (ttl: Ttl): number => (ttl === '1h' ? 60 : 5)

// Where the 1h or 5m figure came from, as the pane's footnote says it.
const SOURCE_WORDS: Record<CacheState['ttlSource'], string> = {
  'plan default': 'your plan default',
  setting: 'set in settings',
  'seen in use': 'seen in use',
  'over plan limits': 'over plan limits',
  'engine on resume': 'reported on resume',
}

// The last width and layout the band drew at, written to layout.log by the
// timer so the width estimate can be checked against a real screen.
let seen = ''
let logged = ''

/** What the cache drawings read, or null until a request and its context size are known. */
export const viewOf = (s: CacheState | null, now: number): CacheView | null => {
  if (!s || s.lastHitAt === null) return null
  const tokens = cachedTokens(s)
  if (tokens <= 0) return null
  const idleMs = Math.max(0, now - s.lastHitAt)
  return {
    mode: status(s, now) === 'cold' ? 'cold' : 'warm',
    idle: fmtIdle(idleMs),
    idleMin: Math.floor(idleMs / 60000),
    tokens,
    window: s.contextWindow,
    mine: familyOf(s.model),
    ttlMin: ttlMinOf(s.ttl),
  }
}

// The mod only watches: a failure of its own must never block a command, a
// prompt or a tool call, so each gating hook runs its work through this.
async function safely($: EngineInterface, work: () => Promise<unknown>) {
  try {
    await work()
  } catch (error) {
    $.ui.log(`cache-glance: ${String(error)}`, { to: 'debug' })
  }
}

function savedKey(id: string): string {
  return `session:${id}`
}

// Keeps this session's state across an app restart.
async function persist($: EngineInterface) {
  const id = await $.session.id()
  const saved: Saved = {
    cache: await read($, cache),
    skills: await read($, skills),
    savedAt: await $.clock.now(),
  }
  await $.store.set(savedKey(id), saved)
  const index = ((await $.store.get(INDEX_KEY)) as string[] | undefined) ?? []
  const kept = [id, ...index.filter(one => one !== id)]
  for (const old of kept.slice(KEPT_SESSIONS)) {
    await $.store.delete(savedKey(old))
  }
  await $.store.set(INDEX_KEY, kept.slice(0, KEPT_SESSIONS))
}

// Fills in what the reopened session had before the restart. The engine's
// resume numbers (classic.SessionStart) may already have set the cache
// timing; the saved totals and skills fill the rest.
async function restore($: EngineInterface) {
  const id = await $.session.id()
  const saved = (await $.store.get(savedKey(id))) as Saved | undefined
  if (!saved) return
  await update($, skills, list => (list.length === 0 ? saved.skills : list))
  const old = saved.cache
  if (old === null) return
  await update($, cache, state => {
    if (state === null) return { ...initial(old.model), ...old, isWorking: false }
    if (state.totalRead + state.totalWritten > 0) return state

    return {
      ...state,
      totalRead: old.totalRead,
      totalWritten: old.totalWritten,
      coldStarts: old.coldStarts,
      contextWindow: state.contextWindow || old.contextWindow,
    }
  })
}

async function recordCommand($: EngineInterface, name: string) {
  if (name === PLUGIN) return
  const commands = await $.command.list()
  const info = commands.find(one => one.name === name)
  // Built-ins such as /clear and /compact are not skills.
  if (!info || info.source === 'builtin') return
  const at = await $.clock.now()
  await update($, skills, list => addRun(list, name, 'you', at))
  await persist($)
}

async function pull($: EngineInterface) {
  const u = await $.session.usage()
  await update($, windows, () => clean(u.rateLimits))
}

/** Fresh context figures and usage windows from the engine, after a turn. */
async function measure($: EngineInterface) {
  const u = await $.session.usage()
  await update($, windows, () => clean(u.rateLimits))
  // Past the plan's limits, usage credits drop the main cache to 5m.
  const isOver = u.rateLimits.some(limit => limit.percentUsed >= 100)
  await update($, cache, state => {
    if (state === null) return null
    const ttlChange =
      isOver && state.ttlSource !== 'setting'
        ? { ttl: '5m' as const, ttlSource: 'over plan limits' as const }
        : {}
    const tokens = u.context.tokens
    const window = u.context.window

    return {
      ...state,
      ...ttlChange,
      isWorking: false,
      contextTokens: tokens && tokens > 0 ? tokens : state.contextTokens,
      contextWindow: window || state.contextWindow,
      contextPercent: tokens && window > 0 ? tokens / window : state.contextPercent,
    }
  })
}

async function openPane($: EngineInterface) {
  const opened = await $.ui.open({ id: PANE, title: PANE_TITLE })
  if (!opened.isPlaced) $.ui.log(`cache-glance: pane not placed (${opened.reason})`, { to: 'debug' })
}

async function toggleFold($: EngineInterface, mode: 'warm' | 'cold') {
  await update($, fold, f => ({ mode, open: !(f && f.mode === mode ? f.open : mode === 'cold') }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await safely($, () =>
      $.command.register({
        name: PLUGIN,
        description: 'Open the cache and skills pane',
      }),
    )
    await safely($, async () => {
      // The environment variable wins over the setting, as in the engine.
      const fromEnv = await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL')
      const setting = fromEnv ?? (await $.settings.read({ key: 'promptCacheTtl' }))
      if (setting === '5m' || setting === '1h') {
        const ttl: Ttl = setting
        const model = await $.session.model()
        await update($, cache, state => ({ ...(state ?? initial(model)), ttl, ttlSource: 'setting' as const }))
      }
    })
    await safely($, () => restore($))
    await safely($, () => pull($))
    $.clock.every(TICK_MS, () => {
      $.ui.invalidate('ui.render')
      if (seen !== logged) {
        logged = seen
        void $.fs.write(`${$.plugin.root}/layout.log`, seen + '\n').catch(() => undefined)
      }
    })

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      await update($, windows, () => clean(e.rateLimits))
    }
    if (e.changed.includes('context') && e.context.tokens && e.context.tokens > 0) {
      const tokens = e.context.tokens
      await update($, cache, c =>
        c ? { ...c, contextTokens: tokens, contextWindow: e.context.window || c.contextWindow } : c,
      )
    }

    return next(e)
  })

  // On resume the engine reports how long ago the last response was, how big the
  // session is and whether it thinks the cache expired: what a restart would lose.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.source === 'clear') {
      await update($, cache, () => null)
      await update($, fold, () => null)
    } else if ((e.source === 'resume' || e.source === 'fork') && typeof e.seconds_since_last_response === 'number') {
      const secondsSince = e.seconds_since_last_response
      const at = await $.clock.now()
      const model = typeof e.model === 'string' ? e.model : await $.session.model()
      const window = (await $.session.usage()).context.window
      const resume = {
        at,
        model,
        secondsSince,
        contextTokens: typeof e.context_tokens === 'number' ? e.context_tokens : undefined,
        isLikelyExpired: e.prompt_cache_likely_expired,
      }
      await update($, cache, state => ({ ...fromResume(state, resume), contextWindow: window || state?.contextWindow || 0 }))
    }

    return r
  }).catch(($, e, next) => next(e)) // a band that fails to seed never holds up the session

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, cache, () => null)
      await update($, skills, () => [])
      await update($, fold, () => null)
    }

    return next(e)
  })

  on('command.run', { command: PLUGIN }, async $ => {
    await safely($, () => openPane($))

    return { text: 'Cache and skills pane opened.' }
  })

  on('command.run', async ($, e, next) => {
    await safely($, () => recordCommand($, e.command))

    return next(e)
  })

  // Fallback in case a typed command reaches the engine only as a prompt.
  on('prompt.submit', async ($, e, next) => {
    const name = commandName(e.text)
    if (name) await safely($, () => recordCommand($, name))

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool === 'Skill' && !e.agentId) {
      const name = e.skill
      await safely($, async () => {
        const at = await $.clock.now()
        await update($, skills, list => addRun(list, name, 'claude', at))
        await persist($)
      })
    }

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!('agentId' in e && e.agentId)) {
      const model = await $.session.model()
      await update($, cache, state => ({ ...(state ?? initial(model)), isWorking: true }))
    }

    return next(e)
  })

  // Each main-thread request reads or writes the cache, so its start resets the
  // timer; its usage says whether it read (warm) or rewrote (cold).
  on('turn.step', async function* ($, e, next) {
    const at = e.agentId ? 0 : await $.clock.now()
    const done = yield* next(e)
    if (!e.agentId && done.usage) {
      const step = {
        read: done.usage.cache_read_input_tokens,
        written: done.usage.cache_creation_input_tokens,
        model: done.usage.model,
        at,
      }
      await update($, cache, state => ({ ...applyStep(state, step), isWorking: true }))
    }

    return done
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!('agentId' in e && e.agentId)) {
      await safely($, () => measure($))
      await safely($, () => persist($))
    }

    return done
  })

  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    await safely($, () =>
      update($, cache, state => (state === null ? null : { ...state, lastHitAt: null, isCompacted: true })),
    )

    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    // Svg draws on desktop, mobile and VS Code; the terminal gets the text form.
    // Ask the surface, not the table: the terminal's table still lists Svg.
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : null
    const list = await read($, windows)
    const runs = await read($, skills)
    const now = await $.clock.now()
    const view = viewOf(await read($, cache), now)

    if (list.length === 0 && !view) {
      return (
        <Box backgroundColor={BG} paddingX={1}>
          <Text color={MUTED}>USAGE · waiting for the first reply</Text>
        </Box>
      )
    }

    const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 100
    const windowTexts: WindowText[] = list.map(w => {
      const left = Math.max(0, Math.round((100 - w.percentUsed) * 10) / 10)
      return {
        name: NAMES[w.kind] ?? w.kind.toUpperCase(),
        cells: CELLS,
        left: `${left}%`,
        isLow: left < LOW_AT,
        reset: fmtReset(w.resetsAt, now),
      }
    })
    const preview = viewOf(await read($, cache), now)
    const previewMine = preview ? mineModel(preview) : undefined
    // Sized for the longest the cache text gets in its current state (warm: the
    // full hour left; cold: a day idle and a big price), so the layout changes
    // once when the cache goes cold, not again as the idle time grows.
    const isCold = preview?.mode === 'cold'
    const time = isCold ? ' 23h 59m idle' : ' 60m left'
    const price = isCold ? '$99.99' : '$9.99'
    const cacheText = preview
      ? {
          summary: previewMine ? `${time} · ${price} next` : time,
          time,
          next: previewMine ? price : null,
        }
      : null
    // The open card replaces the inline cache, so only the folded band needs room for it.
    const { layout, isButtonsBelow } = pickLayout(columns, windowTexts, cacheText, CELLS, TIGHT_CELLS)
    seen = `columns=${columns} surface=${e.surface} layout=${layout}${isButtonsBelow ? '+buttons-below' : ''} need=${JSON.stringify(
      Object.fromEntries(Object.entries(widths(windowTexts, cacheText, CELLS, TIGHT_CELLS)).map(([k, v]) => [k, Math.round(v)])),
    )}`
    const kind = layout === 'wide' ? 'wide' : layout === 'stacked' ? 'stacked' : 'tight'
    const isWide = kind === 'wide'
    const cells = layout === 'mini' || layout === 'list' ? TIGHT_CELLS : CELLS
    // The two smallest layouts drop the USAGE label: the colored 7D and 5H say it.
    const hasLabel = layout !== 'mini' && layout !== 'list'

    const parts = (w: Window) => {
      const left = Math.max(0, Math.round((100 - w.percentUsed) * 10) / 10)
      return {
        left,
        col: COLORS[w.kind] ?? TEXT,
        name: NAMES[w.kind] ?? w.kind.toUpperCase(),
        d: dots(left, cells),
        reset: fmtReset(w.resetsAt, now),
      }
    }

    // Wide: every window on one row. Narrow: each window is a block of three
    // lines (name and dots, percent left, reset time) so nothing wraps or clips.
    const wide = (w: Window, i: number) => {
      const p = parts(w)
      return (
        <Box key={`w-${i}`} flexDirection="row" flexShrink={0} marginRight={layout === 'list' || i === list.length - 1 ? 0 : 3}>
          <Text color={MUTED} bold>{p.name} </Text>
          <Text color={p.col}>{p.d.on}</Text>
          <Text color={EMPTY}>{p.d.off}</Text>
          <Text color={p.col} bold> {p.left}% left</Text>
          {p.left < LOW_AT ? <Text color={TEXT} bold> LOW</Text> : null}
          {p.reset && layout !== 'list' ? <Text color={MUTED}> · {p.reset}</Text> : null}
        </Box>
      )
    }

    const stacked = (w: Window, i: number) => {
      const p = parts(w)
      return (
        <Box key={`w-${i}`} flexDirection="column" flexShrink={0} marginRight={i === list.length - 1 ? 0 : 3}>
          <Box flexDirection="row">
            <Text color={MUTED} bold>{p.name} </Text>
            <Text color={p.col}>{p.d.on}</Text>
            <Text color={EMPTY}>{p.d.off}</Text>
          </Box>
          <Box flexDirection="row">
            <Text color={p.col} bold>{p.left}% left</Text>
            {p.left < LOW_AT ? <Text color={TEXT} bold> LOW</Text> : null}
          </Box>
          {p.reset ? <Text color={MUTED}>{layout === 'mini' ? p.reset : `resets ${p.reset}`}</Text> : null}
        </Box>
      )
    }

    const label = hasLabel ? (
      <Box key="label" flexShrink={0} marginRight={isWide ? 2 : 3}>
        <Text color={TEXT} bold>USAGE</Text>
      </Box>
    ) : null
    const usage = list.length > 0
      ? layout === 'list'
        ? [<Box key="list" flexDirection="column">{list.map(wide)}</Box>]
        : list.map(isWide ? wide : stacked)
      : [<Box key="wait" flexShrink={0} marginRight={3}><Text color={MUTED}>waiting for the first reply</Text></Box>]

    // The terminal has no card, so its skills sit on a text row of their own.
    const newest = [...runs].reverse()
    const skillsText = Svg === null && runs.length > 0 ? (
      <Box key="skills-row" flexDirection="row" paddingX={1}>
        <Text color={TEXT} bold>SKILLS </Text>
        {newest.slice(0, SHOWN_SKILLS).map((run, i) => (
          <Text key={`s-${i}`} color={BY_HUE[run.by]}>
            {i > 0 ? ' · ' : ''}{run.by === 'you' ? `you /${run.name}` : `claude ${run.name}`}
          </Text>
        ))}
        {runs.length > SHOWN_SKILLS ? <Text color={MUTED}> +{runs.length - SHOWN_SKILLS}</Text> : null}
      </Box>
    ) : null

    // Before the first reply there is no cache to show: the usage row alone.
    if (!view) {
      return (
        <Box flexDirection="column" backgroundColor={BG}>
          <Box flexDirection="row" paddingX={1}>
            {label}
            {usage}
          </Box>
          {skillsText}
        </Box>
      )
    }

    const mode = view.mode
    const cold = mode === 'cold'
    const hue = HUE[mode]
    const mine = mineModel(view)
    const stored = await read($, fold)
    // Folding needs the card, and the card is a drawing: the terminal stays folded.
    const open = Svg !== null && (stored && stored.mode === mode ? stored.open : cold)
    const toggle = () => toggleFold($, mode)
    const left = `${Math.max(0, view.ttlMin - view.idleMin)}m left`

    const badge = Svg
      ? [
          <Svg key="robo" source={roboSvg(mode)} alt="Cache" width={ROBO_SIZE} height={ROBO_SIZE} isInteractive />,
          <Text key="gap"> </Text>,
          (() => {
            const c = chipSvg(mode)
            return <Svg key="chip" source={c.source} alt={WORD[mode]} width={c.w} height={c.h} />
          })(),
        ]
      : [<Text key="chip" backgroundColor={hue} color={INK} bold>{` ${WORD[mode]} `}</Text>]

    // One phrase pair everywhere: "51m left" warm, "18m idle" cold, and the
    // next message's price after either.
    const summary = [
      <Text key="time" color={hue} bold>{cold ? ` ${view.idle} idle` : ` ${left}`}</Text>,
      mine ? <Text key="dot" color={MUTED}> · </Text> : null,
      mine ? <Text key="cost" color={TEXT} bold>{usd(costOf(mine, mode, view.tokens, view.ttlMin))}</Text> : null,
      mine ? <Text key="next" color={MUTED}> next</Text> : null,
    ]

    const button = Svg ? (
      <Box key="fold" flexDirection="row" gap={1} flexShrink={0} alignItems="flex-start">
        <Button key="cache-fold" label={open ? 'Hide' : 'Show'} onPress={toggle} />
        <Button key="pane" label="Details" dimColor onPress={() => openPane($)} />
      </Box>
    ) : null
    const grow = <Box key="grow" flexGrow={1} />

    let rows
    if (kind === 'wide') {
      rows = (
        <Box key="row" flexDirection="row" paddingX={1} alignItems="center">
          {label}
          {usage}
          {open ? null : (
            <Box key="inline" flexDirection="row" flexShrink={0} marginLeft={3} marginRight={2} alignItems="center">
              {badge}
              {summary}
            </Box>
          )}
          {grow}
          {button}
        </Box>
      )
    } else if (kind === 'stacked') {
      // The cache becomes a third stacked block, the same shape as 7D and 5H.
      rows = (
        <Box key="row" flexDirection="row" paddingX={1}>
          {label}
          {usage}
          {open ? null : (
            <Box key="block" flexDirection="column" flexShrink={0} marginLeft={3} marginRight={2}>
              <Box flexDirection="row" alignItems="center">{badge}</Box>
              <Text color={hue} bold>{cold ? `${view.idle} idle` : left}</Text>
              {mine ? (
                <Box flexDirection="row">
                  <Text color={TEXT} bold>{usd(costOf(mine, mode, view.tokens, view.ttlMin))}</Text>
                  <Text color={MUTED}> next</Text>
                </Box>
              ) : null}
            </Box>
          )}
          {grow}
          {button}
        </Box>
      )
    } else {
      // Narrow: the cache gets its own row under the usage blocks, in the same
      // column as them, so the label keeps the left side to itself and the
      // button lines up with the band's right edge.
      rows = (
        <Box key="row" flexDirection="row" paddingX={1}>
          {label}
          <Box key="right" flexDirection="column" flexGrow={1} gap={1}>
            <Box key="usage" flexDirection="row">
              {usage}
            </Box>
            {!isButtonsBelow ? (
              <Box key="cache" flexDirection="row" alignItems="center">
                {badge}
                {summary}
                {grow}
                {button}
              </Box>
            ) : hasLabel ? (
              <Box key="cache" flexDirection="column">
                <Box flexDirection="row" alignItems="center">
                  {badge}
                  {summary}
                </Box>
                {button ? (
                  <Box flexDirection="row">
                    {grow}
                    {button}
                  </Box>
                ) : null}
              </Box>
            ) : (
              // The narrowest layouts: the time, the price and the buttons each
              // get a short line, so none of them runs past the edge.
              <Box key="cache" flexDirection="column">
                <Box flexDirection="row" alignItems="center">
                  {badge}
                  {summary[0]}
                </Box>
                {mine ? (
                  <Box flexDirection="row">
                    {summary[2]}
                    {summary[3]}
                  </Box>
                ) : null}
                {button ? (
                  <Box flexDirection="row">
                    {grow}
                    {button}
                  </Box>
                ) : null}
              </Box>
            )}
          </Box>
        </Box>
      )
    }

    let card = null
    if (open && Svg) {
      const W = bandPx(columns)
      // The card follows the band's layout, so Robo and the chip are drawn once,
      // and steps down further when its pixels can't hold that layout.
      const ck = cardKind(kind, W)
      const c = cardSvg(view, ck, W)
      const expanded = await read($, isExpanded)
      const shown = expanded ? newest : newest.slice(0, SHOWN_SKILLS)
      const s = skillsSvg(shown, totalRuns(runs), W, clock)
      card = (
        <Box key="card" flexDirection="column">
          <Svg source={c.source} alt={c.alt} width={c.w} height={c.h} isInteractive={ck !== 'tight'} />
          <Svg key="skills" source={s.source} alt={s.alt} width={s.w} height={s.h} />
          {newest.length > SHOWN_SKILLS ? (
            <Box key="skills-more-row" flexDirection="row" paddingX={1}>
              <Box flexGrow={1} />
              <Button
                key="skills-more"
                label={expanded ? 'Show fewer' : `Show all (${newest.length})`}
                dimColor
                onPress={() => update($, isExpanded, x => !x)}
              />
            </Box>
          ) : null}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" backgroundColor={BG}>
        {rows}
        {card}
        {skillsText}
      </Box>
    )
  })
  // The pane: everything the band has no room for, in the band's own look. Text
  // and boxes rather than one drawing, so it fits whatever width the pane gets.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : null
    const state = await read($, cache)
    const runs = await read($, skills)
    const now = await $.clock.now()
    const view = viewOf(state, now)
    const newest = [...runs].reverse()
    const columns = e.props.bodyColumns
    const isSideBySide = columns >= 2 * CARD_COLUMNS + 1
    const cardColumns = isSideBySide ? Math.floor((columns - 1) / 2) : Math.min(columns, 64)
    // Under about 40 columns inside a card (its border and padding take 6), a
    // label and its value don't fit on one line.
    const isNarrow = cardColumns - 6 < 40

    const heading = (word: string, right?: string) => (
      <Box key={`h-${word}`} flexDirection="row" justifyContent="space-between">
        <Text color={MUTED} bold>{word}</Text>
        {right ? <Text color={MUTED} bold>{right}</Text> : null}
      </Box>
    )
    const row = (name: string, value: string) =>
      isNarrow ? (
        <Box key={name} flexDirection="column">
          <Text color={MUTED}>{name}</Text>
          <Text color={TEXT} bold tabular>{value}</Text>
        </Box>
      ) : (
        <Box key={name} flexDirection="row" justifyContent="space-between" gap={2}>
          <Text color={MUTED} wrap="truncate-end">{name}</Text>
          <Text color={TEXT} bold tabular>{value}</Text>
        </Box>
      )
    // A figure the way Ribbon's card leads with one: large, under a small label.
    const hero = (key: string, value: string, unit: string, caption: string, captionColor = MUTED) => (
      <Box key={key} flexDirection="column">
        <Box flexDirection="row">
          <Text color={TEXT} size="title" weight="semibold">{value}</Text>
          {unit ? <Text color={MUTED} size="body">{` ${unit}`}</Text> : null}
        </Box>
        <Text color={captionColor}>{caption}</Text>
      </Box>
    )
    const card = {
      flexDirection: 'column',
      gap: 1,
      paddingX: 2,
      paddingY: 1,
      backgroundColor: BG,
      borderStyle: 'round',
      borderColor: LINE,
      flexGrow: 1,
      flexShrink: 1,
      width: isSideBySide ? '49%' : Math.min(columns, 64),
    } as const

    let cacheCard
    if (!state || !view) {
      cacheCard = (
        <Box key="cache-card" {...card}>
          {heading('CACHE')}
          <Text color={MUTED}>
            {state?.isCompacted ? 'Compacted. The next reply rewrites the cache.' : 'Waiting for the first reply.'}
          </Text>
        </Box>
      )
    } else {
      const mode = view.mode
      const cold = mode === 'cold'
      const hue = HUE[mode]
      const mine = mineModel(view)
      const end = expiresAt(state)
      const rate = hitRate(state)
      const chip = chipSvg(mode)
      const minutes = Math.max(0, view.ttlMin - view.idleMin)
      cacheCard = (
        <Box key="cache-card" {...card}>
          {heading('CACHE', mine ? `PRICED AS ${mine.NAME}` : undefined)}
          <Box flexDirection="row" alignItems="center">
            {Svg ? (
              <Svg source={roboSvg(mode)} alt="Cache" width={ROBO_SIZE} height={ROBO_SIZE} isInteractive />
            ) : null}
            <Text> </Text>
            {Svg ? (
              <Svg source={chip.source} alt={WORD[mode]} width={chip.w} height={chip.h} />
            ) : (
              <Text backgroundColor={hue} color={INK} bold>{` ${WORD[mode]} `}</Text>
            )}
          </Box>
          {cold
            ? hero('time', view.idle, 'idle', end !== null ? `went cold at ${clock(end)}` : 'cold now', HUE.cold)
            : hero('time', `${minutes}m`, 'left', end !== null ? `cold at ${clock(end)}` : '', HUE.cold)}
          {hero(
            'tokens',
            tokens(view.tokens),
            'tokens',
            `${cold ? 'to re-cache' : 'in cache'}${view.window > 0 ? ` · ${percent(view.tokens / view.window)} of ${tokens(view.window)} context` : ''}`,
          )}
          <Box flexDirection="column">
            {mine ? row('Next message', usd(costOf(mine, mode, view.tokens, view.ttlMin))) : null}
            {row('Last turn', `${tokens(state.lastRead)} read · ${tokens(state.lastWritten)} written`)}
            {row('This session', `${tokens(state.totalRead)} read · ${tokens(state.totalWritten)} written`)}
            {row('Hit rate', rate === null ? '–' : percent(rate))}
            {row('Cold starts', String(state.coldStarts))}
          </Box>
          <Text color={MUTED}>
            {`${view.ttlMin >= 60 ? '1h' : '5m'} cache, ${SOURCE_WORDS[state.ttlSource]} · last use ${state.lastHitAt === null ? '–' : ago(now - state.lastHitAt)}`}
          </Text>
          {mine ? <Text color={MUTED}>Prices are list-price estimates.</Text> : null}
        </Box>
      )
    }

    // Each row says who started the skill in a word, not by color alone: the
    // strip's rounded chip on desktop, all one width so the names line up.
    const tag = (by: 'you' | 'claude') => {
      if (Svg) {
        const c = chipShapes(0, 0, BY_WORD[by], BY_HUE[by], 10, 0.8, 60)
        return <Svg source={svgDoc(c.w, c.h, c.svg, true)} alt={by === 'you' ? 'You' : 'Claude'} width={c.w} height={c.h} />
      }

      return <Text backgroundColor={BY_HUE[by]} color={INK} bold>{by === 'you' ? '  YOU   ' : ' CLAUDE '}</Text>
    }
    const skillsCard = (
      <Box key="skills-card" {...card}>
        {heading('SKILLS', `${totalRuns(runs)} ${totalRuns(runs) === 1 ? 'RUN' : 'RUNS'}`)}
        {newest.length === 0 ? <Text color={MUTED}>Skills you or Claude run show up here.</Text> : null}
        <Box flexDirection="column" gap={1}>
          {newest.map((run, i) => (
            <Box key={`r-${i}-${run.at}`} flexDirection="row" gap={1} alignItems="center">
              {tag(run.by)}
              <Box flexGrow={1} flexShrink={1} flexDirection="row" gap={1}>
                <Text color={TEXT} bold wrap="truncate-end">{run.by === 'you' ? `/${run.name}` : run.name}</Text>
                {run.count > 1 ? <Text color={MUTED}>{`×${run.count}`}</Text> : null}
              </Box>
              <Text color={MUTED} tabular>{clock(run.at)}</Text>
            </Box>
          ))}
        </Box>
      </Box>
    )

    return (
      <Box key="cards" flexDirection={isSideBySide ? 'row' : 'column'} gap={1} alignItems={isSideBySide ? 'stretch' : 'center'}>
        {cacheCard}
        {skillsCard}
      </Box>
    )
  })
}
