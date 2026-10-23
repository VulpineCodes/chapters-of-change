import { Injectable, UnauthorizedException } from '@nestjs/common';
import {
  issueTokenForSeededUser,
  signJwt,
  verifyJwt,
  type JwtClaims,
  type VerifiedJwt,
} from './jwt';

/**
 * NestJS adapter over the pure JWT module in `./jwt.ts`. All cryptography
 * lives there (Node `node:crypto` only); this service only resolves the
 * secret from the environment and translates failures to HTTP exceptions.
 */
/** Resolves the JWT secret from the environment (single source of truth). */
export function resolveJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET must be set in production');
    }
    // Local development only — never used when JWT_SECRET is configured.
    return 'dev-only-secret-change-me';
  }
  return secret;
}

@Injectable()
export class JwtService {
  private get secret(): string {
    return resolveJwtSecret();
  }

  /** Issues a token for arbitrary verified claims (e.g. after login). */
  issue(claims: JwtClaims, expiresInSeconds = 3600): string {
    return signJwt(claims, this.secret, { expiresInSeconds });
  }

  /** Demo/dev helper: issues a token for the seeded synthetic user. */
  issueForSeededUser(): { accessToken: string; tokenType: 'Bearer' } {
    return { accessToken: issueTokenForSeededUser(this.secret), tokenType: 'Bearer' };
  }

  /** Verifies a token, throwing 401 on any failure (expired, tampered, …). */
  verify(token: string): VerifiedJwt {
    try {
      return verifyJwt(token, this.secret);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
