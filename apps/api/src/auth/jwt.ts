/**
 * Pure HS256 JSON Web Token issuance + verification.
 *
 * Implemented with Node's built-in `node:crypto` ONLY — no third-party JWT
 * library — so the security-critical logic is small, auditable, and unit
 * testable without NestJS or a database. This file has no framework imports:
 * the NestJS layer (`jwt.service.ts`, `roles.guard.ts`) is a thin adapter
 * over these functions, and the Vitest suite in `packages/app-services`
 * imports this exact module (single source of truth — do not copy it).
 *
 * Security properties enforced here:
 *  - `alg` is pinned to HS256; tokens advertising any other algorithm
 *    (including `none`) are rejected before signature verification.
 *  - Signatures are compared with `crypto.timingSafeEqual`.
 *  - `exp` is required on verification and checked against an injectable
 *    clock (deterministic tests, optional small clock tolerance).
 *  - Payload/signature tampering invalidates the HMAC and is rejected.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type JwtRole = 'DONOR' | 'ORG_ADMIN' | 'ORG_MEMBER' | 'ADMIN';

export interface JwtClaims {
  /** Subject — the user id. */
  sub: string;
  role: JwtRole;
  email?: string;
  organizationId?: string;
}

export interface VerifiedJwt extends JwtClaims {
  iat: number;
  exp: number;
}

export type JwtErrorCode =
  | 'TOKEN_MALFORMED'
  | 'TOKEN_ALG_REJECTED'
  | 'TOKEN_SIGNATURE_INVALID'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_MISSING_EXP';

export class JwtError extends Error {
  constructor(
    public readonly code: JwtErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'JwtError';
  }
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(segment: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) {
    throw new JwtError('TOKEN_MALFORMED', 'Token segment is not valid base64url');
  }
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(segment.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64');
}

function hmacSha256(signingInput: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(signingInput).digest();
}

export interface SignOptions {
  /** Lifetime in seconds. Defaults to 3600 (1 hour). */
  expiresInSeconds?: number;
  /** Issuance time (seconds since epoch). Injectable for deterministic tests. */
  nowSeconds?: number;
}

export function signJwt(claims: JwtClaims, secret: string, opts: SignOptions = {}): string {
  if (!secret) throw new JwtError('TOKEN_MALFORMED', 'JWT secret must not be empty');
  const iat = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const exp = iat + (opts.expiresInSeconds ?? 3600);
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64UrlEncode(JSON.stringify({ ...claims, iat, exp }));
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${base64UrlEncode(hmacSha256(signingInput, secret))}`;
}

export interface VerifyOptions {
  /** Current time (seconds since epoch). Injectable for deterministic tests. */
  nowSeconds?: number;
  /** Tolerated clock skew in seconds. Defaults to 0. */
  clockToleranceSeconds?: number;
}

export function verifyJwt(token: string, secret: string, opts: VerifyOptions = {}): VerifiedJwt {
  if (!secret) throw new JwtError('TOKEN_MALFORMED', 'JWT secret must not be empty');
  if (typeof token !== 'string') throw new JwtError('TOKEN_MALFORMED', 'Token must be a string');
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('TOKEN_MALFORMED', 'Token must have exactly three segments');

  const [headerSeg, payloadSeg, signatureSeg] = parts as [string, string, string];
  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(base64UrlDecode(headerSeg).toString('utf8'));
    payload = JSON.parse(base64UrlDecode(payloadSeg).toString('utf8'));
  } catch (err) {
    if (err instanceof JwtError) throw err;
    throw new JwtError('TOKEN_MALFORMED', 'Token header/payload is not valid JSON');
  }

  // Pin the algorithm BEFORE trusting anything else in the token.
  if (
    typeof header !== 'object' ||
    header === null ||
    (header as { alg?: unknown }).alg !== 'HS256'
  ) {
    throw new JwtError('TOKEN_ALG_REJECTED', 'Only HS256 tokens are accepted');
  }

  const expected = hmacSha256(`${headerSeg}.${payloadSeg}`, secret);
  const actual = base64UrlDecode(signatureSeg);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new JwtError('TOKEN_SIGNATURE_INVALID', 'Token signature verification failed');
  }

  if (typeof payload !== 'object' || payload === null) {
    throw new JwtError('TOKEN_MALFORMED', 'Token payload must be a JSON object');
  }
  const claims = payload as Record<string, unknown>;
  if (typeof claims.exp !== 'number') {
    throw new JwtError('TOKEN_MISSING_EXP', 'Token has no numeric exp claim');
  }
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.clockToleranceSeconds ?? 0;
  if (now > claims.exp + tolerance) {
    throw new JwtError('TOKEN_EXPIRED', 'Token has expired');
  }
  if (typeof claims.sub !== 'string' || typeof claims.role !== 'string') {
    throw new JwtError('TOKEN_MALFORMED', 'Token is missing sub/role claims');
  }
  return claims as unknown as VerifiedJwt;
}

/** Extracts the token from an `Authorization: Bearer <token>` header value. */
export function extractBearerToken(authorizationHeader: string | undefined | null): string | null {
  if (!authorizationHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  return match ? match[1]!.trim() : null;
}

/**
 * Seeded synthetic demo user (mirrors `prisma/seed.ts`). Fictional — used so
 * local development and tests can issue a real token without a database.
 */
export const SEEDED_SYNTHETIC_USER: JwtClaims = {
  sub: 'seed-donor-1',
  email: 'donor@example.com',
  role: 'DONOR',
};

/** Issues a signed token for the seeded synthetic user. */
export function issueTokenForSeededUser(secret: string, opts: SignOptions = {}): string {
  return signJwt(SEEDED_SYNTHETIC_USER, secret, opts);
}
