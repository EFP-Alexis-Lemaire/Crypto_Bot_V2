import crypto from 'crypto';
import axios from 'axios';

const COINBASE_API_URL = 'https://api.coinbase.com/api/v3/brokerage';

function isCDPKey(apiKey: string): boolean {
  return apiKey.startsWith('organizations/');
}

/**
 * Loads a Coinbase CDP private key.
 * Coinbase CDP now uses Ed25519 by default — the JSON file contains:
 *   { "id": "...", "privateKey": "<base64 of 64-byte Ed25519 keypair>" }
 * The first 32 bytes are the private seed, the last 32 are the public key.
 */
function loadCDPPrivateKey(secret: string): { key: crypto.KeyObject; alg: 'EdDSA' | 'ES256' } {
  const normalised = secret.replace(/\\n/g, '\n').trim();

  // Already a PEM
  if (normalised.includes('-----BEGIN')) {
    const key = crypto.createPrivateKey(normalised);
    const alg = key.asymmetricKeyType === 'ed25519' ? 'EdDSA' : 'ES256';
    return { key, alg };
  }

  const raw = Buffer.from(normalised, 'base64');

  // Ed25519: 64 bytes (32 seed + 32 public) or 32 bytes (seed only)
  if (raw.length === 64 || raw.length === 32) {
    const seed = raw.slice(0, 32);
    // PKCS#8 DER for Ed25519: 30 2e 02 01 00 30 05 06 03 2b 65 70 04 22 04 20 <32-byte seed>
    const pkcs8Der = Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      seed,
    ]);
    const key = crypto.createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' });
    return { key, alg: 'EdDSA' };
  }

  // EC P-256: try DER formats
  for (const type of ['pkcs8', 'sec1'] as const) {
    try {
      const key = crypto.createPrivateKey({ key: raw, format: 'der', type });
      return { key, alg: 'ES256' };
    } catch { /* try next */ }
  }

  throw new Error(`Cannot load Coinbase private key — unsupported format (${raw.length} bytes)`);
}

function buildCDPJWT(apiKey: string, method: string, path: string, secret: string): string {
  const uri = `${method.toUpperCase()} api.coinbase.com${path}`;
  const { key, alg } = loadCDPPrivateKey(secret);

  const header = Buffer.from(JSON.stringify({
    alg,
    kid: apiKey,
    nonce: crypto.randomBytes(16).toString('hex'),
  })).toString('base64url');

  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    sub: apiKey,
    iss: 'cdp',
    nbf: now,
    exp: now + 120,
    uri,
  })).toString('base64url');

  const signingInput = `${header}.${payload}`;

  // Ed25519 uses sign() directly; EC uses createSign('SHA256')
  let signature: string;
  if (alg === 'EdDSA') {
    signature = crypto.sign(null, Buffer.from(signingInput), key).toString('base64url');
  } else {
    const s = crypto.createSign('SHA256');
    s.update(signingInput);
    signature = s.sign(key, 'base64url');
  }

  return `${signingInput}.${signature}`;
}

function getCoinbaseSignature(
  timestamp: string,
  method: string,
  path: string,
  body: string,
  secret: string
): string {
  const message = timestamp + method.toUpperCase() + path + body;
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

async function coinbaseRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>
): Promise<T> {
  const apiKey = process.env.COINBASE_API_KEY;
  const apiSecret = process.env.COINBASE_API_SECRET;

  if (!apiKey || !apiSecret || apiKey === 'your_coinbase_api_key_here') {
    throw new Error('Coinbase API keys not configured');
  }

  const fullPath = `/api/v3/brokerage${path}`;
  const bodyStr = body ? JSON.stringify(body) : '';

  let headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (isCDPKey(apiKey)) {
    const jwt = buildCDPJWT(apiKey, method, fullPath, apiSecret);
    headers['Authorization'] = `Bearer ${jwt}`;
  } else {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = getCoinbaseSignature(timestamp, method, fullPath, bodyStr, apiSecret);
    headers = {
      ...headers,
      'CB-ACCESS-KEY': apiKey,
      'CB-ACCESS-SIGN': signature,
      'CB-ACCESS-TIMESTAMP': timestamp,
    };
  }

  const response = await axios({
    method,
    url: `${COINBASE_API_URL}${path}`,
    data: body,
    headers,
    timeout: 15000,
  });

  return response.data as T;
}

export interface CoinbaseAccount {
  uuid: string;
  name: string;
  currency: string;
  available_balance: { value: string; currency: string };
}

export async function getCoinbaseBalance(): Promise<Record<string, number>> {
  const result = await coinbaseRequest<{ accounts: CoinbaseAccount[] }>('GET', '/accounts');
  const balances: Record<string, number> = {};
  for (const account of result.accounts ?? []) {
    const amount = parseFloat(account.available_balance.value);
    if (amount > 0) {
      balances[account.currency] = amount;
    }
  }
  return balances;
}

export async function placeCoinbaseOrder(
  productId: string,
  side: 'BUY' | 'SELL',
  quoteSize?: string,
  baseSize?: string
): Promise<{ order_id: string; product_id: string; status: string }> {
  const clientOrderId = `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const orderConfig = side === 'BUY'
    ? { market_market_ioc: { quote_size: quoteSize } }
    : { market_market_ioc: { base_size: baseSize } };

  const result = await coinbaseRequest<{
    success: boolean;
    order_id: string;
    success_response: { order_id: string; product_id: string; status: string };
    error_response?: { error: string; message: string };
  }>('POST', '/orders', {
    client_order_id: clientOrderId,
    product_id: productId,
    side,
    order_configuration: orderConfig,
  });

  if (!result.success || result.error_response) {
    throw new Error(`Coinbase order failed: ${result.error_response?.message ?? 'Unknown error'}`);
  }

  return result.success_response;
}

export async function getCoinbaseTicker(productId: string): Promise<{
  price: number; bid: number; ask: number
}> {
  const result = await coinbaseRequest<{
    best_bid: string;
    best_ask: string;
    price: string;
  }>('GET', `/best_bid_ask?product_ids=${productId}`);

  return {
    price: parseFloat(result.price),
    bid: parseFloat(result.best_bid),
    ask: parseFloat(result.best_ask),
  };
}

export const SYMBOL_TO_COINBASE_PRODUCT: Record<string, string> = {
  BTC: 'BTC-EUR',
  ETH: 'ETH-EUR',
  SOL: 'SOL-EUR',
  ADA: 'ADA-EUR',
  DOT: 'DOT-EUR',
  AVAX: 'AVAX-EUR',
  LINK: 'LINK-EUR',
  UNI: 'UNI-EUR',
  AAVE: 'AAVE-EUR',
  LTC: 'LTC-EUR',
  XRP: 'XRP-EUR',
  MATIC: 'MATIC-EUR',
  ARB: 'ARB-EUR',
  NEAR: 'NEAR-EUR',
  ALGO: 'ALGO-EUR',
};
