/**
 * Polymarket Data Module
 *
 * Fetches real, live prediction-market questions from Polymarket's
 * Gamma API. No auth required. We filter the firehose to "interesting"
 * markets (implied probability between 0.20 and 0.80) so the demo
 * doesn't get stuck on questions the market is already 99% certain about.
 */

import type { PolymarketQuestion } from "./types";

const POLYMARKET = "https://gamma-api.polymarket.com";

const cache = new Map<string, { data: PolymarketQuestion[]; ts: number }>();
const CACHE_TTL = 5 * 60_000;

interface RawMarket {
  id?: string | number;
  conditionId?: string;
  question?: string;
  description?: string;
  category?: string;
  groupItemTitle?: string;
  outcomes?: string | string[];
  outcomePrices?: string | string[];
  volume?: string | number;
  volume24hr?: string | number;
  liquidity?: string | number;
  endDate?: string;
  end_date_iso?: string;
  slug?: string;
}

function parseMarket(raw: RawMarket): PolymarketQuestion | null {
  try {
    const outcomes: string[] = typeof raw.outcomes === "string"
      ? JSON.parse(raw.outcomes)
      : (raw.outcomes ?? ["Yes", "No"]);

    const pricesRaw: unknown = typeof raw.outcomePrices === "string"
      ? JSON.parse(raw.outcomePrices)
      : (raw.outcomePrices ?? ["0.5", "0.5"]);
    const prices = (Array.isArray(pricesRaw) ? pricesRaw : ["0.5", "0.5"]).map(p => parseFloat(String(p)));

    const yesIdx = outcomes.findIndex(o => /yes/i.test(o));
    const noIdx  = outcomes.findIndex(o => /no/i.test(o));
    const yesPrice = (yesIdx >= 0 ? prices[yesIdx] : prices[0]) ?? 0.5;
    const noPrice  = (noIdx  >= 0 ? prices[noIdx]  : prices[1]) ?? 0.5;

    if (!raw.question || raw.question.length < 5) return null;
    if (Number.isNaN(yesPrice) || Number.isNaN(noPrice)) return null;

    const slug = String(raw.slug || "");

    return {
      id: String(raw.id ?? raw.conditionId ?? ""),
      conditionId: String(raw.conditionId ?? ""),
      question: String(raw.question),
      description: String(raw.description ?? ""),
      category: String(raw.category ?? raw.groupItemTitle ?? "general"),
      yesPrice,
      noPrice,
      volume24hr: parseFloat(String(raw.volume24hr ?? raw.volume ?? "0")) || 0,
      liquidity: parseFloat(String(raw.liquidity ?? "0")) || 0,
      endDate: String(raw.endDate ?? raw.end_date_iso ?? ""),
      slug,
      url: slug ? `https://polymarket.com/event/${slug}` : "",
      fetchedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

/**
 * Fetch the top live Polymarket questions and filter to ones with
 * genuine uncertainty (0.20 < YES probability < 0.80) and real volume.
 *
 * The cache stores the FULL filtered list (not the sliced one) so callers
 * with different limits see consistent data.
 */
export async function fetchInterestingQuestions(limit = 5): Promise<PolymarketQuestion[]> {
  const cached = cache.get("interesting");
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data.slice(0, limit);

  const url = `${POLYMARKET}/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=200`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Polymarket ${res.status} ${res.statusText}`);
  const raw = await res.json() as RawMarket[];
  if (!Array.isArray(raw)) throw new Error("Polymarket response not an array");

  const parsed: PolymarketQuestion[] = [];
  for (const r of raw) {
    const m = parseMarket(r);
    if (m) parsed.push(m);
  }

  const now = Date.now();
  const interesting = parsed
    .filter(m => m.yesPrice >= 0.20 && m.yesPrice <= 0.80)
    .filter(m => {
      if (!m.endDate) return true;
      const end = new Date(m.endDate).getTime();
      return Number.isFinite(end) && end > now;
    })
    .filter(m => m.volume24hr > 1000);

  // Cache the full filtered list so callers with any limit see consistent data
  cache.set("interesting", { data: interesting, ts: Date.now() });
  return interesting.slice(0, limit);
}

/** Fetch a single market by id (used for refresh / verification). */
export async function fetchQuestionById(id: string): Promise<PolymarketQuestion | null> {
  try {
    const res = await fetch(`${POLYMARKET}/markets/${id}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const raw = await res.json() as RawMarket;
    return parseMarket(raw);
  } catch {
    return null;
  }
}
