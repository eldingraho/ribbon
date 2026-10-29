import { describe, expect, test } from 'claude-code/testing'

import { MINUTE, applyStep, fromResume, initial, status } from '../hooks/cache'
import { addRun, commandName, totalRuns } from '../hooks/skills'
import { tokens } from '../hooks/format'

const T0 = 1_000_000_000_000
const step = (at: number, read: number, written: number, model = 'opus') => ({
  at,
  read,
  written,
  model,
})

describe('cache estimate', () => {
  test('warm for the hour after a hit, cooling in its last 5 minutes, then cold', async () => {
    const state = applyStep(null, step(T0, 180_000, 2_000))
    expect(status(state, T0 + 30 * MINUTE)).toBe('warm')
    expect(status(state, T0 + 56 * MINUTE)).toBe('cooling')
    expect(status(state, T0 + 60 * MINUTE)).toBe('cold')
  })

  test('a step that reads nothing counts as a cold start', async () => {
    const state = applyStep(null, step(T0, 0, 90_000))
    expect(state.coldStarts).toBe(1)
  })

  test('a full rewrite after 5 to 60 idle minutes switches to the 5m cache', async () => {
    const warm = applyStep(null, step(T0, 180_000, 2_000))
    const cold = applyStep(warm, step(T0 + 20 * MINUTE, 0, 182_000))
    expect(cold.ttl).toBe('5m')
    expect(cold.ttlSource).toBe('seen in use')
    expect(status(cold, T0 + 24 * MINUTE)).toBe('cooling')
    expect(status(cold, T0 + 26 * MINUTE)).toBe('cold')
  })

  test('a read after more than 5 idle minutes proves the 1h cache', async () => {
    const fiveMinute = { ...initial('opus'), ttl: '5m' as const, ttlSource: 'seen in use' as const }
    const warm = applyStep(fiveMinute, step(T0, 180_000, 2_000))
    const again = applyStep(warm, step(T0 + 30 * MINUTE, 182_000, 500))
    expect(again.ttl).toBe('1h')
  })

  test('a setting is never overridden by evidence', async () => {
    const set = { ...initial('opus'), ttl: '1h' as const, ttlSource: 'setting' as const }
    const warm = applyStep(set, step(T0, 180_000, 2_000))
    const cold = applyStep(warm, step(T0 + 20 * MINUTE, 0, 182_000))
    expect(cold.ttl).toBe('1h')
  })

  test('a working turn shows working, and no state shows none', async () => {
    const state = { ...applyStep(null, step(T0, 1, 1)), isWorking: true }
    expect(status(state, T0)).toBe('working')
    expect(status(null, T0)).toBe('none')
  })
})

describe('resume after an app restart', () => {
  test('the last response time comes from the engine', async () => {
    const state = fromResume(null, { at: T0, model: 'opus', secondsSince: 20 * 60, contextTokens: 182_000, isLikelyExpired: false })
    expect(state.lastHitAt).toBe(T0 - 20 * MINUTE)
    expect(state.lastRead).toBe(182_000)
    expect(state.ttl).toBe('1h')
    expect(status(state, T0)).toBe('warm')
  })

  test('an engine verdict of expired inside the hour means the 5m cache', async () => {
    const state = fromResume(null, { at: T0, model: 'opus', secondsSince: 20 * 60, isLikelyExpired: true })
    expect(state.ttl).toBe('5m')
    expect(state.ttlSource).toBe('engine on resume')
    expect(status(state, T0)).toBe('cold')
  })

  test('saved totals survive the resume', async () => {
    const before = applyStep(null, step(T0, 180_000, 2_000))
    const state = fromResume(before, { at: T0 + 2 * 60 * MINUTE, model: 'opus', secondsSince: 2 * 60 * 60, isLikelyExpired: true })
    expect(state.totalRead).toBe(180_000)
    expect(status(state, T0 + 2 * 60 * MINUTE)).toBe('cold')
  })
})

describe('skill list', () => {
  test('repeats collapse, and a doubled typed command counts once', async () => {
    let list = addRun([], 'dataviz', 'claude', T0)
    list = addRun(list, 'dataviz', 'claude', T0 + 10_000)
    list = addRun(list, 'simplify', 'you', T0 + 20_000)
    list = addRun(list, 'simplify', 'you', T0 + 20_500)
    expect(list.length).toBe(2)
    expect(list[0]?.count).toBe(2)
    expect(list[1]?.count).toBe(1)
    expect(totalRuns(list)).toBe(3)
  })

  test('command names are read from typed text', async () => {
    expect(commandName('/egm:egm_brainstorm make a mod')).toBe('egm:egm_brainstorm')
    expect(commandName('no command')).toBe(null)
  })

  test('token counts are rounded for display', async () => {
    expect(tokens(182_400)).toBe('182k')
    expect(tokens(2_300_000)).toBe('2.3M')
    expect(tokens(850)).toBe('850')
  })
})

import { pickLayout } from '../hooks/layout'

describe('band layout', () => {
  const windows = [
    { name: '7D', cells: 10, left: '99%', isLow: false, reset: '5d 19h' },
    { name: '5H', cells: 10, left: '99%', isLow: false, reset: '4h 42m' },
  ]
  const warm = { summary: ' 60m left · $9.99 next', time: ' 60m left', next: '$9.99' }
  const cold = { summary: ' 23h 59m idle · $99.99 next', time: ' 23h 59m idle', next: '$99.99' }
  const at = (columns: number, cache: typeof warm | null) => {
    const p = pickLayout(columns, windows, cache, 10, 6)
    return p.isButtonsBelow ? `${p.layout}+below` : p.layout
  }

  test('the roomiest layout that fits wins, and narrower bands step down', async () => {
    expect(at(140, warm)).toBe('wide')
    expect(at(90, warm)).toBe('stacked')
    expect(at(60, warm)).toBe('split')
    expect(at(49, warm)).toBe('split+below')
    expect(at(40, warm)).toBe('mini+below')
    // The narrowest chat column on the desktop is about 30 columns.
    expect(at(31, warm)).toBe('mini+below')
    // At the narrowest column the cache takes short lines, so it fits too.
    expect(at(30, { summary: ' 23h 59m idle · $99.99 next', time: ' 23h 59m idle', next: '$99.99' })).toBe('mini+below')
  })

  test('the layout holds for the whole cold state, however long it idles', async () => {
    expect(at(49, cold)).toBe(at(49, cold))
    expect(at(49, cold)).toBe('split+below')
  })

  test('with no cache yet the usage blocks get the whole width', async () => {
    expect(at(80, null)).toBe('stacked')
  })
})
