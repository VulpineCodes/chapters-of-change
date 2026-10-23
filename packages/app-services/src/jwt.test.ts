import { describe, it, expect } from 'vitest';
// Imports the API app's canonical JWT module (see vitest.config.ts alias) —
// the exact code the NestJS guard/service ship, not a copy.
import {
  JwtError,
  SEEDED_SYNTHETIC_USER,
  extractBearerToken,
  issueTokenForSeededUser,
  signJwt,
  verifyJwt,
} from '@api-auth-jwt';

const SECRET = 'test-secret-for-vitest-only';
const NOW = 1_700_000_000; // fixed clock for deterministic tests

function tamperPayload(token: string, mutate: (payload: Record<string, unknown>) => void): string {
  const [header, payload, signature] = token.split('.') as [string, string, string];
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  mutate(decoded);
  const reEncoded = Buffer.from(JSON.stringify(decoded)).toString('base64url');
  return `${header}.${reEncoded}.${signature}`;
}

describe('JWT (HS256, node:crypto only)', () => {
  it('signs and verifies a round-trip token with claims intact', () => {
    const token = signJwt(
      { sub: 'user-1', role: 'ORG_ADMIN', organizationId: 'org-1', email: 'a@example.com' },
      SECRET,
      { nowSeconds: NOW, expiresInSeconds: 600 },
    );
    const claims = verifyJwt(token, SECRET, { nowSeconds: NOW + 60 });
    expect(claims.sub).toBe('user-1');
    expect(claims.role).toBe('ORG_ADMIN');
    expect(claims.organizationId).toBe('org-1');
    expect(claims.iat).toBe(NOW);
    expect(claims.exp).toBe(NOW + 600);
  });

  it('issues a verifiable token for the seeded synthetic user', () => {
    const token = issueTokenForSeededUser(SECRET, { nowSeconds: NOW });
    const claims = verifyJwt(token, SECRET, { nowSeconds: NOW });
    expect(claims.sub).toBe(SEEDED_SYNTHETIC_USER.sub);
    expect(claims.email).toBe('donor@example.com');
    expect(claims.role).toBe('DONOR');
  });

  it('rejects an expired token', () => {
    const token = signJwt({ sub: 'user-1', role: 'DONOR' }, SECRET, { nowSeconds: NOW, expiresInSeconds: 60 });
    expect(() => verifyJwt(token, SECRET, { nowSeconds: NOW + 61 })).toThrowError(
      expect.objectContaining({ code: 'TOKEN_EXPIRED' }),
    );
    // Still valid exactly at the boundary and within clock tolerance.
    expect(verifyJwt(token, SECRET, { nowSeconds: NOW + 60 }).sub).toBe('user-1');
    expect(verifyJwt(token, SECRET, { nowSeconds: NOW + 65, clockToleranceSeconds: 10 }).sub).toBe('user-1');
  });

  it('rejects a token whose payload was modified (privilege escalation attempt)', () => {
    const token = signJwt({ sub: 'user-1', role: 'DONOR' }, SECRET, { nowSeconds: NOW });
    const forged = tamperPayload(token, (p) => {
      p.role = 'ADMIN';
    });
    expect(() => verifyJwt(forged, SECRET, { nowSeconds: NOW })).toThrowError(
      expect.objectContaining({ code: 'TOKEN_SIGNATURE_INVALID' }),
    );
  });

  it('rejects a token verified with the wrong secret', () => {
    const token = signJwt({ sub: 'user-1', role: 'DONOR' }, SECRET, { nowSeconds: NOW });
    expect(() => verifyJwt(token, 'a-different-secret', { nowSeconds: NOW })).toThrowError(
      expect.objectContaining({ code: 'TOKEN_SIGNATURE_INVALID' }),
    );
  });

  it('rejects alg=none and other non-HS256 tokens before signature checks', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: 'attacker', role: 'ADMIN', iat: NOW, exp: NOW + 3600 }),
    ).toString('base64url');
    expect(() => verifyJwt(`${header}.${payload}.`, SECRET, { nowSeconds: NOW })).toThrowError(
      expect.objectContaining({ code: 'TOKEN_ALG_REJECTED' }),
    );
  });

  it('rejects malformed tokens and tokens without exp', () => {
    expect(() => verifyJwt('not-a-jwt', SECRET)).toThrowError(expect.objectContaining({ code: 'TOKEN_MALFORMED' }));
    expect(() => verifyJwt('a.b', SECRET)).toThrowError(JwtError);
    const noExp = tamperPayload(signJwt({ sub: 'u', role: 'DONOR' }, SECRET, { nowSeconds: NOW }), (p) => {
      delete p.exp;
    });
    // (Signature no longer matches either — malformed/expiry family either way, must throw.)
    expect(() => verifyJwt(noExp, SECRET, { nowSeconds: NOW })).toThrowError(JwtError);
  });

  it('extracts Bearer tokens and ignores other schemes', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(extractBearerToken('bearer abc')).toBe('abc');
    expect(extractBearerToken('Basic abc')).toBeNull();
    expect(extractBearerToken(undefined)).toBeNull();
  });
});
