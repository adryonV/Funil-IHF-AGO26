// build.mjs — runs on the GitHub Actions runner (Node 20+, no dependencies).
// Reads a metrics spreadsheet with TWO tabs (Meta Ads + Google Ads) and a leads
// spreadsheet, cross-references leads to ads by UTM, and writes
// ./public/data.json (aggregated, NO personal data) for the static dashboard.
//
// READ-ONLY: it only fetches the sheets via the CSV export endpoint; it never writes to them.

import { writeFileSync, mkdirSync } from 'node:fs';

// --- Sources ----------------------------------------------------------------
// Métricas dos Anúncios — one spreadsheet, two tabs.
const METRICS_ID = '1lw-5M6W5HwvTrohtWm80SnUrzjlh5SNva0xW8BcGESU';
const META_URL   = `https://docs.google.com/spreadsheets/d/${METRICS_ID}/export?format=csv&gid=0`;          // aba "Meta Ads"
const GOOGLE_URL = `https://docs.google.com/spreadsheets/d/${METRICS_ID}/export?format=csv&gid=1326864235`; // aba "Google Ads"
// Lista de Leads — aba "Página1".
const LEADS_URL  =
  'https://docs.google.com/spreadsheets/d/12bpXRkwC3yknrPt2_AmDWnvoyT0f78FSpJhMZ5BLWbg/export?format=csv&gid=0';

// --- Tax applied on top of ad spend (spend × TAX_RATE) ----------------------
const TAX_RATE = 1.1385;

// ---------------------------------------------------------------------------
// CSV parser (handles quoted fields containing commas / escaped quotes / newlines)
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* ignore */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Parse a number written in Brazilian (or plain) format: "1.234,56" / "16,14" / "197"
function num(s) {
  if (s == null) return 0;
  s = String(s).trim();
  if (!s) return 0;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); // 1.234,56 -> 1234.56
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

// Normalize a join key: collapse runs of whitespace + trim.
// CRITICAL: Sheet 1 has "Lookalike 1%  - 18a65" (double space) while the UTM in
// the leads sheet has a single space. Without this they won't match.
const normKey = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// Decode a UTM value: some leads arrive URL-encoded ("Im%C3%B3veis") while the
// metrics sheet stores them decoded ("Imóveis"). Decode, then normalize.
function decodeUtm(s) {
  let v = String(s == null ? '' : s);
  if (v.includes('%')) { try { v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch { /* keep raw */ } }
  return normKey(v);
}

// Is this UTM value a real attribution? (not empty / "undefined" / unresolved
// Meta template placeholder like "{{campaign.name}}")
const isUtm = (s) => {
  const v = String(s == null ? '' : s).trim().toLowerCase();
  return v !== '' && v !== 'undefined' && !v.includes('{{');
};

const pad = (n) => String(n).padStart(2, '0');

// Leads "DATA" is DD-MM-YYYY (also tolerates YYYY-MM-DD). Returns YYYY-MM-DD.
function leadDate(s) {
  const t = String(s || '').trim();
  let m = t.match(/^(\d{2})[-\/](\d{2})[-\/](\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

async function fetchText(url) {
  const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'funnel-dashboard-build' } });
  if (!r.ok) throw new Error(`Fetch failed ${r.status} for ${url}`);
  return await r.text();
}

function headerIndex(headerRow, name) {
  return headerRow.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
}

// Parse one metrics tab into ad rows. `map` names the columns for this channel.
function parseAds(csv, channel, map) {
  const a = parseCSV(csv);
  const h = a[0] || [];
  const I = {};
  for (const [k, name] of Object.entries(map)) I[k] = headerIndex(h, name);
  const out = [];
  for (let i = 1; i < a.length; i++) {
    const r = a[i];
    if (!r || r.length < 2) continue;
    const day = String(r[I.day] || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    out.push({
      channel,
      date: day,
      campaign: normKey(r[I.camp]),
      adset: normKey(r[I.set]),          // Meta: Ad Set · Google: Ad Group (unified field)
      ad: normKey(r[I.ad]),
      spend: num(r[I.spend]),
      impressions: Math.round(num(r[I.imp])),
      clicks: Math.round(num(r[I.clk])),
      lpv: I.lpv != null && I.lpv >= 0 ? Math.round(num(r[I.lpv])) : 0,
    });
  }
  return out;
}

(async () => {
  const [csvMeta, csvGoogle, csvLeads] = await Promise.all([
    fetchText(META_URL), fetchText(GOOGLE_URL), fetchText(LEADS_URL),
  ]);

  // ---------------- Metrics: Meta Ads + Google Ads ----------------
  const metaAds = parseAds(csvMeta, 'meta', {
    day: 'Day', camp: 'Campaign Name', set: 'Ad Set Name', ad: 'Ad Name',
    spend: 'Amount Spent', imp: 'Impressions', clk: 'Link Clicks', lpv: 'Landing Page Views',
  });
  const googleAds = parseAds(csvGoogle, 'google', {
    day: 'Day', camp: 'Campaign Name', set: 'Ad Group Name', ad: 'Ad Name',
    spend: 'Cost (Spend)', imp: 'Impressions', clk: 'Clicks', // no Landing Page Views on Google
  });
  const ads = [...metaAds, ...googleAds];

  // ---------------- Leads ----------------
  const s = parseCSV(csvLeads);
  const h = s[0];
  const J = {
    date:    0, // "DATA"
    source:  headerIndex(h, 'UTM_SOURCE'),
    camp:    headerIndex(h, 'UTM_CAMPAIGN'),
    medium:  headerIndex(h, 'UTM_MEDIUM'),   // Meta: Ad Set · Google: Ad Group
    content: headerIndex(h, 'UTM_CONTENT'),
  };

  // Classify a lead's source from utm_source.
  const classify = (raw) => {
    const v = String(raw || '').trim().toLowerCase();
    if (v === 'facebook-ads') return 'meta';
    if (v === 'google-ads')   return 'google';
    return 'organic';
  };

  const leadsMap = new Map();
  let leadsTotal = 0, attributedTotal = 0;
  const bySource = { meta: 0, google: 0, organic: 0 };

  for (let i = 1; i < s.length; i++) {
    const r = s[i];
    if (!r || r.length < 2) continue;
    const date = leadDate(r[J.date]);
    if (!date) continue;

    const source = classify(r[J.source]);
    const paid = source === 'meta' || source === 'google';

    const campOk = paid && isUtm(r[J.camp]);
    const setOk  = paid && isUtm(r[J.medium]);
    const adOk   = paid && isUtm(r[J.content]);

    const campaign = campOk ? decodeUtm(r[J.camp])    : '';
    const adset    = setOk  ? decodeUtm(r[J.medium])  : '';
    const ad       = adOk   ? decodeUtm(r[J.content]) : '';
    const attributed = paid && campOk; // can be joined to an ad-spend row

    const key = [date, source, campaign, adset, ad].join('||');
    if (!leadsMap.has(key)) leadsMap.set(key, { date, source, campaign, adset, ad, attributed, count: 0 });
    leadsMap.get(key).count++;
    leadsTotal++;
    bySource[source]++;
    if (attributed) attributedTotal++;
  }

  const leads = [...leadsMap.values()];

  // ---------------- Output ----------------
  const allDates = [...ads.map((x) => x.date), ...leads.map((x) => x.date)].sort();
  const out = {
    generatedAt: new Date().toISOString(),
    taxRate: TAX_RATE,
    currency: 'BRL',
    dateRange: { min: allDates[0] || null, max: allDates[allDates.length - 1] || null },
    counts: {
      metaRows:        metaAds.length,
      googleRows:      googleAds.length,
      leadsTotal,
      leadsMeta:       bySource.meta,
      leadsGoogle:     bySource.google,
      leadsOrganic:    bySource.organic,
      leadsAttributed: attributedTotal,
    },
    ads,
    leads,
  };

  mkdirSync('public', { recursive: true });
  writeFileSync('public/data.json', JSON.stringify(out));
  console.log('Wrote public/data.json', out.counts, out.dateRange);

  if (ads.length === 0) {
    throw new Error('No ad rows parsed — aborting so the previous deploy is kept.');
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
