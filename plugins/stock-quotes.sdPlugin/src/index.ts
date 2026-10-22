import WebSocket from "ws";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── CLI Args (passed by the plugin lifecycle manager) ────────

interface CliArgs {
  port: number;
  pluginUUID: string;
  registerEvent: string;
  info: Record<string, unknown>;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const parsed: Partial<CliArgs> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^-/, "");
    const val = args[i + 1];
    switch (key) {
      case "port": parsed.port = parseInt(val); break;
      case "pluginUUID": parsed.pluginUUID = val; break;
      case "registerEvent": parsed.registerEvent = val; break;
      case "info": try { parsed.info = JSON.parse(val); } catch {} break;
    }
  }
  return parsed as CliArgs;
}

// ─── Config ───────────────────────────────────────────────────

interface StockConfig {
  apiKey: string;
  symbols: string[];
  crypto: string[];
  intervalMinutes: number;
}

const CONFIG_PATH = path.join(process.cwd(), "config.json");

function loadConfig(): StockConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    const parseList = (v: unknown): string[] =>
      Array.isArray(v) ? v.map((s: string) => s.trim().toUpperCase()).filter(Boolean)
      : typeof v === "string" ? v.split(",").map((s: string) => s.trim().toUpperCase()).filter(Boolean)
      : [];
    return {
      apiKey: parsed.apiKey || "",
      symbols: parseList(parsed.symbols),
      crypto: parseList(parsed.crypto),
      intervalMinutes: Math.max(1, Math.min(60, parsed.intervalMinutes || 5)),
    };
  } catch {
    return { apiKey: "", symbols: [], intervalMinutes: 5 };
  }
}

// ─── Finnhub API ──────────────────────────────────────────────

interface FinnhubQuote {
  c: number;  // current price
  d: number;  // change
  dp: number; // change percent
  h: number;  // high
  l: number;  // low
  o: number;  // open
  pc: number; // previous close
  t: number;  // timestamp
}

let rateLimitUntil = 0;

async function fetchQuote(symbol: string, apiKey: string): Promise<FinnhubQuote | null> {
  if (Date.now() < rateLimitUntil) return null;
  try {
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`;
    const resp = await fetch(url);
    if (resp.status === 429) {
      rateLimitUntil = Date.now() + 60_000;
      log("Rate limited by Finnhub, backing off 60s");
      return null;
    }
    if (!resp.ok) {
      log(`Finnhub error for ${symbol}: HTTP ${resp.status}`);
      return null;
    }
    return await resp.json() as FinnhubQuote;
  } catch (e) {
    log(`Fetch failed for ${symbol}: ${e}`);
    return null;
  }
}

// ─── CoinGecko API (crypto, no key needed) ───────────────────

const CRYPTO_IDS: Record<string, string> = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", ADA: "cardano",
  DOGE: "dogecoin", XRP: "ripple", DOT: "polkadot", AVAX: "avalanche-2",
  MATIC: "matic-network", LINK: "chainlink", ATOM: "cosmos", UNI: "uniswap",
  LTC: "litecoin", BCH: "bitcoin-cash", NEAR: "near", APT: "aptos",
  ARB: "arbitrum", OP: "optimism", SUI: "sui", FIL: "filecoin",
  SHIB: "shiba-inu", PEPE: "pepe", TRX: "tron", TON: "the-open-network",
  BNB: "binancecoin", USDT: "tether", USDC: "usd-coin",
};

function getCoinGeckoId(ticker: string): string {
  return CRYPTO_IDS[ticker] || ticker.toLowerCase();
}

interface CoinGeckoPrice {
  usd: number;
  usd_24h_change: number;
}

async function fetchCryptoPrices(tickers: string[]): Promise<Record<string, CoinGeckoPrice>> {
  if (tickers.length === 0) return {};
  const ids = tickers.map(getCoinGeckoId).join(",");
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;
    const resp = await fetch(url);
    if (!resp.ok) {
      log(`CoinGecko error: HTTP ${resp.status}`);
      return {};
    }
    const data = await resp.json() as Record<string, CoinGeckoPrice>;
    const result: Record<string, CoinGeckoPrice> = {};
    for (const ticker of tickers) {
      const id = getCoinGeckoId(ticker);
      if (data[id]) result[ticker] = data[id];
    }
    return result;
  } catch (e) {
    log(`CoinGecko fetch failed: ${e}`);
    return {};
  }
}

function syncCryptoToVariables(ticker: string, price: CoinGeckoPrice) {
  const p = `stock.${ticker}`;
  setVariable(`${p}.price`, String(price.usd));
  const change = price.usd_24h_change || 0;
  const changeDollar = price.usd * (change / 100);
  setVariable(`${p}.change`, changeDollar.toFixed(2));
  setVariable(`${p}.change_pct`, change.toFixed(2));

  const direction = change > 0 ? "up" : change < 0 ? "down" : "flat";
  setVariable(`${p}.direction`, direction);
  setVariable(`${p}.arrow`, direction === "up" ? "↑" : direction === "down" ? "↓" : "→");
  setVariable(`${p}.color`, direction === "up" ? "#00c853" : direction === "down" ? "#ff1744" : "#888888");

  setVariable(`${p}.price_usd`, `$${price.usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const sign = changeDollar > 0 ? "+" : "";
  setVariable(`${p}.change_signed`, `${sign}${changeDollar.toFixed(2)}`);

  const now = new Date();
  setVariable(`${p}.updated`, now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
}

// ─── Variable Sync ────────────────────────────────────────────

function syncQuoteToVariables(symbol: string, quote: FinnhubQuote) {
  const p = `stock.${symbol}`;
  setVariable(`${p}.price`, String(quote.c));
  setVariable(`${p}.change`, String(quote.d));
  setVariable(`${p}.change_pct`, String(quote.dp));
  setVariable(`${p}.open`, String(quote.o));
  setVariable(`${p}.high`, String(quote.h));
  setVariable(`${p}.low`, String(quote.l));
  setVariable(`${p}.prev_close`, String(quote.pc));

  const direction = quote.d > 0 ? "up" : quote.d < 0 ? "down" : "flat";
  setVariable(`${p}.direction`, direction);
  setVariable(`${p}.arrow`, direction === "up" ? "↑" : direction === "down" ? "↓" : "→");
  setVariable(`${p}.color`, direction === "up" ? "#00c853" : direction === "down" ? "#ff1744" : "#888888");

  setVariable(`${p}.price_usd`, `$${quote.c.toFixed(2)}`);
  const sign = quote.d > 0 ? "+" : "";
  setVariable(`${p}.change_signed`, `${sign}${quote.d.toFixed(2)}`);

  const now = new Date();
  setVariable(`${p}.updated`, now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
}

async function pollAll(config: StockConfig) {
  const hasStocks = config.symbols.length > 0 && config.apiKey;
  const hasCrypto = config.crypto.length > 0;

  if (!hasStocks && !hasCrypto) {
    log("No symbols configured, skipping poll");
    return;
  }

  // Stocks (Finnhub — needs API key)
  if (hasStocks) {
    log(`Polling ${config.symbols.length} stocks...`);
    for (const symbol of config.symbols) {
      const quote = await fetchQuote(symbol, config.apiKey);
      if (quote && quote.c !== 0) {
        syncQuoteToVariables(symbol, quote);
      }
      if (config.symbols.indexOf(symbol) < config.symbols.length - 1) {
        await sleep(200);
      }
    }
  }

  // Crypto (CoinGecko — free, no key needed, batched in one request)
  if (hasCrypto) {
    log(`Polling ${config.crypto.length} crypto...`);
    const prices = await fetchCryptoPrices(config.crypto);
    for (const [ticker, price] of Object.entries(prices)) {
      syncCryptoToVariables(ticker, price);
    }
  }
}

// ─── WebSocket Connection ─────────────────────────────────────

let ws: WebSocket | null = null;

function connectWs(args: CliArgs) {
  ws = new WebSocket(`ws://127.0.0.1:${args.port}`);

  ws.on("open", () => {
    log("Connected to app");
    ws!.send(JSON.stringify({ event: args.registerEvent, uuid: args.pluginUUID }));
  });

  ws.on("message", (data: WebSocket.Data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.event === "variableChanged") {
        // Response to getVariable — not needed for this plugin
      }
    } catch {}
  });

  ws.on("close", () => {
    log("Disconnected, reconnecting in 5s...");
    setTimeout(() => connectWs(args), 5000);
  });

  ws.on("error", () => {});
}

function setVariable(name: string, value: string) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ event: "setVariable", payload: { name, value } }));
  }
}

function log(message: string) {
  const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  console.log(`[StockQuotes ${ts}] ${message}`);
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ event: "logMessage", payload: { message: `[StockQuotes] ${message}` } }));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Main ─────────────────────────────────────────────────────

const args = parseArgs();
let config = loadConfig();
let pollTimer: ReturnType<typeof setInterval> | null = null;

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollAll(config);
  const intervalMs = config.intervalMinutes * 60 * 1000;
  pollTimer = setInterval(() => pollAll(config), intervalMs);
  const all = [...config.symbols.map(s => s), ...config.crypto.map(s => `${s}`)];
  log(`Polling every ${config.intervalMinutes}m for: ${all.join(", ") || "(none)"}`);
}

// Watch config.json for changes
fs.watchFile(CONFIG_PATH, { interval: 2000 }, () => {
  log("Config changed, reloading...");
  config = loadConfig();
  startPolling();
});

// Connect to app and start polling after a short delay (let WS connect first)
connectWs(args);
setTimeout(() => startPolling(), 2000);
