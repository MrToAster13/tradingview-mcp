# mc_basic_1m context

Terms used in this folder's code, tests and design notes. design_v14 wins on behaviour; this list only names things.

## Glossary

**Chart session.** The open CDP clients that cdp.mjs holds for one command: at most one client on tab 1, one on tab 2 and one discovery candidate. cli.mjs ends every session with the close template on tab "all".

**Tab 1 pin.** Tab 1 is the chart page whose path is `/chart/HCCCDVCt/`, fixed in cdp.mjs and templates.mjs. It is the MES 1-minute chart and the only tab that draw_trade may write to.

**Tab 2 pin.** Tab 2 is the one other chart page that discovery finds showing MES 15-minute with MarketCipher_B. cdp.mjs keeps the pinned path after a lost connection, so a later call never attaches to a different chart. Zero matches is E_TAB2_NONE and more than one is E_TAB2_MANY.

**Identity guard.** The checks at the start of every template: the page path, one chart, the MES symbol and the expected resolution. A read that fails one returns a code such as E_PATH or E_RES. draw_trade repeats the guard with a deadline before each write and returns E_GUARD when it fails.

**Template pin.** The SHA-256 of each template text, kept in TEMPLATE_SHA256 in cdp.mjs. cdp.mjs refuses a template whose text does not hash to its pin (E_TEMPLATE_HASH). templates_hash.test.mjs reads cdp.mjs as text and checks every pin against templates.mjs.

**Run adapter.** The one function every command uses to reach the chart, `deps.run(templateName, args, tab)`. In production it is the run export of cdp.mjs, wired in by cli.mjs. In tests it is the run of fakeChart() in fake_chart.mjs, which makes the same front-door checks and template fill and returns the test's reply.
