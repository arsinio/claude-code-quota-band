export type WindowKind = 'five_hour' | 'seven_day'

export type QuotaWindow = {
  kind: WindowKind
  percentUsed: number
  // Epoch milliseconds.
  resetsAt: number
}

export type QuotaReading = {
  windows: QuotaWindow[]
  // True when loaded from the store and not yet refreshed this session.
  isStale: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'quota-band': { reading: QuotaReading | null; now: number }
  }
}
