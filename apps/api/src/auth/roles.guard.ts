import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { extractBearerToken, verifyJwt } from './jwt';

// Domain RBAC is framework-agnostic; this guard is a thin adapter over it.
// The authenticated user is built exclusively from *verified* JWT claims —
// never from client-supplied headers or body fields.
export const ROLES_KEY = 'roles';
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

export interface AuthUser {
  id: string;
  role: 'DONOR' | 'ORG_ADMIN' | 'ORG_MEMBER' | 'ADMIN';
  organizationId?: string;
  email?: string;
}

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET must be set in production');
    }
    return 'dev-only-secret-change-me';
  }
  return secret;
}

/**
 * Populates `req.user` from a verified Bearer token, if one is present.
 * Returns the verified user, or null when no usable token was supplied.
 * An expired or tampered token is treated as "no user" here; route-level
 * role requirements below then reject with 401.
 */
export function authenticateRequest(req: { headers?: Record<string, unknown>; user?: AuthUser }): AuthUser | null {
  if (req.user) return req.user;
  const header = req.headers?.['authorization'];
  const token = extractBearerToken(typeof header === 'string' ? header : undefined);
  if (!token) return null;
  try {
    const claims = verifyJwt(token, jwtSecret());
    const user: AuthUser = {
      id: claims.sub,
      role: claims.role,
      organizationId: claims.organizationId,
      email: claims.email,
    };
    req.user = user;
    return user;
  } catch {
    return null;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}
  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!required?.length) return true;
    const req = ctx.switchToHttp().getRequest();
    const user: AuthUser | undefined = authenticateRequest(req) ?? undefined;
    if (!user) throw new UnauthorizedException('Authentication required');
    if (!required.includes(user.role)) throw new ForbiddenException('Insufficient role');
    return true;
  }
}

/** Ownership check helper — delegates to domain policy functions in services. */
export function assertCan(actor: { id: string; role: string }, allowed: boolean, msg = 'Forbidden') {
  if (!allowed) throw new ForbiddenException(msg);
}
