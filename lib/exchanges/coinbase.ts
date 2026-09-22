import crypto from 'crypto';
import axios from 'axios';

const COINBASE_API_URL = 'https://api.coinbase.com/api/v3/brokerage';

function isCDPKey(apiKey: string): boolean {
  return apiKey.startsWith('organizations/');
}

/**
 * Génère un JWT via le CDP SDK officiel Coinbase.
 * Supporte Ed25519 (nouveau format CDP) et ECDSA (legacy).
 */
async function buildCDPJWT(apiKey: string, method: string, path: string, secret: string): Promise<string> {
  // Utiliser le SDK officiel Coinbase CDP
  const { generateJwt } = await import('@coinbase/cdp-sdk/auth');
  return generateJwt({
    apiKeyId: apiKey,
    apiKeySecret: secret,
    requestMethod: method.toUpperCase(),
    requestHost: 'api.coinbase.com',
    requestPath: path,
    expiresIn: 120,
  });
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
  // JWT must be signed with path only (no query string)
  const pathForJwt = fullPath.split('?')[0];
  const bodyStr = body ? JSON.stringify(body) : '';

  let headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (isCDPKey(apiKey)) {
    const jwt = await buildCDPJWT(apiKey, method, pathForJwt, apiSecret);
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
  hold: { value: string; currency: string };
}

export async function getCoinbaseBalance(): Promise<Record<string, number>> {
  const balances: Record<string, number> = {};
  let cursor: string | undefined;

  // Paginate through all accounts (max 250 per page)
  do {
    const path = cursor
      ? `/accounts?limit=250&cursor=${encodeURIComponent(cursor)}`
      : '/accounts?limit=250';

    const result = await coinbaseRequest<{
      accounts: CoinbaseAccount[];
      has_next: boolean;
      cursor: string;
    }>('GET', path);

    for (const account of result.accounts ?? []) {
      // available_balance = liquid, hold = staked/reserved — add both
      const available = parseFloat(account.available_balance?.value ?? '0');
      const held = parseFloat(account.hold?.value ?? '0');
      const total = available + held;
      if (total > 0.000000001) {
        balances[account.currency] = (balances[account.currency] ?? 0) + total;
      }
    }

    cursor = result.has_next ? result.cursor : undefined;
  } while (cursor);

  return balances;
}

function formatCoinbaseApiError(data: unknown): string {
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    const parts = [d.message ?? d.error, d.error_details]
      .filter(v => typeof v === 'string' && (v as string).length > 0) as string[];
    if (parts.length > 0) return parts.join(' — ');
  }
  if (typeof data === 'string' && data.length > 0) return data;
  return 'Unknown error';
}

// Incrément de quantité par produit (ex: UNI-EUR n'accepte pas 8 décimales).
// Lu sur /products/{id} (base_increment), cache 1h, défaut 6 décimales.
const _specCache = new Map<string, { inc: string; at: number }>();

export async function formatCoinbaseBaseSize(productId: string, amount: string): Promise<string> {
  let inc = '0.000001';
  try {
    const now = Date.now();
    const cached = _specCache.get(productId);
    if (cached && now - cached.at < PRODUCTS_TTL_MS) {
      inc = cached.inc;
    } else {
      const spec = await coinbaseRequest<{ base_increment?: string }>('GET', `/products/${productId}`);
      if (spec.base_increment) inc = spec.base_increment;
      _specCache.set(productId, { inc, at: now });
    }
  } catch { /* défaut */ }
  const frac = inc.includes('.') ? inc.split('.')[1].replace(/0+$/, '') : '';
  const decimals = frac.length;
  const factor = 10 ** decimals;
  const floored = Math.floor(parseFloat(amount) * factor) / factor;
  return floored.toFixed(decimals);
}

export async function placeCoinbaseOrder(
  productId: string,
  side: 'BUY' | 'SELL',
  quoteSize?: string,
  baseSize?: string
): Promise<{ order_id: string; product_id: string; status: string }> {
  const clientOrderId = `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Les tailles en crypto doivent respecter l'incrément du produit,
  // sinon Coinbase rejette avec "Too many decimals in order amount"
  if (side === 'SELL' && baseSize) {
    baseSize = await formatCoinbaseBaseSize(productId, baseSize);
    if (parseFloat(baseSize) <= 0) {
      throw new Error(`Coinbase order failed: montant trop petit après arrondi à l'incrément (${productId})`);
    }
  }

  const orderConfig = side === 'BUY'
    ? { market_market_ioc: { quote_size: quoteSize } }
    : { market_market_ioc: { base_size: baseSize } };

  let result: {
    success: boolean;
    order_id: string;
    success_response: { order_id: string; product_id: string; status: string };
    error_response?: { error: string; message: string };
  };
  try {
    result = await coinbaseRequest<{
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
  } catch (e) {
    // Axios rejette sur les HTTP 4xx/5xx : extraire le message Coinbase
    // (ex: "Invalid product_id") au lieu de "Request failed with status code 400"
    const responseData = (e as { response?: { data?: unknown } })?.response?.data;
    throw new Error(`Coinbase order failed: ${formatCoinbaseApiError(responseData)}`);
  }

  if (!result.success || result.error_response) {
    throw new Error(`Coinbase order failed: ${result.error_response?.message ?? 'Unknown error'}`);
  }

  return result.success_response;
}

// Cache des produits réellement tradables sur le compte (la dispo varie
// selon région/compte : ex. NEAR-EUR peut répondre "Invalid product_id").
// TTL 1h, fail-open : si la liste est inaccessible, on tente quand même l'ordre.
let _productsCache: { ids: Set<string>; fetchedAt: number } | null = null;
const PRODUCTS_TTL_MS = 60 * 60 * 1000;

export async function getCoinbaseProductIds(): Promise<Set<string>> {
  if (_productsCache && Date.now() - _productsCache.fetchedAt < PRODUCTS_TTL_MS) {
    return _productsCache.ids;
  }
  const ids = new Set<string>();
  const limit = 250;
  let offset = 0;
  for (;;) {
    const result = await coinbaseRequest<{
      products: Array<{ product_id: string; status?: string }>;
    }>('GET', `/products?limit=${limit}&offset=${offset}`);
    const products = result.products ?? [];
    for (const p of products) {
      // N'exclure que les statuts explicitement non-tradables au marché
      if (p.status && ['offline', 'delist', 'cancel_only'].includes(p.status)) continue;
      ids.add(p.product_id);
    }
    if (products.length < limit) break;
    offset += limit;
  }
  _productsCache = { ids, fetchedAt: Date.now() };
  return ids;
}

export async function isCoinbaseProductTradable(productId: string): Promise<boolean> {
  try {
    return (await getCoinbaseProductIds()).has(productId);
  } catch {
    return true; // fail-open : vérification impossible -> on tente l'ordre
  }
}

// Parmi les symboles gérés par le bot, lesquels ne sont PAS tradables sur
// Coinbase (mapping absent OU produit non listé sur le compte) ?
export async function getSymbolsUntradableOnCoinbase(symbols: string[]): Promise<string[]> {
  let tradable: Set<string> | null = null;
  try {
    tradable = await getCoinbaseProductIds();
  } catch {
    return symbols.filter(s => !SYMBOL_TO_COINBASE_PRODUCT[s]); // repli : mapping seul
  }
  return symbols.filter(s => {
    const productId = SYMBOL_TO_COINBASE_PRODUCT[s];
    return !productId || !tradable!.has(productId);
  });
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
  CRV: 'CRV-EUR',
  MKR: 'MKR-EUR',
};
