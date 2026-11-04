import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, Timer } from 'claude-code'

import {
  Arg,
  COMMAND,
  type Config,
  type GuardMode,
  combineReadings,
  dropText,
  holdFor,
  isHoldable,
  isOverridden,
  isPersonal,
  isSecondSend,
  MAX_DELAY,
  nextChangeAt,
  nextWarnings,
  overrideFor,
  parseReadings,
  pruneOverride,
  READINGS_KEY,
  readConfig,
  recordReadings,
  statusReport,
  statusText,
  toastText,
  trippedWindows,
} from './guard'

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const warned = atom({ plugin: 'usage-guard', key: 'warned' } as const, {}, { shape: 'warned-1' })
const held = atom({ plugin: 'usage-guard', key: 'held' } as const, null, { shape: 'held-2' })
const override = atom({ plugin: 'usage-guard', key: 'override' } as const, null, {
  shape: 'override-3',
})
const isDisabled = atom({ plugin: 'usage-guard', key: 'isDisabled' } as const, false)

const FAILED =
  `usage-guard could not check your usage, so it held this prompt to be safe. ` +
  `Run /${COMMAND} off to stop holding prompts.`

// Redraws the status line when a window resets or an override ends; a reload
// cancels it with the old environment.
let refreshTimer: Timer | undefined

// This session's windows merged with what any session on this machine read
// last, so a session with no response yet still sees the account's state.
async function currentWindows($: EngineInterface): Promise<SessionRateLimit[]> {
  const now = await $.clock.now()
  const own = (await $.session.usage()).rateLimits

  return combineReadings(parseReadings(await $.store.get(READINGS_KEY)), own, now)
}

// The windows, or null when usage can't be read; for what only shows them.
async function readWindows($: EngineInterface): Promise<SessionRateLimit[] | null> {
  try {
    return await currentWindows($)
  } catch {
    return null
  }
}

// Records a fresh reading for every session, and answers the merged windows.
async function recordWindows(
  $: EngineInterface,
  fresh: readonly SessionRateLimit[],
): Promise<SessionRateLimit[]> {
  const now = await $.clock.now()

  try {
    const readings = recordReadings(parseReadings(await $.store.get(READINGS_KEY)), fresh, now)
    await $.store.set(READINGS_KEY, readings)

    return combineReadings(readings, fresh, now)
  } catch {
    return [...fresh]
  }
}

async function refreshStatus(
  $: EngineInterface,
  config: Config,
  windows: readonly SessionRateLimit[] | null,
): Promise<void> {
  const now = await $.clock.now()
  const lasting = pruneOverride(await read($, override), windows ?? [], config, now)
  $.ui.status(
    statusText(windows, config, now, { isDisabled: await read($, isDisabled), override: lasting }),
  )

  refreshTimer?.cancel()
  refreshTimer = undefined
  const changeAt = nextChangeAt(windows ?? [], lasting, now)

  if (changeAt !== null) {
    refreshTimer = $.clock.after(Math.min(changeAt - now, MAX_DELAY), () => {
      void refreshFromUsage($, config)
    })
  }
}

async function refreshFromUsage($: EngineInterface, config: Config): Promise<void> {
  await refreshStatus($, config, await readWindows($))
}

async function warn(
  $: EngineInterface,
  config: Config,
  windows: readonly SessionRateLimit[],
): Promise<void> {
  const now = await $.clock.now()
  const next = nextWarnings(await read($, warned), windows, config, now)
  const lasting = await read($, override)
  const isOff = await read($, isDisabled)

  for (const { window, threshold } of next.toasts) {
    const mode: GuardMode = isOff ? 'off' : isOverridden(lasting, [window]) ? 'override' : 'on'
    $.ui.toast(toastText(window, threshold, config, now, mode), { timeoutMs: 8000 })
  }

  await update($, warned, () => next.warned)
}

async function report($: EngineInterface, config: Config, note: string): Promise<string> {
  const windows = await readWindows($)
  await refreshStatus($, config, windows)
  const now = await $.clock.now()

  return (
    note +
    statusReport(windows, config, now, {
      isDisabled: await read($, isDisabled),
      override: pruneOverride(await read($, override), windows ?? [], config, now),
    })
  )
}

export const register: Register = (on, options) => {
  const config = readConfig(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-guard',
      description: 'Show Claude rate-limit usage, or override, pause or resume the prompt guard',
      argumentHint: `[${Object.values(Arg).join('|')}]`,
      immediate: true,
    })
    const started = await next(e)
    await refreshFromUsage($, config)

    return started
  })

  // Every measurement, not only one naming `rateLimits`: a window that moved
  // less than a whole point can still cross a threshold.
  on('session.measure', async ($, e, next) => {
    const now = await $.clock.now()
    const windows = await recordWindows($, e.rateLimits)
    await update($, override, lasting => pruneOverride(lasting, windows, config, now))

    if (trippedWindows(windows, config.blockAt, now).length === 0) {
      await update($, held, () => null)
    }

    await warn($, config, windows)
    await refreshStatus($, config, windows)

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (!isHoldable(e) || (await read($, isDisabled))) {
      return next(e)
    }

    const now = await $.clock.now()
    const windows = await currentWindows($)
    const tripped = trippedWindows(windows, config.blockAt, now)

    if (tripped.length === 0) {
      await update($, held, () => null)

      return next(e)
    }

    if (isOverridden(pruneOverride(await read($, override), windows, config, now), tripped)) {
      return next(e)
    }

    // Only the person's own prompts arm or use the second-send pass: a
    // repeating automated prompt would otherwise get through every other time.
    if (isPersonal(e)) {
      if (isSecondSend(await read($, held), e.text, tripped)) {
        await update($, held, () => null)

        return next(e)
      }

      await update($, held, () => holdFor(e.text, tripped))
    }

    return { drop: dropText(tripped, now, e) }
  }).catch(($, e, next) => (next.called || !isHoldable(e) ? next(e) : { drop: FAILED }))

  on('command.run', { command: 'usage-guard' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase() || Arg.status

    switch (arg) {
      case Arg.override: {
        const now = await $.clock.now()
        const windows = await readWindows($)

        if (windows === null) {
          return { text: await report($, config, `Usage could not be read, so there is nothing to override; /${COMMAND} off stops holding prompts.\n`) }
        }

        const tripped = trippedWindows(windows, config.blockAt, now)

        if (tripped.length === 0) {
          return { text: await report($, config, `No window is at ${config.blockAt}% now, so there is nothing to override.\n`) }
        }

        await update($, override, () => overrideFor(tripped))
        await update($, held, () => null)

        return { text: await report($, config, '') }
      }
      case Arg.clear:
        await update($, override, () => null)

        return { text: await report($, config, '') }
      case Arg.off:
        await update($, isDisabled, () => true)

        return { text: await report($, config, '') }
      case Arg.on:
        await update($, isDisabled, () => false)

        return { text: await report($, config, '') }
      case Arg.status:
        return { text: await report($, config, '') }
      default:
        return { text: await report($, config, `Unknown argument "${arg}".\n`) }
    }
  })
}
