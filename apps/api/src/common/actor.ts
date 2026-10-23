import { UnauthorizedException } from '@nestjs/common';
import type { Actor } from '@chapters/domain';
import { authenticateRequest, type AuthUser } from '../auth/roles.guard';

/**
 * Extracts the authenticated actor for the workflow layer from the request.
 * The user comes exclusively from the verified JWT (see RolesGuard /
 * authenticateRequest) — never from headers or body fields a client could
 * forge. Throws 401 when no valid token was presented.
 */
export type ActorRequest = { headers?: Record<string, unknown>; user?: AuthUser };

export function actorFromRequest(req: ActorRequest): Actor {
  const user = authenticateRequest(req);
  if (!user) throw new UnauthorizedException('Authentication required');
  return { id: user.id, role: user.role, organizationId: user.organizationId };
}
