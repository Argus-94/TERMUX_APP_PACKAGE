import { useCallback, useEffect, useRef, useState } from "react";
import { getManusAvailableCredits } from "../lib/manus-api";
import { parseManusCredits, type ManusCredits } from "../lib/manus-credits";

type Failure = "denied" | "rateLimited" | "invalid" | "timeout" | "network";
type Snapshot = { binding: string; credits?: ManusCredits; updatedAt?: number; loading: boolean; failure?: Failure };
const COPY = {
  ru: { denied: "API не разрешает просмотр баланса (401/403). Проверка аккаунта не гарантирует доступ к этому разделу.", rateLimited: "Лимит запросов API. Попробуйте обновить баланс позже.", invalid: "API вернул некорректные данные баланса. Остаток и начисления не подтверждены.", timeout: "Время ожидания баланса истекло. Попробуйте обновить позже.", network: "Не удалось загрузить баланс. Проверьте сеть и повторите обновление." },
  uk: { denied: "API не дозволяє перегляд балансу (401/403). Перевірка акаунта не гарантує доступ до цього розділу.", rateLimited: "Ліміт запитів API. Спробуйте оновити баланс пізніше.", invalid: "API повернув некоректні дані балансу. Залишок і нарахування не підтверджені.", timeout: "Час очікування балансу вичерпано. Спробуйте оновити пізніше.", network: "Не вдалося завантажити баланс. Перевірте мережу та повторіть оновлення." },
  en: { denied: "The API denied balance access (401/403). Account verification does not guarantee access to this endpoint.", rateLimited: "API rate limit reached. Try refreshing the balance later.", invalid: "The API returned invalid balance data. Balance and refresh information are unconfirmed.", timeout: "The balance request timed out. Try refreshing later.", network: "Could not load the balance. Check your connection and refresh again." },
};
function classify(error: unknown): Failure {
  const message = error instanceof Error ? error.message : "";
  if (/^MANUS_(UNAUTHORIZED|FORBIDDEN):/.test(message)) return "denied";
  if (message.startsWith("MANUS_RATE_LIMITED:")) return "rateLimited";
  if (message.startsWith("MANUS_INVALID_RESPONSE:")) return "invalid";
  if (message.startsWith("MANUS_TIMEOUT:")) return "timeout";
  return "network";
}

/** In-memory only; verification belongs to the saved credential binding, never to a draft. */
export function useManusCredits(enabled: boolean, binding: string, language: "ru" | "uk" | "en") {
  const [snapshot, setSnapshot] = useState<Snapshot>({ binding: "", loading: false });
  const active = useRef<{ binding: string; controller: AbortController } | null>(null);
  const refresh = useCallback(async () => {
    if (!enabled || !binding || active.current) return;
    const controller = new AbortController();
    const token = { binding, controller };
    active.current = token;
    setSnapshot(previous => ({ ...(previous.binding === binding ? previous : {}), binding, loading: true, failure: undefined }));
    try {
      const credits = parseManusCredits(await getManusAvailableCredits(controller.signal));
      if (active.current === token && !controller.signal.aborted) setSnapshot({ binding, credits, updatedAt: Date.now(), loading: false });
    } catch (error) {
      if (active.current === token && !controller.signal.aborted) setSnapshot(previous => ({ ...previous, binding, loading: false, failure: classify(error) }));
    } finally { if (active.current === token) active.current = null; }
  }, [enabled, binding]);
  useEffect(() => {
    setSnapshot({ binding, loading: false });
    if (enabled) void refresh();
    return () => {
      const pending = active.current;
      active.current = null;
      pending?.controller.abort();
    };
  }, [enabled, binding, refresh]);
  const visible: Snapshot = enabled && snapshot.binding === binding ? snapshot : { binding, loading: false };
  return { credits: visible.credits, updatedAt: visible.updatedAt, loading: visible.loading, error: visible.failure ? COPY[language][visible.failure] : "", refresh };
}
