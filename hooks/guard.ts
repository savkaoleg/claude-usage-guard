import type { PluginOptions, PromptOrigin, PromptSubmitInput, SessionRateLimit } from 'claude-code'

import type { Held, Override, Reading } from '../types'

export const COMMAND = 'usage-guard'
export const DEFAULT_BLOCK_AT = 95
export const DEFAULT_WARN_AT = '80,90'
export const READINGS_KEY = 'readings'

export const Arg = {
  status: 'status',
  override: 'override',
  clear: 'clear',
  off: 'off',
  on: 'on',
} as const

export type Config = { blockAt: number; warnAt: number[] }

export type GuardMode = 'on' | 'off' | 'override'

const LABELS: Readonly<Record<string, string>> = {
  five_hour: '5h',
  seven_day: '7d',
  spend_limit: 'spend',
}

// The person's own gestures: only these can send a held prompt again.
const PERSONAL_ORIGINS: ReadonlySet<PromptOrigin['kind']> = new Set(['composer', 'bridge', 'slack-ping'])

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
// Reset times of one period read a little apart from response to response.
const SAME_PERIOD_MS = 5 * MINUTE
// How long a stored reading with no reset time is trusted.
const READING_MAX_AGE_MS = DAY
// The longest wait a timer takes.
export const MAX_DELAY = 2 ** 31 - 1

export const label = (kind: string): string => LABELS[kind] ?? kind

export const readConfig = (options: PluginOptions): Config => {
  const raw = Number(options.blockAt)
  const blockAt = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BLOCK_AT
  const warnAt = [
    ...new Set(
      String(options.warnAt ?? DEFAULT_WARN_AT)
        .split(',')
        .map(part => Number(part.trim()))
        .filter(n => Number.isFinite(n) && n > 0 && n < blockAt),
    ),
  ].sort((a, b) => a - b)

  return { blockAt, warnAt }
}

const parseMs = (iso: string | undefined): number | null => {
  const ms = iso === undefined ? NaN : Date.parse(iso)

  return Number.isFinite(ms) ? ms : null
}

export const resetsAtMs = (window: SessionRateLimit): number | null => parseMs(window.resetsAt)

// A window's figure comes from the last API response, so once its reset time
// has passed the figure is stale until the next response reports a new one.
export const isLive = (window: SessionRateLimit, now: number): boolean => {
  const resetsAt = resetsAtMs(window)

  return resetsAt === null || resetsAt > now
}

export const liveWindows = (
  windows: readonly SessionRateLimit[],
  now: number,
): SessionRateLimit[] => windows.filter(window => isLive(window, now))

export const trippedWindows = (
  windows: readonly SessionRateLimit[],
  blockAt: number,
  now: number,
): SessionRateLimit[] =>
  liveWindows(windows, now).filter(window => window.percentUsed >= blockAt)

export const windowKey = (window: SessionRateLimit): string =>
  `${window.kind}@${window.resetsAt ?? ''}`

const isReading = (value: unknown): value is Reading => {
  const r = value as Partial<Reading> | null

  return (
    typeof r === 'object' &&
    r !== null &&
    typeof r.kind === 'string' &&
    typeof r.percentUsed === 'number' &&
    typeof r.measuredAt === 'number' &&
    (r.resetsAt === undefined || typeof r.resetsAt === 'string')
  )
}

// What `$.store` holds under READINGS_KEY, whatever wrote it.
export const parseReadings = (stored: unknown): Reading[] =>
  Array.isArray(stored) ? stored.filter(isReading) : []

const isTrusted = (reading: Reading, now: number): boolean =>
  isLive(reading, now) && (reading.resetsAt !== undefined || now - reading.measuredAt < READING_MAX_AGE_MS)

// Of two readings of one window, the one to believe. A session's reading can be
// older than it looks (a turn ends on an old response; two sessions race to
// write), but within one period usage only grows, so the higher figure is the
// true one; a later period replaces an earlier one.
const truer = <W extends SessionRateLimit>(a: W, b: W): W => {
  const aResets = resetsAtMs(a)
  const bResets = resetsAtMs(b)

  if (aResets !== null && bResets !== null && Math.abs(aResets - bResets) > SAME_PERIOD_MS) {
    return aResets > bResets ? a : b
  }

  return a.percentUsed >= b.percentUsed ? a : b
}

// The stored readings with this session's fresh ones recorded; what has reset
// or grown too old is dropped. A window with no reset time can fall (a spend
// limit raised), so its fresh reading replaces the stored one.
export const recordReadings = (
  stored: readonly Reading[],
  fresh: readonly SessionRateLimit[],
  now: number,
): Reading[] => {
  const byKind = new Map(stored.filter(r => isTrusted(r, now)).map(r => [r.kind, r]))

  for (const { kind, percentUsed, resetsAt } of fresh) {
    const reading: Reading =
      resetsAt === undefined ? { kind, percentUsed, measuredAt: now } : { kind, percentUsed, resetsAt, measuredAt: now }
    const known = byKind.get(kind)
    byKind.set(kind, known === undefined || resetsAt === undefined ? reading : truer(reading, known))
  }

  return [...byKind.values()]
}

// The windows to judge by: for each kind, the truer of this session's own
// reading and the stored one any session on this machine recorded.
export const combineReadings = (
  stored: readonly Reading[],
  own: readonly SessionRateLimit[],
  now: number,
): SessionRateLimit[] => {
  const byKind = new Map<string, SessionRateLimit>(own.map(w => [w.kind, w]))

  for (const reading of stored) {
    if (isTrusted(reading, now)) {
      const { kind, percentUsed, resetsAt } = reading
      const window: SessionRateLimit = resetsAt === undefined ? { kind, percentUsed } : { kind, percentUsed, resetsAt }
      const known = byKind.get(kind)
      byKind.set(kind, known === undefined ? window : truer(known, window))
    }
  }

  return [...byKind.values()]
}

export const formatIn = (ms: number): string => {
  if (ms <= 0) {
    return 'now'
  }

  const minutes = Math.ceil(ms / MINUTE)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) {
    return `${days}d ${hours % 24}h`
  }

  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

export const describeWindow = (window: SessionRateLimit, now: number): string => {
  const resetsAt = resetsAtMs(window)
  const reset = resetsAt === null ? '' : ` (resets in ${formatIn(resetsAt - now)})`

  return `${label(window.kind)} window at ${window.percentUsed}%${reset}`
}

// The override covers each window tripped now for its current period only:
// until it resets, or, with no reset time, until it falls below the threshold.
export const overrideFor = (tripped: readonly SessionRateLimit[]): Override => ({
  windows: tripped.map(w => ({ kind: w.kind, resetsAt: resetsAtMs(w) })),
})

const covers = (entry: Override['windows'][number], window: SessionRateLimit): boolean => {
  const resetsAt = resetsAtMs(window)

  return (
    entry.kind === window.kind &&
    (entry.resetsAt === null
      ? resetsAt === null
      : resetsAt !== null && Math.abs(resetsAt - entry.resetsAt) <= SAME_PERIOD_MS)
  )
}

// A prompt passes on the override only while every tripped window is one the
// person overrode, in the same period: a window that trips later holds again.
export const isOverridden = (
  override: Override | null,
  tripped: readonly SessionRateLimit[],
): boolean =>
  override !== null && tripped.every(w => override.windows.some(entry => covers(entry, w)))

// What is left of the override: an entry goes when its reset passes, or, with
// no reset time, when a reading shows its window below the threshold. A window
// a reading leaves out keeps its entry.
export const pruneOverride = (
  override: Override | null,
  windows: readonly SessionRateLimit[],
  config: Config,
  now: number,
): Override | null => {
  if (override === null) {
    return null
  }

  const kept = override.windows.filter(entry => {
    if (entry.resetsAt !== null) {
      return entry.resetsAt > now
    }

    const current = windows.find(w => w.kind === entry.kind)

    return current === undefined || current.percentUsed >= config.blockAt
  })

  return kept.length ? { windows: kept } : null
}

export const isPersonal = (e: PromptSubmitInput): boolean => PERSONAL_ORIGINS.has(e.origin.kind)

// Whatever would start a turn is held, the person's prompts even mid-turn (the
// engine queues them, and they spend the window once they run). A delivery
// that isn't the person's, folded into a running turn, is lost if dropped and
// starts nothing new, so it passes; so does this mod's own command.
export const isHoldable = (e: PromptSubmitInput): boolean =>
  e.command?.name !== COMMAND && (isPersonal(e) || e.turnId === undefined)

// The person's held prompt passes on its second send while a window it was
// held for is still tripped in the same period.
export const isSecondSend = (
  held: Held | null,
  text: string,
  tripped: readonly SessionRateLimit[],
): boolean =>
  held !== null && held.text === text && tripped.some(w => held.keys.includes(windowKey(w)))

export const holdFor = (text: string, tripped: readonly SessionRateLimit[]): Held => ({
  text,
  keys: tripped.map(windowKey),
})

// The highest threshold the window has reached, if any.
export const reachedThreshold = (
  window: SessionRateLimit,
  config: Config,
): number | undefined =>
  [...config.warnAt, config.blockAt].filter(t => window.percentUsed >= t).pop()

// Which windows to toast, and the toasted levels to keep. A level is kept until
// its window's reset time passes, not dropped when one reading leaves the
// window out; a window with no reset time counts falling back as its reset.
export const nextWarnings = (
  seen: Readonly<Record<string, number>>,
  windows: readonly SessionRateLimit[],
  config: Config,
  now: number,
): { warned: Record<string, number>; toasts: { window: SessionRateLimit; threshold: number }[] } => {
  const warned: Record<string, number> = {}

  for (const [key, level] of Object.entries(seen)) {
    const resetsAt = parseMs(key.slice(key.indexOf('@') + 1) || undefined)

    if (resetsAt === null || resetsAt > now) {
      warned[key] = level
    }
  }

  const toasts: { window: SessionRateLimit; threshold: number }[] = []

  for (const window of liveWindows(windows, now)) {
    const key = windowKey(window)
    const threshold = reachedThreshold(window, config) ?? 0
    const previous = warned[key] ?? 0

    if (threshold > previous) {
      toasts.push({ window, threshold })
    }

    warned[key] = window.resetsAt === undefined ? threshold : Math.max(previous, threshold)
  }

  return { warned, toasts }
}

export const toastText = (
  window: SessionRateLimit,
  threshold: number,
  config: Config,
  now: number,
  mode: GuardMode,
): string => {
  const figure = `Claude usage: ${describeWindow(window, now)}.`

  if (threshold < config.blockAt) {
    return figure
  }

  switch (mode) {
    case 'off':
      return `${figure} The guard is off, so prompts are not held.`
    case 'override':
      return `${figure} The override is on, so prompts are not held.`
    case 'on':
      return `${figure} New prompts will be held; send one twice to go anyway, or run /${COMMAND} override.`
  }
}

export const dropText = (
  tripped: readonly SessionRateLimit[],
  now: number,
  e: PromptSubmitInput,
): string => {
  const windows = tripped.map(w => describeWindow(w, now)).join(', ')
  const until = tripped.every(w => resetsAtMs(w) !== null)
    ? 'until the window resets'
    : 'until the window resets or falls below the threshold'
  const override = `run /${COMMAND} override to stop holding ${until}.`

  if (isPersonal(e)) {
    return `usage-guard held this prompt: ${windows}. Send the same prompt again to go anyway, or ${override}`
  }

  const what =
    e.origin.kind === 'task-notification'
      ? "a background task's notification (its result is not delivered)"
      : `an automated prompt (${e.origin.kind})`

  return `usage-guard held ${what}: ${windows}. To let such prompts through, ${override}`
}

// The next time the status line could read differently with no new reading:
// a window resets or an overridden one does.
export const nextChangeAt = (
  windows: readonly SessionRateLimit[],
  override: Override | null,
  now: number,
): number | null => {
  const times = [...windows.map(resetsAtMs), ...(override?.windows ?? []).map(entry => entry.resetsAt)].filter(
    (ms): ms is number => ms !== null && ms > now,
  )

  return times.length ? Math.min(...times) : null
}

// `windows` is null when usage could not be read: prompts are held then.
export const statusText = (
  windows: readonly SessionRateLimit[] | null,
  config: Config,
  now: number,
  flags: { isDisabled: boolean; override: Override | null },
): string | undefined => {
  if (windows === null) {
    return flags.isDisabled ? 'usage-guard off' : 'usage unreadable · holding prompts'
  }

  const live = liveWindows(windows, now)

  if (live.length === 0) {
    return flags.isDisabled ? 'usage-guard off' : undefined
  }

  const tripped = trippedWindows(windows, config.blockAt, now)
  const figures = live.map(w => `${label(w.kind)} ${w.percentUsed}%`).join(' · ')
  const mode = flags.isDisabled
    ? ' · guard off'
    : tripped.length === 0
      ? ''
      : isOverridden(flags.override, tripped)
        ? ' · override'
        : ' · holding prompts'

  return `usage ${figures}${mode}`
}

export const statusReport = (
  windows: readonly SessionRateLimit[] | null,
  config: Config,
  now: number,
  flags: { isDisabled: boolean; override: Override | null },
): string => {
  const live = liveWindows(windows ?? [], now)
  const lines =
    windows === null
      ? ['  usage could not be read right now, so prompts are held']
      : live.length
        ? live.map(w => `  ${describeWindow(w, now)}`)
        : ['  no rate-limit window reported yet (none before the first response, or off a subscription)']
  const override = flags.override
    ? `on for ${flags.override.windows
        .map(
          entry =>
            `${label(entry.kind)} ${
              entry.resetsAt === null
                ? 'until it falls below the threshold'
                : `until it resets in ${formatIn(entry.resetsAt - now)}`
            }`,
        )
        .join(', ')}`
    : 'off'
  const warnings = config.warnAt.length ? `${config.warnAt.join(', ')}%` : 'none'

  return [
    'Rate-limit windows:',
    ...lines,
    `Guard: ${flags.isDisabled ? 'off' : 'on'}, holds prompts at ${config.blockAt}%, warns at ${warnings}`,
    `Override: ${override}`,
    `Usage: /${COMMAND} [${Object.values(Arg).join('|')}]`,
  ].join('\n')
}
