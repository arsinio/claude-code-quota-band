import type { SessionRateLimit } from 'claude-code'

import type { QuotaWindow, WindowKind } from '../types'

export const WINDOW_MS: Record<WindowKind, number> = {
  five_hour: 5 * 3_600_000,
  seven_day: 7 * 86_400_000,
}

export const LABEL: Record<WindowKind, string> = {
  five_hour: '5h',
  seven_day: '7d',
}

export const LONG_LABEL: Record<WindowKind, string> = {
  five_hour: '5-hour limit',
  seven_day: 'Weekly limit',
}

const KINDS: readonly WindowKind[] = ['five_hour', 'seven_day']

// Points ahead of pace before the bar turns yellow / red.
export const WARN_AHEAD = 5
export const ALERT_AHEAD = 15
export const ALERT_USED = 90

// Row layout: gap between the two windows, and the cells each window spends
// on text (`5h ` + ` 100%` + `  ↻6d23h`).
const GAP = 4
const FIXED = 16
const MIN_BAR = 6
const MAX_BAR = 30

export type PaceColor = 'success' | 'warning' | 'error'
export type CellRole = 'filled' | 'empty' | 'marker'
export type Run = { role: CellRole; text: string }

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

// Fraction of the window that has elapsed, 0..1.
export function pace(w: QuotaWindow, now: number): number {
  return clamp(1 - (w.resetsAt - now) / WINDOW_MS[w.kind], 0, 1)
}

export function paceColor(percentUsed: number, elapsed: number): PaceColor {
  const ahead = percentUsed - elapsed * 100

  if (percentUsed >= ALERT_USED || ahead > ALERT_AHEAD) {
    return 'error'
  }

  return ahead > WARN_AHEAD ? 'warning' : 'success'
}

// The bar as runs of same-role cells, the pace marker replacing one cell.
export function barRuns(percentUsed: number, elapsed: number, width: number): Run[] {
  const filled = Math.round((clamp(percentUsed, 0, 100) / 100) * width)
  const marker = Math.min(width - 1, Math.floor(elapsed * width))
  const runs: Run[] = []

  for (let i = 0; i < width; i++) {
    const role: CellRole = i === marker ? 'marker' : i < filled ? 'filled' : 'empty'
    const char = role === 'marker' ? '│' : role === 'filled' ? '█' : '░'
    const last = runs[runs.length - 1]

    if (last?.role === role) {
      last.text += char
    } else {
      runs.push({ role, text: char })
    }
  }

  return runs
}

// Desktop draws each bar as an SVG pill instead of cells.
export const PILL = { width: 88, height: 10 }

const PILL_HEX: Record<PaceColor, string> = {
  success: '#3fb950',
  warning: '#d29922',
  error: '#f85149',
}

export function pillSvg(
  percentUsed: number,
  elapsed: number,
  color: PaceColor | undefined,
  title: string,
): string {
  const { width: w, height: h } = PILL
  const fill = (clamp(percentUsed, 0, 100) / 100) * w
  const marker = clamp(elapsed * w - 1, 0, w - 2)
  const hex = color ? PILL_HEX[color] : '#8b949e'

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<style>.t{fill:#8b949e;fill-opacity:.3}.m{fill:#1f2328}` +
    `@media (prefers-color-scheme: dark){.m{fill:#f0f6fc}}</style>` +
    `<title>${title}</title>` +
    `<clipPath id="p"><rect y="2" width="${w}" height="${h - 4}" rx="${(h - 4) / 2}"/></clipPath>` +
    `<rect class="t" y="2" width="${w}" height="${h - 4}" rx="${(h - 4) / 2}"/>` +
    `<rect clip-path="url(#p)" y="2" width="${fill.toFixed(1)}" height="${h - 4}" fill="${hex}"/>` +
    `<rect class="m" x="${marker.toFixed(1)}" width="2" height="${h}" rx="1"/>` +
    `</svg>`
  )
}

export function formatResetIn(ms: number): string {
  const minutes = Math.floor(ms / 60_000)

  if (minutes < 1) {
    return '<1m'
  }

  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60

  if (days > 0) {
    return hours > 0 ? `${days}d${hours}h` : `${days}d`
  }

  return hours > 0 ? `${hours}h${mins}m` : `${mins}m`
}

// Cells per bar for a row `columns` wide; 0 means show text only.
export function barWidth(columns: number): number {
  const half = Math.floor((columns - GAP) / 2)
  const width = Math.min(MAX_BAR, half - FIXED)

  return width < MIN_BAR ? 0 : width
}

export function toWindows(rateLimits: readonly SessionRateLimit[]): QuotaWindow[] {
  const windows: QuotaWindow[] = []

  for (const kind of KINDS) {
    const limit = rateLimits.find(r => r.kind === kind)
    const resetsAt = limit?.resetsAt ? Date.parse(limit.resetsAt) : NaN

    if (limit && Number.isFinite(resetsAt)) {
      windows.push({ kind, percentUsed: limit.percentUsed, resetsAt })
    }
  }

  return windows
}

// Windows that have not reset yet; tolerates anything read back from the store.
export function liveWindows(saved: unknown, now: number): QuotaWindow[] {
  const windows = (saved as { windows?: unknown } | null | undefined)?.windows

  if (!Array.isArray(windows)) {
    return []
  }

  return windows.filter(
    (w): w is QuotaWindow =>
      KINDS.includes(w?.kind) &&
      typeof w.percentUsed === 'number' &&
      typeof w.resetsAt === 'number' &&
      w.resetsAt > now,
  )
}
