import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import type { ManusCredits } from '../lib/manus-credits';
import type { AppColors } from '../theme/colors';

type Props = {
  credits?: ManusCredits;
  loading: boolean;
  error: string;
  updatedAt?: number;
  onRefresh: () => void;
  language: 'ru' | 'uk' | 'en';
  colors: AppColors;
};

const copy = {
  ru: {
    title: 'Кредиты Manus', available: 'Доступно', credits: 'кредитов', exhausted: 'Баланс исчерпан или неположительный.',
    free: 'Бесплатные', periodic: 'Остаток подписки', addon: 'Покупные', event: 'Событийные', refresh: 'Обновляемые',
    monthly: 'Месячная квота подписки', maxRefresh: 'Квота обновления (макс.)', refreshAt: 'Следующее обновление',
    noRefresh: 'API не сообщает предстоящее пополнение.', noSchedule: 'API не предоставил расписание.', expired: 'Дата обновления прошла — обновите баланс.',
    cadenceMissing: 'API не предоставил подтверждённое расписание.', periodEnd: 'Конец периода подписки (не дата начисления)', ended: 'Период подписки завершился (не дата начисления)',
    info: 'Это кредиты, не токены. API может показывать общий пул команды. Остаток на момент загрузки; после задач обновите вручную.',
    stale: 'Последние данные; не подтверждены', updated: 'Последняя успешная загрузка', refreshButton: 'Обновить', loading: 'Загрузка…',
    in: 'через', days: 'дн', hours: 'ч', minutes: 'мин',
  },
  uk: {
    title: 'Кредити Manus', available: 'Доступно', credits: 'кредитів', exhausted: 'Баланс вичерпано або він непозитивний.',
    free: 'Безкоштовні', periodic: 'Залишок підписки', addon: 'Придбані', event: 'Подієві', refresh: 'Для оновлення',
    monthly: 'Місячна квота підписки', maxRefresh: 'Квота оновлення (макс.)', refreshAt: 'Наступне оновлення',
    noRefresh: 'API не повідомляє про майбутнє поповнення.', noSchedule: 'API не надав розклад.', expired: 'Дата оновлення минула — оновіть баланс.',
    cadenceMissing: 'API не надав підтвердженого розкладу.', periodEnd: 'Кінець періоду підписки (не дата нарахування)', ended: 'Період підписки завершився (не дата нарахування)',
    info: 'Це кредити, не токени. API може показувати спільний пул команди. Залишок на час завантаження; після завдань оновіть вручну.',
    stale: 'Останні дані; не підтверджені', updated: 'Останнє успішне завантаження', refreshButton: 'Оновити', loading: 'Завантаження…',
    in: 'через', days: 'дн', hours: 'год', minutes: 'хв',
  },
  en: {
    title: 'Manus credits', available: 'Available', credits: 'credits', exhausted: 'Balance is exhausted or non-positive.',
    free: 'Free', periodic: 'Subscription remainder', addon: 'Purchased', event: 'Event', refresh: 'Refresh',
    monthly: 'Monthly subscription quota', maxRefresh: 'Maximum refresh quota', refreshAt: 'Next refresh',
    noRefresh: 'The API reports no upcoming refresh.', noSchedule: 'The API did not provide a schedule.', expired: 'Refresh date has passed — refresh the balance.',
    cadenceMissing: 'The API did not provide a confirmed schedule.', periodEnd: 'Subscription period ends (not a credit grant date)', ended: 'Subscription period ended (not a credit grant date)',
    info: 'These are credits, not tokens. The API may report a shared team pool. Balance is a snapshot; refresh manually after tasks.',
    stale: 'Latest data; not confirmed', updated: 'Last successful load', refreshButton: 'Refresh', loading: 'Loading…',
    in: 'in', days: 'd', hours: 'h', minutes: 'min',
  },
} as const;

function dateTime(timestamp: number, language: Props['language']): string {
  try {
    return new Intl.DateTimeFormat(language === 'ru' ? 'ru-RU' : language === 'uk' ? 'uk-UA' : 'en-US', {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toLocaleString();
  }
}

export function ManusCreditsPanel({ credits, loading, error, updatedAt, onRefresh, language, colors }: Props) {
  const t = copy[language];
  const stale = Boolean(credits && (loading || error));
  const [now, setNow] = useState(Date.now());
  const future = credits?.next_refresh_time !== undefined && credits.next_refresh_time * 1000 > Date.now() &&
    (credits.refresh_interval === 'daily' || credits.refresh_interval === 'weekly');

  useEffect(() => {
    setNow(Date.now());
    if (!future || stale) return;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [future, stale, credits?.next_refresh_time]);

  const text = (value: string, style: object = {}) => (
    <Text style={[{ color: colors.ink, fontSize: 13 }, style]}>{value}</Text>
  );
  const row = (label: string, value: number | undefined) => value === undefined ? null : (
    <View key={label} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 }}>
      {text(label, { color: colors.muted, flex: 1 })}{text(String(value), { fontWeight: '600' })}
    </View>
  );

  let refreshDetails: string | undefined;
  if (credits && !stale) {
    const ts = credits.next_refresh_time;
    if (ts === 0) refreshDetails = t.noRefresh;
    else if (ts === undefined) refreshDetails = t.noSchedule;
    else if (ts * 1000 <= Date.now()) refreshDetails = t.expired;
    else if (credits.refresh_interval !== 'daily' && credits.refresh_interval !== 'weekly') refreshDetails = t.cadenceMissing;
    else {
      const remaining = Math.max(0, ts * 1000 - now);
      const minutesTotal = Math.ceil(remaining / 60_000);
      const days = Math.floor(minutesTotal / 1440);
      const hours = Math.floor((minutesTotal % 1440) / 60);
      const minutes = minutesTotal % 60;
      refreshDetails = `${dateTime(ts * 1000, language)} · ${t.in} ${days} ${t.days} ${hours} ${t.hours} ${minutes} ${t.minutes}`;
    }
  }

  return (
    <View style={{ backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 12, padding: 12, gap: 7 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        {text(t.title, { color: colors.inkBright, fontSize: 15, fontWeight: '700' })}
        <TouchableOpacity onPress={onRefresh} disabled={loading} accessibilityRole="button" accessibilityLabel={t.refreshButton}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4, paddingHorizontal: 8, borderRadius: 8, backgroundColor: colors.accentDim, opacity: loading ? 0.6 : 1 }}>
          {loading ? <ActivityIndicator size="small" color={colors.accent} /> : null}
          {text(loading ? t.loading : t.refreshButton, { color: colors.accent, fontWeight: '600' })}
        </TouchableOpacity>
      </View>
      {credits ? <>
        {text(`${t.available}: ${credits.total_credits} ${t.credits}`, { fontSize: 16, fontWeight: '700', color: credits.total_credits <= 0 ? colors.warning : colors.inkBright })}
        {credits.total_credits <= 0 ? text(t.exhausted, { color: colors.warning }) : null}
        {row(t.free, credits.free_credits)}
        {row(t.periodic, credits.periodic_credits)}
        {row(t.addon, credits.addon_credits)}
        {row(t.event, credits.event_credits)}
        {row(t.refresh, credits.refresh_credits)}
        {row(t.monthly, credits.pro_monthly_credits)}
        {row(t.maxRefresh, credits.max_refresh_credits !== undefined && credits.max_refresh_credits > 0 ? credits.max_refresh_credits : undefined)}
        {!stale && refreshDetails ? <View style={{ paddingTop: 3 }}>{text(`${t.refreshAt}: ${refreshDetails}`, { color: colors.muted, fontSize: 12 })}</View> : null}
        {!stale && credits.current_period_end !== undefined && credits.current_period_end > 0 ? text(
          `${credits.current_period_end * 1000 <= Date.now() ? t.ended : t.periodEnd}: ${dateTime(credits.current_period_end * 1000, language)}`,
          { color: colors.muted, fontSize: 12 },
        ) : null}
      </> : null}
      {stale ? text(t.stale, { color: colors.warning, fontWeight: '600' }) : null}
      {error ? text(error, { color: colors.warning }) : null}
      {updatedAt !== undefined ? text(`${t.updated}: ${dateTime(updatedAt, language)}`, { color: colors.muted, fontSize: 12 }) : null}
      {text(t.info, { color: colors.muted, fontSize: 12 })}
    </View>
  );
}
