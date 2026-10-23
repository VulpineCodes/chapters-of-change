import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  AuthorizationError,
  ConflictError,
  InvalidCredentialsError,
  NotFoundError,
  ValidationError,
} from '@chapters/app-services';
import { IllegalTransitionError } from '@chapters/domain';

/**
 * Translates application-layer errors from `packages/app-services` (and the
 * domain state machine) into HTTP exceptions. Services in this API contain
 * no business rules of their own — every failure they surface originates in
 * the tested workflow layer and is only *presented* here.
 *
 *  - AuthorizationError   → 403 (authenticated, but not allowed: wrong
 *                           donor, wrong organization, wrong role for the
 *                           resource)
 *  - NotFoundError        → 404
 *  - ValidationError      → 400
 *  - IllegalTransitionError → 409 (state machine rejected the transition)
 *  - ConflictError        → 409 (e.g. duplicate registration)
 *  - InvalidCredentialsError → 401 (generic — never reveals which part failed)
 */
export function toHttpException(err: unknown): Error {
  if (err instanceof AuthorizationError) return new ForbiddenException(err.message);
  if (err instanceof NotFoundError) return new NotFoundException(err.message);
  if (err instanceof ValidationError) return new BadRequestException(err.message);
  if (err instanceof IllegalTransitionError) return new ConflictException(err.message);
  if (err instanceof ConflictError) return new ConflictException(err.message);
  if (err instanceof InvalidCredentialsError) return new UnauthorizedException(err.message);
  return err instanceof Error ? err : new Error(String(err));
}

/** Runs a workflow call, converting known application errors to HTTP ones. */
export async function workflowCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toHttpException(err);
  }
}
