import { assertEquals } from 'jsr:@std/assert';
import { buildJwtParts, type SfEnv } from './sf.ts';

const env: SfEnv = {
  loginUrl: 'https://test.salesforce.com',
  clientId: 'CONSUMER_KEY',
  username: 'svc@example.com',
  privateKeyPkcs8Pem: '',
};

Deno.test('buildJwtParts encodes header+claim as two base64url segments', () => {
  const parts = buildJwtParts(env, 1_000_000);
  const [h, c] = parts.split('.');
  assertEquals(parts.split('.').length, 2);
  const header = JSON.parse(atob(h.replace(/-/g, '+').replace(/_/g, '/')));
  const claim = JSON.parse(atob(c.replace(/-/g, '+').replace(/_/g, '/')));
  assertEquals(header, { alg: 'RS256', typ: 'JWT' });
  assertEquals(claim.iss, 'CONSUMER_KEY');
  assertEquals(claim.sub, 'svc@example.com');
  assertEquals(claim.aud, 'https://test.salesforce.com');
  assertEquals(claim.exp, 1_000_000 + 180);
});
