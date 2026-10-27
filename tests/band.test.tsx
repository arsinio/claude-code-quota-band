import type { On, SessionRateLimit } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const HOUR = 3_600_000
const NOW = Date.parse('2026-10-27T13:00:00Z')

const RATE_LIMITS: SessionRateLimit[] = [
  // 2h left of 5h: pace 60%.
  { kind: 'five_hour', percentUsed: 80, resetsAt: '2026-10-27T15:00:00Z' },
  { kind: 'seven_day', percentUsed: 2, resetsAt: '2026-11-02T22:00:00Z' },
]

const band = (bodyColumns: number) =>
  ({
    plugin: 'quota-band',
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 10,
      bodyColumns,
      scroll: { offset: 0, bodyRows: 9 },
      view: {},
    },
  }) as const

// Stands in for the engine beneath the plugin.
function engine(on: On, rateLimits: SessionRateLimit[], stored?: Record<string, unknown>) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, stored)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: {}, rateLimits } }) as never)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  return clock
}

const start = { cwd: '/', surface: 'terminal', isInteractive: true } as const

async function rowText(ui: { findAll: (q: { type: 'Text' }) => Promise<{ text?: string }[]> }) {
  return (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '').join('')
}

test('draws both windows with pace markers and reset times', async ($, on) => {
  engine(on, RATE_LIMITS)
  await $.session.start(start)

  const ui = await $.ui.mount({ ...band(100), surface: 'terminal' })
  const text = await rowText(ui)

  // 30-cell bars: 80% fills 24, pace 60% puts the marker at cell 18.
  expect(text).toContain('5h ' + '█'.repeat(18) + '│' + '█'.repeat(5) + '░'.repeat(6) + '  80%  ↻2h0m')
  // 2% rounds to 1 cell; 15h into 7d puts the marker at cell 2.
  expect(text).toContain('7d █░│' + '░'.repeat(27) + '   2%  ↻6d9h')

  const ahead = await ui.find({ type: 'Text', text: /^█+$/ })
  expect(ahead?.props).toMatchObject({ color: 'error' })
  await ui.unmount()
})

test('draws SVG pills on desktop', async ($, on) => {
  engine(on, RATE_LIMITS)
  await $.session.start(start)

  const ui = await $.ui.mount({ ...band(100), surface: 'desktop' })
  const pills = await ui.findAll({ type: 'Svg' })
  expect(pills).toHaveLength(2)
  expect(pills[0]?.props).toMatchObject({
    alt: '5-hour limit: 80% used, 60% of the window elapsed, resets in 2h0m',
    width: 88,
    height: 10,
  })
  expect(String(pills[0]?.props.source)).toContain('fill="#f85149"')
  expect(await rowText(ui)).toBe('5h80%↻2h0m7d2%↻6d9h')
  await ui.unmount()
})

test('falls back to text when the row is narrow', async ($, on) => {
  engine(on, RATE_LIMITS)
  await $.session.start(start)

  const ui = await $.ui.mount({ ...band(40), surface: 'terminal' })
  expect(await rowText(ui)).toBe('5h 80% ↻2h0m · 7d 2% ↻6d9h')
  await ui.unmount()
})

test('shows the stored reading dimmed until a fresh one arrives', async ($, on) => {
  const stored = { windows: [{ kind: 'five_hour', percentUsed: 30, resetsAt: NOW + HOUR }] }
  engine(on, [], { lastReading: stored })
  await $.session.start(start)

  let ui = await $.ui.mount({ ...band(100), surface: 'terminal' })
  expect(await rowText(ui)).toContain('30%  ↻1h0m')
  expect((await ui.find({ type: 'Text', text: /^█+$/ }))?.props).toMatchObject({ dimColor: true })
  await ui.unmount()

  await $.session.measure({ context: {} as never, rateLimits: RATE_LIMITS, changed: ['rateLimits'] })
  ui = await $.ui.mount({ ...band(100), surface: 'terminal' })
  expect(await rowText(ui)).toContain('80%  ↻2h0m')
  await ui.unmount()
})

test('leaves the band to the engine with no reading at all', async ($, on) => {
  engine(on, [])
  await $.session.start(start)

  const ui = await $.ui.mount({ ...band(100), surface: 'terminal' })
  expect(await rowText(ui)).toBe('engine')
  await ui.unmount()
})

test('the countdown moves with the clock', async ($, on) => {
  const clock = engine(on, RATE_LIMITS)
  await $.session.start(start)
  await clock.advance(60 * 60_000)

  const ui = await $.ui.mount({ ...band(100), surface: 'terminal' })
  expect(await rowText(ui)).toContain('↻1h0m')
  await ui.unmount()
})
