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
    let pemKey: string;
    const normalised = apiSecret.replace(/\\n/g, '\n').trim();

    if (normalised.includes('-----BEGIN')) {
      pemKey = normalised;
      info.pem_type = 'PEM envelope detected';
    } else {
      // Raw base64 → PKCS#8 PEM
      const rawKey = Buffer.from(normalised, 'base64');
      info.raw_key_bytes = rawKey.length;
      const pkcs8Prefix = Buffer.from(
        '304102010030130607' +
        '2a8648ce3d020106082a8648ce3d03010704270' +
        '4253023020101042' +
        '0',
        'hex'
      );
      const der = Buffer.concat([pkcs8Prefix, rawKey]);
      const b64 = der.toString('base64').match(/.{1,64}/g)!.join('\n');
      pemKey = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`;
      info.pem_type = 'Converted from raw base64 to PKCS#8 PEM';
    }

    info.pem_preview = `${pemKey.slice(0, 60)}...`;

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
