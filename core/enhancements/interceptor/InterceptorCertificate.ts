import type { InterceptorCertificateAdapter, InterceptorTimeline } from "./types";

export type CertificateStatus = Readonly<{ state: "unavailable" | "missing" | "not-trusted" | "trusted" | "unknown"; subject?: string; fingerprint?: string; message: string }>;

/** Certificate actions are explicit; an absent secure host adapter never fabricates a CA or trust result. */
export class InterceptorCertificate {
  constructor(private readonly adapter?: InterceptorCertificateAdapter, private readonly record?: InterceptorTimeline) {}

  async createAfterUserConfirmation(confirmed: boolean): Promise<CertificateStatus> {
    if (!confirmed) { await this.audit("certificate-create", "denied", "USER_CONFIRMATION_REQUIRED"); throw new Error("USER_CONFIRMATION_REQUIRED"); }
    if (!this.adapter) { await this.audit("certificate-create", "failed", "CERTIFICATE_ADAPTER_UNAVAILABLE"); return { state: "unavailable", message: "Защищённый механизм создания CA-сертификата недоступен. Сертификат не создан." }; }
    try {
      const created = await this.adapter.generateAndStore();
      if (!created.fingerprint || created.fingerprint.length > 256 || !created.subject || created.subject.length > 256) throw new Error("CERTIFICATE_RESULT_INVALID");
      await this.audit("certificate-create", "allowed");
      const trust = await this.adapter.checkTrust();
      return { state: trust === "trusted" ? "trusted" : trust === "not-trusted" ? "not-trusted" : "unknown", subject: created.subject, fingerprint: created.fingerprint, message: trust === "trusted" ? "Сертификат создан и проверен." : "Сертификат создан. Доверие Android не подтверждено; экспортируйте публичный CA, установите его вручную и проверьте целевой клиент." };
    } catch {
      await this.audit("certificate-create", "failed", "CERTIFICATE_OPERATION_FAILED");
      return { state: "unavailable", message: "Не удалось создать CA-сертификат; перехват HTTPS останется недоступен." };
    }
  }

  async checkInstallation(): Promise<CertificateStatus> {
    if (!this.adapter) return { state: "unavailable", message: "В этой сборке нет проверенного bridge для проверки системного доверия." };
    try {
      const state = await this.adapter.checkTrust();
      await this.audit("certificate-check", "allowed");
      return { state, message: state === "trusted" ? "Система сообщает, что сертификат доверенный." : state === "not-trusted" ? "Сертификат не найден среди доверенных." : "Android не предоставляет этому приложению надёжную проверку наличия пользовательского CA. Проверьте установку в настройках и тестовом клиенте." };
    } catch { return { state: "unknown", message: "Проверка установки не удалась." }; }
  }

  async exportPublicCertificate(): Promise<Readonly<{ pem: string; fingerprint: string; subject: string }>> {
    if (!this.adapter) throw new Error("CERTIFICATE_ADAPTER_UNAVAILABLE");
    const result = await this.adapter.exportPublicCertificate();
    if (typeof result.pem !== "string" || !result.pem.startsWith("-----BEGIN CERTIFICATE-----") || result.pem.length > 16_384 || !result.fingerprint || result.fingerprint.length > 256 || !result.subject || result.subject.length > 256) throw new Error("CERTIFICATE_EXPORT_INVALID");
    await this.audit("certificate-export", "allowed");
    return result;
  }

  async removeAfterUserConfirmation(confirmed: boolean): Promise<boolean> {
    if (!confirmed) { await this.audit("certificate-remove", "denied", "USER_CONFIRMATION_REQUIRED"); return false; }
    if (!this.adapter) { await this.audit("certificate-remove", "failed", "CERTIFICATE_ADAPTER_UNAVAILABLE"); return false; }
    try { await this.adapter.remove(); await this.audit("certificate-remove", "allowed"); return true; }
    catch { await this.audit("certificate-remove", "failed", "CERTIFICATE_OPERATION_FAILED"); return false; }
  }

  installationInstructions(): readonly string[] {
    return [
      "CA-сертификат нужен только для просмотра HTTPS. Без него доступны лишь метаданные/HTTP — содержимое HTTPS останется зашифрованным.",
      "Создавайте сертификат только через проверенный защищённый системный адаптер и только если понимаете последствия.",
      "Android: откройте Настройки → Безопасность → Шифрование и учётные данные → Установить сертификат → Сертификат CA.",
      "Экспортируйте только публичный .cer/.pem и выберите его в системном экране установки. Приложение не может надёжно проверить пользовательское хранилище CA — проверьте целевой клиент отдельно.",
      "Удаление в приложении отключает его локальный signing key, но не удаляет ранее установленный системный CA. Удалите сертификат отдельно в настройках Android.",
      "Приложения с certificate pinning могут не работать через MITM. Не отключайте pinning и не перехватывайте чужой или служебный трафик.",
    ];
  }

  private async audit(operation: string, outcome: "allowed" | "denied" | "failed", reason?: string): Promise<void> {
    try { await this.record?.({ operation, outcome, source: "user", ...(reason ? { reason } : {}) }); } catch { /* best-effort audit */ }
  }
}
