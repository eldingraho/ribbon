import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2098-12-31T22:00:00Z')
const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 12 },
  view: {},
} as const

async function coldSession($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1]) {
  mock.store(on)
  mock.clock(on, { now: NOW })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: [] } }))
  on('classic.SessionStart', () => ({}))
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 7200, context_tokens: 200000, model: 'claude-opus-5-5' })
}

test('the open card lists the skills Claude ran, newest first', async ($, on) => {
  await coldSession($, on)
  await $.tool.call({ tool: 'Skill', skill: 'dataviz' })
  await $.tool.call({ tool: 'Skill', skill: 'plugin-authoring' })

  const band = await $.ui.mount({ plugin: 'cache-glance', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  const alts = (await band.findAll({ type: 'Svg' })).map(s => s.props.alt)
  expect(alts).toContain('Skills: plugin-authoring by Claude, dataviz by Claude.')
  expect(await band.find({ key: 'skills-more' })).toBeUndefined()
  await band.unmount()
})

test('a subagent skill call is left out', async ($, on) => {
  await coldSession($, on)
  await $.tool.call({ tool: 'Skill', skill: 'dataviz', agentId: 'a1' })

  const band = await $.ui.mount({ plugin: 'cache-glance', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  const alts = (await band.findAll({ type: 'Svg' })).map(s => s.props.alt)
  expect(alts).toContain('No skills run yet.')
  await band.unmount()
})

test('more than three skills hide behind a button', async ($, on) => {
  await coldSession($, on)
  for (const skill of ['a', 'b', 'c', 'd', 'e']) await $.tool.call({ tool: 'Skill', skill })

  const band = await $.ui.mount({ plugin: 'cache-glance', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect((await band.find({ key: 'skills-more' }))?.props.label).toBe('Show all (5)')
  let alts = (await band.findAll({ type: 'Svg' })).map(s => s.props.alt)
  expect(alts).toContain('Skills: e by Claude, d by Claude, c by Claude.')
  await band.press({ key: 'skills-more' })
  alts = (await band.findAll({ type: 'Svg' })).map(s => s.props.alt)
  expect(alts).toContain('Skills: e by Claude, d by Claude, c by Claude, b by Claude, a by Claude.')
  await band.unmount()
})

test('the terminal shows skills as a text row', async ($, on) => {
  await coldSession($, on)
  await $.tool.call({ tool: 'Skill', skill: 'dataviz' })

  const band = await $.ui.mount({ plugin: 'cache-glance', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await band.find({ key: 'skills-row' })).toBeDefined()
  expect(await band.findAll({ type: 'Svg' })).toEqual([])
  await band.unmount()
})

test('on the 5m cache the cold write is priced at 1.25 times input', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: [] } }))
  on('classic.SessionStart', () => ({}))
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  // 20 minutes idle and the engine says expired: the 5-minute cache.
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 1200, context_tokens: 800000, model: 'claude-opus-5-5', prompt_cache_likely_expired: true })

  const band = await $.ui.mount({ plugin: 'cache-glance', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  await band.press({ key: 'cache-fold' })
  // Opus 5.5: 800k tokens at 1.25 x $4 per million.
  expect(await band.find({ text: '$4.00' })).toBeDefined()
  await band.unmount()
})

const PANE = {
  plugin: 'cache-glance',
  component: 'Pane',
  requestId: 'cache-glance',
  props: { title: 'Cache and skills', isFocused: false, bodyColumns: 48, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('Details opens the pane, which lists every skill and the cache numbers', async ($, on) => {
  let opened = ''
  on('ui.open', (_, e) => {
    opened = e.id
    return { value: { isPlaced: true } }
  })
  await coldSession($, on)
  for (const skill of ['a', 'b', 'c', 'd', 'e']) await $.tool.call({ tool: 'Skill', skill })

  const band = await $.ui.mount({ plugin: 'cache-glance', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  await band.press({ key: 'pane' })
  expect(opened).toBe('cache-glance')
  await band.unmount()

  for (const bodyColumns of [40, 120]) {
    const pane = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns } })
    expect(await pane.find({ text: '5 RUNS' })).toBeDefined()
    expect(await pane.find({ text: 'a' })).toBeDefined()
    expect(await pane.find({ text: 'Cold starts' })).toBeDefined()
    expect(await pane.find({ text: 'Hit rate' })).toBeDefined()
    await pane.unmount()
  }
})
