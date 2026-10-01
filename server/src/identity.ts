import type { Request, Response, NextFunction } from 'express';
import { ROLES } from '@shared/types';
import type { Role } from '@shared/types';
import { badRequest, forbidden } from './errors.js';

export interface Identity {
  role: Role;
  userId: string;
}

// Extend Express Request with identity, populated by requireIdentity.
declare global {
  namespace Express {
    interface Request {
      identity: Identity;
    }
  }
}

/**
 * Reads X-Simulated-Role and X-Simulated-User from every request.
 * Missing or unrecognised values → 400 (malformed request, §Q2).
 */
export function requireIdentity(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const role = req.headers['x-simulated-role'];
  const userId = req.headers['x-simulated-user'];

  if (typeof role !== 'string' || !ROLES.includes(role as Role)) {
    return next(
      badRequest(
        'X-Simulated-Role header is required and must be one of: ' +
          ROLES.join(', '),
      ),
    );
  }
  if (typeof userId !== 'string' || userId.trim() === '') {
    return next(badRequest('X-Simulated-User header is required'));
  }

  req.identity = { role: role as Role, userId: userId.trim() };
  next();
}

/**
 * Guards a route to a single role. Must be used after requireIdentity.
 * Wrong role → 403 (well-formed identity, not permitted, §Q2).
 */
export function requireRole(role: Role) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.identity.role !== role) {
      return next(
        forbidden(`This action requires the ${role} role`),
      );
    }
    next();
  };
}
