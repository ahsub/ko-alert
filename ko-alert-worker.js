/**
 * KO Scanner Breakout Alert Worker
 * Cloudflare Worker + Cron Trigger
 *
 * Überwacht Kurs + Volumen für die Watchlist.
 * Feuert Telegram-Alert wenn:
 *   - Kurs > 20-Tage-Hoch (Breakout)
 *   - Volumen >= 150% des 20-Tage-Durchschnitts
 *
 * Umgebungsvariablen (Cloudflare Dashboard → Settings → Variables):
 *   TWELVE_DATA_KEY   — Twelve Data API Key
 *   TELEGRAM_TOKEN    — Bot Token von @BotFather
 *   TELEGRAM_CHAT_ID  — 526277347
 *
 * KV Namespace (Cloudflare Dashboard → KV → Create):
 *   KO_ALERT_KV       — verhindert Doppel-Alerts (24h Sperre)
 *
 * wrangler.toml (siehe unten):
 *   name = "ko-alert"
 *   kv_namespaces = [{ binding = "KO_ALERT_KV", id = "<deine-kv-id>" }]
 *   [triggers]
 */

// ── Watchlist ────────────────────────────────────────────────────────────────
const WATCHLIST = [
  "SMCI", "ARM", "MRVL", "APP", "AVGO",
  "AMD", "TSM", "TSLA", "NVDA", "HOOD"
];

const VOLUME_THRESHOLD = 1.5;   // 150% des 20-Tage-Durchschnitts
const LOOKBACK = 20;            // Tage für Hoch + Volumen-Durchschnitt
const ALERT_COOLDOWN_HOURS = 24;// Keine Doppel-Alerts innerhalb dieser Zeit

// ── Cron Entry Point ─────────────────────────────────────────────────────────
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScan(env));
  },

  // Manueller Test via HTTP GET https://ko-alert.<dein-subdomain>.workers.dev/
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/test") {
      await runScan(env);
      return new Response("Scan abgeschlossen — prüf Telegram.", { status: 200 });
    }
    return new Response("KO Scanner Alert Worker läuft.\nGET /test für manuellen Scan.", { status: 200 });
  }
};

// ── Haupt-Scan ────────────────────────────────────────────────────────────────
async function runScan(env) {
  const results = await Promise.allSettled(
    WATCHLIST.map(ticker => checkTicker(ticker, env))
  );

  for (const r of results) {
    if (r.status === "rejected") {
      console.error("Fehler beim Scan:", r.reason);
    }
  }
}

// ── Einzelner Ticker ──────────────────────────────────────────────────────────
async function checkTicker(ticker, env) {
  // Twelve Data: tägliche OHLCV der letzten 25 Tage
  const url = `https://api.twelvedata.com/time_series?symbol=${ticker}&interval=1day&outputsize=${LOOKBACK + 5}&apikey=${env.TWELVE_DATA_KEY}`;
  const resp = await fetch(url);
  const data = await resp.json();

  if (data.status === "error" || !data.values || data.values.length < LOOKBACK + 1) {
    console.log(`${ticker}: keine ausreichenden Daten`);
    return;
  }

  const bars = data.values; // newest first
  const today = bars[0];
  const history = bars.slice(1, LOOKBACK + 1); // die letzten 20 abgeschlossenen Tage

  const todayClose  = parseFloat(today.close);
  const todayVolume = parseFloat(today.volume);

  // 20-Tage-Hoch (aus History, ohne heutigen Tag)
  const high20 = Math.max(...history.map(b => parseFloat(b.high)));

  // 20-Tage-Durchschnittsvolumen
  const avgVol20 = history.reduce((s, b) => s + parseFloat(b.volume), 0) / history.length;

  const isBreakout    = todayClose > high20;
  const isHighVolume  = avgVol20 > 0 && (todayVolume / avgVol20) >= VOLUME_THRESHOLD;

  console.log(
    `${ticker}: close=${todayClose} high20=${high20.toFixed(2)} ` +
    `vol=${todayVolume} avgVol=${avgVol20.toFixed(0)} ` +
    `breakout=${isBreakout} highVol=${isHighVolume}`
  );

  if (!isBreakout || !isHighVolume) return;

  // Cooldown prüfen — kein Doppel-Alert
  const kvKey = `alert:${ticker}`;
  const lastAlert = await env.KO_ALERT_KV.get(kvKey);
  if (lastAlert) {
    console.log(`${ticker}: Alert bereits gesendet, Cooldown aktiv`);
    return;
  }

  // Alert senden
  const volPct = ((todayVolume / avgVol20) * 100).toFixed(0);
  const breakoutPct = (((todayClose - high20) / high20) * 100).toFixed(2);

  const message = buildMessage(ticker, todayClose, high20, breakoutPct, todayVolume, avgVol20, volPct);
  await sendTelegram(message, env);

  // Cooldown setzen (24h)
  await env.KO_ALERT_KV.put(kvKey, new Date().toISOString(), {
    expirationTtl: ALERT_COOLDOWN_HOURS * 3600
  });

  console.log(`${ticker}: Alert gesendet ✓`);
}

// ── Nachricht formatieren ─────────────────────────────────────────────────────
function buildMessage(ticker, close, high20, breakoutPct, vol, avgVol, volPct) {
  const sign = breakoutPct >= 0 ? "+" : "";
  return [
    `🚀 *BREAKOUT ALERT — ${ticker}*`,
    ``,
    `📈 Kurs:       $${close.toFixed(2)}`,
    `📊 20-Tage-Hoch: $${high20.toFixed(2)}  (${sign}${breakoutPct}%)`,
    `📦 Volumen:    ${formatVol(vol)}  (${volPct}% des Ø)`,
    `📉 Ø-Volumen:  ${formatVol(avgVol)}`,
    ``,
    `✅ Kurs über 20-Tage-Hoch`,
    `✅ Volumen ${volPct}% des 20-Tage-Durchschnitts`,
    ``,
    `_KO Scanner Alert · ${new Date().toUTCString()}_`
  ].join("\n");
}

function formatVol(v) {
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + "M";
  if (v >= 1_000)     return (v / 1_000).toFixed(0) + "K";
  return v.toFixed(0);
}

// ── Telegram ──────────────────────────────────────────────────────────────────
async function sendTelegram(text, env) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`;
  const body = JSON.stringify({
    chat_id: env.TELEGRAM_CHAT_ID,
    text,
    parse_mode: "Markdown"
  });
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Telegram Fehler: ${err}`);
  }
}
