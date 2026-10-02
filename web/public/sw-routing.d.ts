export type RouteOutcome = 'navigation' | 'asset' | 'bypass';

export interface RequestShape {
  method: string;
  url: string;
  mode: string;
}

export function classifyRequest(
  req: RequestShape,
  origin: string,
  precacheSet: ReadonlySet<string>,
): RouteOutcome;
