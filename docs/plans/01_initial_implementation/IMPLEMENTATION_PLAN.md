# Quota Band — Initial Implementation Plan

## Goal

A Claude Code mod that draws one row directly above the prompt bar showing the
account's two subscription quota windows:

```
5h ██████│░░░░░░░  38%  ↻2h31m    7d ██│░░░░░░░░░░░░  12%  ↻6d9h
```

- **Two small progress bars**: the 5-hour window and the 7-day window, side by side.
- **Pace marker**: a vertical bar (`│`) inside each progress bar showing how far
  through the window we are in time. Usage left of the marker is under budget,
  right of it is over.
- **Time to reset**: short form (`2h31m`, `6d9h`, `45m`) after each bar.
- **Color by pace**: green when on or behind pace, yellow when a little ahead,
  red when well ahead or nearly exhausted.
- **Last known values**: before the session's first reading, show the last saved
  reading, dimmed.

## Decisions

| Topic | Decision |
| --- | --- |
| Delivery | A **mod**: a `ui.render` hook on the `AbovePrompt` component. A classic `statusLine` command can't do this because it draws *below* the prompt. |
| Data source | `session.measure` events (pushed when a rate-limit window moves a whole point) plus `$.session.usage()` at start. Both give `rateLimits: { kind, percentUsed, resetsAt }[]`, the same figures the status line JSON has. |
| Layout | One row, both bars side by side. |
| Color | By pace (thresholds below). |
| Empty state | Last known values from `$.store`, dimmed, with expired windows dropped. Show nothing if there are none. |
| Surfaces | Terminal and desktop, the two that raise `AbovePrompt`. Uses only `Box` and `Text`, which both surfaces have. |
| Out of scope (v1) | `spend_limit` (gateway), per-model weekly limits (not exposed to mods), extra usage, config options. |

## Verified facts

These were checked on this machine (Claude Code 2.1.251 CLI; the desktop app's
engine is 2.1.308):

- The status line JSON carries `rate_limits.five_hour` / `seven_day` with
  `used_percentage` (integer here) and `resets_at` (epoch seconds). A live
  capture gave 10% / 2%. It's absent until the first API response.
- The mod API (`claude-code` types, 2.1.308) has:
  - `AbovePrompt` props: `hasSurvey`, `isWorking`, `maxRows`, `bodyColumns`.
  - `SessionRateLimit`: `kind` (`five_hour` | `seven_day` | `spend_limit`),
    `percentUsed` (0–100, one decimal), `resetsAt` (ISO 8601, optional).
  - `session.measure` input: `{ context, rateLimits, cost, changed }`.
  - `$.store.get/set` (persists across sessions), `$.clock.now/every`,
    `atom/read/update`.

## Mod layout

The repository root is the mod folder:

```
claude_code_status_plugin/
├── .claude-plugin/plugin.json    { name: "quota-band", version: "0.1.0", description, types }
├── hooks/
│   ├── hooks.json                { "modules": ["./register.tsx"] }
│   ├── register.tsx              hooks: session.start, session.measure, ui.render, timer
│   └── quota.ts                  pure logic: pace, color, bar cells, duration format
├── tests/
│   ├── quota.test.ts             unit tests for quota.ts
│   └── band.test.tsx             render tests for the band
├── types/index.d.ts              PluginState contract for 'quota-band'
├── docs/plans/01_initial_implementation/IMPLEMENTATION_PLAN.md
└── README.md
```

## Design

### State

Declared in `types/index.d.ts` under `interface PluginState { 'quota-band': … }`:

```ts
export type QuotaWindow = {
  kind: 'five_hour' | 'seven_day'
  percentUsed: number
  resetsAt: number   // epoch ms
}
export type QuotaReading = {
  windows: QuotaWindow[]
  isStale: boolean   // true when loaded from $.store, not yet refreshed this session
}
// PluginState['quota-band'] = { reading: QuotaReading | null; now: number }
```

- `reading` atom: the windows the band draws.
- `now` atom: a clock tick (epoch ms), updated every 60 s so the pace marker and
  countdown move between readings. Writing it redraws the band.
- `$.store` key `lastReading`: `{ windows }`, rewritten on every fresh reading.

### Hooks (`register.tsx`)

1. **`session.start`**
   - Load `$.store.get('lastReading')`, drop windows whose `resetsAt <= now`, and
     set `reading` to it with `isStale: true`.
   - Call `$.session.usage()`. If `rateLimits` has windows, apply them as fresh
     (see 2).
   - Start `$.clock.every(60_000, …)` to update `now`. Keep the returned
     canceller. A reload re-runs `register`, so module variables start over and
     there's no double timer.
2. **`session.measure`**: when `e.changed` includes `rateLimits`, map
   `e.rateLimits` → `QuotaWindow[]` (keep `five_hour`/`seven_day`, parse
   `resetsAt` to ms, and skip any without `resetsAt`). Set
   `reading = { windows, isStale: false }`, save to `$.store`, then `next(e)`.
3. **`ui.render` `{ component: 'AbovePrompt' }`**
   - Pass (`return next(e)`) when `e.props.hasSurvey`, when `reading` is null,
     or when no window is left after dropping expired ones.
   - Otherwise lay out the row to fit `e.props.bodyColumns` and return the tree.

### Pure logic (`quota.ts`)

```ts
const WINDOW_MS = { five_hour: 5 * 3600_000, seven_day: 7 * 86_400_000 }

pace(w, now)            // 0..1: elapsed fraction = clamp(1 - (resetsAt - now) / WINDOW_MS[kind], 0, 1)
paceColor(used, pace)   // 'green' | 'yellow' | 'red'
barCells(used, pace, width) // [{ char, role: 'filled' | 'empty' | 'marker' }]
formatResetIn(ms)       // '6d9h' | '2h31m' | '45m' | '<1m'
layout(columns)         // bar width per window
```

**Color thresholds** (constants, easy to tune): `ahead = used - pace * 100`.
- red: `used >= 90` or `ahead > 15`
- yellow: `ahead > 5`
- green: otherwise

The +5 point grace keeps the bar from turning yellow right after a reset, when
pace is near 0 and the first request jumps usage a couple of points.

**Bar cells**: `filled = round(used / 100 * width)`. Marker index =
`min(width - 1, floor(pace * width))`. The marker replaces whatever cell is at
its index and draws as `│`, bright/bold so it reads on both filled (`█`) and
empty (`░`) cells. Usage above 100% clamps to full.

**Short duration**: `≥1d` → `{d}d{h}h` (omit `0h`), `≥1h` → `{h}h{m}m`,
`≥1m` → `{m}m`, else `<1m`.

**Layout**: each half gets `floor((bodyColumns - 4) / 2)` columns. The fixed text
is about 16 cells (`5h ` + ` 100%` + `  ↻6d23h`). Bar width =
`clamp(half - 16, 6, 30)`. If `bodyColumns` is too narrow for two 6-cell bars,
drop the bars and show text only: `5h 38% ↻2h31m · 7d 12% ↻6d9h`.

### Rendering

```tsx
<Box flexDirection="row">
  {windows.map(w => (
    <Box key={w.kind} marginRight={4}>
      <Text dimColor>{label} </Text>
      {/* runs of same-role cells, one <Text> per run */}
      <Text color={paceColor}>{'████'}</Text>
      <Text bold>{'│'}</Text>
      <Text color={paceColor} dimColor>{'░░░'}</Text>
      <Text> {pct}%  ↻{resetIn}</Text>
    </Box>
  ))}
</Box>
```

- When `isStale`, render the whole row `dimColor` and show no color by pace. It's
  an old reading.
- Group adjacent same-role cells into one `Text` to keep the tree small.
- If `↻` turns out to be ambiguous-width in some terminals, drop the glyph and
  show plain text (`2h31m`).

## Implementation steps

1. **Scaffold**: `plugin.json`, `hooks.json`, `types/index.d.ts`, and an empty
   `register` that renders a static row. Run `claude plugin validate .`.
2. **Pure logic**: write `quota.ts` and `quota.test.ts`, covering pace at 0 / mid
   / end, the color threshold edges, marker over filled vs empty cells, >100%,
   duration formatting edges (59s, 59m, 23h59m, 6d0h), and layout at 40 / 80 /
   160 columns.
3. **Data wiring**: atoms, `session.start` (store + `$.session.usage()`),
   `session.measure`, and the 60 s tick.
4. **Rendering**: the `AbovePrompt` hook with the layout, colors, stale dimming
   and narrow-width fallback.
5. **Render test**: drive the band with a fake reading in a `claude plugin test`
   test and check the text it draws at a couple of widths.
6. **Manual check**: start a terminal session with `claude --plugin-dir .`, send
   one prompt, and confirm the numbers match `/usage`. Then check the band in
   the desktop app. Confirm it collapses with `[-]` and yields to a survey.
7. **README**: what the mod shows, the color legend and how to install.

## Verification

- `claude plugin validate .`: no refusals.
- `tsc -p .`: type-checks against the generated `.claude-plugin/types/`.
- `claude plugin test .`: unit and render tests pass.
- Manual: the band values match the app's usage card / `/usage` within a
  point, and the pace marker sits where the elapsed time says. For example, 2.5h
  into the 5-hour window it sits mid-bar.

## Risks / open items

- **CLI version**: the installed CLI is 2.1.251, while the mod API docs are from
  the desktop engine (2.1.308). Confirm in step 1 that `AbovePrompt`,
  `session.measure` and `$.session.usage()` exist on the CLI the band will run
  in. Update the CLI if not.
- **Measure cadence**: `session.measure` fires on whole-point moves and after
  turns. Usage from *other* sessions only shows up when this session gets its
  next API response. That's acceptable. The tick keeps the pace marker and
  countdown fresh.
- **Window lengths**: hard-coded 5h / 7d. If the API ever reports a window
  without a known length, draw it without a pace marker.
