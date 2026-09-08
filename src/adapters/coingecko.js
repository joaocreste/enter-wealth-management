/**
 * CoinGecko — digital assets. Primary for crypto spot and monthly windows,
 * because Yahoo's crypto series carries exchange-dependent gaps.
 */
import { getJson } from './http.js';
import { makeSource } from '../core/sources.js';
import { cacheGet, cacheSet, throttle } from './cache.js';

const BASE = 'https://api.coingecko.com/api/v3';
export const COIN_IDS = { 'BTC-USD': 'bitcoin', 'ETH-USD': 'ethereum', 'SOL-USD': 'solana' };

export async function spot(symbols) {
  const ids = symbols.map((s) => COIN_IDS[s]).filter(Boolean);
  if (!ids.length) return {};
  const cacheKey = `cg:spot:${ids.join(',')}`;
  let data = await cacheGet(cacheKey, 300);
  try {
    if (!data) {
      await throttle('coingecko', 400);
      data = await getJson(`${BASE}/simple/price?ids=${ids.join(',')}&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true`, { retries: 1 });
      await cacheSet(cacheKey, data, 300);
    }
  } catch (err) {
    return Object.fromEntries(symbols.map((s) => [s, { symbol: s, unavailable: true, reason: err.message, providers_attempted: ['CoinGecko'] }]));
  }
  const out = {};
  for (const s of symbols) {
    const id = COIN_IDS[s];
    const row = id && data[id];
    out[s] = row
      ? {
        symbol: s,
        name: id[0].toUpperCase() + id.slice(1),
        currency: 'USD',
        price: row.usd,
        changePct: row.usd_24h_change != null ? row.usd_24h_change / 100 : null,
        asOf: row.last_updated_at ? new Date(row.last_updated_at * 1000).toISOString().slice(0, 10) : null,
        source: makeSource({
          provider: 'CoinGecko',
          kind: 'market_price',
          instrument: `${id} / USD`,
          identifier: id,
          requested_range: 'spot',
          last_observation: row.last_updated_at ? new Date(row.last_updated_at * 1000).toISOString().slice(0, 10) : null,
          reference: `https://www.coingecko.com/en/coins/${id}`,
        }),
      }
      : { symbol: s, unavailable: true, reason: 'coin not mapped', providers_attempted: ['CoinGecko'] };
  }
  return out;
}
