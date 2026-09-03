import { NextResponse } from 'next/server';
import { getKrakenBalance } from '@/lib/exchanges/kraken';
import { getCoinbaseBalance } from '@/lib/exchanges/coinbase';
import { getMarketData } from '@/lib/market-data';
import axios from 'axios';

const COINGECKO_IDS: Record<string, string> = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', ADA: 'cardano',
  DOT: 'polkadot', AVAX: 'avalanche-2', LINK: 'chainlink', UNI: 'uniswap',
  AAVE: 'aave', LTC: 'litecoin', XRP: 'ripple', MATIC: 'matic-network',
  ARB: 'arbitrum', OP: 'optimism', NEAR: 'near', ALGO: 'algorand',
  TON: 'the-open-network', INJ: 'injective-protocol', SUI: 'sui',
  APT: 'aptos', SEI: 'sei-network', TIA: 'celestia',
  // Coinbase specific
  ATOM: 'cosmos', XTZ: 'tezos', XCN: 'chain-2',
  DOGE: 'dogecoin', SHIB: 'shiba-inu', CRO: 'crypto-com-chain',
  FIL: 'filecoin', ICP: 'internet-computer', VET: 'vechain',
  ETC: 'ethereum-classic', MANA: 'decentraland', SAND: 'the-sandbox',
  GRT: 'the-graph', ENJ: 'enjincoin', BAT: 'basic-attention-token',
  ZEC: 'zcash', DASH: 'dash', EOS: 'eos', XLM: 'stellar',
  COMP: 'compound-governance-token', SNX: 'havven', MKR: 'maker',
  YFI: 'yearn-finance', SUSHI: 'sushi', CRV: 'curve-dao-token',
  '1INCH': '1inch', BAL: 'balancer', REN: 'republic-protocol',
  SKL: 'skale', NMR: 'numeraire', OXT: 'orchid-protocol',
  STORJ: 'storj', ANKR: 'ankr', CTSI: 'cartesi',
};

export interface ExchangeBalance {
  symbol: string;
  amount: number;
  price_eur: number | null;
  value_eur: number | null;
  source: 'kraken' | 'coinbase' | 'both';
}

export async function GET() {
  const result: {
    balances: ExchangeBalance[];
    total_eur: number;
    cash_eur: number;
    crypto_eur: number;
    kraken_available: boolean;
    coinbase_available: boolean;
    error?: string;
  } = {
    balances: [],
    total_eur: 0,
    cash_eur: 0,
    crypto_eur: 0,
    kraken_available: false,
    coinbase_available: false,
  };

  // Fetch balances from both exchanges
  let krakenBal: Record<string, number> = {};
  let coinbaseBal: Record<string, number> = {};

  try {
    krakenBal = await getKrakenBalance();
    result.kraken_available = true;
  } catch {
    // Keys not configured or error — not fatal
  }

  try {
    coinbaseBal = await getCoinbaseBalance();
    result.coinbase_available = true;
  } catch {
    // Keys not configured or error — not fatal
  }

  if (!result.kraken_available && !result.coinbase_available) {
    return NextResponse.json({
      ...result,
      error: 'Aucune clé API exchange configurée (KRAKEN_API_KEY / COINBASE_API_KEY)',
    });
  }

  // Merge balances from both exchanges
  const merged: Record<string, { amount: number; sources: Set<'kraken' | 'coinbase'> }> = {};

  for (const [sym, amt] of Object.entries(krakenBal)) {
    if (!merged[sym]) merged[sym] = { amount: 0, sources: new Set() };
    merged[sym].amount += amt;
    merged[sym].sources.add('kraken');
  }

  for (const [sym, amt] of Object.entries(coinbaseBal)) {
    if (!merged[sym]) merged[sym] = { amount: 0, sources: new Set() };
    merged[sym].amount += amt;
    merged[sym].sources.add('coinbase');
  }

  // Fetch prices — known symbols via getMarketData, unknowns via CoinGecko simple/price
  const cryptoSymbols = Object.keys(merged).filter(s => !['EUR','USD','USDC','USDT'].includes(s));
  const knownIds = cryptoSymbols.filter(s => COINGECKO_IDS[s]).map(s => COINGECKO_IDS[s]);
  const unknownSymbols = cryptoSymbols.filter(s => !COINGECKO_IDS[s]);

  let priceMap: Record<string, number> = {};

  // Fetch known symbols
  if (knownIds.length > 0) {
    try {
      const marketData = await getMarketData(knownIds);
      for (const md of marketData) {
        priceMap[md.symbol] = md.price_eur;
      }
    } catch { /* silent */ }
  }

  // Fetch unknown symbols by ticker via CoinGecko simple/price
  if (unknownSymbols.length > 0) {
    try {
      const ids = unknownSymbols.map(s => s.toLowerCase()).join(',');
      const res = await axios.get(
        `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=eur`,
        { timeout: 8000 }
      );
      for (const [id, prices] of Object.entries(res.data as Record<string, { eur: number }>)) {
        const sym = unknownSymbols.find(s => s.toLowerCase() === id);
        if (sym) priceMap[sym] = prices.eur;
      }
    } catch { /* silent */ }
  }

  // Build final balances list
  let totalEur = 0;
  let cashEur = 0;
  let cryptoEur = 0;

  for (const [sym, { amount, sources }] of Object.entries(merged)) {
    const sourceArr = Array.from(sources);
    const source: 'kraken' | 'coinbase' | 'both' =
      sourceArr.length === 2 ? 'both' : sourceArr[0];

    if (sym === 'EUR') {
      cashEur += amount;
      totalEur += amount;
      result.balances.push({ symbol: 'EUR', amount, price_eur: 1, value_eur: amount, source });
      continue;
    }

    // Stablecoins — treat as ~1 EUR (approximation)
    if (sym === 'USD' || sym === 'USDC' || sym === 'USDT') {
      const valueEur = amount * 0.92; // rough EUR/USD
      cashEur += valueEur;
      totalEur += valueEur;
      result.balances.push({ symbol: sym, amount, price_eur: 0.92, value_eur: valueEur, source });
      continue;
    }

    const priceEur = priceMap[sym] ?? null;
    const valueEur = priceEur !== null ? amount * priceEur : null;

    if (valueEur !== null) {
      cryptoEur += valueEur;
      totalEur += valueEur;
    }

    result.balances.push({ symbol: sym, amount, price_eur: priceEur, value_eur: valueEur, source });
  }

  // Sort: EUR first, then by value desc, then unknowns last
  result.balances.sort((a, b) => {
    if (a.symbol === 'EUR') return -1;
    if (b.symbol === 'EUR') return 1;
    if (a.value_eur !== null && b.value_eur !== null) return b.value_eur - a.value_eur;
    if (a.value_eur !== null) return -1;
    if (b.value_eur !== null) return 1;
    return a.symbol.localeCompare(b.symbol);
  });

  result.total_eur = totalEur;
  result.cash_eur = cashEur;
  result.crypto_eur = cryptoEur;

  return NextResponse.json(result);
}
