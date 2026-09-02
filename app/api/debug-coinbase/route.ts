import { NextResponse } from 'next/server';
import crypto from 'crypto';
import axios from 'axios';

// Temporary debug route — remove after fixing Coinbase auth
export async function GET() {
  const apiKey = process.env.COINBASE_API_KEY ?? '';
  const apiSecret = process.env.COINBASE_API_SECRET ?? '';

  const info: Record<string, unknown> = {
    key_present: !!apiKey,
    secret_present: !!apiSecret,
    key_format: apiKey.startsWith('organizations/') ? 'CDP (organizations/...)' : 'Legacy HMAC',
    key_preview: apiKey ? `${apiKey.slice(0, 30)}...` : 'MISSING',
    secret_length: apiSecret.length,
    secret_starts_with: apiSecret.slice(0, 30),
    secret_contains_newline_literal: apiSecret.includes('\\n'),
    secret_contains_real_newline: apiSecret.includes('\n'),
  };

  if (!apiKey || !apiSecret) {
    return NextResponse.json({ error: 'Keys missing', info });
  }

  // Try to build and call with JWT
  try {
    const fullPath = '/api/v3/brokerage/accounts';
    const method = 'GET';
    const uri = `${method} api.coinbase.com${fullPath}`;
    const now = Math.floor(Date.now() / 1000);

    const header = Buffer.from(JSON.stringify({
      alg: 'ES256',
      kid: apiKey,
      nonce: crypto.randomBytes(16).toString('hex'),
    })).toString('base64url');

    const payload = Buffer.from(JSON.stringify({
      sub: apiKey,
      iss: 'cdp',
      nbf: now,
      exp: now + 120,
      uri,
    })).toString('base64url');

    const signingInput = `${header}.${payload}`;

    // Normalize — raw base64 or PEM
    let pemKey: crypto.KeyObject | null = null;
    const normalised = apiSecret.replace(/\\n/g, '\n').trim();
    const der = normalised.includes('-----BEGIN') ? null : Buffer.from(normalised, 'base64');

    info.raw_key_bytes = der?.length ?? 'N/A (PEM)';
    info.der_hex_preview = der ? der.slice(0, 10).toString('hex') : 'N/A';

    const attempts: string[] = [];

    if (normalised.includes('-----BEGIN')) {
      try { pemKey = crypto.createPrivateKey(normalised); attempts.push('PEM direct: OK'); } catch (e) { attempts.push(`PEM direct: ${e}`); }
    } else if (der) {
      try { pemKey = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }); attempts.push('DER pkcs8: OK'); } catch (e) { attempts.push(`DER pkcs8: ${e}`); }
      if (!pemKey) {
        try { pemKey = crypto.createPrivateKey({ key: der, format: 'der', type: 'sec1' }); attempts.push('DER sec1: OK'); } catch (e) { attempts.push(`DER sec1: ${e}`); }
      }
      if (!pemKey) {
        try {
          const jwk = { kty: 'EC', crv: 'P-256', d: der.toString('base64url'), x: Buffer.alloc(32).toString('base64url'), y: Buffer.alloc(32).toString('base64url') };
          pemKey = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
          attempts.push('JWK d=full: OK');
        } catch (e) { attempts.push(`JWK d=full: ${e}`); }
      }
      if (!pemKey && der.length > 32) {
        try {
          const scalar = der.slice(der.length - 32);
          const jwk = { kty: 'EC', crv: 'P-256', d: scalar.toString('base64url'), x: Buffer.alloc(32).toString('base64url'), y: Buffer.alloc(32).toString('base64url') };
          pemKey = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
          attempts.push('JWK d=last32: OK');
        } catch (e) { attempts.push(`JWK d=last32: ${e}`); }
      }
    }

    info.key_load_attempts = attempts;
    if (!pemKey) throw new Error('Could not load private key — see key_load_attempts');

    const sign = crypto.createSign('SHA256');
    sign.update(signingInput);
    const signature = sign.sign(pemKey, 'base64url');

    const jwt = `${signingInput}.${signature}`;
    info.jwt_length = jwt.length;
    info.jwt_preview = `${jwt.slice(0, 50)}...`;

    // Make the actual call
    const response = await axios.get('https://api.coinbase.com/api/v3/brokerage/accounts', {
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    return NextResponse.json({
      success: true,
      info,
      status: response.status,
      accounts_count: response.data?.accounts?.length ?? 0,
      first_account: response.data?.accounts?.[0] ?? null,
    });

  } catch (err: unknown) {
    const axiosErr = err as { response?: { status: number; data: unknown }; message: string };
    return NextResponse.json({
      success: false,
      info,
      error: axiosErr.message,
      http_status: axiosErr.response?.status,
      coinbase_response: axiosErr.response?.data,
    });
  }
}
