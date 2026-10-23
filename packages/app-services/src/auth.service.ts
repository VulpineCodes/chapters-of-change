/**
 * AuthService — JWT issuance on top of the user repository.
 *
 * Signing/verification primitives live in the API app's pure JWT module
 * (`apps/api/src/auth/jwt.ts`, Node `node:crypto` only, HS256). This service
 * is the testable application-layer seam: it turns a stored user record into
 * verified claims. Password verification (bcrypt against the stored
 * credential hash) lives in `credentials.ts` (`CredentialAuthService`),
 * which issues tokens through this same signing path after a login.
 */
// Relative import of the API app's canonical JWT module (single source of
// truth — do not copy it). The `.js` suffix is the emitted-file name; both
// the Vitest alias config and the package build resolve it to the same
// source file the NestJS guard/service ship.
import { SEEDED_SYNTHETIC_USER, signJwt } from '../../../apps/api/src/auth/jwt.js';
import type { Store } from './repositories.js';
import { NotFoundError } from './workflow.service.js';

export class AuthService {
  constructor(
    private readonly store: Store,
    private readonly secret: string,
  ) {}

  /** Issues a signed JWT whose claims come from the stored user record. */
  async issueForUser(userId: string, expiresInSeconds = 3600): Promise<string> {
    const user = await this.store.users.getById(userId);
    if (!user) throw new NotFoundError(`User ${userId}`);
    return signJwt(
      { sub: user.id, role: user.role, email: user.email, organizationId: user.organizationId },
      this.secret,
      { expiresInSeconds },
    );
  }

  /**
   * Issues a token for the seeded synthetic user: if the seed has run, the
   * token carries the seeded record's id/role; otherwise it falls back to
   * the shared synthetic claims constant used by the API dev-token endpoint.
   */
  async issueForSeededUser(expiresInSeconds = 3600): Promise<string> {
    const seeded = await this.store.users.getByEmail(SEEDED_SYNTHETIC_USER.email!);
    if (seeded) return this.issueForUser(seeded.id, expiresInSeconds);
    return signJwt(SEEDED_SYNTHETIC_USER, this.secret, { expiresInSeconds });
  }
}
