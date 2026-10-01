import type { Role } from '@shared/types';

export interface Identity {
  user_id: string;
  role: Role;
}

const KEY = 'weder:identity';

const DEFAULTS: Identity = { user_id: 'worker-1', role: 'field_worker' };

export function getIdentity(): Identity {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Identity;
  } catch {
    // corrupt storage — fall through to default
  }
  return DEFAULTS;
}

export function setIdentity(identity: Identity): void {
  localStorage.setItem(KEY, JSON.stringify(identity));
}
