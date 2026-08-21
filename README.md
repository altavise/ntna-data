# NTNA Data Room refresher

Rebuilds the seven datasets the Data Room reads: six from BLS, one from Census. No API key, no browser, no
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

Writes `btos.json`, `ecec.json`, `eci.json`, `industry.json`, `jolts.json`,
`laus.json` and `stoppages.json`, plus `status.json`.

Requires Node 18 or newer (it uses the built-in `fetch`). No dependencies.

## Failure policy

If a series that should exist comes back empty, the script **exits non-zero and
writes nothing**. A stale dataset is recoverable. A silently truncated one that
gets published as fact is not.

Nothing is written until all seven datasets have been built, so a failure
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
| `btos.json` | Who is actually using AI | Fortnightly |
| `status.json` | Nothing. Heartbeat only | Every run |

`status.json` is a **heartbeat**, rewritten on every successful run whether or
not a figure moved. Without it the repository looks identical whether the job
ran or never fired, and a dead scheduler sends no failure email because there
is no run. Anything watching this data should read `status.json` and treat a
`ran_at` older than about a day as a stopped job.

Two are quarterly, so most daily runs will report `unchanged`. That is expected
and is not a failure. The script ignores its own `pulled` date when deciding
whether anything really moved, so it will not churn the files daily for nothing.

## BTOS is the odd one out

`btos.json` comes from the Census Business Trends and Outlook Survey, not BLS,
and it is **incremental**: it reads the copy it wrote last time and only fetches
periods it has never seen. On most days that is none.

It has to, because the only endpoint carrying every stratum is the whole-period
dump, which decodes to about 10MB. That is nothing on a runner and far too much
in a reader's browser, which is why the Data Room panel used to make 27 separate
requests instead and still could not show the national figure. The national
number exists **only** inside that dump.

If Census is down, this does **not** fail the run, because a Census outage must
not block five BLS datasets. The consequence is a quietly frozen panel, so the
failure is logged and `status.json` carries BTOS's reference window, which is
what makes the staleness visible from outside.

## Gotchas worth knowing

- **Check for monthly periods before settling for the annual roll-up.** Several
  BLS programs publish both on the same series ID. Taking `M13` when monthly
  exists silently makes a live panel look a year out of date. That is exactly
  what happened to work stoppages.
- **BLS blocks requests without a descriptive User-Agent.** One is set in
  `HEADERS`; keep the contact address current.
- **Census changed the AI question and one period reverts to the old wording.**
  Late 2025 it moved from "in producing goods or services" to "in any of its
  business functions". **Period 96 answers the old question** in the middle of
  the new run. The national figures either side are 18.2, 18.9, 19.1 - perfectly
  continuous, so nothing in the numbers reveals the substitution. Every period
  records which question it answered; only plot entries with `modern` true.
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
