import { parseManusCredits } from './manus-credits';

const FIELDS = ['total_credits', 'free_credits', 'periodic_credits', 'addon_credits', 'pro_monthly_credits', 'event_credits', 'refresh_credits', 'max_refresh_credits', 'next_refresh_time', 'current_period_end', 'refresh_interval'] as const;
const REASONS = ['expected envelope', 'expected successful envelope', 'expected data object', 'missing total_credits', ...FIELDS.map(field => `invalid ${field}`)] as const;
function kind(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fieldType(value: unknown, field: string): string {
  return object(value) && Object.prototype.hasOwnProperty.call(value, field) ? kind(value[field]) : 'absent';
}
export type BalanceOutcome = 'accepted' | 'http_rejected' | 'json_failed' | 'transport_failed' | 'aborted' | 'validator_rejected';
/** Only fixed keys, fixed enum strings and HTTP status can leave this boundary. No payload copy. */
export function buildManusBalanceDiagnostic(status: number | null, json: 'not_attempted' | 'success' | 'failed', value: unknown, outcome: BalanceOutcome): string {
  const record: Record<string, string | number | boolean | null> = {
    operation: 'balance.availableCredits',
    http_status: status !== null && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    json_parse: json,
    outcome,
    validator: 'not_run',
  };
  if (json === 'success') {
    record.root_type = kind(value);
    record.root_object = object(value);
    record.ok_type = fieldType(value, 'ok');
    record.data_type = fieldType(value, 'data');
    const data = object(value) ? value.data : undefined;
    record.data_object = object(data);
    for (const field of FIELDS) record[`${field}_type`] = fieldType(data, field);
    try { parseManusCredits(value); record.validator = 'accepted'; }
    catch (error) {
      const message = error instanceof Error ? error.message : '';
      const reason = REASONS.find(item => message === `MANUS_INVALID_RESPONSE: ${item}`);
      record.validator = reason ? reason.replace(/ /g, '_') : 'unclassified';
      record.outcome = 'validator_rejected';
    }
  }
  return JSON.stringify(record);
}
