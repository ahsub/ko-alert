/**
 * KO Scanner Alert Worker v2.1
 * Cloudflare Worker + Cron Trigger
 */

const TELEGRAM_API = 'https://api.telegram.org/bot';
const YAHOO_BASE   = 'https://query1.finance.yahoo.com/v7/finance/chart/';

const DEFAULT_WATCHLIST = [
  'NVDA','AAPL','MSFT','AMD','AMSC',
  'SAP','RHM','SIE','ALV','MBG'
];

const DE_MAP = {
  'SAP':'SAP.DE','RHM':'RHM.DE','SIE':'SIE.DE','ALV':'ALV.DE',
  'MBG':'MBG.DE','BMW':'BMW.DE','BAS':'BAS.DE','DTE':'DTE.DE',
  'BAYN':'BAYN.DE','ADS':'ADS.DE','DBK':'DBK.DE','MUV2':'MUV2.DE',
  'HAG':'HAG.DE','EOAN':'EOAN.DE','VOW3':'VOW3.DE','IFX':'IFX.DE',
  'MTX':'MTX.DE','HNR1':'HNR1.DE','CBK':'CBK.DE','SY1':'SY1.DE',
  'BOSS':'BOSS.SG','HEN3':'HAG.DE','RHM':'RHM.DE',
};

function toYahooSym(sym) {
  return DE_MAP[sym] || sym;
}

function isMarketOpen() {
  const now = new Date();
  const dow = now.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return (mins >= 7 * 60 && mins < 20 * 60);
}

async function fetchOHLCV(sym) {
  const yfSym = toYahooSym(sym);
  const to = Math.floor(Date.now() / 1000);
  const from = to - 60 * 60 * 24 * 40; // 40 Tage → sicher > 20 Handelstage
  const url = `${YAHOO_BASE}${yfSym}?interval=1d&period1=${from}&period2=${to}&includePrePost=false`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://finance.yahoo.com/',
    }
  });

  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status} for ${yfSym}`);
  const j = await res.json();
  const result = j?.chart?.result?.[0];
  if (!result) {
    const err = j?.chart?.error;
    throw new Error(`No data for ${yfSym}${err ? ': '+err.description : ''}`);
  }

  const q = result.indicators.quote[0];
  // Null-Werte filtern aber Index-Korrespondenz behalten
  const rawClose  = q.close  || [];
  const rawHigh   = q.high   || [];
  const rawVol    = q.volume || [];
  const validIdx  = rawClose.map((_,i)=>i).filter(i => rawClose[i] != null && rawHigh[i] != null);

  const closes = validIdx.map(i => rawClose[i]);
  const highs  = validIdx.map(i => rawHigh[i]);
  const vols   = validIdx.map(i => rawVol[i] || 0);
  const price  = result.meta.regularMarketPrice || closes[closes.length - 1];

  return { sym, yfSym, price, closes, highs, vols, bars: closes.length };
}

function checkBreakout(data) {
  const { closes, highs, vols, price } = data;
  // Mindestens 15 Handelstage für sinnvolles Signal
  if (closes.length < 15) return null;

  const n = closes.length;
  const lookback = Math.min(20, n - 1); // max 20, mind. n-1

  // 20T-Hoch: alle Bars außer dem letzten (heutiger Tag)
  const high20 = Math.max(...highs.slice(-lookback - 1, -1));
  // 20T-Volumen-Durchschnitt ohne heutigen Tag
  const volSlice  = vols.slice(-lookback - 1, -1);
  const avgVol20  = volSlice.reduce((a, b) => a + b, 0) / volSlice.length;
  const todayVol  = vols[n - 1] || 0;

  const priceBreakout = price > high20;
  const volBreakout   = avgVol20 > 0 && todayVol >= avgVol20 * 1.5;

  return {
    breakout: priceBreakout && volBreakout,
    price,
    high20: Math.round(high20 * 100) / 100,
    pctAbove: Math.round((price / high20 - 1) * 1000) / 10,
    volRatio: avgVol20 > 0 ? Math.round(todayVol / avgVol20 * 10) / 10 : 0,
    todayVol,
    avgVol20: Math.round(avgVol20),
    bars: closes.length,
  };
}

async function sendTelegram(token, chatId, text) {
  const url = `${TELEGRAM_API}${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  const j = await res.json();
  return { ok: res.ok, result: j };
}

async function getWatchlist(env) {
  try {
    const kv = await env.KO_ALERT_KV.get('alert_watchlist');
    if (kv) {
      const parsed = JSON.parse(kv);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch(e) {}
  return DEFAULT_WATCHLIST;
}

async function runScan(env, force = false) {
  if (!force && !isMarketOpen()) {
    return { skipped: true, reason: 'Markt geschlossen', time: new Date().toISOString() };
  }

  const watchlist = await getWatchlist(env);
  const results = [], alerts = [], errors = [];

  for (const sym of watchlist) {
    try {
      const data = await fetchOHLCV(sym);
      const bo   = checkBreakout(data);

      if (!bo) {
        errors.push(`${sym}: nur ${data.bars} Bars (min 15)`);
        continue;
      }

      results.push({ sym, ...bo });

      if (bo.breakout) {
        const kvKey = `alert_sent_${sym}_${new Date().toISOString().slice(0, 10)}`;
        const alreadySent = await env.KO_ALERT_KV.get(kvKey);
        if (alreadySent) { alerts.push(`${sym} (bereits gesendet)`); continue; }

        const flag = DE_MAP[sym] ? '🇩🇪' : '🇺🇸';
        const msg = `🚨 <b>BREAKOUT ALERT</b> ${flag}\n\n`
          + `<b>${sym}</b> (${data.yfSym})\n`
          + `💰 Kurs: <b>${bo.price.toFixed(2)}</b> (+${bo.pctAbove}% über 20T-Hoch)\n`
          + `📊 Volumen: <b>${bo.volRatio}x</b> Ø (${(bo.todayVol/1e6).toFixed(1)}M vs Ø ${(bo.avgVol20/1e6).toFixed(1)}M)\n`
          + `🏔 20T-Hoch: ${bo.high20}\n\n`
          + `⏰ ${new Date().toLocaleString('de-DE', {timeZone:'Europe/Berlin'})}`;

        const sent = await sendTelegram(env.TELEGRAM_TOKEN, env.TELEGRAM_CHAT_ID, msg);
        if (sent.ok) {
          await env.KO_ALERT_KV.put(kvKey, '1', { expirationTtl: 86400 });
          alerts.push(sym);
        } else {
          errors.push(`${sym}: Telegram Fehler: ${JSON.stringify(sent.result)}`);
        }
      }
    } catch(e) {
      errors.push(`${sym}: ${e.message}`);
    }
  }

  const scanResult = {
    ts: new Date().toISOString(),
    scanned: watchlist.length,
    breakouts: alerts,
    errors,
    results: results.map(r => ({
      sym: r.sym, price: r.price, high20: r.high20,
      pctAbove: r.pctAbove, volRatio: r.volRatio,
      breakout: r.breakout, bars: r.bars
    }))
  };

  await env.KO_ALERT_KV.put('last_scan', JSON.stringify(scanResult));
  return scanResult;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScan(env, false));
  },

  async fetch(request, env, ctx) {
    const url  = new URL(request.url);
    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

    if (url.pathname === '/test') {
      const result = await runScan(env, true);
      return new Response(JSON.stringify(result, null, 2), { headers: cors });
    }

    if (url.pathname === '/status') {
      const last = await env.KO_ALERT_KV.get('last_scan');
      const wl   = await getWatchlist(env);
      return new Response(JSON.stringify({
        last_scan: last ? JSON.parse(last) : null,
        watchlist: wl,
        market_open: isMarketOpen(),
        time_utc: new Date().toISOString(),
      }, null, 2), { headers: cors });
    }

    // /alert?sym=NVDA → Einzel-Test MIT Telegram
    if (url.pathname === '/alert') {
      const sym = url.searchParams.get('sym');
      if (!sym) return new Response(JSON.stringify({error:'?sym= fehlt'}), {status:400, headers:cors});
      try {
        const data = await fetchOHLCV(sym);
        const bo   = checkBreakout(data);
        const flag = DE_MAP[sym] ? '🇩🇪' : '🇺🇸';
        const msg  = `🧪 <b>TEST ${flag} ${sym}</b>\n`
          + (bo
            ? `💰 ${bo.price.toFixed(2)} | 20T-Hoch: ${bo.high20} | +${bo.pctAbove}%\n`
              + `📊 Vol: ${bo.volRatio}x Ø | Bars: ${bo.bars}\n`
              + `✅ Breakout: <b>${bo.breakout ? 'JA' : 'NEIN'}</b>`
            : `⚠️ Zu wenig Daten (${data.bars} Bars)`);
        const tg = await sendTelegram(env.TELEGRAM_TOKEN, env.TELEGRAM_CHAT_ID, msg);
        return new Response(JSON.stringify({ sym, bars: data.bars, bo, telegram: tg.ok }), { headers: cors });
      } catch(e) {
        return new Response(JSON.stringify({error: e.message}), {status:500, headers:cors});
      }
    }

    return new Response(JSON.stringify({
      status: 'KO Alert Worker v2.1',
      endpoints: ['/test (force scan)', '/status', '/alert?sym=NVDA'],
      market_open: isMarketOpen(),
      time_utc: new Date().toISOString(),
    }), { headers: cors });
  }
};
