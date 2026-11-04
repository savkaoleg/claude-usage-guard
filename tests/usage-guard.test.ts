import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptOrigin, SessionRateLimit } from 'claude-code'

import type { Reading } from '../types'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const NOW = Date.parse('2026-11-04T10:00:00.000Z')
const IN_1H = '2026-11-04T11:00:00.000Z'
const IN_6H = '2026-11-04T16:00:00.000Z'
const IN_3D = '2026-11-07T10:00:00.000Z'
const AN_HOUR_AGO = '2026-11-04T09:00:00.000Z'
const COMPOSER: PromptOrigin = { kind: 'composer' }
const SCHEDULED: PromptOrigin = { kind: 'scheduled-trigger' }
const TASK: PromptOrigin = { kind: 'task-notification' }

type World = {
  windows: SessionRateLimit[]
  toasts: string[]
  status: { text: string | undefined }
  clock: ReturnType<typeof mock.clock>
  store: Map<string, unknown>
}

// Nothing sits beneath the plugin: these hooks stand for the engine.
// `'unreadable'` makes `$.session.usage()` fail; `stored` is what other
// sessions on this machine left in the plugin's store.
const world = (
  on: On,
  windows: SessionRateLimit[] | 'unreadable' = [],
  stored: Reading[] = [],
): World => {
  const w: World = {
    windows: windows === 'unreadable' ? [] : windows,
    toasts: [],
    status: { text: undefined },
    clock: mock.clock(on, { now: NOW }),
    store: new Map(stored.length ? [['readings', stored]] : []),
  }
  // The plugin's store, kept here so a test can read what was written.
  on('store.get', (_, e) => ({ value: w.store.get(e.key) }))
  on('store.set', (_, e) => {
    w.store.set(e.key, e.value)

    return { value: undefined }
  })
  on('session.usage', () => {
    if (windows === 'unreadable') {
      throw new Error('usage unavailable')
    }

    return { value: { startedAt: NOW - HOUR, context: { window: 200_000 }, rateLimits: w.windows } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('command.register', () => ({ value: { command: 'usage-guard' } }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('ui.toast', (_, e) => {
    w.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    w.status.text = e.text

    return { value: undefined }
  })

  return w
}

const start = ($: Engine) =>
  $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

const submit = ($: Engine, text: string, extra: Partial<Parameters<Engine['prompt']['submit']>[0]> = {}) =>
  $.prompt.submit({ text, origin: COMPOSER, wait: false, ...extra })

const run = ($: Engine, args = '') =>
  $.command.run({
    command: 'usage-guard',
    args,
    origin: COMPOSER,
    presentation: { isFullscreen: false, columns: 80 },
  })

// What a response reporting these windows raises; the usage op answers them too.
const measure = (
  w: World,
  $: Engine,
  rateLimits: SessionRateLimit[],
  changed: ('context' | 'rateLimits' | 'cost')[] = ['rateLimits'],
) => {
  w.windows = rateLimits

  return $.session.measure({ context: { window: 200_000 }, rateLimits, changed })
}

const fiveHour = (percentUsed: number, resetsAt = IN_1H): SessionRateLimit => ({
  kind: 'five_hour',
  percentUsed,
  resetsAt,
})
const sevenDay = (percentUsed: number, resetsAt = IN_3D): SessionRateLimit => ({
  kind: 'seven_day',
  percentUsed,
  resetsAt,
})
const spend = (percentUsed: number): SessionRateLimit => ({ kind: 'spend_limit', percentUsed })

describe('prompt guard', () => {
  test('lets prompts through below the threshold', async ($, on) => {
    world(on, [fiveHour(62), sevenDay(31)])
    await start($)

    expect(await submit($, 'hello')).toEqual({ text: 'hello' })
  })

  test('holds a prompt at 95%, lets the same prompt through on the second send', async ($, on) => {
    world(on, [fiveHour(96), sevenDay(31)])
    await start($)

    const first = await submit($, 'refactor it')
    expect(first.drop).toMatch(/5h window at 96% \(resets in 1h 0m\)/)
    expect(first.drop).toMatch(/Send the same prompt again/)
    expect(first.drop).toMatch(/\/usage-guard override/)

    expect(await submit($, 'refactor it')).toEqual({ text: 'refactor it' })
    // The pass is used up: the same text is held again.
    expect((await submit($, 'refactor it')).drop).toBeDefined()
  })

  test('a different prompt after a hold is held, and replaces the held one', async ($, on) => {
    world(on, [fiveHour(97)])
    await start($)

    expect((await submit($, 'one')).drop).toBeDefined()
    expect((await submit($, 'two')).drop).toBeDefined()
    expect((await submit($, 'one')).drop).toBeDefined()
    expect(await submit($, 'one')).toEqual({ text: 'one' })
  })

  test('the seven-day window counts too', async ($, on) => {
    world(on, [fiveHour(10), sevenDay(95)])
    await start($)
    expect((await submit($, 'x')).drop).toMatch(/7d window at 95%/)
  })

  test('counts a spend_limit window past 100%', async ($, on) => {
    world(on, [spend(104.5)])
    await start($)
    const held = await submit($, 'x')
    expect(held.drop).toMatch(/spend window at 104.5%/)
    expect(held.drop).toMatch(/until the window resets or falls below the threshold/)
  })

  test('a window whose reset time has passed no longer holds', async ($, on) => {
    world(on, [fiveHour(99, AN_HOUR_AGO)])
    await start($)
    expect(await submit($, 'go')).toEqual({ text: 'go' })
  })

  test('the hold lifts once the clock passes the reset time', async ($, on) => {
    const w = world(on, [fiveHour(99)])
    await start($)
    expect((await submit($, 'go')).drop).toBeDefined()
    await w.clock.advance(HOUR + 1)
    expect(await submit($, 'later')).toEqual({ text: 'later' })
  })

  test('a prompt the person types mid-turn is held: it would run once queued', async ($, on) => {
    world(on, [fiveHour(99)])
    await start($)

    expect((await submit($, 'next', { turnId: 't1' })).drop).toBeDefined()
    expect(await submit($, 'next', { turnId: 't1' })).toEqual({ text: 'next' })
  })

  test('deliveries into a running turn and its own command pass', async ($, on) => {
    world(on, [fiveHour(99)])
    await start($)

    expect(await submit($, 'done', { origin: TASK, turnId: 't1' })).toEqual({ text: 'done' })
    expect(await submit($, 'fyi', { origin: { kind: 'peer' }, turnId: 't1' })).toEqual({ text: 'fyi' })
    expect(
      await submit($, '/usage-guard', { command: { name: 'usage-guard', args: '' } }),
    ).toEqual({ text: '/usage-guard' })
  })

  test('a task notification that would start a turn while idle is held, and says so', async ($, on) => {
    world(on, [fiveHour(99)])
    await start($)

    const notified = await submit($, 'monitor fired', { origin: TASK })
    expect(notified.drop).toMatch(/background task's notification \(its result is not delivered\)/)
  })

  test('other slash commands and automated prompts that start a turn are held', async ($, on) => {
    world(on, [fiveHour(99)])
    await start($)

    expect((await submit($, '/review', { command: { name: 'review', args: '' } })).drop).toBeDefined()
    expect((await submit($, 'hi', { origin: { kind: 'peer' } })).drop).toBeDefined()
    const scheduled = await submit($, 'nightly', { origin: SCHEDULED })
    expect(scheduled.drop).toMatch(/held an automated prompt \(scheduled-trigger\)/)
    expect(scheduled.drop).not.toMatch(/Send the same prompt again/)
  })

  test('a repeating automated prompt never earns the second-send pass', async ($, on) => {
    world(on, [fiveHour(99)])
    await start($)

    for (let firing = 0; firing < 4; firing += 1) {
      expect((await submit($, 'check CI', { origin: SCHEDULED })).drop).toBeDefined()
    }
  })

  test("an automated prompt with the person's held text does not use their pass", async ($, on) => {
    world(on, [fiveHour(99)])
    await start($)

    expect((await submit($, 'check CI')).drop).toBeDefined()
    expect((await submit($, 'check CI', { origin: SCHEDULED })).drop).toBeDefined()
    expect(await submit($, 'check CI')).toEqual({ text: 'check CI' })
  })

  test("an automated prompt held in between keeps the person's pass", async ($, on) => {
    world(on, [fiveHour(99)])
    await start($)

    expect((await submit($, 'refactor it')).drop).toBeDefined()
    expect((await submit($, 'check CI', { origin: SCHEDULED })).drop).toBeDefined()
    expect(await submit($, 'refactor it')).toEqual({ text: 'refactor it' })
  })

  test('a prompt held in one trip earns no pass in a later one', async ($, on) => {
    const w = world(on, [fiveHour(96)])
    await start($)
    expect((await submit($, 'continue')).drop).toBeDefined()

    // The window resets, and trips again in its next period.
    await w.clock.advance(HOUR + 1)
    await measure(w, $, [fiveHour(3, IN_6H)])
    await measure(w, $, [fiveHour(97, IN_6H)])
    expect((await submit($, 'continue')).drop).toBeDefined()
    expect(await submit($, 'continue')).toEqual({ text: 'continue' })
  })

  test('a held prompt earns no pass when the next period is already tripped', async ($, on) => {
    const w = world(on, [fiveHour(96)])
    await start($)
    expect((await submit($, 'continue')).drop).toBeDefined()

    // Another session used up the new period before this one read anything low.
    await w.clock.advance(HOUR + 1)
    await measure(w, $, [fiveHour(97, IN_6H)])
    expect((await submit($, 'continue')).drop).toBeDefined()
  })

  test('fails closed when usage cannot be read, but never for what always passes', async ($, on) => {
    world(on, 'unreadable')

    expect((await submit($, 'hi')).drop).toMatch(/could not check your usage/)
    expect(await submit($, 'done', { origin: TASK, turnId: 't1' })).toEqual({ text: 'done' })
  })
})

describe('readings shared between sessions', () => {
  const stored = (kind: string, percentUsed: number, resetsAt: string | undefined, measuredAt: number): Reading =>
    resetsAt === undefined ? { kind, percentUsed, measuredAt } : { kind, percentUsed, resetsAt, measuredAt }

  test("a new session with no reading of its own holds by another session's", async ($, on) => {
    const w = world(on, [], [stored('five_hour', 99, IN_1H, NOW - MINUTE)])
    await start($)

    expect(w.status.text).toBe('usage 5h 99% · holding prompts')
    expect((await submit($, 'first')).drop).toMatch(/5h window at 99%/)
  })

  test("a higher reading from another session in the same period wins over this session's", async ($, on) => {
    world(on, [fiveHour(70)], [stored('five_hour', 99, IN_1H, NOW - MINUTE)])
    await start($)
    expect((await submit($, 'x')).drop).toBeDefined()
  })

  test("a lower stored reading in the same period never beats this session's own", async ($, on) => {
    // This session's response moved less than a point, so no measurement recorded it.
    world(on, [fiveHour(95.2)], [stored('five_hour', 94.6, IN_1H, NOW - MINUTE)])
    await start($)
    expect((await submit($, 'x')).drop).toMatch(/5h window at 95.2%/)
  })

  test('recording keeps the higher figure of a period, and a later period replaces it', async ($, on) => {
    const w = world(on, [], [stored('five_hour', 96, IN_1H, NOW - MINUTE)])
    await start($)

    // A turn that ends on an older response must not lower what another session read.
    await measure(w, $, [fiveHour(94.8)])
    expect(w.store.get('readings')).toEqual([
      { kind: 'five_hour', percentUsed: 96, resetsAt: IN_1H, measuredAt: NOW - MINUTE },
    ])

    await measure(w, $, [fiveHour(10, IN_6H)])
    expect(w.store.get('readings')).toEqual([
      { kind: 'five_hour', percentUsed: 10, resetsAt: IN_6H, measuredAt: NOW },
    ])
  })

  test('a window with no reset time records its newest reading, which can fall', async ($, on) => {
    const w = world(on, [], [stored('spend_limit', 99, undefined, NOW - MINUTE)])
    await start($)
    await measure(w, $, [spend(20)])
    expect(w.store.get('readings')).toEqual([{ kind: 'spend_limit', percentUsed: 20, measuredAt: NOW }])
    expect(await submit($, 'x')).toEqual({ text: 'x' })
  })

  test('a stored reading that has reset, or with no reset time and a day old, is ignored', async ($, on) => {
    world(on, [], [
      stored('five_hour', 99, AN_HOUR_AGO, NOW - 2 * HOUR),
      stored('spend_limit', 99, undefined, NOW - 25 * HOUR),
    ])
    await start($)
    expect(await submit($, 'x')).toEqual({ text: 'x' })
  })

  test('a measurement records its windows for other sessions', async ($, on) => {
    const w = world(on)
    await start($)
    await measure(w, $, [fiveHour(42)])

    expect(w.store.get('readings')).toEqual([
      { kind: 'five_hour', percentUsed: 42, resetsAt: IN_1H, measuredAt: NOW },
    ])
  })
})

describe('/usage-guard', () => {
  test('override lets prompts through until cleared', async ($, on) => {
    world(on, [fiveHour(99)])
    await start($)

    const { text } = await run($, 'override')
    expect(text).toMatch(/Override: on for 5h until it resets in 1h 0m/)
    expect(await submit($, 'a')).toEqual({ text: 'a' })
    expect(await submit($, 'b', { origin: SCHEDULED })).toEqual({ text: 'b' })

    await run($, 'clear')
    expect((await submit($, 'c')).drop).toBeDefined()
  })

  test('override covers only the windows tripped when it was given', async ($, on) => {
    const w = world(on, [fiveHour(99), sevenDay(60)])
    await start($)
    await run($, 'override')
    expect(await submit($, 'a')).toEqual({ text: 'a' })

    await measure(w, $, [fiveHour(99), sevenDay(95)])
    expect((await submit($, 'b')).drop).toMatch(/7d window at 95%/)
  })

  test("override covers a window's current period only", async ($, on) => {
    const w = world(on, [fiveHour(96), sevenDay(96)])
    await start($)
    await run($, 'override')

    // The five-hour window resets and trips again while the seven-day one stays tripped.
    await w.clock.advance(HOUR + 1)
    await measure(w, $, [fiveHour(3, IN_6H), sevenDay(96)])
    expect(await submit($, 'a')).toEqual({ text: 'a' })
    await measure(w, $, [fiveHour(96, IN_6H), sevenDay(96)])
    expect((await submit($, 'b')).drop).toMatch(/5h window at 96%/)
  })

  test('override does not cover a new period even before the local clock reaches the old reset', async ($, on) => {
    const w = world(on, [fiveHour(96), sevenDay(96)])
    await start($)
    await run($, 'override')

    await measure(w, $, [fiveHour(96, IN_6H), sevenDay(96)])
    expect((await submit($, 'b')).drop).toMatch(/5h window at 96%/)
  })

  test('override ends once its window falls back below the threshold', async ($, on) => {
    const w = world(on, [spend(104.5)])
    await start($)
    expect((await run($, 'override')).text).toMatch(/spend until it falls below the threshold/)
    expect(await submit($, 'a')).toEqual({ text: 'a' })

    await measure(w, $, [spend(20)])
    await measure(w, $, [spend(97)])
    expect((await submit($, 'b')).drop).toBeDefined()
  })

  test('a reading that leaves the overridden window out keeps the override', async ($, on) => {
    const w = world(on, [spend(104.5)])
    await start($)
    await run($, 'override')

    await measure(w, $, [fiveHour(10)])
    await measure(w, $, [fiveHour(10), spend(104.5)])
    expect(await submit($, 'a')).toEqual({ text: 'a' })
  })

  test('override with nothing tripped changes nothing', async ($, on) => {
    world(on, [fiveHour(40)])
    await start($)

    const { text } = await run($, 'override')
    expect(text).toMatch(/nothing to override/)
    expect(text).toMatch(/Override: off/)
  })

  test('override says so when usage cannot be read', async ($, on) => {
    world(on, 'unreadable')
    expect((await run($, 'override')).text).toMatch(/Usage could not be read/)
  })

  test('off and on pause and resume the guard', async ($, on) => {
    const w = world(on, [fiveHour(99)])
    await start($)

    await run($, 'off')
    expect(w.status.text).toMatch(/guard off/)
    expect(await submit($, 'x')).toEqual({ text: 'x' })

    await run($, 'on')
    expect((await submit($, 'y')).drop).toBeDefined()
  })

  test('off still works, and says so, when usage cannot be read', async ($, on) => {
    world(on, 'unreadable')

    const { text } = await run($, 'off')
    expect(text).toMatch(/usage could not be read/)
    expect(text).toMatch(/Guard: off/)
    expect(await submit($, 'hi')).toEqual({ text: 'hi' })
  })

  test('status reports every window and the settings', async ($, on) => {
    world(on, [fiveHour(62), sevenDay(31)])
    await start($)

    const { text } = await run($)
    expect(text).toMatch(/5h window at 62% \(resets in 1h 0m\)/)
    expect(text).toMatch(/7d window at 31% \(resets in 3d 0h\)/)
    expect(text).toMatch(/holds prompts at 95%, warns at 80, 90%/)
  })

  test('an unknown argument says so', async ($, on) => {
    world(on)
    await start($)
    expect((await run($, 'bogus')).text).toMatch(/Unknown argument "bogus"/)
  })
})

describe('status line and toasts', () => {
  test('the status line shows each window and turns to holding', async ($, on) => {
    const w = world(on, [fiveHour(62), sevenDay(31)])
    await start($)
    expect(w.status.text).toBe('usage 5h 62% · 7d 31%')

    await measure(w, $, [fiveHour(96), sevenDay(31)])
    expect(w.status.text).toBe('usage 5h 96% · 7d 31% · holding prompts')
  })

  test('a measurement that does not name rateLimits still updates it', async ($, on) => {
    const w = world(on, [fiveHour(94.6)])
    await start($)

    await measure(w, $, [fiveHour(95.3)], ['context'])
    expect(w.status.text).toBe('usage 5h 95.3% · holding prompts')
    expect(w.toasts.at(-1)).toMatch(/New prompts will be held/)
  })

  test('the status line redraws itself when a window resets', async ($, on) => {
    const w = world(on, [fiveHour(96), sevenDay(31)])
    await start($)
    expect(w.status.text).toMatch(/holding prompts/)

    await w.clock.advance(HOUR + 1)
    expect(w.status.text).toBe('usage 7d 31%')
  })

  test('the status line says prompts are held when usage cannot be read', async ($, on) => {
    const w = world(on, 'unreadable')
    await start($)
    expect(w.status.text).toBe('usage unreadable · holding prompts')
  })

  test('no windows yet clears the status line', async ($, on) => {
    const w = world(on, [])
    await start($)
    expect(w.status.text).toBeUndefined()
  })

  test('one toast per threshold per window, again after a reset', async ($, on) => {
    const w = world(on)
    await start($)

    await measure(w, $, [fiveHour(70)])
    expect(w.toasts).toEqual([])

    await measure(w, $, [fiveHour(82)])
    await measure(w, $, [fiveHour(85)])
    expect(w.toasts).toHaveLength(1)
    expect(w.toasts[0]).toMatch(/5h window at 82%/)

    await measure(w, $, [fiveHour(91)])
    await measure(w, $, [fiveHour(95)])
    expect(w.toasts).toHaveLength(3)
    expect(w.toasts[2]).toMatch(/New prompts will be held/)

    // The next five-hour window: a new reset time starts over.
    await w.clock.advance(HOUR + 1)
    await measure(w, $, [fiveHour(81, IN_6H)])
    expect(w.toasts).toHaveLength(4)
  })

  test('a window missing from one reading is not warned about twice', async ($, on) => {
    const w = world(on)
    await start($)

    await measure(w, $, [fiveHour(10), sevenDay(85)])
    await measure(w, $, [fiveHour(12)])
    await measure(w, $, [fiveHour(12), sevenDay(85)])
    expect(w.toasts).toHaveLength(1)
  })

  test('a jump past several thresholds toasts once, for the highest', async ($, on) => {
    const w = world(on)
    await start($)
    await measure(w, $, [fiveHour(97)])
    expect(w.toasts).toHaveLength(1)
    expect(w.toasts[0]).toMatch(/New prompts will be held/)
  })

  test('the block toast does not promise a hold while the guard is off', async ($, on) => {
    const w = world(on)
    await start($)
    await run($, 'off')

    await measure(w, $, [fiveHour(96)])
    expect(w.toasts[0]).toMatch(/The guard is off/)
    expect(w.toasts[0]).not.toMatch(/will be held/)
  })
})

describe('options', () => {
  test('blockAt and warnAt come from userConfig', { options: { blockAt: 80, warnAt: '50, 70, 90' } }, async ($, on) => {
    const w = world(on, [fiveHour(80)])
    await start($)

    expect((await submit($, 'x')).drop).toMatch(/5h window at 80%/)
    await measure(w, $, [fiveHour(60)])
    // 90 is not below blockAt, so it is no warning level.
    expect((await run($)).text).toMatch(/holds prompts at 80%, warns at 50, 70%/)
    expect(w.toasts).toHaveLength(1)
  })

  test('no warning levels reads as none', { options: { warnAt: '' } }, async ($, on) => {
    world(on)
    await start($)
    expect((await run($)).text).toMatch(/warns at none$/m)
  })
})
