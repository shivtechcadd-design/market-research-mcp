import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

const NSE_BASE = process.env.NSE_BASE_URL ?? "https://www.nseindia.in";
const API = `${NSE_BASE}/api/NextApi/apiClient/GetQuoteApi`;
const MAX_CHARS = 12000;

// Same headers as your Python helpers (Accept-Encoding omitted: Node handles it itself)
const headers = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0",
  Accept: "application/json, text/javascript, */*; q=0.01",
  "Accept-Language": "en-US,en;q=0.5",
  Referer: "https://www.nseindia.com/",
};

// ---------- helpers ----------
const cleanSymbol = (s: string) =>
  s.trim().toUpperCase().replace(/EQN$/, "").replace(/EQ$/, "");
const eqnSymbol = (s: string) => cleanSymbol(s) + "EQN";

const ddmmyyyy = (d: Date) =>
  `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
const defaultRange = () => {
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from: ddmmyyyy(from), to: ddmmyyyy(to) };
};

async function nseGet(
  functionName: string,
  params: Record<string, string>
): Promise<{ data?: any; error?: string; sample?: string }> {
  const url = new URL(API);
  url.searchParams.set("functionName", functionName);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    });
    const text = await res.text();
    if (!res.ok)
      return { error: `NSE returned HTTP ${res.status}`, sample: text.slice(0, 200) };
    try {
      return { data: JSON.parse(text) };
    } catch {
      return {
        error: "NSE returned non-JSON (likely a bot-check page)",
        sample: text.slice(0, 200),
      };
    }
  } catch (e) {
    return { error: `Failed to connect to NSE: ${String(e)}` };
  }
}

// Generic safeguard: cut any long array to its first 10 items
function shrink(v: any): any {
  if (Array.isArray(v)) return v.slice(0, 10).map(shrink);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shrink(x)]));
  return v;
}

// Apply fn to the list whether NSE returns [..] or { data: [..] }
function mapList(d: any, fn: (arr: any[]) => any[]) {
  if (Array.isArray(d)) return fn(d);
  if (d && Array.isArray(d.data)) return { ...d, data: fn(d.data) };
  return d;
}

function reply(payload: unknown, isError = false) {
  let text = JSON.stringify(payload);
  if (text.length > MAX_CHARS)
    text = text.slice(0, MAX_CHARS) + " ...[TRUNCATED: payload too large]";
  return { isError, content: [{ type: "text" as const, text }] };
}

async function run(
  fn: string,
  params: Record<string, string>,
  transform: (d: any) => any = shrink
) {
  const r = await nseGet(fn, params);
  if (r.error) return reply({ error: r.error, sample: r.sample }, true);
  return reply({
    source: "NSE",
    fetched_at: new Date().toISOString(),
    data: transform(r.data),
  });
}

// Exact stats computed from the FULL series, before downsampling
function chartStats(arr: any[]) {
  const prices = arr
    .map((p) => (Array.isArray(p) ? Number(p[1]) : NaN))
    .filter(Number.isFinite);
  if (!prices.length) return undefined;
  const first = prices[0];
  const last = prices[prices.length - 1];
  return {
    points: prices.length,
    high: Math.max(...prices),
    low: Math.min(...prices),
    first,
    last,
    pct_change_first_to_last: Number((((last - first) / first) * 100).toFixed(2)),
  };
}

const sym = z.string().describe("NSE stock symbol, e.g. KOTAKBANK");

// ---------- server ----------
const handler = createMcpHandler(
  async (server) => {
    const add = (
      name: string,
      description: string,
      schema: z.ZodRawShape,
      fn: (args: any) => Promise<any>
    ) =>
      server.tool(name, description, schema, { title: name, readOnlyHint: true }, fn);

    add(
      "nse_health_check",
      "Checks whether the NSE API is reachable from this server. Returns HTTP status and a short sample.",
      {},
      async () => {
        const r = await nseGet("getSymbolData", {
          marketType: "N",
          series: "EQ",
          symbol: "KOTAKBANK",
        });
        return reply({ base: NSE_BASE, ok: !r.error, error: r.error, sample: r.sample ?? JSON.stringify(r.data).slice(0, 200) });
      }
    );

    add(
      "get_stock_quote",
      "Live equity quote from NSE: price, change, VWAP, day and 52-week range, volume, plus delivery %, impact cost, margins, P/E and order-book data where NSE provides them.",
      { symbol: sym },
      async ({ symbol }) =>
        run("getSymbolData", { marketType: "N", series: "EQ", symbol: cleanSymbol(symbol) })
    );

    add(
      "get_stock_chart",
      "Intraday or historical chart data. Returns exact period high/low/first/last computed from the full series, plus a downsampled series.",
      {
        symbol: sym,
        days: z.string().default("1D").describe("Timeframe, e.g. 1D, 1W, 1M, 1Y"),
      },
      async ({ symbol, days }) => {
        const r = await nseGet("getSymbolChartData", { symbol: eqnSymbol(symbol), days });
        if (r.error) return reply({ error: r.error, sample: r.sample }, true);
        const data = r.data;
        const computed: Record<string, unknown> = {};
        if (data && typeof data === "object") {
          for (const key of ["grapthData", "grapthData5m"]) {
            if (Array.isArray(data[key])) {
              computed[key] = chartStats(data[key]);
              data[key] = data[key].filter((_: any, i: number) => i % 15 === 0).slice(0, 20);
            }
          }
        }
        return reply({ source: "NSE", fetched_at: new Date().toISOString(), computed, data: shrink(data) });
      }
    );

    add(
      "get_relative_performance",
      "Stock returns across 1 week, 1 month, 3 months and 1 year versus the Nifty 50 benchmark.",
      { symbol: sym },
      async ({ symbol }) => run("getYearwiseData", { symbol: eqnSymbol(symbol) })
    );

    add(
      "get_derivatives_most_active",
      "Most active derivative contracts for a stock. call_type: C = calls, P = puts, O = overall.",
      { symbol: sym, call_type: z.enum(["C", "P", "O"]).default("O") },
      async ({ symbol, call_type }) =>
        run("getDerivativesMostActive", { symbol: cleanSymbol(symbol), callType: call_type })
    );

    add(
      "get_derivatives_filter",
      "Available F&O expiry dates, option types, instrument types and strike prices for a stock.",
      { symbol: sym },
      async ({ symbol }) =>
        run("getSymbolDerivativesFilter", { isSymbolIndex: "S", symbol: cleanSymbol(symbol) })
    );

    add(
      "get_derivatives_chain",
      "Options and futures chain for a stock: top 15 contracts by traded volume, with open interest and OI change.",
      { symbol: sym },
      async ({ symbol }) =>
        run("getSymbolDerivativesData", { symbol: cleanSymbol(symbol) }, (d) =>
          mapList(d, (arr) =>
            [...arr]
              .sort((a, b) => (b?.totalTradedVolume ?? 0) - (a?.totalTradedVolume ?? 0))
              .slice(0, 15)
          )
        )
    );

    add(
      "get_option_chain_dropdown",
      "Option chain expiry dates and the full strike price range for a stock.",
      { symbol: sym },
      async ({ symbol }) => run("getOptionChainDropdown", { symbol: cleanSymbol(symbol) })
    );

    add(
      "get_slbm",
      "Stock lending and borrowing (SLBM) contracts: lending fees, yields, spreads and traded quantity. Only contracts with activity are returned.",
      { symbol: sym },
      async ({ symbol }) =>
        run(
          "getGetQuoteSLBMData",
          { symbol: cleanSymbol(symbol), series: "", month: "" },
          (d) =>
            mapList(d, (arr) => {
              const active = arr.filter(
                (i) => (i?.totTradedQty ?? 0) > 0 || (i?.lastPrice ?? 0) > 0 || (i?.totalBuyQuantity ?? 0) > 0
              );
              return (active.length ? active : arr).slice(0, 15);
            })
        )
    );

    add(
      "get_historical_trades",
      "Historical daily trade data (close, VWAP, volume, trades) for a date range. Dates are DD-MM-YYYY; defaults to the last 30 days.",
      {
        symbol: sym,
        series: z.string().default("EQ"),
        from_date: z.string().optional().describe("DD-MM-YYYY"),
        to_date: z.string().optional().describe("DD-MM-YYYY"),
      },
      async ({ symbol, series, from_date, to_date }) => {
        const def = defaultRange();
        return run(
          "getHistoricalTradeData",
          {
            symbol: cleanSymbol(symbol),
            series,
            fromDate: from_date ?? def.from,
            toDate: to_date ?? def.to,
          },
          (d) => mapList(d, (arr) => arr.slice(0, 15))
        );
      }
    );

    add(
      "get_bulk_block_deals",
      "Bulk and block deals for a stock over a date range (top 15 by value). Dates are DD-MM-YYYY; defaults to the last 30 days.",
      {
        symbol: sym,
        from_date: z.string().optional().describe("DD-MM-YYYY"),
        to_date: z.string().optional().describe("DD-MM-YYYY"),
      },
      async ({ symbol, from_date, to_date }) => {
        const def = defaultRange();
        return run(
          "getHistoricalBulkAndBlockData",
          { symbol: cleanSymbol(symbol), fromDate: from_date ?? def.from, toDate: to_date ?? def.to },
          (d) =>
            mapList(d, (arr) =>
              [...arr]
                .sort(
                  (a, b) =>
                    Number(b?.tradedValue || b?.quantity || 0) -
                    Number(a?.tradedValue || a?.quantity || 0)
                )
                .slice(0, 15)
            )
        );
      }
    );

    add(
      "get_integrated_filings",
      "Recent corporate quarterly results: income, profit before tax, net profit and EPS (latest 6 filings).",
      { symbol: sym },
      async ({ symbol }) =>
        run("getIntegratedFilingData", { symbol: cleanSymbol(symbol) }, (d) =>
          mapList(d, (arr) => arr.slice(0, 6))
        )
    );
  },
  {},
  {
    basePath: "",
    verboseLogs: true,
    maxDuration: 60,
    disableSse: true,
  }
);

export { handler as GET, handler as POST, handler as DELETE };