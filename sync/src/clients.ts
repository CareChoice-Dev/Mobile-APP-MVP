// Connection helpers for the integration user (Salesforce) and the service-role
// Supabase client. Both live ONLY here, server-side. Never shipped to the app.
import fs from 'node:fs';
import crypto from 'node:crypto';
import jsforce from 'jsforce';
import { createClient } from '@supabase/supabase-js';

export const env = {
  loginUrl: process.env.SF_LOGIN_URL ?? 'https://test.salesforce.com',
  clientId: process.env.SF_CLIENT_ID ?? '',
  username: process.env.SF_USERNAME ?? '',
  privateKeyPath: process.env.SF_PRIVATE_KEY_PATH ?? '',
  privateKey: process.env.SF_PRIVATE_KEY ?? '', // PEM contents (alt to *_PATH, for secret injection)
  password: process.env.SF_PASSWORD ?? '',
  resourceId: process.env.SF_RESOURCE_ID ?? 'a2sI80000000HFPIA2',
  supabaseUrl: process.env.SUPABASE_URL ?? '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  dryRun: process.env.DRY_RUN === '1',
};

// Connect as the integration user. Prefers JWT Bearer; falls back to
// username/password+token for a quick PoC.
export async function sfConnect(): Promise<jsforce.Connection> {
  if (env.clientId && (env.privateKey || env.privateKeyPath)) {
    const conn = new jsforce.Connection({ loginUrl: env.loginUrl });
    await conn.authorize({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: buildJwt(),
    } as any);
    return conn;
  }
  const conn = new jsforce.Connection({ loginUrl: env.loginUrl });
  await conn.login(env.username, env.password);
  return conn;
}

function buildJwt(): string {
  // Minimal JWT Bearer assertion. In production use a vetted JWT lib.
  const key = env.privateKey || fs.readFileSync(env.privateKeyPath, 'utf8');
  const header = b64({ alg: 'RS256', typ: 'JWT' });
  const claim = b64({
    iss: env.clientId,
    sub: env.username,
    aud: env.loginUrl,
    exp: Math.floor(Date.now() / 1000) + 180,
  });
  const sig = crypto
    .createSign('RSA-SHA256')
    .update(`${header}.${claim}`)
    .sign(key, 'base64url');
  return `${header}.${claim}.${sig}`;
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

export function supabaseAdmin() {
  return createClient(env.supabaseUrl, env.supabaseServiceKey, {
    auth: { persistSession: false },
  });
}
