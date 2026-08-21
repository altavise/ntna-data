#!/usr/bin/env node
/*
 * No Talent, No Alpha - Data Room refresher.
 *
 * Rebuilds the six bundled BLS datasets the Data Room reads. Run it anywhere
 * with plain internet access; it needs no API key and no browser.
 *
 * WHY THE FLAT FILES AND NOT THE API
 * The BLS public API allows 25 requests a day per IP without a registration
 * key, and these six datasets need well over forty series between them. The flat
 * files at download.bls.gov carry the same numbers with no key and no cap. The
 * cost is that some are large, so each is streamed once and scanned for the
 * series we want rather than parsed into memory as a whole.
 *
 * FAILURE POLICY
 * If a series that should exist comes back empty, this exits non-zero and
 * writes nothing. A stale dataset is recoverable; a silently truncated one
 * that gets published as fact is not.
 *
 *   node update.js [outputDir]      default: ./data
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BASE = 'https://download.bls.gov/pub/time.series';

/* BLS blocks requests without a descriptive User-Agent. Their published
   guidance asks for a contact address, so identify the job honestly. */
const HEADERS = {
    'User-Agent': 'NoTalentNoAlpha-DataRoom/1.0 (hello@notalentnoalpha.com)',
    'Accept': 'text/plain,*/*'
};

const OUT = path.resolve(process.argv[2] || 'data');
const TODAY = new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------------ */

async function get(rel) {
    const url = BASE + rel;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const r = await fetch(url, { headers: HEADERS });
            if (!r.ok) { throw new Error('HTTP ' + r.status); }
            const text = await r.text();
            if (text.length < 100) { throw new Error('suspiciously short: ' + text.length); }
            return text;
        } catch (e) {
            if (attempt === 3) { throw new Error(rel + ' failed after 3 tries: ' + e.message); }
            await new Promise(r => setTimeout(r, attempt * 3000));
        }
    }
}

/* Pull specific series out of a BLS flat data file.
 * Returns { seriesId: [ [periodKey, value], ... ] } sorted ascending.
 * With withFootnotes, each point carries a third element: the raw footnote
 * codes for that observation. Only JOLTS needs them, to mark the newest
 * month preliminary, so the other callers stay on the two-element shape. */
function extract(text, wanted, periodOk, keyOf, withFootnotes) {
    const want = new Set(wanted);
    const out = {};
    const lines = text.split('\n');
    for (let i = 1; i < lines.length; i++) {
        const c = lines[i].split('\t');
        if (c.length < 4) { continue; }
        const id = c[0].trim();
        if (!want.has(id)) { continue; }
        const period = c[2].trim();
        if (!periodOk(period)) { continue; }
        const value = parseFloat(c[3]);
        if (Number.isNaN(value)) { continue; }
        const point = [keyOf(c[1].trim(), period), value];
        if (withFootnotes) { point.push((c[4] || '').trim()); }
        (out[id] || (out[id] = [])).push(point);
    }
    for (const k of Object.keys(out)) { out[k].sort((a, b) => a[0].localeCompare(b[0])); }

    const missing = wanted.filter(id => !out[id] || !out[id].length);
    if (missing.length) {
        throw new Error('series returned no data: ' + missing.join(', ') +
            ' (BLS may have renamed or discontinued them)');
    }
    return out;
}

const QUARTER = p => /^Q0[1-4]$/.test(p);
const MONTH = p => /^M(0[1-9]|1[0-2])$/.test(p);
const ANNUAL = p => p === 'M13';
const qKey = (y, p) => y + 'Q' + p.slice(2);
const mKey = (y, p) => y + '-' + p.slice(1);
const yKey = y => y;

function tail(arr, n) { return arr.slice(-n); }
function vals(series, n) { return tail(series, n).map(p => p[1]); }
function keys(series, n) { return tail(series, n).map(p => p[0]); }

/* ------------------------------------------------------------------ */

async function ecec() {
    const S = {
        cost_civilian_total: 'CMU1010000000000D',
        cost_private_total: 'CMU2010000000000D',
        cost_private_wages: 'CMU2020000000000D',
        cost_private_benefits: 'CMU2030000000000D',
        cost_public_total: 'CMU3010000000000D',
        pct_benefits: 'CMU2030000000000P',
        pct_paidleave: 'CMU2040000000000P',
        pct_supplemental: 'CMU2090000000000P',
        pct_insurance: 'CMU2130000000000P',
        pct_retirement: 'CMU2180000000000P'
    };
    const raw = extract(await get('/cm/cm.data.1.AllData'),
        Object.values(S), QUARTER, qKey);
    const N = 21;
    const doc = {
        source: 'US Bureau of Labor Statistics, Employer Costs for Employee Compensation',
        reference: keys(raw[S.cost_private_total], 1)[0],
        pulled: TODAY,
        note: 'Rebuilt by update.js from the cm database. Quarterly.',
        q: keys(raw[S.cost_private_total], N)
    };
    for (const k of Object.keys(S)) { doc[k] = vals(raw[S[k]], N); }
    return ['ecec.json', doc];
}

async function eci() {
    const S = {
        civilian_total: 'CIU1010000000000A',
        private_total: 'CIU2010000000000A',
        private_wages: 'CIU2020000000000A',
        private_benefits: 'CIU2030000000000A',
        public_total: 'CIU3010000000000A'
    };
    const raw = extract(await get('/ci/ci.data.0.Current'),
        Object.values(S), QUARTER, qKey);
    const N = 28;
    const doc = {
        source: 'US Bureau of Labor Statistics, Employment Cost Index',
        measure: '12-month percent change, current dollars',
        reference: keys(raw[S.private_total], 1)[0],
        pulled: TODAY,
        note: 'Rebuilt by update.js from the ci database. Periodicity code A. Quarterly.',
        q: keys(raw[S.private_total], N)
    };
    for (const k of Object.keys(S)) { doc[k] = vals(raw[S[k]], N); }
    return ['eci.json', doc];
}

const INDUSTRIES = {
    CES0000000001: 'Total nonfarm',
    CES1000000001: 'Mining and logging',
    CES2000000001: 'Construction',
    CES3000000001: 'Manufacturing',
    CES4000000001: 'Trade, transport and utilities',
    CES5000000001: 'Information',
    CES5500000001: 'Financial activities',
    CES6000000001: 'Professional and business services',
    CES6500000001: 'Private education and health',
    CES7000000001: 'Leisure and hospitality',
    CES8000000001: 'Other services',
    CES9000000001: 'Government',
    CES6056132001: 'Temporary help services'
};

async function industry() {
    const ids = Object.keys(INDUSTRIES);
    const raw = extract(await get('/ce/ce.data.01a.CurrentSeasAE'), ids, MONTH, mKey);

    const yoy = {};
    for (const id of ids) {
        const d = raw[id];
        if (d.length < 13) { throw new Error(id + ' has under 13 months, cannot compute a year'); }
        const now = d[d.length - 1][1], yr = d[d.length - 13][1];
        yoy[INDUSTRIES[id]] = [Math.round((now - yr) / yr * 1000) / 10, Math.round(now)];
    }
    const N = 42;
    return ['industry.json', {
        source: 'US Bureau of Labor Statistics, Current Employment Statistics',
        reference: keys(raw.CES0000000001, 1)[0],
        pulled: TODAY,
        note: 'Rebuilt by update.js from the ce database. All employees, seasonally adjusted, thousands. Monthly.',
        yoy,
        m: keys(raw.CES0000000001, N),
        temp_help: vals(raw.CES6056132001, N),
        information: vals(raw.CES5000000001, N)
    }];
}

const STATES = {
    '01': 'Alabama', '02': 'Alaska', '04': 'Arizona', '05': 'Arkansas', '06': 'California',
    '08': 'Colorado', '09': 'Connecticut', '10': 'Delaware', '11': 'District of Columbia',
    '12': 'Florida', '13': 'Georgia', '15': 'Hawaii', '16': 'Idaho', '17': 'Illinois',
    '18': 'Indiana', '19': 'Iowa', '20': 'Kansas', '21': 'Kentucky', '22': 'Louisiana',
    '23': 'Maine', '24': 'Maryland', '25': 'Massachusetts', '26': 'Michigan', '27': 'Minnesota',
    '28': 'Mississippi', '29': 'Missouri', '30': 'Montana', '31': 'Nebraska', '32': 'Nevada',
    '33': 'New Hampshire', '34': 'New Jersey', '35': 'New Mexico', '36': 'New York',
    '37': 'North Carolina', '38': 'North Dakota', '39': 'Ohio', '40': 'Oklahoma', '41': 'Oregon',
    '42': 'Pennsylvania', '44': 'Rhode Island', '45': 'South Carolina', '46': 'South Dakota',
    '47': 'Tennessee', '48': 'Texas', '49': 'Utah', '50': 'Vermont', '51': 'Virginia',
    '53': 'Washington', '54': 'West Virginia', '55': 'Wisconsin', '56': 'Wyoming',
    '72': 'Puerto Rico'
};

async function laus() {
    const ids = Object.keys(STATES).map(f => 'LASST' + f + '00000000003');
    const raw = extract(await get('/la/la.data.3.AllStatesS'), ids, MONTH, mKey);

    const rows = [];
    let reference = null;
    for (const fips of Object.keys(STATES)) {
        const d = raw['LASST' + fips + '00000000003'];
        const now = d[d.length - 1];
        const yr = d[d.length - 13] || null;
        reference = reference || now[0];
        rows.push([STATES[fips], now[1], yr ? yr[1] : null]);
    }
    rows.sort((a, b) => b[1] - a[1]);

    const names = rows.map(r => r[0]);
    if (new Set(names).size !== names.length) {
        throw new Error('duplicate state names, check the FIPS map');
    }
    return ['laus.json', {
        source: 'US Bureau of Labor Statistics, Local Area Unemployment Statistics',
        measure: 'Unemployment rate, seasonally adjusted',
        reference,
        pulled: TODAY,
        note: 'Rebuilt by update.js from the la database. State, current rate, rate twelve months earlier. Monthly.',
        rows
    }];
}

async function stoppages() {
    const S = { stop: 'WSU100', work: 'WSU010', days: 'WSU001' };
    const text = await get('/ws/ws.data.1.AllData');
    const mo = extract(text, Object.values(S), MONTH, mKey);
    const yr = extract(text, Object.values(S), ANNUAL, yKey);

    /* A trailing twelve-month sum needs eleven months of run-up before the
       first point it can report, so the window is only as long as the history
       allows. Reading past the start of the array would otherwise produce
       NaN totals that look like real zeroes once rounded. */
    const WINDOW = 48;
    const span = Math.min(WINDOW, mo[S.stop].length - 11);
    if (span < 12) {
        throw new Error('work stoppages has under 23 months, cannot build rolling totals');
    }
    const months = keys(mo[S.stop], span);
    const roll = id => {
        const f = mo[id], out = [];
        for (let i = f.length - span; i < f.length; i++) {
            let s = 0;
            for (let j = i - 11; j <= i; j++) { s += f[j][1]; }
            out.push(Math.round(s * 10) / 10);
        }
        return out;
    };

    /* Year to date is compared against the same months of the prior year, not
       against the prior full year, or a partial year always looks like a
       collapse. */
    const latest = months[months.length - 1];
    const thisYear = latest.slice(0, 4);
    const lastYear = String(Number(thisYear) - 1);
    const cutoff = Number(latest.slice(5));
    const ytd = y => {
        const sum = id => mo[id]
            .filter(p => p[0].slice(0, 4) === y && Number(p[0].slice(5)) <= cutoff)
            .reduce((a, p) => a + p[1], 0);
        return {
            stoppages: Math.round(sum(S.stop)),
            workers_thousands: Math.round(sum(S.work)),
            days_idle_thousands: Math.round(sum(S.days))
        };
    };

    const doc = {
        source: 'US Bureau of Labor Statistics, Work Stoppages Program',
        scope: 'Work stoppages involving 1,000 or more workers',
        reference: latest,
        pulled: TODAY,
        note: 'Rebuilt by update.js from the ws database. Rolling figures are trailing twelve-month sums. Monthly.',
        ytd_month: cutoff,
        ytd: {},
        m: months,
        rolling_stoppages: roll(S.stop),
        rolling_workers_thousands: roll(S.work),
        y: keys(yr[S.stop], 26),
        stoppages: vals(yr[S.stop], 26),
        workers_thousands: vals(yr[S.work], 26),
        days_idle_thousands: vals(yr[S.days], 26)
    };
    doc.ytd[thisYear] = ytd(thisYear);
    doc.ytd[lastYear] = ytd(lastYear);
    return ['stoppages.json', doc];
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* JOLTS was the last panel reading api.bls.gov live in the reader's browser.
   That worked, but it spent four of a visitor's twenty-five daily API requests,
   and a reader who had spent them elsewhere saw an error instead of data. The
   same numbers are in the jt database with no key and no cap.
   All four series are seasonally adjusted (jt.series column `seasonal` = S),
   which is what the panel's chart titles claim. */
const JOLTS_SERIES = [
    { id: 'JTS000000000000000JOL', name: 'Job openings', group: 'level' },
    { id: 'JTS000000000000000HIR', name: 'Hires', group: 'rate' },
    { id: 'JTS000000000000000QUR', name: 'Quits', group: 'rate' },
    { id: 'JTS000000000000000LDR', name: 'Layoffs and discharges', group: 'rate' }
];

async function jolts() {
    const ids = JOLTS_SERIES.map(s => s.id);
    const raw = extract(await get('/jt/jt.data.0.Current'), ids, MONTH, mKey, true);

    const N = 30;

    /* Every series must end on the same month. JOLTS publishes all four
       together, so a mismatch means the file was read mid-revision and the
       panel would draw lines that stop at different points without saying so. */
    const ends = ids.map(id => tail(raw[id], 1)[0][0]);
    if (new Set(ends).size !== 1) {
        throw new Error('JOLTS series end on different months: ' + ends.join(', '));
    }
    const shortest = Math.min(...ids.map(id => raw[id].length));
    if (shortest < N) {
        throw new Error('JOLTS has only ' + shortest + ' months, need ' + N);
    }

    return ['jolts.json', {
        source: 'US Bureau of Labor Statistics, Job Openings and Labor Turnover Survey',
        measure: 'Seasonally adjusted. Openings in thousands, the rest as a percent of employment.',
        reference: ends[0],
        pulled: TODAY,
        note: 'Rebuilt by update.js from the jt database. Monthly.',
        series: JOLTS_SERIES.map(s => ({
            id: s.id,
            name: s.name,
            group: s.group,
            points: tail(raw[s.id], N).map(p => ({
                label: MONTH_NAMES[Number(p[0].slice(5)) - 1] + " '" + p[0].slice(2, 4),
                key: p[0],
                value: p[1],
                preliminary: p[2].split(/[\s,]+/).indexOf('P') >= 0
            }))
        }))
    }];
}

/* ------------------------------------------------------------------ */

async function main() {
    const jobs = [ecec, eci, industry, jolts, laus, stoppages];
    const results = [];

    for (const job of jobs) {
        const started = Date.now();
        const [name, doc] = await job();
        results.push([name, doc, Date.now() - started]);
    }

    // Nothing is written until every dataset has been built, so a failure
    // halfway through cannot leave the Data Room reading a mixed vintage.
    fs.mkdirSync(OUT, { recursive: true });
    let changed = 0;
    for (const [name, doc, ms] of results) {
        const file = path.join(OUT, name);
        const next = JSON.stringify(doc);
        let prev = null;
        try { prev = fs.readFileSync(file, 'utf8'); } catch (e) { /* first run */ }

        // ignore the pulled date when deciding whether anything really moved
        const strip = s => s ? s.replace(/"pulled":"[^"]*",?/, '') : null;
        const same = strip(prev) === strip(next);
        if (!same) { fs.writeFileSync(file, next); changed++; }
        console.log('%s %s  reference %s  %dms', same ? 'unchanged' : 'UPDATED  ',
            name.padEnd(16), doc.reference, ms);
    }
    console.log('\n%d of %d datasets changed', changed, results.length);
    process.exit(0);
}

main().catch(err => {
    console.error('FAILED, nothing written:', err.message);
    process.exit(1);
});
