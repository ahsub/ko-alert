/**
 * KO Scanner Alert Worker v3.0
 * Cloudflare Worker + Cron Trigger
 *
 * Endpoints:
 *   GET  /status            — letzter Scan-Status
 *   GET  /test              — Force-Scan mit Telegram
 *   GET  /alert?sym=NVDA    — Einzel-Test MIT Telegram
 *   GET  /debug-telegram    — Telegram-Verbindung testen
 *   POST /macro             — Makro-State vom Scanner empfangen
 *   POST /alert             — Einzel-Ticker-Alert vom Scanner empfangen
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
  'BOSS':'BOSS.SG','HEN3':'HAG.DE',
};

const VIX_ZONES = {
  1: { label: 'Extrem niedrig',  emoji: '🟢', desc: 'Sehr ruhiger Markt' },
  2: { label: 'Niedrig',         emoji: '🟢', desc: 'Ruhiger Markt' },
  3: { label: 'Normal',          emoji: '🟡', desc: 'Normaler Markt' },
  4: { label: 'Erhöht',          emoji: '🟠', desc: 'Selektiv vorgehen' },
  5: { label: 'Hoch',            emoji: '🔴', desc: 'Vorsicht — Hedge erwägen' },
  6: { label: 'Extrem',          emoji: '🚨', desc: 'Krisenzone — kein Long' },
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

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: CORS });
}

async function fetchOHLCV(sym) {
  const yfSym = toYahooSym(sym);
  const to = Math.floor(Date.now() / 1000);
  const from = to - 60 * 60 * 24 * 40;
  const url = `${YAHOO_BASE}${yfSym}?interval=1d&period1=${from}&period2=${to}&includePrePost=false`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://finance.yahoo.com/',
    }
  });

  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status} for ${yfSym}`);
  const j = await res.json();
  const result = j?.chart?.result?.[0];
  if (!result) throw new Error(`No data for ${yfSym}`);

  const q = result.indicators.quote[0];
  const rawClose = q.close  || [];
  const rawHigh  = q.high   || [];
  const rawVol   = q.volume || [];
  const validIdx = rawClose.map((_,i)=>i).filter(i => rawClose[i] != null && rawHigh[i] != null);

  const closes = validIdx.map(i => rawClose[i]);
  const highs  = validIdx.map(i => rawHigh[i]);
  const vols   = validIdx.map(i => rawVol[i] || 0);
  const price  = result.meta.regularMarketPrice || closes[closes.length - 1];

  return { sym, yfSym, price, closes, highs, vols, bars: closes.length };
}

function checkBreakout(data) {
  const { closes, highs, vols, price } = data;
  if (closes.length < 15) return null;

  const n = closes.length;
  const lookback = Math.min(20, n - 1);
  const high20 = Math.max(...highs.slice(-lookback - 1, -1));
  const volSlice = vols.slice(-lookback - 1, -1);
  const avgVol20 = volSlice.reduce((a, b) => a + b, 0) / volSlice.length;
  const todayVol = vols[n - 1] || 0;

  return {
    breakout: price > high20 && avgVol20 > 0 && todayVol >= avgVol20 * 1.5,
    price,
    high20:   Math.round(high20 * 100) / 100,
    pctAbove: Math.round((price / high20 - 1) * 1000) / 10,
    volRatio: avgVol20 > 0 ? Math.round(todayVol / avgVol20 * 10) / 10 : 0,
    todayVol,
    avgVol20: Math.round(avgVol20),
    bars:     closes.length,
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
    if (!env.KO_ALERT_KV) return DEFAULT_WATCHLIST;
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

      if (!bo) { errors.push(`${sym}: nur ${data.bars} Bars (min 15)`); continue; }
      results.push({ sym, ...bo });

      if (bo.breakout) {
        const kvKey = `alert_sent_${sym}_${new Date().toISOString().slice(0, 10)}`;
        const alreadySent = env.KO_ALERT_KV ? await env.KO_ALERT_KV.get(kvKey) : null;
        if (alreadySent) { alerts.push(`${sym} (bereits gesendet)`); continue; }

        const flag = DE_MAP[sym] ? '🇩🇪' : '🇺🇸';
        const msg = `🚨 <b>BREAKOUT ALERT</b> ${flag}\n\n`
          + `<b>${sym}</b> (${data.yfSym})\n`
          + `💰 Kurs: <b>${bo.price.toFixed(2)}</b> (+${bo.pctAbove}% über 20T-Hoch)\n`
          + `📊 Volumen: <b>${bo.volRatio}x</b> Ø\n`
          + `🏔 20T-Hoch: ${bo.high20}\n\n`
          + `⏰ ${new Date().toLocaleString('de-DE', {timeZone:'Europe/Berlin'})}`;

        const sent = await sendTelegram(env.TELEGRAM_TOKEN, env.TELEGRAM_CHAT_ID, msg);
        if (sent.ok) {
          if (env.KO_ALERT_KV) await env.KO_ALERT_KV.put(kvKey, '1', { expirationTtl: 86400 });
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

  if (env.KO_ALERT_KV) await env.KO_ALERT_KV.put('last_scan', JSON.stringify(scanResult));
  return scanResult;
}

// ── POST /macro — Makro-State vom KO-Scanner empfangen ───────────────────────
async function handleMacroPost(request, env) {
  let body;
  try { body = await request.json(); } catch(e) {
    return jsonResponse({ error: 'Ungültiges JSON' }, 400);
  }

  const { vix, vixZone, breadth, market, timestamp } = body;

  // In KV speichern
  const state = { vix, vixZone, breadth, market, timestamp, received: new Date().toISOString() };
  if (env.KO_ALERT_KV) {
    await env.KO_ALERT_KV.put('macro_state', JSON.stringify(state));
  }

  // Telegram-Alert wenn VIX-Zone kritisch (≥ 4)
  const minAlertZone = 4;
  if (vixZone >= minAlertZone && env.TELEGRAM_TOKEN && env.TELEGRAM_CHAT_ID) {
    const zone = VIX_ZONES[vixZone] || { emoji: '❓', label: 'Unbekannt', desc: '' };

    // Duplikat-Schutz: nur 1x pro Zone-Wechsel pro Tag senden
    const kvKey = `macro_alert_zone${vixZone}_${new Date().toISOString().slice(0, 10)}`;
    const alreadySent = env.KO_ALERT_KV ? await env.KO_ALERT_KV.get(kvKey) : null;

    if (!alreadySent) {
      const msg = `${zone.emoji} <b>MARKT-REGIME ALERT</b>\n\n`
        + `VIX: <b>${vix ? vix.toFixed(1) : '?'}</b> — Zone ${vixZone}: ${zone.label}\n`
        + `📊 ${zone.desc}\n`
        + (breadth != null ? `🌡 NDX Breadth: ${breadth}%\n` : '')
        + `🌍 Markt: ${(market || 'us').toUpperCase()}\n\n`
        + `⏰ ${new Date().toLocaleString('de-DE', {timeZone:'Europe/Berlin'})}`;

      const sent = await sendTelegram(env.TELEGRAM_TOKEN, env.TELEGRAM_CHAT_ID, msg);
      if (sent.ok && env.KO_ALERT_KV) {
        await env.KO_ALERT_KV.put(kvKey, '1', { expirationTtl: 86400 });
      }
    }
  }

  return jsonResponse({ ok: true, state });
}

// ── POST /alert — Einzel-Ticker-Alert vom KO-Scanner empfangen ───────────────
async function handleAlertPost(request, env) {
  let body;
  try { body = await request.json(); } catch(e) {
    return jsonResponse({ error: 'Ungültiges JSON' }, 400);
  }

  const { symbol, level, overheatScore, bullCount, compositeScore, pBull2Bear, market } = body;

  if (!symbol) return jsonResponse({ error: 'symbol fehlt' }, 400);

  // Mindest-Level: MITTEL
  const levelMap = { 'NIEDRIG': 1, 'MITTEL': 2, 'HOCH': 3 };
  if ((levelMap[level] || 0) < 2) {
    return jsonResponse({ ok: true, skipped: true, reason: 'unter Mindest-Level MITTEL' });
  }

  // Duplikat-Schutz: pro Symbol + Level pro Tag
  const kvKey = `ticker_alert_${symbol}_${level}_${new Date().toISOString().slice(0, 10)}`;
  if (env.KO_ALERT_KV) {
    const alreadySent = await env.KO_ALERT_KV.get(kvKey);
    if (alreadySent) return jsonResponse({ ok: true, skipped: true, reason: 'heute bereits gesendet' });
  }

  if (env.TELEGRAM_TOKEN && env.TELEGRAM_CHAT_ID) {
    const flag   = DE_MAP[symbol] ? '🇩🇪' : '🇺🇸';
    const lvlEmoji = level === 'HOCH' ? '🔴' : '🟠';
    const msg = `${lvlEmoji} <b>ÜBERHITZUNG ${level}</b> ${flag}\n\n`
      + `<b>${symbol}</b>\n`
      + `🌡 Überhitzungs-Score: <b>${overheatScore}</b>/100\n`
      + (bullCount    != null ? `📈 Bull-Signale: ${bullCount}/3\n` : '')
      + (compositeScore != null ? `⭐ Composite: ${compositeScore}\n` : '')
      + (pBull2Bear   != null ? `⚠️ P(Bull→Bear): ${(pBull2Bear*100).toFixed(1)}%\n` : '')
      + `🌍 Markt: ${(market || 'us').toUpperCase()}\n\n`
      + `⏰ ${new Date().toLocaleString('de-DE', {timeZone:'Europe/Berlin'})}`;

    const sent = await sendTelegram(env.TELEGRAM_TOKEN, env.TELEGRAM_CHAT_ID, msg);
    if (sent.ok && env.KO_ALERT_KV) {
      await env.KO_ALERT_KV.put(kvKey, '1', { expirationTtl: 86400 });
    }
    return jsonResponse({ ok: sent.ok, symbol, level, telegram: sent.ok });
  }

  return jsonResponse({ ok: false, error: 'TELEGRAM_TOKEN oder CHAT_ID nicht gesetzt' });
}

// ── MAIN FETCH HANDLER ────────────────────────────────────────────────────────
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScan(env, false));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ── POST /macro ──────────────────────────────────────────────
    if (url.pathname === '/macro' && request.method === 'POST') {
      return handleMacroPost(request, env);
    }

    // ── POST /alert ──────────────────────────────────────────────
    if (url.pathname === '/alert' && request.method === 'POST') {
      return handleAlertPost(request, env);
    }

    // ── GET /test ────────────────────────────────────────────────
    if (url.pathname === '/test') {
      const result = await runScan(env, true);
      return jsonResponse(result);
    }

    // ── GET /status ──────────────────────────────────────────────
    if (url.pathname === '/status') {
      const last       = env.KO_ALERT_KV ? await env.KO_ALERT_KV.get('last_scan')    : null;
      const macroState = env.KO_ALERT_KV ? await env.KO_ALERT_KV.get('macro_state')  : null;
      const wl         = await getWatchlist(env);
      return jsonResponse({
        last_scan:   last       ? JSON.parse(last)       : null,
        macro_state: macroState ? JSON.parse(macroState) : null,
        watchlist:   wl,
        market_open: isMarketOpen(),
        time_utc:    new Date().toISOString(),
      });
    }

    // ── GET /alert?sym=NVDA ──────────────────────────────────────
    if (url.pathname === '/alert' && request.method === 'GET') {
      const sym = url.searchParams.get('sym');
      if (!sym) return jsonResponse({ error: '?sym= fehlt' }, 400);
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
        return jsonResponse({ sym, bars: data.bars, bo, telegram: tg.ok });
      } catch(e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ── GET /debug-telegram ──────────────────────────────────────
    if (url.pathname === '/debug-telegram') {
      const token  = env.TELEGRAM_TOKEN   || 'NICHT GESETZT';
      const chatId = env.TELEGRAM_CHAT_ID || 'NICHT GESETZT';
      const tokenPreview = token.length > 10 ? token.slice(0,10)+'...' : token;
      try {
        const tgUrl = `${TELEGRAM_API}${token}/sendMessage`;
        const res = await fetch(tgUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: '🔧 Debug-Test KO Alert Worker v3.0', parse_mode: 'HTML' }),
        });
        const responseText = await res.text();
        return jsonResponse({
          token_preview: tokenPreview,
          chat_id: chatId,
          http_status: res.status,
          http_ok: res.ok,
          tg_response: JSON.parse(responseText),
        });
      } catch(e) {
        return jsonResponse({ error: e.message, token_preview: tokenPreview }, 500);
      }
    }

    // ── ROOT ─────────────────────────────────────────────────────
    return jsonResponse({
      status: 'KO Alert Worker v3.0',
      endpoints: {
        'GET  /status':           'letzter Scan + Makro-State',
        'GET  /test':             'Force-Scan mit Telegram',
        'GET  /alert?sym=NVDA':   'Einzel-Test MIT Telegram',
        'GET  /debug-telegram':   'Telegram-Verbindung testen',
        'POST /macro':            'Makro-State vom Scanner empfangen',
        'POST /alert':            'Ticker-Alert vom Scanner empfangen',
      },
      market_open: isMarketOpen(),
      time_utc: new Date().toISOString(),
    });
  }
};
