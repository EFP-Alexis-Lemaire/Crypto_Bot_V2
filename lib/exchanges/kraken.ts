import crypto from 'crypto';
import axios from 'axios';

const KRAKEN_API_URL = 'https://api.kraken.com';

function getKrakenSignature(
  path: string,
  nonce: string,
  postData: string,
  secret: string
): string {
  const secretBuffer = Buffer.from(secret, 'base64');
  const sha256Hash = crypto
    .createHash('sha256')
    .update(nonce + postData)
    .digest();
  const hmac = crypto
    .createHmac('sha512', secretBuffer)
    .update(Buffer.concat([Buffer.from(path), sha256Hash]))
    .digest('base64');
  return hmac;
}

async function krakenPrivate(
  endpoint: string,
  params: Record<string, string | number> = {}
): Promise<unknown> {
  const apiKey = process.env.KRAKEN_API_KEY;
  const apiSecret = process.env.KRAKEN_API_SECRET;

  if (!apiKey || !apiSecret || apiKey === 'your_kraken_api_key_here') {
    throw new Error('Kraken API keys not configured');
  }

  const nonce = Date.now().toString();
  const path = `/0/private/${endpoint}`;
  const postData = new URLSearchParams({ nonce, ...params as Record<string, string> }).toString();
  const signature = getKrakenSignature(path, nonce, postData, apiSecret);

  const response = await axios.post(
    `${KRAKEN_API_URL}${path}`,
    postData,
    {
      headers: {
        'API-Key': apiKey,
        'API-Sign': signature,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 15000,
    }
  );

  const data = response.data;
  if (data.error && data.error.length > 0) {
    throw new Error(`Kraken API error: ${data.error.join(', ')}`);
  }
  return data.result;
}

async function krakenPublic(
  endpoint: string,
  params: Record<string, string> = {}
): Promise<unknown> {
  const response = await axios.get(
    `${KRAKEN_API_URL}/0/public/${endpoint}`,
    { params, timeout: 10000 }
  );
  return response.data.result;
}

export interface KrakenBalance {
  [currency: string]: string;
}

export async function getKrakenBalance(): Promise<Record<string, number>> {
  const result = await krakenPrivate('Balance') as KrakenBalance;
  const balances: Record<string, number> = {};
  for (const [currency, amount] of Object.entries(result)) {
    const value = parseFloat(amount);
    if (value > 0) {
      // Normalize currency names (XXBT → BTC, XETH → ETH, ZEUR → EUR)
      const normalized = normalizeCurrency(currency);
      balances[normalized] = value;
    }
  }
  return balances;
}

export async function getKrakenTicker(pair: string): Promise<{
  ask: number; bid: number; last: number
}> {
  const result = await krakenPublic('Ticker', { pair }) as Record<string, {
    a: string[]; b: string[]; c: string[]
  }>;
  const ticker = Object.values(result)[0];
  return {
    ask: parseFloat(ticker.a[0]),
    bid: parseFloat(ticker.b[0]),
    last: parseFloat(ticker.c[0]),
  };
}

export async function placeKrakenOrder(
  pair: string,
  type: 'buy' | 'sell',
  volume: string,
  price?: string
): Promise<{ txid: string[]; description: string }> {
  const params: Record<string, string> = {
    pair,
    type,
    ordertype: price ? 'limit' : 'market',
    volume,
  };

  if (price) params.price = price;

  // Validate order before execution
  const validateResult = await krakenPrivate('AddOrder', {
    ...params,
    validate: 'true',
  }) as { descr: { order: string } };

  console.log(`[Kraken] Order validation: ${validateResult.descr.order}`);

  // Execute real order
  const result = await krakenPrivate('AddOrder', params) as {
    txid: string[];
    descr: { order: string };
  };

  return {
    txid: result.txid,
    description: result.descr.order,
  };
}

export async function getKrakenOpenOrders(): Promise<unknown[]> {
  const result = await krakenPrivate('OpenOrders') as { open: Record<string, unknown> };
  return Object.values(result.open ?? {});
}

// Kraken uses non-standard currency codes
function normalizeCurrency(currency: string): string {
  const map: Record<string, string> = {
    XXBT: 'BTC', XBT: 'BTC',
    XETH: 'ETH', ETH: 'ETH',
    XLTC: 'LTC',
    XXRP: 'XRP',
    ZEUR: 'EUR', EUR: 'EUR',
    ZUSD: 'USD',
    SOL: 'SOL',
    ADA: 'ADA',
    DOT: 'DOT',
    MATIC: 'MATIC',
    LINK: 'LINK',
    UNI: 'UNI',
    AAVE: 'AAVE',
  };
  return map[currency] ?? currency;
}

// Symbol to Kraken pair mapping
export const SYMBOL_TO_KRAKEN_PAIR: Record<string, string> = {
  BTC: 'XXBTZEUR',
  ETH: 'XETHZEUR',
  SOL: 'SOLEUR',
  ADA: 'ADAEUR',
  DOT: 'DOTZEUR',
  AVAX: 'AVAXEUR',
  LINK: 'LINKEUR',
  UNI: 'UNIEUR',
  AAVE: 'AAVEEUR',
  LTC: 'XLTCZEUR',
  XRP: 'XXRPZEUR',
  MATIC: 'MATICEUR',
  ARB: 'ARBEUR',
  OP: 'OPEUR',
  NEAR: 'NEAREUR',
  ALGO: 'ALGOEUR',
};
