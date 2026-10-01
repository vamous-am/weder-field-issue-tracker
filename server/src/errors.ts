import type { Request, Response, NextFunction } from 'express';

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNPROCESSABLE'
  | 'INTERNAL';

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: string[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (message: string, details?: string[]): ApiError =>
  new ApiError(400, 'BAD_REQUEST', message, details);

export const forbidden = (message: string): ApiError =>
  new ApiError(403, 'FORBIDDEN', message);

export const notFound = (message: string): ApiError =>
  new ApiError(404, 'NOT_FOUND', message);

export const conflict = (message: string): ApiError =>
  new ApiError(409, 'CONFLICT', message);

export const unprocessable = (message: string, details?: string[]): ApiError =>
  new ApiError(422, 'UNPROCESSABLE', message, details);

/** Serialises any ApiError to the standard response shape. */
function toBody(err: ApiError) {
  const body: { error: { code: ErrorCode; message: string; details?: string[] } } = {
    error: { code: err.code, message: err.message },
  };
  if (err.details && err.details.length > 0) body.error.details = err.details;
  return body;
}

/**
 * Converts express.json() parse errors into our shape before they reach
 * the route handlers. Must be registered right after express.json().
 */
export function bodyParserErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (
    err !== null &&
    typeof err === 'object' &&
    'type' in err &&
    (err as { type: string }).type === 'entity.parse.failed'
  ) {
    res.status(400).json(toBody(badRequest('Request body is not valid JSON')));
    return;
  }
  next(err);
}

/** Catches ApiError instances thrown by route handlers. */
export function apiErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (err instanceof ApiError) {
    res.status(err.statusCode).json(toBody(err));
    return;
  }
  next(err);
}

/** Final catch-all: returns 500 without leaking stack traces. */
export function internalErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  console.error(err); // log server-side only
  res.status(500).json(toBody(new ApiError(500, 'INTERNAL', 'An unexpected error occurred')));
}

/** 404 handler for unknown routes — must be registered after all routes. */
export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json(toBody(notFound('Route not found')));
}
