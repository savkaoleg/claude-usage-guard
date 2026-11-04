// One window the person overrode: its kind and reset time (epoch ms), null
// when it reported none.
export type OverrideWindow = { kind: string; resetsAt: number | null }

export type Override = { windows: OverrideWindow[] }

// A rate-limit window as some session on this machine last read it, kept in
// `$.store` so a session with no reading of its own yet still sees it.
export type Reading = { kind: string; percentUsed: number; resetsAt?: string; measuredAt: number }

// Text of the person's prompt the guard held, and the windows it was held for.
export type Held = { text: string; keys: string[] }

declare module 'claude-code' {
  interface PluginState {
    'usage-guard': {
      // Highest threshold already toasted, keyed by `<kind>@<resetsAt>`.
      warned: Shaped<Record<string, number>>
      held: Shaped<Held | null>
      override: Shaped<Override | null>
      isDisabled: boolean
    }
  }
}
