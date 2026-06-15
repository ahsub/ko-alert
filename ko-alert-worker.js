/**
 * KO Scanner Alert Worker v2.0
 * Cloudflare Worker + Cron Trigger
 *
 * Funktion:
 * - Alle 5 Min während Marktzeiten: Breakout-Scan via Yahoo Finance
 * - Breakout = Kurs > 20T-Hoch UND Volumen >= 150% des 20T-Durchschnitts
 * - Alert via Telegram, kein Doppelalert (24h KV-Sperre)
 * - Watchlist aus KV (ko-sync) oder Fallback auf hardcoded Liste
 * - /test Endpoint: erzwingt Scan unabhängig von Marktzeiten
 * - /status Endpoint: zeigt letzte Alerts + Watchlist
 * - /alert?sym=SAP Endpoint: manueller Alert-Test für einzelnen Ticker
 */

const TELEGRAM_API = 'https://api.telegram.org/bot';
const YAHOO_BASE   = 'https://query1.finance.yahoo.com/v7/finance/chart/';

// Fallback-Watchlist wenn KV leer
const DEFAULT_WATCHLIST = [
  'NVDA','AAPL','MSFT','AMD','AMSC',
  'SAP','RHM','SIE','ALV','MBG'
];

// DE-Ticker → Yahoo Suffix Mapping
const DE_MAP = {
  'SAP':'SAP.DE','RHM':'RHM.DE','SIE':'SIE.DE','ALV':'ALV.DE',
  'MBG':'MBG.DE','BMW':'BMW.DE','BAS':'BAS.DE','DTE':'DTE.DE',
  'BAYN':'BAYN.DE','ADS':'ADS.DE','DBK':'DBK.DE','MUV2':'MUV2.DE',
  'HEN3':'HAG.DE','EOAN':'EOAN.DE','VOW3':'VOW3.DE','IFX':'IFX.DE',
  'RHM':'RHM.DE','MTX':'MTX.DE','HAG':'HAG.DE','SY1':'SY1.DE',
  'BOSS':'BOSS.SG','HNR1':'HNR1.DE','CBK':'CBK.DE',
};

function toYahooSym(sym) {
  return DE_MAP[sym] || sym;
}

function isMarketOpen() {
  const now = new Date();
  const dow = now.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  // NYSE: 13:30-20:00 UTC + XETRA: 07:00-15:30 UTC → combined window
  return (mins >= 7 * 60 && mins < 20 * 60);
}

async function fetchOHLCV(sym) {
  const yfSym = toYahooSym(sym);
  const to = Math.floor(Date.now() / 1000);
  const from = to - 60 * 60 * 24 * 30; // 30 Tage für 20T-Hoch
  const url = `${YAHOO_BASE}${yfSym}?interval=1d&period1=${from}&period2=${to}&includePrePost=false`;
  
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'application/json',
    }
  });
  if (!res.ok) throw new Error(`Yahoo ${res.status} for ${yfSym}`);
  const j = await res.json();
  const result = j?.chart?.result?.[0];
  if (!result) throw new Error(`No data for ${yfSym}`);
  
  const q = result.indicators.quote[0];
  const closes = q.close.filter(v => v != null);
  const highs  = q.high.filter(v => v != null);
  const vols   = q.volume.filter(v => v != null);
  const price  = result.meta.regularMarketPrice || closes[closes.length - 1];
  
  return { sym, yfSym, price, closes, highs, vols };
}

function checkBreakout(data) {
  const { closes, highs, vols, price } = data;
  if (closes.length < 21) return null;
  
  // 20T-Hoch (ohne heutigen Tag)
  const high20 = Math.max(...highs.slice(-21, -1));
  // 20T-Volumen-Durchschnitt (ohne heutigen Tag)  
  const avgVol20 = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const todayVol = vols[vols.length - 1] || 0;
  
  const priceBreakout = price > high20;
  const volBreakout   = todayVol >= avgVol20 * 1.5;
  
  return {
    breakout: priceBreakout && volBreakout,
    price,
    high20: Math.round(high20 * 100) / 100,
    pctAbove: Math.round((price / high20 - 1) * 1000) / 10,
    volRatio: Math.round(todayVol / avgVol20 * 10) / 10,
    todayVol,
    avgVol20: Math.round(avgVol20),
  };
}

async function sendTelegram(token, chatId, text) {
  const url = `${TELEGRAM_API}${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    }),
  });
  return res.ok;
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
    return { skipped: true, reason: 'Markt geschlossen' };
  }

  const watchlist = await getWatchlist(env);
  const results = [];
  const alerts  = [];
  const errors  = [];

  for (const sym of watchlist) {
    try {
      const data = await fetchOHLCV(sym);
      const bo   = checkBreakout(data);
      if (!bo) { errors.push(`${sym}: zu wenig Daten`); continue; }

      results.push({ sym, ...bo });

      if (bo.breakout) {
        // 24h Duplikat-Sperre
        const kvKey = `alert_sent_${sym}_${new Date().toISOString().slice(0, 10)}`;
        const alreadySent = await env.KO_ALERT_KV.get(kvKey);
        if (alreadySent) continue;

        // Alert senden
        const flag = DE_MAP[sym] ? '🇩🇪' : '🇺🇸';
        const msg = `🚨 <b>BREAKOUT ALERT</b> ${flag}\n\n`
          + `<b>${sym}</b> (${data.yfSym})\n`
          + `💰 Kurs: <b>$${bo.price.toFixed(2)}</b> (+${bo.pctAbove}% über 20T-Hoch)\n`
          + `📊 Volumen: <b>${bo.volRatio}x</b> Ø (${(bo.todayVol/1e6).toFixed(1)}M vs Ø ${(bo.avgVol20/1e6).toFixed(1)}M)\n`
          + `🏔 20T-Hoch: $${bo.high20}\n\n`
          + `⏰ ${new Date().toLocaleString('de-DE', {timeZone:'Europe/Berlin'})}`;

        const sent = await sendTelegram(env.TELEGRAM_TOKEN, env.TELEGRAM_CHAT_ID, msg);
        if (sent) {
          await env.KO_ALERT_KV.put(kvKey, '1', { expirationTtl: 86400 });
          alerts.push(sym);
        }
      }
    } catch(e) {
      errors.push(`${sym}: ${e.message}`);
    }
  }

  // Status in KV speichern
  await env.KO_ALERT_KV.put('last_scan', JSON.stringify({
    ts: new Date().toISOString(),
    scanned: watchlist.length,
    breakouts: alerts,
    errors,
    results: results.map(r => ({
      sym: r.sym, price: r.price, high20: r.high20,
      pctAbove: r.pctAbove, volRatio: r.volRatio, breakout: r.breakout
    }))
  }));

  return { scanned: watchlist.length, alerts, errors, results };
}

export default {
  // Cron: alle 5 Minuten
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScan(env, false));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

    // /test → erzwinge Scan
    if (url.pathname === '/test') {
      const result = await runScan(env, true);
      return new Response(JSON.stringify(result, null, 2), { headers: cors });
    }

    // /status → letzter Scan + Watchlist
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

    // /alert?sym=SAP → manueller Test-Alert für einen Ticker
    if (url.pathname === '/alert') {
      const sym = url.searchParams.get('sym');
      if (!sym) return new Response(JSON.stringify({error:'sym fehlt'}), {status:400, headers:cors});
      try {
        const data = await fetchOHLCV(sym);
        const bo   = checkBreakout(data);
        const msg  = `🧪 <b>TEST ALERT</b>\n\n<b>${sym}</b>\n💰 ${data.price?.toFixed(2)}\n`
          + (bo ? `📊 VolRatio: ${bo.volRatio}x | 20T-Hoch: $${bo.high20} | Breakout: ${bo.breakout}` : 'Zu wenig Daten');
        await sendTelegram(env.TELEGRAM_TOKEN, env.TELEGRAM_CHAT_ID, msg);
        return new Response(JSON.stringify({sym, data: bo}), { headers: cors });
      } catch(e) {
        return new Response(JSON.stringify({error: e.message}), {status:500, headers:cors});
      }
    }

    // / → Status
    return new Response(JSON.stringify({
      status: 'KO Alert Worker v2.0',
      endpoints: ['/test', '/status', '/alert?sym=SAP'],
      market_open: isMarketOpen(),
    }), { headers: cors });
  }
};
