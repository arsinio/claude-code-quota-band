import { describe, expect, test } from 'claude-code/testing'

import {
  WINDOW_MS,
  barRuns,
  barWidth,
  formatResetIn,
  liveWindows,
  pace,
  paceColor,
  pillSvg,
  toWindows,
} from '../hooks/quota'

const HOUR = 3_600_000
const NOW = 1_800_000_000_000

const bar = (used: number, elapsed: number, width: number) =>
  barRuns(used, elapsed, width)
    .map(r => r.text)
    .join('')

describe('pace', () => {
  test('is 0 at the start of a window, 0.5 midway, 1 at reset', async () => {
    const w = { kind: 'five_hour', percentUsed: 0 } as const
    expect(pace({ ...w, resetsAt: NOW + 5 * HOUR }, NOW)).toBe(0)
    expect(pace({ ...w, resetsAt: NOW + 2.5 * HOUR }, NOW)).toBe(0.5)
    expect(pace({ ...w, resetsAt: NOW }, NOW)).toBe(1)
  })

  test('clamps past either end and uses the 7-day length', async () => {
    const w = { kind: 'seven_day', percentUsed: 0 } as const
    expect(pace({ ...w, resetsAt: NOW + 2 * WINDOW_MS.seven_day }, NOW)).toBe(0)
    expect(pace({ ...w, resetsAt: NOW - HOUR }, NOW)).toBe(1)
    expect(pace({ ...w, resetsAt: NOW + 3.5 * 86_400_000 }, NOW)).toBe(0.5)
  })
})

describe('paceColor', () => {
  test('green on or within 5 points of pace', async () => {
    expect(paceColor(40, 0.5)).toBe('success')
    expect(paceColor(55, 0.5)).toBe('success')
  })

  test('yellow more than 5 ahead, red more than 15 ahead', async () => {
    expect(paceColor(56, 0.5)).toBe('warning')
    expect(paceColor(65, 0.5)).toBe('warning')
    expect(paceColor(66, 0.5)).toBe('error')
  })

  test('red at 90% used even when behind pace', async () => {
    expect(paceColor(90, 0.99)).toBe('error')
  })
})

describe('barRuns', () => {
  test('marks pace over empty cells', async () => {
    expect(bar(20, 0.5, 10)).toBe('██░░░│░░░░')
  })

  test('marks pace over filled cells', async () => {
    expect(bar(80, 0.5, 10)).toBe('█████│██░░')
  })

  test('keeps the marker inside the bar at the ends', async () => {
    expect(bar(0, 0, 6)).toBe('│░░░░░')
    expect(bar(100, 1, 6)).toBe('█████│')
  })

  test('clamps usage above 100%', async () => {
    expect(bar(140, 0, 4)).toBe('│███')
  })
})

describe('pillSvg', () => {
  test('fills to usage and places the pace marker', async () => {
    const svg = pillSvg(50, 0.25, 'warning', 'tip')
    expect(svg).toContain('width="44.0" height="6" fill="#d29922"')
    expect(svg).toContain('class="m" x="21.0"')
    expect(svg).toContain('<title>tip</title>')
  })

  test('grey fill when no color, marker kept inside at the ends', async () => {
    expect(pillSvg(100, 1, undefined, '')).toContain('fill="#8b949e"')
    expect(pillSvg(0, 0, undefined, '')).toContain('class="m" x="0.0"')
    expect(pillSvg(0, 1, undefined, '')).toContain('class="m" x="86.0"')
  })
})

describe('formatResetIn', () => {
  test('short forms', async () => {
    expect(formatResetIn(59_000)).toBe('<1m')
    expect(formatResetIn(59 * 60_000)).toBe('59m')
    expect(formatResetIn(HOUR)).toBe('1h0m')
    expect(formatResetIn(23 * HOUR + 59 * 60_000)).toBe('23h59m')
    expect(formatResetIn(6 * 24 * HOUR)).toBe('6d')
    expect(formatResetIn(6 * 24 * HOUR + 9 * HOUR + 30 * 60_000)).toBe('6d9h')
  })
})

describe('barWidth', () => {
  test('text only when too narrow, capped when wide', async () => {
    expect(barWidth(40)).toBe(0)
    expect(barWidth(80)).toBe(22)
    expect(barWidth(160)).toBe(30)
  })
})

describe('reading windows', () => {
  test('toWindows keeps the two quota windows in order', async () => {
    const windows = toWindows([
      { kind: 'spend_limit', percentUsed: 50, resetsAt: '2026-11-01T00:00:00Z' },
      { kind: 'seven_day', percentUsed: 2, resetsAt: '2026-11-02T20:00:00Z' },
      { kind: 'five_hour', percentUsed: 10, resetsAt: '2026-10-27T15:30:00Z' },
    ])
    expect(windows).toEqual([
      { kind: 'five_hour', percentUsed: 10, resetsAt: Date.parse('2026-10-27T15:30:00Z') },
      { kind: 'seven_day', percentUsed: 2, resetsAt: Date.parse('2026-11-02T20:00:00Z') },
    ])
  })

  test('toWindows skips a window with no reset time', async () => {
    expect(toWindows([{ kind: 'five_hour', percentUsed: 10 }])).toEqual([])
  })

  test('liveWindows drops reset windows and junk', async () => {
    const live = { kind: 'seven_day', percentUsed: 2, resetsAt: NOW + HOUR }
    const saved = {
      windows: [{ kind: 'five_hour', percentUsed: 9, resetsAt: NOW - 1 }, live, { kind: 'x' }, null],
    }
    expect(liveWindows(saved, NOW)).toEqual([live])
    expect(liveWindows(undefined, NOW)).toEqual([])
    expect(liveWindows({ windows: 'nope' }, NOW)).toEqual([])
  })
})
