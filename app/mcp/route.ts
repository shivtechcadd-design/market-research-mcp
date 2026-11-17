import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { BUILD_VERSION, versionInfo } from "../../lib/version";

export const dynamic = "force-dynamic";

const NSE_BASE = process.env.NSE_BASE_URL ?? "https://www.nseindia.in";
const API = `${NSE_BASE}/api/NextApi/apiClient/GetQuoteApi`;
const MAX_CHARS = 60000;

const headers = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0",
  Accept: "application/json, text/javascript, */*; q=0.01",
  "Accept-Language": "en-US,en;q=0.5",
  Referer: "https://www.nseindia.com/",
};

// ---------- utilities ----------
const cleanSymbol = (s: string) =>
  s.trim().toUpperCase().replace(/EQN$/, "").replace(/EQ$/, "");
const eqnSymbol = (s: string) => cleanSymbol(s) + "EQN";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const num = (v: any): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const rnd = (v: number | null, d = 2) => (v === null ? null : Number(v.toFixed(d)));

const IST_MS = 5.5 * 3600000;
const pad = (n: number) => String(n).padStart(2, "0");
const istDDMMYYYY = (d: Date) => {
  const x = new Date(d.getTime() + IST_MS);
  return `${pad(x.getUTCDate())}-${pad(x.getUTCMonth() + 1)}-${x.getUTCFullYear()}`;
};
const defaultRange = () => {
  const to = new Date();
  return { from: istDDMMYYYY(new Date(to.getTime() - 30 * 86400000)), to: istDDMMYYYY(to) };
};

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// "03-Nov-2026" -> "2026-11-03"
function parseNseDate(s: any): string | null {
  const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})/.exec(String(s ?? ""));
  if (!m) return null;
  const mon = MONTHS[m[2].toLowerCase()];
  if (mon === undefined) return null;
  return `${m[3]}-${pad(mon + 1)}-${m[1]}`;
}

// "04-Nov-2026 14:11:01" (IST) -> epoch ms
function parseNseDateTimeMs(s: any): number | null {
  const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/.exec(String(s ?? ""));
  if (!m) return null;
  const mon = MONTHS[m[2].toLowerCase()];
  if (mon === undefined) return null;
  return Date.UTC(+m[3], mon, +m[1], +m[4], +m[5], +m[6]) - IST_MS;
}

function marketSession(now = new Date()) {
  const x = new Date(now.getTime() + IST_MS);
  const day = x.getUTCDay(); // 0 Sun .. 6 Sat
  const mins = x.getUTCHours() * 60 + x.getUTCMinutes();
  const weekday = day >= 1 && day <= 5;
  const inHours = weekday && mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
  return {
    ist_now: `${istDDMMYYYY(now)} ${pad(x.getUTCHours())}:${pad(x.getUTCMinutes())}`,
    weekday,
    within_regular_hours: inHours,
    note: "Based on weekday and 09:15-15:30 IST only. Exchange holidays are not detected.",
  };
}

// ---------- NSE client (no sessions, retry on 429/5xx) ----------
type NseResult = { data?: any; error?: string; sample?: string; status?: number };

async function nseGet(functionName: string, params: Record<string, string>): Promise<NseResult> {
  const url = new URL(API);
  url.searchParams.set("functionName", functionName);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let last: NseResult = { error: "unknown" };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(10000),
        cache: "no-store",
      });
      const text = await res.text();
      if (res.ok) {
        try {
          return { data: JSON.parse(text), status: res.status };
        } catch {
          return {
            error: "NSE returned non-JSON (likely a bot-check page)",
            sample: text.slice(0, 200),
            status: res.status,
          };
        }
      }
      last = { error: `NSE returned HTTP ${res.status}`, sample: text.slice(0, 200), status: res.status };
      if (res.status !== 429 && res.status < 500) return last;
    } catch (e) {
      last = { error: `Failed to connect to NSE: ${String(e)}` };
    }
    await sleep(500 * attempt);
  }
  return last;
}

// ---------- response envelope ----------
function reply(payload: unknown, isError = false) {
  let text = JSON.stringify(payload);
  if (text.length > MAX_CHARS) {
    text = JSON.stringify({
      build_version: BUILD_VERSION,
      error: "Response too large to return safely. Narrow the date range.",
      size_chars: text.length,
    });
    isError = true;
  }
  return { isError, content: [{ type: "text" as const, text }] };
}

function envelope(fn: string, symbol: string | null, schemaVerified: boolean, data: unknown, notes: string[] = []) {
  return {
    build_version: BUILD_VERSION,
    source: "NSE India official API",
    endpoint: fn,
    symbol,
    fetched_at_utc: new Date().toISOString(),
    schema_verified: schemaVerified,
    notes,
    data,
  };
}

const errReply = (r: NseResult) => reply({ build_version: BUILD_VERSION, error: r.error, sample: r.sample }, true);

function rowsOf(d: any): any[] | null {
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d.data)) return d.data;
  return null;
}

// Unverified tools: exact NSE rows, capped, with true counts
function listResult(
  fn: string, symbol: string, raw: any, limit: number,
  pick: (rows: any[]) => any[] = (r) => r, notes: string[] = []
) {
  const rows = rowsOf(raw);
  if (!rows)
    return envelope(fn, symbol, false, raw, [...notes, "Unexpected shape; raw NSE payload returned unchanged."]);
  const chosen = pick(rows).slice(0, limit);
  return envelope(fn, symbol, false,
    { total_rows: rows.length, returned_rows: chosen.length, rows: chosen },
    [...notes, "Exact NSE values, unmodified. Field names not yet validated against a real sample."]);
}

// ---------- VERIFIED: quote ----------
function extractQuote(d: any) {
  const r = d?.equityResponse?.[0];
  if (!r) return null;
  const m = r.metaData ?? {}, t = r.tradeInfo ?? {}, p = r.priceInfo ?? {};
  const s = r.secInfo ?? {}, o = r.orderBook ?? {};

  const ltp = num(o.lastPrice) ?? num(t.lastPrice);
  const vwap = num(m.averagePrice);
  const hi = num(m.dayHigh), lo = num(m.dayLow);
  const y52h = num(p.yearHigh), y52l = num(p.yearLow);
  const level = (side: "buy" | "sell", i: number) => ({
    price: num(o[`${side}Price${i}`]),
    qty: num(o[`${side}Quantity${i}`]),
  });
  const lv = [1, 2, 3, 4, 5];

  // Freshness: is NSE's price timestamp recent?
  const priceMs = parseNseDateTimeMs(r.lastUpdateTime);
  const delMs = parseNseDateTimeMs(t.secwisedelposdate);
  const session = marketSession();
  const ageSec = priceMs !== null ? Math.round((Date.now() - priceMs) / 1000) : null;
  const warnings: string[] = [];
  if (session.within_regular_hours && ageSec !== null && ageSec > 120)
    warnings.push(`Price timestamp is ${ageSec}s old during market hours; NSE data may be delayed or stale.`);
  if (!session.within_regular_hours)
    warnings.push("Outside regular market hours: values are from the last trading session.");
  if (num(t.quantitytraded) !== null && num(t.quantitytraded) !== num(t.totalTradedVolume))
    warnings.push("Delivery % uses an earlier volume snapshot (qty_basis) than total traded volume; not the same moment.");

  return {
    symbol: m.symbol ?? null,
    company: m.companyName ?? null,
    isin: m.isinCode ?? null,
    series: m.series ?? null,
    freshness: {
      price_as_of_ist: r.lastUpdateTime ?? null,
      price_age_seconds: ageSec,
      delivery_as_of_ist: t.secwisedelposdate ?? null,
      delivery_lag_seconds:
        priceMs !== null && delMs !== null ? Math.round((priceMs - delMs) / 1000) : null,
      market: session,
    },
    price: {
      ltp,
      open: num(m.open),
      previous_close: num(m.previousClose),
      change: num(m.change),
      pchange: num(m.pChange),
      day_high: hi,
      day_low: lo,
      vwap,
      price_band: p.priceBand ?? null,
    },
    range_52w: { high: y52h, high_date: p.yearHightDt ?? null, low: y52l, low_date: p.yearLowDt ?? null },
    volume: {
      total_traded_volume: num(t.totalTradedVolume),
      total_traded_value_inr: num(t.totalTradedValue),
    },
    delivery: {
      delivery_pct: num(t.deliveryToTradedQuantity),
      delivery_qty: num(t.deliveryquantity),
      qty_basis: num(t.quantitytraded),
    },
    liquidity_and_risk: {
      impact_cost_pct: num(t.impactCost),
      applicable_margin_pct: num(t.applicableMargin),
      daily_volatility_pct: num(p.cmDailyVolatility),
      annual_volatility_pct: num(p.cmAnnualVolatility),
    },
    valuation: {
      stock_pe: num(s.pdSymbolPe),
      sector_pe: num(s.pdSectorPe),
      sector_index: s.pdSectorInd?.trim() ?? null,
      market_cap_inr: num(t.totalMarketCap),
      free_float_market_cap_inr: num(t.ffmc),
    },
    order_book: {
      total_buy_qty: num(o.totalBuyQuantity),
      total_sell_qty: num(o.totalSellQuantity),
      buy_pct: num(o.perBuyQty),
      sell_pct: num(o.perSellQty),
      bids: lv.map((i) => level("buy", i)),
      asks: lv.map((i) => level("sell", i)),
      note: "Resting order-book depth, not executed net buying or selling.",
    },
    classification: { industry: s.basicIndustry ?? null, sector: s.sector ?? null, indices: s.indexList ?? [] },
    derived_not_from_nse: {
      pct_vs_vwap: ltp !== null && vwap ? rnd(((ltp - vwap) / vwap) * 100) : null,
      pct_below_day_high: ltp !== null && hi ? rnd(((hi - ltp) / hi) * 100) : null,
      pct_above_day_low: ltp !== null && lo ? rnd(((ltp - lo) / lo) * 100) : null,
      position_in_52w_range_pct:
        ltp !== null && y52h && y52l !== null && y52h > y52l
          ? rnd(((ltp - y52l) / (y52h - y52l)) * 100)
          : null,
    },
    warnings,
    omitted_placeholder_fields: ["closePrice", "indicativeClose", "iep", "ieq (NSE sends 0 during market hours)"],
  };
}

// ---------- VERIFIED: historical trades ----------
function extractHistorical(raw: any) {
  const rows = rowsOf(raw);
  if (!rows) return null;

  const sessions = rows
    .map((r) => {
      const close = num(r.chClosingPrice);
      const prev = num(r.chPreviousClsPrice);
      return {
        date: parseNseDate(r.mtimestamp),
        open: num(r.chOpeningPrice),
        high: num(r.chTradeHighPrice),
        low: num(r.chTradeLowPrice),
        close,
        previous_close: prev,
        vwap: num(r.vwap),
        volume: num(r.chTotTradedQty),
        value_inr: num(r.chTotTradedVal),
        trades: num(r.chTotalTrades),
        change_pct_derived: close !== null && prev ? rnd(((close - prev) / prev) * 100) : null,
      };
    })
    .filter((s) => s.date)
    .sort((a, b) => (a.date! < b.date! ? 1 : -1));

  const col = (f: (s: (typeof sessions)[number]) => number | null) =>
    sessions.map(f).filter((x): x is number => x !== null);
  const closes = col((s) => s.close), highs = col((s) => s.high), lows = col((s) => s.low);
  const vol = col((s) => s.volume), val = col((s) => s.value_inr);

  const gaps: any[] = [];
  for (let i = 0; i < sessions.length - 1; i++) {
    const a = sessions[i], b = sessions[i + 1];
    if (a.previous_close !== null && b.close !== null && a.previous_close !== b.close)
      gaps.push({ date: a.date, previous_close: a.previous_close, prior_session_close: b.close });
  }

  const newest = sessions[0], oldest = sessions[sessions.length - 1];
  return {
    freshness: {
      latest_session_date: newest?.date ?? null,
      market: marketSession(),
      note: "End-of-day data only. Today's session appears after the close.",
    },
    sessions,
    derived_not_from_nse: sessions.length
      ? {
          sessions: sessions.length,
          first_date: oldest.date,
          last_date: newest.date,
          period_high: highs.length ? Math.max(...highs) : null,
          period_low: lows.length ? Math.min(...lows) : null,
          highest_close: closes.length ? Math.max(...closes) : null,
          lowest_close: closes.length ? Math.min(...closes) : null,
          close_to_close_return_pct:
            oldest.close && newest.close !== null ? rnd(((newest.close - oldest.close) / oldest.close) * 100) : null,
          avg_daily_volume: vol.length ? Math.round(vol.reduce((a, b) => a + b, 0) / vol.length) : null,
          period_vwap:
            vol.length === sessions.length && val.length === sessions.length
              ? rnd(val.reduce((a, b) => a + b, 0) / vol.reduce((a, b) => a + b, 0))
              : null,
          previous_close_mismatches: gaps,
        }
      : null,
    omitted_fields: {
      "ch52WeekHighPrice / ch52WeekLowPrice":
        "Not split-adjusted in this endpoint (shows 2228 while the live quote shows 465.95). Use get_stock_quote for 52-week levels.",
    },
  };
}

// ---------- server ----------
const sym = z.string().describe("NSE stock symbol, e.g. KOTAKBANK");
const dateArg = z.string().optional().describe("DD-MM-YYYY");

const VERIFIED = ["get_stock_quote", "get_historical_trades","get_recommended_stocks","get_intraday_candles"];

const handler = createMcpHandler(
  async (server) => {
    const add = (name: string, description: string, schema: z.ZodRawShape, fn: (args: any) => Promise<any>) =>
      server.tool(name, description, schema, { title: name, readOnlyHint: true }, fn);

    add(
      "server_info",
      "Returns the deployed build version, git commit and which tools have verified schemas. Call this first to confirm the latest code is live.",
      {},
      async () =>
        reply({
          ...versionInfo(),
          nse_base: NSE_BASE,
          api_key_protection: Boolean(process.env.MCP_API_KEY),
          verified_schema_tools: VERIFIED,
          market: marketSession(),
        })
    );

    add("nse_health_check", "Checks whether the NSE API is reachable from this server.", {}, async () => {
      const t0 = Date.now();
      const r = await nseGet("getSymbolData", { marketType: "N", series: "EQ", symbol: "KOTAKBANK" });
      return reply({
        build_version: BUILD_VERSION,
        base: NSE_BASE,
        ok: !r.error,
        status: r.status ?? null,
        latency_ms: Date.now() - t0,
        error: r.error ?? null,
        last_update_time_ist: r.data?.equityResponse?.[0]?.lastUpdateTime ?? null,
      });
    });

    add(
      "get_stock_quote",
      "Official NSE live quote: price, VWAP, ranges, volume, delivery %, impact cost, margin, P/E, market cap, top-5 order book. Includes NSE timestamps, data age in seconds and consistency warnings. Quote values exactly as published.",
      { symbol: sym },
      async ({ symbol }) => {
        const s = cleanSymbol(symbol);
        const r = await nseGet("getSymbolData", { marketType: "N", series: "EQ", symbol: s });
        if (r.error) return errReply(r);
        const q = extractQuote(r.data);
        if (!q) return reply({ build_version: BUILD_VERSION, error: "Unexpected NSE response: equityResponse missing" }, true);
        return reply(envelope("getSymbolData", s, true, q));
      }
    );

    add(
      "get_historical_trades",
      "Official NSE end-of-day history: open, high, low, close, VWAP, volume, value, trades per session, sorted newest first by date. Dates DD-MM-YYYY, default last 30 days (IST). Includes derived period stats from every returned session. Excludes the current day; use get_stock_quote for that.",
      { symbol: sym, series: z.string().default("EQ"), from_date: dateArg, to_date: dateArg },
      async ({ symbol, series, from_date, to_date }) => {
        const def = defaultRange();
        const from = from_date ?? def.from, to = to_date ?? def.to;
        const s = cleanSymbol(symbol);
        const r = await nseGet("getHistoricalTradeData", { symbol: s, series, fromDate: from, toDate: to });
        if (r.error) return errReply(r);
        const out = extractHistorical(r.data);
        if (!out)
          return reply(envelope("getHistoricalTradeData", s, false, r.data, ["Unexpected shape; raw payload returned."]));
        return reply(envelope("getHistoricalTradeData", s, true, out, [
          `Requested range: ${from} to ${to} (IST)`,
          "Completed sessions only. Prices exactly as published by NSE.",
        ]));
      }
    );

    add(
      "get_stock_chart",
      "NSE chart time series for 1D, 1W, 1M, 1Y. Returns original point counts and an evenly downsampled series including first and last points. Do NOT use the downsampled series to find period high or low.",
      { symbol: sym, days: z.string().default("1D") },
      async ({ symbol, days }) => {
        const s = cleanSymbol(symbol);
        const r = await nseGet("getSymbolChartData", { symbol: eqnSymbol(symbol), days });
        if (r.error) return errReply(r);
        const out: any = r.data && typeof r.data === "object" && !Array.isArray(r.data) ? { ...r.data } : r.data;
        const counts: Record<string, number> = {};
        if (out && typeof out === "object" && !Array.isArray(out)) {
          for (const key of Object.keys(out)) {
            const arr = out[key];
            if (Array.isArray(arr) && arr.length > 40) {
              counts[key] = arr.length;
              const step = Math.ceil(arr.length / 40);
              const sampled = arr.filter((_: any, i: number) => i % step === 0);
              if (sampled[sampled.length - 1] !== arr[arr.length - 1]) sampled.push(arr[arr.length - 1]);
              out[key] = sampled;
            }
          }
        }
        return reply(envelope("getSymbolChartData", s, false, out, [
          `Original point counts before downsampling: ${JSON.stringify(counts)}`,
        ]));
      }
    );

    add("get_relative_performance", "Stock returns across horizons versus the Nifty 50, as published by NSE.", { symbol: sym }, async ({ symbol }) => {
      const r = await nseGet("getYearwiseData", { symbol: eqnSymbol(symbol) });
      if (r.error) return errReply(r);
      return reply(envelope("getYearwiseData", cleanSymbol(symbol), false, r.data, ["Raw NSE payload, unmodified."]));
    });

    add(
      "get_derivatives_most_active",
      "Most active derivative contracts. call_type: C = calls, P = puts, O = overall.",
      { symbol: sym, call_type: z.enum(["C", "P", "O"]).default("O") },
      async ({ symbol, call_type }) => {
        const r = await nseGet("getDerivativesMostActive", { symbol: cleanSymbol(symbol), callType: call_type });
        if (r.error) return errReply(r);
        return reply(listResult("getDerivativesMostActive", cleanSymbol(symbol), r.data, 25));
      }
    );

    add("get_derivatives_filter", "Available F&O expiry dates, option types, instrument types and strikes.", { symbol: sym }, async ({ symbol }) => {
      const r = await nseGet("getSymbolDerivativesFilter", { isSymbolIndex: "S", symbol: cleanSymbol(symbol) });
      if (r.error) return errReply(r);
      return reply(envelope("getSymbolDerivativesFilter", cleanSymbol(symbol), false, r.data, ["Raw NSE payload, unmodified."]));
    });

    add(
      "get_derivatives_chain",
      "Futures and options contracts, top 15 by traded volume, with total contract count and OI fields as published.",
      { symbol: sym },
      async ({ symbol }) => {
        const r = await nseGet("getSymbolDerivativesData", { symbol: cleanSymbol(symbol) });
        if (r.error) return errReply(r);
        return reply(listResult("getSymbolDerivativesData", cleanSymbol(symbol), r.data, 15,
          (rows) => [...rows].sort((a, b) => (num(b?.totalTradedVolume) ?? 0) - (num(a?.totalTradedVolume) ?? 0)),
          ["Selected by highest totalTradedVolume."]));
      }
    );

    add("get_option_chain_dropdown", "Option chain expiry dates and strike range.", { symbol: sym }, async ({ symbol }) => {
      const r = await nseGet("getOptionChainDropdown", { symbol: cleanSymbol(symbol) });
      if (r.error) return errReply(r);
      return reply(envelope("getOptionChainDropdown", cleanSymbol(symbol), false, r.data, ["Raw NSE payload, unmodified."]));
    });

    add(
      "get_slbm",
      "Stock lending and borrowing contracts with activity or pricing, plus total contract count.",
      { symbol: sym },
      async ({ symbol }) => {
        const r = await nseGet("getGetQuoteSLBMData", { symbol: cleanSymbol(symbol), series: "", month: "" });
        if (r.error) return errReply(r);
        return reply(listResult("getGetQuoteSLBMData", cleanSymbol(symbol), r.data, 25,
          (rows) => rows.filter((i) => (num(i?.totTradedQty) ?? 0) > 0 || (num(i?.lastPrice) ?? 0) > 0 || (num(i?.totalBuyQuantity) ?? 0) > 0),
          ["Filtered to contracts with traded quantity, price or buy quantity above zero."]));
      }
    );

    add(
      "get_bulk_block_deals",
      "Bulk and block deals for a date range (DD-MM-YYYY, default last 30 days), top 15 by value, with total count.",
      { symbol: sym, from_date: dateArg, to_date: dateArg },
      async ({ symbol, from_date, to_date }) => {
        const def = defaultRange();
        const from = from_date ?? def.from, to = to_date ?? def.to;
        const r = await nseGet("getHistoricalBulkAndBlockData", { symbol: cleanSymbol(symbol), fromDate: from, toDate: to });
        if (r.error) return errReply(r);
        return reply(listResult("getHistoricalBulkAndBlockData", cleanSymbol(symbol), r.data, 15,
          (rows) => [...rows].sort((a, b) => (num(b?.tradedValue) ?? num(b?.quantity) ?? 0) - (num(a?.tradedValue) ?? num(a?.quantity) ?? 0)),
          [`Requested range: ${from} to ${to} (IST)`, "No rows means NSE returned no recorded deals for the range."]));
      }
    );

    add(
      "get_integrated_filings",
      "Corporate quarterly results filings from NSE with total count. Rows in NSE's order, not re-sorted.",
      { symbol: sym },
      async ({ symbol }) => {
        const r = await nseGet("getIntegratedFilingData", { symbol: cleanSymbol(symbol) });
        if (r.error) return errReply(r);
        return reply(listResult("getIntegratedFilingData", cleanSymbol(symbol), r.data, 8));
      }
    );

    add(
      "get_recommended_stocks",
      "Research360 (Motilal Oswal) curated stock calls: short-term conviction delivery ideas (up to 2 weeks) and intraday calls. Returns entry, target, stoploss, LTP, action, report link, plus derived risk-reward and upside. Not tied to a symbol.",
      {
        call_type: z.enum(["short_term", "intraday", "both"]).default("both"),
        status: z.enum(["open", "closed"]).default("open"),
        action: z.enum(["Buy", "Sell", ""]).default(""),
        limit: z.number().int().min(1).max(100).default(25),
      },
      async ({ call_type, status, action, limit }) => {
        const kinds = (call_type === "both" ? ["short_term", "intraday"] : [call_type]) as (keyof typeof CALL_TYPES)[];
        const results = await Promise.all(kinds.map((k) => r360Fetch(CALL_TYPES[k], status, action)));

        const data: Record<string, any> = {};
        const errors: string[] = [];
        kinds.forEach((k, i) => {
          const r = results[i];
          if ("error" in r) {
            errors.push(`${k}: ${r.error}`);
            return;
          }
          const rows = r.rows.map(slimCall);
          data[k] = { total_calls: rows.length, returned: Math.min(limit, rows.length), calls: rows.slice(0, limit) };
        });

        if (!Object.keys(data).length)
          return reply({ build_version: BUILD_VERSION, error: errors.join("; ") }, true);

        return reply(
          envelope("research360/alpha-picks/calls", null, true, data, [
            "short_term = calltype 101, intraday = calltype 102. Newest first.",
            "Prices exactly as published; derived_not_from_source values are computed here from entry/target/stoploss/ltp.",
            "Source fields 'current_price' (actually % move vs entry) and 'profit_loss' (-100 on open calls) are omitted as misleading.",
            ...errors,
          ])
        );
      }
    );

    add(
      "get_intraday_candles",
      "NSE intraday OHLCV candles for an equity at 1, 3, 5, 10, 15, 30 or 60 minute intervals. Returns the most recent N candles (oldest to newest) with IST timestamps, plus period high/low, VWAP and change computed from ALL candles in the lookback window.",
      {
        symbol: sym,
        interval: z.enum(["1", "3", "5", "10", "15", "30", "60"]).default("5").describe("Candle size in minutes"),
        days: z.number().int().min(1).max(30).default(1).describe("Lookback in calendar days"),
        limit: z.number().int().min(1).max(300).default(100).describe("Max candles returned (latest)"),
      },
      async ({ symbol, interval, days, limit }) => {
        const s = cleanSymbol(symbol);
        const tk = await resolveToken(s);
        if (tk.error) return errReply(tk.error);

        const nowSec = Math.floor(Date.now() / 1000);
        const r = await chartGet("/charts/symbolHistoricalData", {
          token: tk.token!,
          fromDate: 0,
          toDate: nowSec,
          symbol: s,
          symbolType: "Equity",
          chartType: "I",
          timeInterval: Number(interval),
        });
        if (r.error) return errReply(r);

        const all = toCandles(r.data);
        if (!all) {
          return reply(
            envelope("symbolHistoricalData", s, false,
              { raw_sample: JSON.stringify(r.data).slice(0, 1500) },
              ["Could not recognise the candle format; raw sample returned so the parser can be adjusted."])
          );
        }
        if (!all.length) {
          return reply(
            envelope("symbolHistoricalData", s, true, { candles: [] },
              ["NSE returned no candles for this window (market closed, holiday, or range too short). Try a larger 'days'."])
          );
        }

        const highs = all.map((x) => x.h).filter((x): x is number => x !== null);
        const lows = all.map((x) => x.l).filter((x): x is number => x !== null);
        const vol = all.reduce((a, x) => a + (x.v ?? 0), 0);
        const pv = all.reduce(
          (a, x) => a + (x.v && x.h !== null && x.l !== null && x.c !== null ? ((x.h + x.l + x.c) / 3) * x.v : 0),
          0
        );
        const first = all[0], last = all[all.length - 1];

        const candles = all.slice(-limit).map((x) => ({
          time_ist: istStamp(x.t),
          epoch_utc: x.t,
          open: x.o,
          high: x.h,
          low: x.l,
          close: x.c,
          volume: x.v,
        }));

        return reply(
          envelope("symbolHistoricalData", s, true, {
            interval_minutes: Number(interval),
            total_candles: all.length,
            returned_candles: candles.length,
            first_candle_ist: istStamp(first.t),
            last_candle_ist: istStamp(last.t),
            market: marketSession(),
            derived_not_from_nse: {
              period_high: highs.length ? Math.max(...highs) : null,
              period_low: lows.length ? Math.min(...lows) : null,
              first_open: first.o,
              last_close: last.c,
              change_pct: first.o && last.c !== null ? rnd(((last.c - first.o) / first.o) * 100) : null,
              total_volume: vol || null,
              approx_vwap: vol ? rnd(pv / vol) : null,
            },
            candles,
          }, [
            "Candles are oldest to newest. Stats cover all candles in the window, not just the returned ones.",
            "approx_vwap uses (high+low+close)/3 per candle weighted by volume.",
            `Candle timestamps treated as ${CANDLE_TIME_IS_IST ? "IST-shifted epoch (NSE charting convention)" : "true UTC epoch"}.`,
            "Last candle may still be forming if the market is open.",
          ])
        );
      }
    );
  },
  {},
  { basePath: "", verboseLogs: true, maxDuration: 60, disableSse: true }
);

// Optional access key: set MCP_API_KEY in Vercel. Accepts header x-api-key or ?key=
const guard =
  (h: (req: Request) => Promise<Response>) =>
  async (req: Request) => {
    const key = process.env.MCP_API_KEY;
    if (key) {
      const given = req.headers.get("x-api-key") ?? new URL(req.url).searchParams.get("key");
      if (given !== key) return new Response("Unauthorized", { status: 401 });
    }
    return h(req);
  };

const guarded = guard(handler as unknown as (req: Request) => Promise<Response>);
export { guarded as GET, guarded as POST, guarded as DELETE };

// ---------- Research360 alpha picks ----------
const R360_URL = "https://www.research360.in/api/alpha-picks/calls";
const R360_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": headers["User-Agent"],
  ...(process.env.R360_COOKIE ? { Cookie: process.env.R360_COOKIE } : {}),
};
const CALL_TYPES = { short_term: "101", intraday: "102" } as const;

async function r360Fetch(calltypeId: string, status: string, action: string) {
  try {
    const res = await fetch(R360_URL, {
      method: "POST",
      headers: R360_HEADERS,
      body: JSON.stringify({
        calltype_id: calltypeId,
        status,
        action,
        mcap: "",
        sort_column: "moexcul_latestupd DESC",
        sort_direction: "",
        search: "",
        pagenumber: 1,
        pagesize: 500,
      }),
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    });
    const text = await res.text();
    if (!res.ok) return { error: `Research360 HTTP ${res.status}`, sample: text.slice(0, 200) };
    try {
      const json = JSON.parse(text);
      if (json?.code !== 200 || !Array.isArray(json.data))
        return { error: `Unexpected Research360 response (code ${json?.code})`, sample: text.slice(0, 200) };
      return { rows: json.data as any[] };
    } catch {
      return { error: "Research360 returned non-JSON", sample: text.slice(0, 200) };
    }
  } catch (e) {
    return { error: `Failed to connect to Research360: ${String(e)}` };
  }
}

function slimCall(r: any) {
  const buy = String(r.action).toLowerCase() !== "sell";
  const entry = num(r.entry_price), target = num(r.targetprice), sl = num(r.stoploss), ltp = num(r.ltp);

  const reward = entry !== null && target !== null ? Math.abs(target - entry) : null;
  const risk = entry !== null && sl !== null ? Math.abs(entry - sl) : null;

  const out: Record<string, any> = {
    call_id: r.callid,
    symbol: r.tradesymbol,
    company: r.comp_long_nm ?? r.co_name,
    action: r.action,
    product: r.call_product_type,
    mcap_category: r.mcap_category ?? null,
    entry,
    target,
    stoploss: sl,
    ltp,
    day_change_pct: rnd(num(r.change_per)),
    recommended_at_ist: r.recodate ?? null,
    status: r.status,
    research_report_url: r.research_report_url ?? null,
    derived_not_from_source: {
      move_since_entry_pct:
        entry && ltp !== null ? rnd(((ltp - entry) / entry) * (buy ? 100 : -100)) : null,
      upside_to_target_from_ltp_pct:
        target !== null && ltp ? rnd(((target - ltp) / ltp) * (buy ? 100 : -100)) : null,
      distance_to_sl_from_ltp_pct:
        sl !== null && ltp ? rnd((Math.abs(ltp - sl) / ltp) * 100) : null,
      risk_reward: reward !== null && risk ? rnd(reward / risk) : null,
    },
  };

  // Only for derivative calls (intraday may include these)
  if (r.expirydate && r.expirydate !== "0000-00-00") out.expiry = r.expirydate;
  if (r.strikeprice) out.strike = num(r.strikeprice);
  if (r.futopt_flg) out.fut_opt = r.futopt_flg;
  if (r.status !== "open") {
    out.exit_price = num(r.exitprice);
    out.exit_date = r.exitdate;
  }
  return out;
}

// ---------- NSE charting (intraday candles) ----------
const CHART_BASE = process.env.NSE_CHART_BASE_URL ?? "https://charting.nseindia.in/v1";
const CHART_HEADERS = { "User-Agent": "Mozilla/5.0", Accept: "application/json" };
const tokenCache = new Map<string, { token: string; symbol: string }>();

// NSE charting sends `time` in epoch ms, apparently shifted +5.5h (reads as IST).
// Set CANDLE_TIME_IS_IST=false in env if timestamps turn out to be true UTC.
const CANDLE_TIME_IS_IST = process.env.CANDLE_TIME_IS_IST !== "false";

async function chartGet(path: string, params: Record<string, string | number>): Promise<NseResult> {
  const url = new URL(`${CHART_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  let last: NseResult = { error: "unknown" };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: CHART_HEADERS, signal: AbortSignal.timeout(15000), cache: "no-store" });
      const text = await res.text();
      if (res.ok) {
        try {
          return { data: JSON.parse(text), status: res.status };
        } catch {
          return { error: "NSE charting returned non-JSON", sample: text.slice(0, 200), status: res.status };
        }
      }
      last = { error: `NSE charting HTTP ${res.status}`, sample: text.slice(0, 200), status: res.status };
      if (res.status !== 429 && res.status < 500) return last;
    } catch (e) {
      last = { error: `Failed to connect to NSE charting: ${String(e)}` };
    }
    await sleep(500 * attempt);
  }
  return last;
}

async function resolveToken(symbol: string): Promise<{ token?: string; symbol?: string; error?: NseResult }> {
  const hit = tokenCache.get(symbol);
  if (hit) return hit;
  const r = await chartGet("/exchanges/symbolsDynamic", { symbol, segment: "EQ" });
  if (r.error) return { error: r };
  const first = r.data?.status && Array.isArray(r.data?.data) ? r.data.data[0] : null;
  if (!first?.scripcode) return { error: { error: `Symbol ${symbol} not found on NSE charting` } };
  const found = { token: String(first.scripcode), symbol: String(first.symbol ?? symbol) };
  tokenCache.set(symbol, found);
  return found;
}

type Candle = { t: number; o: number | null; h: number | null; l: number | null; c: number | null; v: number | null };

// Verified shape: [{ time(ms), open, high, low, close, volume }, ...]
// Returns candles sorted oldest -> newest with t as TRUE UTC seconds.
function toCandles(raw: any): Candle[] | null {
  const rows = rowsOf(raw);
  if (!rows) return null;
  if (!rows.length) return [];
  if (rows[0]?.time === undefined || rows[0]?.close === undefined) return null;

  const seen = new Set<number>();
  return rows
    .map((r) => ({
      t: Math.round(Number(r.time) / 1000) - (CANDLE_TIME_IS_IST ? IST_MS / 1000 : 0),
      o: num(r.open),
      h: num(r.high),
      l: num(r.low),
      c: num(r.close),
      v: num(r.volume),
    }))
    .filter((x) => {
      if (!Number.isFinite(x.t) || seen.has(x.t)) return false;
      seen.add(x.t);
      return true;
    })
    .sort((a, b) => a.t - b.t);
}

// true UTC seconds -> "DD-MM-YYYY HH:MM" in IST
const istStamp = (sec: number) => {
  const x = new Date(sec * 1000 + IST_MS);
  return `${istDDMMYYYY(new Date(sec * 1000))} ${pad(x.getUTCHours())}:${pad(x.getUTCMinutes())}`;
};