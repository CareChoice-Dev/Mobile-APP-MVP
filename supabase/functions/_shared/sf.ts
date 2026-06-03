// Deno Salesforce client (mirrors sync/src/clients.ts). JWT-bearer via Web Crypto,
// since jsforce can't run in Supabase Edge Functions.
export interface SfEnv {
  loginUrl: string;
  clientId: string;
  username: string;
  privateKeyPkcs8Pem: string;
}

export function readSfEnv(): SfEnv {
  return {
    loginUrl: Deno.env.get('SF_LOGIN_URL') ?? 'https://test.salesforce.com',
    clientId: Deno.env.get('SF_CLIENT_ID') ?? '',
    username: Deno.env.get('SF_USERNAME') ?? '',
    privateKeyPkcs8Pem: Deno.env.get('SF_PRIVATE_KEY') ?? '',
  };
}

const b64urlFromString = (s: string) =>
  btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlFromBytes = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Pure: the signing input `header.claim` (base64url), testable without crypto.
export function buildJwtParts(env: SfEnv, nowSec: number): string {
  const header = b64urlFromString(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64urlFromString(
    JSON.stringify({ iss: env.clientId, sub: env.username, aud: env.loginUrl, exp: nowSec + 180 }),
  );
  return `${header}.${claim}`;
}

function pkcs8PemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function signRs256(unsigned: string, pkcs8Pem: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'pkcs8', pkcs8PemToDer(pkcs8Pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  return b64urlFromBytes(sig);
}

export interface SfToken { access_token: string; instance_url: string; }

export async function sfToken(env: SfEnv, nowSec: number): Promise<SfToken> {
  const unsigned = buildJwtParts(env, nowSec);
  const assertion = `${unsigned}.${await signRs256(unsigned, env.privateKeyPkcs8Pem)}`;
  const res = await fetch(`${env.loginUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!res.ok) throw new Error(`SF token failed: ${res.status} ${await res.text()}`);
  return await res.json() as SfToken;
}

export async function sfQuery<T = Record<string, unknown>>(token: SfToken, soql: string): Promise<T[]> {
  const url = `${token.instance_url}/services/data/v64.0/query?q=${encodeURIComponent(soql)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token.access_token}` } });
  if (!res.ok) throw new Error(`SF query failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return body.records as T[];
}
