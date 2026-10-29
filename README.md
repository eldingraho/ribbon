# cache-glance

A Claude Code mod that puts a band above the prompt and a details pane beside the chat. They show:

- **Usage left** in the 7-day (orange) and 5-hour (yellow) windows, with when each resets. A bold LOW appears under 15%.
- **The prompt cache**, warm or cold: Robo bobbing beside a WARM chip with the minutes left, or frozen beside a COLD chip with the idle time. Each comes with what the next message costs.
- **The skills run in this session**, each tagged YOU (a `/command` you typed) or CLAUDE (a skill Claude called).

It is a fork of [Ribbon](https://github.com/robonuggets/ribbon) by Jay E | RoboNuggets, whose band, card, Robo drawings and embedded font it reuses under Ribbon's MIT license. It adds:

- **The cache's lifetime:** it is inferred, either 1 hour or 5 minutes once the responses show the short cache. Ribbon assumes a fixed hour.
- **A restart:** the state survives one. The time since the last reply comes from the engine when a session resumes.
- **Skills:** a skills strip under the cache card, and a details pane with the full list and the cache numbers (hit rate, cold starts, session totals).
- **Layout:** a choice made from an estimate of each layout's width, so the band fits from the narrowest chat column to a full-width window without clipping.

It reads the engine's own figures and never calls a model, so it costs no tokens to run.

## Install

At the prompt of a terminal session:

```
/plugin install cache-glance --marketplace eldingraho/ribbon
```

Type `y` to add the marketplace, choose the **user** scope, and start a new session.

From a shell:

```bash
claude plugin install cache-glance --marketplace eldingraho/ribbon
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `eldingraho/ribbon`, then **Add plugin**.

To remove it:

```bash
claude plugin uninstall cache-glance
```

## Use

- **Show / Hide** on the band folds the cache card open or closed. Warm starts folded and cold starts open.
- **Details** on the band opens the side pane. `/cache-glance` does the same.
- **Show all (N)** under the skills strip lists every skill run in the session.

## Notes

- Dollar figures are list-price estimates from a dated table (`hooks/cache-art.ts`), not your bill. On a Claude subscription a cold re-cache uses plan allowance, not dollars.
- Whether the cache is warm is an estimate. The engine gives a mod no live warm/cold flag, and the server can expire a cache early without telling anyone.
- The band was measured on the Claude desktop app's Code tab. It needs Claude Code 2.1.309 or later; older versions refuse its text sizes and skip the band.

## Development

```bash
claude --plugin-dir ./cache-glance
claude plugin test ./cache-glance
```

## License

MIT. See `LICENSE`, which keeps Ribbon's copyright notice and the Outfit font's SIL Open Font License notice.
