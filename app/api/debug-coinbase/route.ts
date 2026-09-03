import { NextResponse } from 'next/server';
import axios from 'axios';

// Temporary debug route — remove after fixing Coinbase auth
export async function GET() {
  const apiKey = process.env.COINBASE_API_KEY ?? '';
  const apiSecret = process.env.COINBASE_API_SECRET ?? '';

  const info: Record<string, unknown> = {
    key_present: !!apiKey,
    secret_present: !!apiSecret,
    key_format: apiKey.startsWith('organizations/') ? 'CDP (organizations/...)' : 'Legacy HMAC',
    key_preview: apiKey ? `${apiKey.slice(0, 40)}...` : 'MISSING',
    secret_length: apiSecret.length,
    secret_preview: apiSecret ? `${apiSecret.slice(0, 20)}...` : 'MISSING',
  };

  if (!apiKey || !apiSecret) {
    return NextResponse.json({ error: 'Keys missing', info });
  }

  try {
    const { generateJwt } = await import('@coinbase/cdp-sdk/auth');

    const fullPath = '/api/v3/brokerage/accounts';
    const jwt = await generateJwt({
      apiKeyId: apiKey,
      apiKeySecret: apiSecret,
      requestMethod: 'GET',
      requestHost: 'api.coinbase.com',
      requestPath: fullPath,
      expiresIn: 120,
    });

    info.jwt_generated = true;
    info.jwt_preview = `${jwt.slice(0, 60)}...`;

    const response = await axios.get(`https://api.coinbase.com${fullPath}`, {
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
    const e = err as { response?: { status: number; data: unknown }; message: string };
    return NextResponse.json({
      success: false,
      info,
      error: e.message,
      http_status: e.response?.status,
      coinbase_response: e.response?.data,
    });
  }
}
