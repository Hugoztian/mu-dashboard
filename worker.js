// micron-dashboard Worker: serves the static dashboard (assets) + GET /api/quote (live quote, keyless, CORS *).
// ?symbol= optional: MU (default) or LMND (allowlist; anything else -> 400). Market hours/holidays: XNAS calendar for both.
// Sources, in order: Robinhood public quotes (bounds=24_5: Nasdaq last sale + extended/overnight prints, no key),
// then Nasdaq.com quote API. Cached in-isolate ~12 s.
const SYMBOLS = { MU: { exchange: 'Nasdaq' }, LMND: { exchange: 'NYSE' } }; // allowlist
const DEFAULT_SYMBOL = 'MU';
const TTL_MS = 12000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const caches_ = {}; // symbol -> { at, body }
let hoursCache = {}; // ET date -> {is_open}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function etParts(ms) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { date: `${p.year}-${p.month}-${p.day}`, hm: (+p.hour) * 60 + (+p.minute), time: `${p.hour}:${p.minute}:${p.second}`, wd };
}
// Which part of the 24h cycle a print/time falls in (by ET clock).
function bucket(ms) {
  const { hm } = etParts(ms);
  if (hm >= 570 && hm < 960) return 'regular';
  if (hm >= 240 && hm < 570) return 'pre';
  if (hm >= 960 && hm < 1200) return 'post';
  return 'overnight';
}
const LABEL = { regular: 'Regular session', pre: 'Pre-market', post: 'After-hours', overnight: 'Overnight', closed: 'Market closed' };

async function isTradingDay(date) {
  if (hoursCache[date] !== undefined) return hoursCache[date];
  let open = null;
  try {
    const r = await fetch(`https://api.robinhood.com/markets/XNAS/hours/${date}/`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (r.ok) open = !!(await r.json()).is_open;
  } catch (e) {}
  if (open === null) { const wd = new Date(date + 'T12:00:00Z').getUTCDay(); open = wd >= 1 && wd <= 5; }
  hoursCache[date] = open;
  return open;
}
async function sessionNow(now) {
  const e = etParts(now);
  const tday = await isTradingDay(e.date);
  if (tday && e.hm >= 570 && e.hm < 960) return 'regular';
  if (tday && e.hm >= 240 && e.hm < 570) return 'pre';
  if (tday && e.hm >= 960 && e.hm < 1200) return 'post';
  // overnight (Blue Ocean ATS): 20:00 Sun–Thu -> 04:00 next weekday
  if ((e.hm >= 1200 && e.wd >= 0 && e.wd <= 4) || (e.hm < 240 && e.wd >= 1 && e.wd <= 5)) return 'overnight';
  return 'closed';
}
const num = v => (v === null || v === undefined || v === '' ? null : +v);
const chg = (p, ref) => (p != null && ref ? { change: +(p - ref).toFixed(4), pct: +((p / ref - 1) * 100).toFixed(4) } : { change: null, pct: null });

function shape({ symbol = DEFAULT_SYMBOL, now, session, regPrice, regTime, prevClose, prevCloseDate, ext, source, sourceNote, bid, ask }) {
  // reference close for extended prints = latest regular-session close
  // Reference close for change: during the regular session = previous close; otherwise = the latest regular-session
  // close (last regular trade), so extended/overnight moves read 'vs close'.
  let refClose, refDate;
  if (session === 'regular') { refClose = prevClose; refDate = prevCloseDate; }
  else { refClose = regPrice ?? prevClose; refDate = regTime ? etParts(regTime).date : prevCloseDate; }
  let extOut = null;
  if (ext && ext.price && ext.time && (!regTime || ext.time > regTime)) {
    const b = bucket(ext.time);
    extOut = { price: ext.price, time: ext.time, time_et: etParts(ext.time).date + ' ' + etParts(ext.time).time + ' ET', label: LABEL[b === 'regular' ? 'post' : b], kind: b, venue: ext.venue || null, ...chg(ext.price, refClose) };
  }
  let main;
  if (session === 'regular') main = { price: regPrice, time: regTime, label: 'Live', kind: 'regular', ...chg(regPrice, prevClose) };
  else if (extOut) main = { price: extOut.price, time: extOut.time, label: extOut.label, kind: extOut.kind, change: extOut.change, pct: extOut.pct };
  else main = { price: refClose, time: regTime, label: 'Last close', kind: 'close', change: null, pct: null };
  if (main.time) main.time_et = etParts(main.time).date + ' ' + etParts(main.time).time + ' ET';
  return {
    ok: true, symbol, session, session_label: LABEL[session], source, source_note: sourceNote,
    main, ext: extOut,
    regular: { price: regPrice, time: regTime, time_et: regTime ? etParts(regTime).date + ' ' + etParts(regTime).time + ' ET' : null, ...chg(regPrice, prevClose) },
    prev_close: { price: prevClose, date: prevCloseDate },
    ref_close: { price: refClose, date: refDate },
    bid: num(bid), ask: num(ask),
    fetched_at: new Date(now).toISOString(), fetched_et: etParts(now).date + ' ' + etParts(now).time + ' ET',
  };
}

async function fromRobinhood(now, session, symbol) {
  const r = await fetch(`https://api.robinhood.com/marketdata/quotes/?symbols=${symbol}&bounds=24_5`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error('robinhood ' + r.status);
  const q = (await r.json()).results?.[0];
  if (!q || !q.last_trade_price) throw new Error('robinhood empty');
  const regTime = q.venue_last_trade_time ? Date.parse(q.venue_last_trade_time) : null;
  const extP = num(q.last_non_reg_trade_price) ?? num(q.last_extended_hours_trade_price);
  const extT = q.venue_last_non_reg_trade_time ? Date.parse(q.venue_last_non_reg_trade_time) : null;
  const src = (q.last_non_reg_trade_price_source || '').toLowerCase();
  if (q.symbol && q.symbol !== symbol) throw new Error('robinhood symbol mismatch');
  return shape({
    symbol, now, session, regPrice: num(q.last_trade_price), regTime, prevClose: num(q.previous_close), prevCloseDate: q.previous_close_date,
    ext: extP && extT ? { price: extP, time: extT, venue: src === 'boats' ? 'Blue Ocean ATS' : (src ? src.toUpperCase() : null) } : null,
    bid: q.bid_price, ask: q.ask_price,
    source: 'Robinhood public quote', sourceNote: `real-time: ${symbol === 'MU' ? 'Nasdaq' : SYMBOLS[symbol].exchange} last sale (regular) and Robinhood 24-hour feed (extended/overnight)`,
  });
}
async function fromNasdaq(now, session, symbol) {
  const r = await fetch(`https://api.nasdaq.com/api/quote/${symbol}/info?assetclass=stocks`, { headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' } });
  if (!r.ok) throw new Error('nasdaq ' + r.status);
  const d = (await r.json()).data; if (!d || !d.primaryData) throw new Error('nasdaq empty'); const p = d.primaryData;
  const price = +String(p.lastSalePrice).replace(/[$,]/g, ''), net = +String(p.netChange).replace(/[$,+]/g, '');
  return shape({ symbol, now, session, regPrice: price, regTime: now, prevClose: price - net, prevCloseDate: null, ext: null, source: 'Nasdaq.com quote API', sourceNote: p.isRealTime ? 'Nasdaq real-time' : 'Nasdaq (may be delayed)' });
}

async function quote(only, symbol = DEFAULT_SYMBOL) {
  const now = Date.now();
  const cache = caches_[symbol] || { at: 0, body: null };
  if (!only && cache.body && now - cache.at < TTL_MS) return { body: cache.body, age: now - cache.at };
  const session = await sessionNow(now);
  const errors = [];
  const SRC = { robinhood: fromRobinhood, nasdaq: fromNasdaq };
  for (const f of only && SRC[only] ? [SRC[only]] : [fromRobinhood, fromNasdaq]) {
    try { const b = await f(now, session, symbol); if (errors.length) b.fallback_errors = errors; if (!only) caches_[symbol] = { at: now, body: b }; return { body: b, age: 0 }; }
    catch (e) { errors.push(String(e).slice(0, 120)); }
  }
  if (cache.body) return { body: { ...cache.body, stale: true, errors }, age: now - cache.at };
  return { body: { ok: false, symbol, errors, fetched_at: new Date(now).toISOString() }, age: 0, status: 502 };
}

export { shape, etParts, bucket };
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/quote') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      const symbol = (url.searchParams.get('symbol') || DEFAULT_SYMBOL).trim().toUpperCase();
      if (!Object.prototype.hasOwnProperty.call(SYMBOLS, symbol)) {
        return new Response(JSON.stringify({ ok: false, error: 'symbol not allowed', allowed: Object.keys(SYMBOLS) }), {
          status: 400, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
      }
      const { body, age, status } = await quote(url.searchParams.get('source'), symbol);
      return new Response(JSON.stringify({ ...body, cache_age_ms: age }), {
        status: status || 200,
        headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=10' },
      });
    }
    return env.ASSETS.fetch(request);
  },
};
