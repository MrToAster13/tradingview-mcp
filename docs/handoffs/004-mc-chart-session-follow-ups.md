# 004. mc_basic_1m chart session follow-ups (tv-2)

Date: 2026-10-21. Branch: `backtest/mc-chart-session`, local only. It is built on `backtest/mc-basic-1m`, so it must never be pushed to the public fork.

Handoff 003 on fork `main` covers tv-1 and tv-3, merged as PR #4 (merge ae5ebd0). The review had three cards, tv-1 to tv-3, so this branch holds the last of the review's work.

## What landed

| Commit | What |
|---|---|
| 49f772f | tv-2. Real template pins in cdp.mjs, cli.mjs as the one entry point, fake_chart.mjs as the shared in-memory adapter, test:mc script, ADR 0003. |
| 5e39018 | Cherry-pick of the fork's sanitization path fix (d80ebf7), so test:unit gives a real signal here too. |
| bb348f5 | The seven lint.test.mjs failures. Code fixes in draw.mjs, cdp.mjs and two test helpers. Stale lints fixed where they tripped on their own text or found no templates. |
| 84681cc | The template lints were vacuous: the old loader found no templates. Each lint now takes the templates as input and has a test that runs it on a mutated template. |
| 54ba91a | draw_trade used 28 bare names instead of `@@NAME@@` placeholders, so its filled text would throw on the chart. Every value is now a placeholder, the pin is recomputed, and fillTemplate refuses extra keys, missing keys and listed names absent from the text. |
| (this commit) | ADR 0003 claim fixes from the audit, and this handoff. |

## Test counts

| After | mc suite (`node --test scripts/mc_basic_1m/*.test.mjs`) | `npm run test:unit` |
|---|---|---|
| 49f772f | 432 tests, 424 pass, 7 fail, 1 skip | 258 pass, sanitization ENOENT |
| 5e39018 | not recorded | not recorded |
| bb348f5 | 432 tests, 431 pass, 1 fail | 294 pass, 0 fail |
| 84681cc | 447 tests, 446 pass, 1 fail | 294 pass, 0 fail |
| 54ba91a | 452 tests, 452 pass, 0 fail, 0 skip | 294 pass, 0 fail |

The one failure after bb348f5 and 84681cc was the real draw_trade defect that 54ba91a fixes. The old skip was the draw_trade structure test, which skipped because the old loader found no draw_trade. It now runs and passes. `npm test`, `test:all` and `test:e2e` were not run; they wipe the live chart.

## Audit

A separate Opus agent audited 49f772f..54ba91a read-only. No critical, high or medium findings. Its secrets grep matched 19 lines, each the word "token" in a code identifier or error text, with no IPs, keys or ts.net hosts. The auditor summarized that output and did not paste it. It recomputed all five template pins, ran `node --check` on realistic fills of all five templates, and checked the P1/P2 to ENTRY/END mapping against draw.mjs:140-141.

Three low claim findings:

- Commit 84681cc says "15 of these tests fail with the old loader". 15 lint tests fail with the old loader, but only 14 of them are new; the 15th is the presence lint. The commit message is left as is; this line is the correction.
- Commit bb348f5 and ADR 0003 said every template lint passed without checking anything. The presence lint failed under the old loader. ADR 0003 is fixed; the commit message is left as is.
- ADR 0003 did not record that the client lint widens design_v14 line 137. It does now.

## Not verified

- cli.mjs and the real cdp.mjs run have never executed. The filled draw_trade text has never run on a page. All of it needs a supervised live run with Elijah watching.

## Not done

- `API_MEMBERS` lists `inputs` and `in_2`, which design_v14 line 129 does not list. Either the design or the list is wrong; not decided.
- `scripts/launch_tv_debug.bat` still runs `taskkill /F`. Handoff 002 on fork `main` (line 57) says Elijah runs it by hand, so changing it changes his bring-up. ADR 0002 on fork `main` records it as a follow-up.
- `%TEMP%\mcaudit` holds scratch copies and an `attack.mjs` dated 2026-10-20, from before this work. The auditor says it did not write `attack.mjs`. Left alone.

## Rule change, 2026-10-21

After this work, Elijah replaced the audit loop. From now on:

- Every code change goes through the tdd-loop skill: baseline the full suite, write failing tests that map 1:1 to the ticket's acceptance criteria, make them pass in at most 10 logged iterations, run tdd-loop's Opus review, add a failing regression test for each confirmed finding and fix it, run the security stage, and commit only when every gate passes. Never edit an assertion to make a test pass.
- The ticket's acceptance criteria are the spec. Ask Elijah only when a ticket has none.
- Docs, comments and config text with no behavior to test run only the security stage, then commit.
- Commit only. Elijah pushes and merges.
- Hard stop on 10 iterations, two iterations with the same failing set, or a test that looks wrong. Leave the work uncommitted, write the reason here and wait.

Pushed before the change: branch `docs/handoff-003-status` to the fork, merged as PR #5 (merge 1b926d8). That was a docs-only update to handoff 003. Nothing was pushed after the change.

## Next

1. A supervised live run of `node scripts/mc_basic_1m/cli.mjs` against the chart, once Elijah says yes.
2. Decide the `API_MEMBERS` question against design_v14 line 129. No ticket covers it, so any code change waits for a ticket with acceptance criteria.
