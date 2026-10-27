import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, Timer } from 'claude-code'

import type { QuotaWindow } from '../types'
import {
  LABEL,
  LONG_LABEL,
  PILL,
  barRuns,
  barWidth,
  formatResetIn,
  liveWindows,
  pace,
  paceColor,
  pillSvg,
  toWindows,
} from './quota'

const reading = atom({ plugin: 'quota-band', key: 'reading' } as const, null)
const now = atom({ plugin: 'quota-band', key: 'now' } as const, 0)

const STORE_KEY = 'lastReading'
const TICK_MS = 60_000

async function applyFresh($: EngineInterface, rateLimits: readonly SessionRateLimit[]) {
  const windows = toWindows(rateLimits)

  if (windows.length === 0) {
    return
  }

  await update($, reading, () => ({ windows, isStale: false }))
  await $.store.set(STORE_KEY, { windows })
}

export const register: Register = on => {
  let tick: Timer | undefined

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const startedAt = await $.clock.now()
    await update($, now, () => startedAt)

    const saved = liveWindows(await $.store.get(STORE_KEY), startedAt)

    if (saved.length > 0) {
      await update($, reading, () => ({ windows: saved, isStale: true }))
    }

    await applyFresh($, (await $.session.usage()).rateLimits)

    // Moves the pace marker and countdown between readings.
    tick?.cancel()
    tick = $.clock.every(TICK_MS, () => {
      void $.clock.now().then(t => update($, now, () => t))
    })

    return result
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      const measuredAt = await $.clock.now()
      await update($, now, () => measuredAt)
      await applyFresh($, e.rateLimits)
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, reading)
    const t = await read($, now)
    const windows = current ? liveWindows(current, t) : []

    if (e.props.hasSurvey || current === null || windows.length === 0) {
      return next(e)
    }

    const isStale = current.isStale

    if (e.surface === 'desktop') {
      const { Box, Text, Svg } = $.ui.resolve(e)

      return (
        <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
          {windows.map(w => {
            const elapsed = pace(w, t)
            const pct = Math.round(w.percentUsed)
            const resetIn = formatResetIn(w.resetsAt - t)
            const title =
              `${LONG_LABEL[w.kind]}: ${pct}% used, ${Math.round(elapsed * 100)}% of the window elapsed, ` +
              `resets in ${resetIn}${isStale ? ' (last known reading)' : ''}`

            return (
              <Box key={w.kind} flexDirection="row" alignItems="center" columnGap={1}>
                <Text dimColor>{LABEL[w.kind]}</Text>
                <Svg
                  source={pillSvg(w.percentUsed, elapsed, isStale ? undefined : paceColor(w.percentUsed, elapsed), title)}
                  alt={title}
                  width={PILL.width}
                  height={PILL.height}
                  isInteractive
                />
                <Text dimColor={isStale}>{pct}%</Text>
                <Text dimColor>↻{resetIn}</Text>
              </Box>
            )
          })}
        </Box>
      )
    }

    const { Box, Text } = $.ui.resolve(e)
    const width = barWidth(e.props.bodyColumns)

    const text = (w: QuotaWindow) =>
      `${LABEL[w.kind]} ${Math.round(w.percentUsed)}% ↻${formatResetIn(w.resetsAt - t)}`

    if (width === 0) {
      return <Text dimColor>{windows.map(text).join(' · ')}</Text>
    }

    return (
      <Box flexDirection="row">
        {windows.map(w => {
          const elapsed = pace(w, t)
          const color = isStale ? undefined : paceColor(w.percentUsed, elapsed)
          const pct = `${Math.round(w.percentUsed)}%`.padStart(4)

          return (
            <Box key={w.kind} marginRight={4}>
              <Text dimColor>{LABEL[w.kind]} </Text>
              {barRuns(w.percentUsed, elapsed, width).map(run =>
                run.role === 'marker' ? (
                  <Text bold dimColor={isStale}>
                    {run.text}
                  </Text>
                ) : (
                  <Text color={color} dimColor={isStale || run.role === 'empty'}>
                    {run.text}
                  </Text>
                ),
              )}
              <Text dimColor={isStale}>
                {' '}
                {pct}
              </Text>
              <Text dimColor>
                {'  ↻'}
                {formatResetIn(w.resetsAt - t)}
              </Text>
            </Box>
          )
        })}
      </Box>
    )
  })
}
