# ADR 0003: one run adapter between the mc_basic_1m commands and the chart

## Status

Accepted on 2026-10-21 for branch backtest/mc-chart-session. Not yet run against a live chart.

## Context

The mc_basic_1m commands (draw, snapshot, recorder, resolve, clear and broker-reset) read and draw on a live TradingView Desktop chart over CDP. A test that reached that chart could change Elijah's drawings or place a broker order, so lint.test.mjs already forbids any test file from importing cdp.mjs or cli.mjs.

Before this change each command test built its own fake run function. The fakes did not check template names, tabs or argument values, so a command could pass a bad argument and still pass its test. cdp.mjs held the placeholder "FILL_AT_INTEGRATION" for every template pin, and no file connected the commands to cdp.mjs.

## Decision

Every command reaches the chart only through `deps.run(templateName, args, tab)`, as api_v1 says.

- cdp.mjs owns the real run. Its template pins now hold the SHA-256 of each template, and templates_hash.test.mjs checks them by reading cdp.mjs as text.
- cli.mjs is the only file that imports both cdp.mjs and the command mains. It builds deps, calls the command's main with the flags after the command name, sets process.exitCode and closes the chart session in a finally block. It holds no command logic.
- fake_chart.mjs is the one in-memory adapter for tests. Its run makes the same front-door checks as cdp.mjs (close on tab "all", known template name, plain-object args, draw_trade on tab1 only, discover on a chart path) and fills the template through prepareValues and fillTemplate. It evaluates nothing; each test supplies the reply.
- The snapshot, resolve, clear and recorder tests now use the shared fake, and draw.test.mjs tests the draw command through its main.
- package.json gets a test:mc script that runs every test in the folder. This overrides design_v14 line 200, which says this work does not edit package.json; the task asked for the script.

## Consequences

- A command that passes a bad template name, tab or argument now fails its test, because the fake applies the same checks and fill as cdp.mjs.
- Any edit to a template's text needs a new pin in cdp.mjs. templates_hash.test.mjs fails until the pin matches, and cdp.mjs refuses the template at run time.
- The front-door checks live in two places, cdp.mjs and fake_chart.mjs. A change to one needs the same change in the other.
- cli.mjs and the real cdp.mjs run have not been executed. They need the live chart, so their behaviour is unverified until a supervised run.
- The report keeps its own entry point in report.mjs, because it needs no chart. Forward data is reached through `snapshot --forward`; there is no separate forward command.
