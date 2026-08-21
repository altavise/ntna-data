# NTNA Data Room refresher

Rebuilds the six BLS datasets the Data Room reads. No API key, no browser, no
rate limit.

## Why this exists

The BLS public API allows **25 requests per day per visitor IP**, shared across
every site that calls it. These datasets need about forty series between them,
so fetching them live in the reader's browser would exhaust a visitor's daily
allowance on a single page load, and a reader who had spent it elsewhere would
see an error instead of data.

So the data is pre-built and served as static JSON. This script is what builds
it. It reads BLS's flat files at `download.bls.gov`, which carry the same
numbers with no key and no cap.

## Running it

```
node update.js ./data
```

Writes `ecec.json`, `eci.json`, `industry.json`, `jolts.json`, `laus.json`
and `stoppages.json`, plus `status.json`.

Requires Node 18 or newer (it uses the built-in `fetch`). No dependencies.

## Failure policy

If a series that should exist comes back empty, the script **exits non-zero and
writes nothing**. A stale dataset is recoverable. A silently truncated one that
gets published as fact is not.

Nothing is written until all six datasets have been built, so a failure
halfway through cannot leave the Data Room reading a mixed vintage.

## What each file feeds

| File | Data Room tab | Cadence |
|---|---|---|
| `ecec.json` | What an employee costs | Quarterly |
| `eci.json` | How fast pay is rising | Quarterly |
| `industry.json` | Who is adding jobs | Monthly |
| `jolts.json` | Openings and turnover | Monthly |
| `laus.json` | State labor markets | Monthly |
| `stoppages.json` | Work stoppages | Monthly |
| `status.json` | Nothing. Heartbeat only | Every run |

`status.json` is a **heartbeat**, rewritten on every successful run whether or
not a figure moved. Without it the repository looks identical whether the job
ran or never fired, and a dead scheduler sends no failure email because there
is no run. Anything watching this data should read `status.json` and treat a
`ran_at` older than about a day as a stopped job.

Two are quarterly, so most daily runs will report `unchanged`. That is expected
and is not a failure. The script ignores its own `pulled` date when deciding
whether anything really moved, so it will not churn the files daily for nothing.

## Gotchas worth knowing

- **Check for monthly periods before settling for the annual roll-up.** Several
  BLS programs publish both on the same series ID. Taking `M13` when monthly
  exists silently makes a live panel look a year out of date. That is exactly
  what happened to work stoppages.
- **BLS blocks requests without a descriptive User-Agent.** One is set in
  `HEADERS`; keep the contact address current.
- **Never build a test fixture from the same constant the code uses.** The LAUS
  fixture was generated from the same state-ID map as `update.js`, so it
  validated a wrong assumption against itself and shipped series IDs that were
  two characters short. Verify IDs against the live file, or by a real run.
- **JOLTS series carry the rate/level in the last character**, not a separate
  field: `JOL` is openings as a level, `HIR`/`QUR`/`LDR` are rates. All four
  used here are seasonally adjusted (`jt.series` column `seasonal` = `S`).
- `ci` periodicity code `A` is the 12-month percent change. Code `I` is the
  index. They are different series and both exist for the same measure.
- ECEC's benefit components do not sum to the benefits total. The remainder is
  legally required cost, derived in the panel and labelled as derived.
