export type ManusRefreshInterval = 'daily' | 'weekly' | '';

/** Credit snapshot as returned by the Manus API. total_credits is authoritative. */
export interface ManusCredits {
  total_credits: number;
  free_credits?: number;
  periodic_credits?: number;
  addon_credits?: number;
  pro_monthly_credits?: number;
  event_credits?: number;
  refresh_credits?: number;
  max_refresh_credits?: number;
  next_refresh_time?: number;
  refresh_interval?: ManusRefreshInterval;
  current_period_end?: number;
}

const CREDIT_FIELDS = [
  'total_credits',
  'free_credits',
  'periodic_credits',
  'addon_credits',
  'pro_monthly_credits',
  'event_credits',
  'refresh_credits',
  'max_refresh_credits',
] as const;
const TIMESTAMP_FIELDS = ['next_refresh_time', 'current_period_end'] as const;
const MAX_DATE_SECONDS = 8_640_000_000_000;

function invalid(reason: string): never {
  // Deliberately exclude payload values: API responses may contain sensitive data.
  throw new Error(`MANUS_INVALID_RESPONSE: ${reason}`);
}

/** Validate and extract the documented API envelope without altering signed balances. */
export function parseManusCredits(value: unknown): ManusCredits {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('expected envelope');
  const envelope = value as Record<string, unknown>;
  if (envelope.ok !== true) invalid('expected successful envelope');
  const data = envelope.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) invalid('expected data object');
  const source = data as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(source, 'total_credits')) invalid('missing total_credits');

  const result: ManusCredits = { total_credits: 0 };
  for (const field of CREDIT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) {
      if (field === 'total_credits') invalid('missing total_credits');
      continue;
    }
    const n = source[field];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < -2_147_483_648 || n > 2_147_483_647)
      invalid(`invalid ${field}`);
    result[field] = n;
  }
  for (const field of TIMESTAMP_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
    const n = source[field];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_DATE_SECONDS)
      invalid(`invalid ${field}`);
    result[field] = n;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'refresh_interval')) {
    const interval = source.refresh_interval;
    if (interval !== 'daily' && interval !== 'weekly' && interval !== '') invalid('invalid refresh_interval');
    result.refresh_interval = interval;
  }
  // Unknown response properties are ignored; only the documented contract is exposed.
  return result;
}

export type ManusCreditsRefreshState = 'scheduled' | 'none' | 'unavailable' | 'expired';

/** Classify scheduled refresh metadata; next_refresh_time is a Unix timestamp in seconds. */
export function creditsRefreshState(credits: ManusCredits, nowMs: number): ManusCreditsRefreshState {
  const timestamp = credits.next_refresh_time;
  if (timestamp === undefined) return 'unavailable';
  if (timestamp === 0) return 'none';
  if (timestamp * 1000 <= nowMs) return 'expired';
  if ((credits.refresh_interval === 'daily' || credits.refresh_interval === 'weekly') && timestamp * 1000 > nowMs)
    return 'scheduled';
  return 'unavailable';
}
