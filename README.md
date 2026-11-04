# usage-guard

A Claude Code mod that stops you from burning through a Claude rate-limit window by accident.

Once any rate-limit window (5-hour, 7-day, or a gateway spend limit) reaches 95%, usage-guard holds new prompts instead of sending them, and tells you which window is at what figure and when it resets.

## What it does

- **Holds prompts at 95%.** A prompt that would start a turn is dropped with the reason. Send the same prompt again to let it through once.
- **Holds automated prompts too.** `/loop` and scheduled prompts, peer and channel messages, and background-task notifications that would start a turn are held, and never get a second-send pass. Deliveries into a turn that is already running pass.
- **Status line.** `usage 5h 62% · 7d 31%`, ending in `· holding prompts` once a window is at the threshold.
- **Early warnings.** One toast per window at 80% and 90% (and at the threshold), again after the window resets.
- **Shares readings between sessions** on this machine, so a new or resumed session is guarded before its first response.
- **Fails closed.** If usage can't be read, prompts are held; `/usage-guard off` is the way out.

## /usage-guard

| Command | Effect |
| --- | --- |
| `/usage-guard` or `/usage-guard status` | Show every window, the settings and the override |
| `/usage-guard override` | Let prompts through for the windows at the threshold now, until each resets (or, with no reset time, falls below the threshold). A window that trips later holds again. |
| `/usage-guard clear` | End the override |
| `/usage-guard off` / `on` | Pause or resume the guard for this session |

## Options

Set in `/config`, or under `pluginConfigs["usage-guard"].options` in `~/.claude/settings.json`:

| Option | Default | Meaning |
| --- | --- | --- |
| `blockAt` | `95` | Hold prompts once any window reaches this percentage |
| `warnAt` | `80,90` | Comma-separated percentages that each raise one toast per window |

## Limits

- Rate-limit windows come from Claude's API responses, so a session sees them only after a response (or from another session's reading stored on this machine).
- Mods can't read which account a session is signed in to, so two accounts used on one machine share stored readings.
