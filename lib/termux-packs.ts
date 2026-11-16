import { errorMessage } from "./error-utils";
import { persistentLogger } from "./persistent-logger";
import {
  makeInstallerError,
  formatInstallerError,
  type InstallerError,
  TOOL_REGISTRY,
  ANDROID_SDK_POLICY,
  TOOL_OWNERSHIP,
} from "./tool-health";
/**
 * Пакеты инструментов, которые ставятся в Termux из экрана Настроек.
 *
 * Не всё из «идеального» списка есть в официальных репозиториях Termux
 * (IDA Free, Ghidra GUI, jadx-gui, MobSF и т.п. — десктоп/сервер). Для
 * сторонних Python/r2pm инструментов установка отключена до появления
 * отдельно проверяемых tool-pack артефактов с pinned SHA-256.
 */

export type PackLang = "uk" | "ru" | "en";

export type InstallStepKind = "pkg" | "pip" | "shell";

export interface InstallStep {
  /** Отображаемое имя в списке прогресса */
  label: string;
  kind: InstallStepKind;
  /** Основная команда / имя пакета */
  primary: string;
  /** Запасные варианты, если primary не установился */
  alternatives?: string[];
  /**
   * Чанковая загрузка файла с реальным KB/s (обходит блокирующий curl).
   * primary тогда = post-install shell после успешного скачивания в dest.
   */
  download?: {
    urls: string[];
    /** Private staging path in Termux, e.g. $AIB_PRIVATE_ROOT/tmp/cmdtools.zip; installed files still go under $PREFIX. */
    dest: string;
    /** Ожидаемый размер для % (байты), 0 = только скорость */
    expectBytes?: number;
    skipDownloadOnArm?: boolean;
    /** Не скачивать host-only архив на ARM/другой неподдерживаемой архитектуре. */
    skipDownloadOnNonArm?: boolean;
    /** Pinned digest; download is rejected when neither digest is present or when mismatched. */
    sha256?: string;
    /** SHA-1 is supported only for official Android repository artifacts whose published SDK index provides SHA-1. */
    sha1?: string;
  };
  /**
   * Shell-проверка «уже установлено» (exit 0 = skip).
   * Пример: command -v jadx >/dev/null
   */
  checkCmd?: string;
  /** Не валит весь пакет при ошибке (frida и т.п.) */
  optional?: boolean;
}

/** Optional Python/r2pm tools are disabled until distributed as verified, hash-pinned tool-pack artifacts. */
const PIP_DISABLED_STEP = 'echo "ERROR: Python/r2pm package installation is disabled because package resolution is not integrity-pinned; use a separately verified tool-pack artifact." >&2; exit 1';
const APK_MITM_DISABLED_STEP = 'echo "ERROR: apk-mitm installation is disabled because global npm installs are not integrity-pinned; use a separately verified tool-pack artifact." >&2; exit 1';

/**
 * Archive extraction boundary. Digest verification proves bytes came from the
 * pinned artifact, but it does not make archive member names safe. Validate
 * names and link entries before any archive is extracted.
 */
const SAFE_ZIP_EXTRACT_CHECK = `python - "ARCHIVE_PATH" <<'PY'
import sys, zipfile, posixpath
path=sys.argv[1]
infos=zipfile.ZipFile(path).infolist()
if len(infos)>100000: raise SystemExit("zip entry-count limit exceeded")
total=0
for i in infos:
 n=i.filename.replace("\\","/"); c=posixpath.normpath(n)
 if n.startswith("/") or c==".." or c.startswith("../") or "/../" in ("/"+c): raise SystemExit("unsafe zip member: "+n)
 if i.file_size>2147483648: raise SystemExit("zip member size limit exceeded: "+n)
 total += i.file_size
 if total>8589934592: raise SystemExit("zip archive size limit exceeded")
 mode=(i.external_attr>>16)&0o170000
 if mode and mode not in (0o100000,0o040000): raise SystemExit("zip special/link member is forbidden: "+n)
PY`;
const SAFE_TAR_EXTRACT_CHECK = `set -e; LIST="ARCHIVE_PATH.list"; tar -tf "ARCHIVE_PATH" > "$LIST"; COUNT=$(wc -l < "$LIST"); if [ "$COUNT" -gt 100000 ]; then echo "tar entry-count limit exceeded" >&2; rm -f "$LIST"; exit 1; fi; if grep -Eq '(^/|(^|/)\.\.(\/|$))' "$LIST"; then echo "unsafe tar member path" >&2; rm -f "$LIST"; exit 1; fi; rm -f "$LIST"; if tar -tvf "ARCHIVE_PATH" 2>/dev/null | awk '{t=substr($0,1,1); if (t=="l" || t=="h" || t=="p" || t=="c" || t=="b" || t=="s") {print "unsafe tar special/link member" > "/dev/stderr"; exit 1}}'; then :; else exit 1; fi` ;


export interface TermuxToolPack {
  id: string;
  /** i18n keys resolved in UI */
  name: Record<PackLang, string>;
  description: Record<PackLang, string>;
  sizeLabel: Record<PackLang, string>;
  /** Шаги установки (порядок = прогресс) */
  installSteps: InstallStep[];
  /** Шаги удаления (pkg uninstall / pip uninstall) */
  removeSteps: InstallStep[];
}

/** APK-build and reverse-eng downloadable packs removed from Settings.
 *  Stubs kept so imports/types remain stable; ALL_TOOL_PACKS is empty.
 */
export const APK_BUILD_PACK: TermuxToolPack = {
  id: "apk-build",
  name: { uk: "", ru: "", en: "" },
  description: { uk: "", ru: "", en: "" },
  sizeLabel: { uk: "", ru: "", en: "" },
  installSteps: [],
  removeSteps: [],
};

export const REVERSE_PACK: TermuxToolPack = {
  id: "reverse-eng",
  name: { uk: "", ru: "", en: "" },
  description: { uk: "", ru: "", en: "" },
  sizeLabel: { uk: "", ru: "", en: "" },
  installSteps: [],
  removeSteps: [],
};

/** Downloadable packs removed from Settings UI (APK build + reverse-eng).
 *  Definitions kept above for reference / possible future re-enable; not exposed. */
export const ALL_TOOL_PACKS: TermuxToolPack[] = [];

export type { InstallerError };
export { formatInstallerError, makeInstallerError, TOOL_REGISTRY, ANDROID_SDK_POLICY };

export function getToolPack(id: string): TermuxToolPack | undefined {
  return ALL_TOOL_PACKS.find((p) => p.id === id);
}

/** Минимальное свободное место (байты) перед тяжёлыми SDK/NDK пакетами. */
export const PACK_MIN_FREE_BYTES: Record<string, number> = {
  "apk-build": 3_500_000_000, // ~3.5 GB
  "reverse-eng": 800_000_000,
};

export function getPackEstimate(id: string, lang: PackLang): { size: string; time: string } {
  if (id === "apk-build") {
    return {
      size: lang === "en" ? "~3–5 GB" : lang === "uk" ? "~3–5 ГБ" : "~3–5 ГБ",
      time: lang === "en" ? "~30–90 min on LTE" : lang === "uk" ? "~30–90 хв на LTE" : "~30–90 мин на LTE",
    };
  }
  if (id === "reverse-eng") {
    return {
      size: lang === "en" ? "~0.5–1.5 GB" : lang === "uk" ? "~0.5–1.5 ГБ" : "~0.5–1.5 ГБ",
      time: lang === "en" ? "~10–40 min on LTE" : lang === "uk" ? "~10–40 хв на LTE" : "~10–40 мин на LTE",
    };
  }
  return { size: "—", time: "—" };
}

/** df -k $PREFIX → free bytes; null if unknown. */
export async function checkTermuxFreeSpace(
  run: (cmd: string, timeoutMs: number) => Promise<{ exitCode: number; stdout: string; stderr: string }>
): Promise<{ freeBytes: number; ok: boolean; detail: string } | null> {
  try {
    const r = await run(
      `df -k "$PREFIX" 2>/dev/null | tail -1 | awk '{print $4}'`,
      15_000
    );
    const kb = parseInt((r.stdout || "").trim().split(/\s+/).pop() || "", 10);
    if (!Number.isFinite(kb) || kb < 0) return null;
    const freeBytes = kb * 1024;
    return {
      freeBytes,
      ok: true,
      detail: `${(freeBytes / (1024 * 1024 * 1024)).toFixed(2)} GiB free on $PREFIX`,
    };
  } catch {
    return null;
  }
}

/** Кэш последнего успешного URL для resume (в памяти процесса). */
const successfulDownloadUrls = new Map<string, string>();

export function rememberSuccessfulDownloadUrl(stepLabel: string, url: string) {
  if (stepLabel && url) successfulDownloadUrls.set(stepLabel, url);
}

export function getRememberedDownloadUrl(stepLabel: string): string | undefined {
  return successfulDownloadUrls.get(stepLabel);
}



export type StepStatus = "pending" | "running" | "ok" | "fail" | "skip";

export interface PackStepProgress {
  label: string;
  status: StepStatus;
  detail?: string;
  /** 0–100 для текущего/завершённого шага (для UI «23%») */
  percent?: number;
}


function buildCommand(step: InstallStep, mode: "install" | "remove"): string {
  if (step.kind === "shell") return step.primary;
  if (step.kind === "pip") {
    return mode === "install"
      ? PIP_DISABLED_STEP
      : `pip uninstall -y ${step.primary}`;
  }
  // pkg
  return mode === "install"
    ? `pkg install -y ${step.primary}`
    : `pkg uninstall -y ${step.primary}`;
}

/**
 * Выполняет шаги пакета в Termux. onProgress вызывается после каждого шага.
 * Возвращает true, если критичных провалов не было (допускаются skip).
 */




/** Починить сломанный curl (libcurl vs openssl) и выбрать рабочий HTTP-клиент. */
async function ensureHttpClient(
  run: (cmd: string, timeoutMs: number) => Promise<{ exitCode: number; stdout: string; stderr: string }>
): Promise<"curl" | "wget"> {
  const probe = await run(
    `curl --version >/dev/null 2>&1; EC=$?; curl -sI --connect-timeout 5 --max-time 8 https://example.com >/dev/null 2>&1; echo CURL_EC=$EC; curl --version 2>&1 | head -1`,
    20_000
  );
  const out = (probe.stdout || "") + "\n" + (probe.stderr || "");
  if (/CANNOT LINK|SSL_set_quic|Failed to run the 'curl'/i.test(out) || /CURL_EC=[1-9]/i.test(out)) {
    persistentLogger.add("warn", "Packs", "curl broken (SSL/libcurl) — reinstall openssl+curl, prefer wget");
    await run(
      "set +e; pkg update -y 2>&1 | tail -8; " +
        "pkg install -y --reinstall openssl openssl-tool libcurl curl wget 2>&1 | tail -30; " +
        "command -v wget; command -v curl; curl --version 2>&1 | head -1",
      600_000
    );
  } else {
    // wget всё равно полезен как запасной
    await run("command -v wget >/dev/null || pkg install -y wget 2>/dev/null || true", 120_000);
  }
  const p2 = await run(
    `(curl -sI --connect-timeout 5 --max-time 8 https://example.com >/dev/null 2>&1 && echo CURL_OK) || echo CURL_BAD; ` +
      `(wget -q --spider --timeout=8 https://example.com >/dev/null 2>&1 && echo WGET_OK) || echo WGET_BAD`,
    25_000
  );
  const o2 = (p2.stdout || "") + (p2.stderr || "");
  if (/CURL_OK/.test(o2)) return "curl";
  if (/WGET_OK/.test(o2)) return "wget";
  return "wget";
}

/** HEAD-проверка URL: жив ли ресурс и какой Content-Length. */
async function headCheckUrl(
  run: (cmd: string, timeoutMs: number) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  url: string
): Promise<{ ok: boolean; size: number }> {
  try {
    const r = await run(
      `(curl -sI -L --connect-timeout 12 --max-time 20 "${url}" 2>/dev/null || wget -S --spider --timeout=20 "${url}" 2>&1) | tr -d '\r'`,
      25_000
    );
    const h = (r.stdout || "") + "\n" + (r.stderr || "");
    const codeM = h.match(/HTTP\/[\d.]+ (\d{3})/i);
    // берём последний код после редиректов
    const codes = h.match(/HTTP\/[\d.]+ (\d{3})/gi) || [];
    const last = codes.length
      ? parseInt((codes[codes.length - 1].match(/(\d{3})/) || [])[1] || "0", 10)
      : codeM
        ? parseInt(codeM[1], 10)
        : 0;
    if (last && last >= 400) return { ok: false, size: 0 };
    const lenM = h.match(/content-length:\s*(\d+)/i);
    const size = lenM ? parseInt(lenM[1], 10) : 0;
    // 0 size + no error code — всё равно пробуем GET (часть CDN режет HEAD)
    return { ok: !last || last < 400, size };
  } catch {
    return { ok: true, size: 0 }; // сеть моргнула — не отбрасываем URL
  }
}

type SpeedCb = (info: { percent: number; speedKBs: number; mb: number; detail: string }) => void;

/** Чанковая загрузка файла с HEAD-фильтром и порогом от expectBytes. */
async function runChunkedDownload(
  step: InstallStep,
  run: (cmd: string, timeoutMs: number) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  onChunk: SpeedCb,
  httpClient: "curl" | "wget",
  shouldAbort?: () => boolean
): Promise<{ ok: boolean; error?: string }> {
  const dl = step.download!;
  const dest = dl.dest.includes("$PREFIX")
    ? dl.dest
    : `$AIB_PRIVATE_ROOT/tmp/${dl.dest.replace(/^.*\//, "")}`;
  let expect = dl.expectBytes || 0;
  const isNdk = /ndk/i.test(step.label);
  const isCmdline = /cmdline/i.test(step.label);
  let isAarchTermux = false;

  await run(
    `mkdir -p "$(dirname ${dest})" "$AIB_PRIVATE_ROOT/tmp" 2>/dev/null; pkg install -y curl wget unzip p7zip 2>/dev/null || true`,
    180_000
  ).catch(() => {});

  if (isNdk) {
    const chk = await run(
      `if [ -d "$PREFIX/opt/android-ndk" ] && { [ -f "$PREFIX/opt/android-ndk/ndk-build" ] || [ -f "$PREFIX/opt/android-ndk/build/ndk-build" ]; }; then echo HAS_NDK; fi`,
      10_000
    ).catch(() => ({ stdout: "", stderr: "", exitCode: 1 }));
    if (/HAS_NDK/.test(chk.stdout || "")) return { ok: true };

    // На Termux aarch64 официальный Google NDK host-пакет не запускается.
    // Используем только pinned aarch64 archive; non-ARM использует ровно pinned r29.
    const arch = await run(`uname -m`, 5_000).catch(() => ({ stdout: "", stderr: "", exitCode: 1 }));
    const isAarch = /aarch64|arm64/i.test(arch.stdout || "");
    isAarchTermux = isAarch;
    const sm = isAarch
      ? { stdout: "SKIP_SM_NDK_AARCH64", stderr: "", exitCode: 0 }
      : { stdout: "", stderr: "NON_ARM_NDK_SDKMANAGER_BLOCKED", exitCode: 1 };
    if (/SM_NDK_OK/.test(sm.stdout || "")) {
      onChunk({ percent: 100, speedKBs: 0, mb: 0, detail: "sdkmanager · OK" });
      await run(
        `export ANDROID_HOME="$PREFIX/opt/android-sdk" ANDROID_SDK_ROOT="$ANDROID_HOME" ANDROID_NDK_HOME="$PREFIX/opt/android-ndk"`,
        10_000
      ).catch(() => {});
      return { ok: true };
    }
  } else if (isCmdline) {
    const chk = await run(
      `if [ -x "$PREFIX/opt/android-sdk/cmdline-tools/latest/bin/sdkmanager" ]; then echo HAS_SDK; fi`,
      10_000
    ).catch(() => ({ stdout: "", stderr: "", exitCode: 1 }));
    if (/HAS_SDK/.test(chk.stdout || "")) return { ok: true };
  }

  let urls = [...dl.urls];
  // На aarch64 официальный Google NDK содержит linux-x86_64 host-бинарники и
  // заведомо несовместим. Не тратим время/трафик на его discovery и загрузку.

  // A-08: every archive that will be extracted/installed must have a pinned digest.
  // SHA-256 remains the default. SHA-1 is accepted only for the official Android
  // repository platform archive because Google's SDK repository publishes that
  // artifact checksum as SHA-1.
  const hasSha256 = !!dl.sha256 && /^[a-f0-9]{64}$/i.test(dl.sha256);
  const hasSha1 = !!dl.sha1 && /^[a-f0-9]{40}$/i.test(dl.sha1);
  if (!hasSha256 && !hasSha1) {
    return { ok: false, error: `DOWNLOAD_DIGEST_REQUIRED:${step.label}` };
  }

  // Download endpoints are data-only transport inputs. Require HTTPS and
  // reject credentials/query/hash components so a future pack cannot silently
  // introduce cleartext transport or URL-embedded secrets. Redirected bytes
  // remain untrusted until the pinned SHA-256 check below succeeds.
  const safeUrls: string[] = [];
  for (const url of urls) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
        persistentLogger.add("error", "Packs", `Rejected unsafe download URL: ${step.label}`);
        continue;
      }
      safeUrls.push(parsed.toString());
    } catch {
      persistentLogger.add("error", "Packs", `Rejected malformed download URL: ${step.label}`);
    }
  }
  if (!safeUrls.length) {
    return { ok: false, error: `DOWNLOAD_HTTPS_URL_REQUIRED:${step.label}` };
  }
  urls = safeUrls;

  // HEAD-фильтр: мёртвые URL сразу мимо; подтягиваем точный size
  let liveUrls: string[] = [];
  for (const url of urls) {
    const head = await headCheckUrl(run, url);
    if (!head.ok) {
      onChunk({ percent: 0, speedKBs: 0, mb: 0, detail: `skip dead · ${url.slice(-40)}` });
      continue;
    }
    if (head.size > 0 && expect <= 0) expect = head.size;
    if (head.size > 0) expect = head.size; // точный Content-Length приоритетнее
    liveUrls.push(url);
  }
  // Never fall back to the raw descriptor URLs after URL policy validation.
  // A failed HEAD request must not bypass the HTTPS/credential/query/hash policy.
  if (!liveUrls.length) liveUrls.push(...safeUrls);
  const remembered = getRememberedDownloadUrl(step.label);
  if (remembered && safeUrls.includes(remembered)) {
    liveUrls = [remembered, ...liveUrls.filter((u) => u !== remembered)];
  } else if (remembered) {
    persistentLogger.add("warn", "Packs", `Rejected unsafe cached download URL: ${step.label}`);
    persistentLogger.add("info", "Packs", `Resume URL cache hit: ${step.label}`);
  }

  const maxChunks = isNdk ? 600 : expect > 50_000_000 ? 400 : 150;
  const chunkTime = isNdk ? 300 : expect > 50_000_000 ? 180 : 90;
  // Порог «файл достаточно большой»: 5% от expect, но не меньше 50 КБ и не больше 5 МБ
  const minDoneBytes =
    expect > 0
      ? Math.min(5_000_000, Math.max(50_000, Math.floor(expect * 0.05)))
      : 50_000;

  let lastPostError = "";
  for (const url of liveUrls) {
    await run(`rm -f "${dest}"`, 15_000).catch(() => {});
    let stableEmpty = 0;
    let lastSize = 0;
    let success = false;

    onChunk({
      percent: 0,
      speedKBs: 0,
      mb: 0,
      detail: `URL · ${url.replace(/^https?:\/\/[^/]+\//, "").slice(0, 48)}`,
    });

    for (let chunk = 0; chunk < maxChunks; chunk++) {
      if (shouldAbort?.()) {
        await run(`pkill -f 'curl|wget' 2>/dev/null || true`, 8_000).catch(() => {});
        return { ok: false, error: "aborted" };
      }
      const t0 = Date.now();
      const preferWget = httpClient === "wget" || isNdk;
      // 100% надёжная загрузка для Termux aarch64:
      // 1) curl --http1.1 (без QUIC/HTTP3)
      // 2) длинный max-time
      // 3) при любом fail/нулевом size → wget
      // 4) всегда $PREFIX/tmp
      const longTime = isNdk ? 1800 : Math.max(chunkTime, expect > 20_000_000 ? 900 : 90);
      const cmd = preferWget
        ? `mkdir -p "$AIB_PRIVATE_ROOT/tmp" 2>/dev/null; ` +
          `rm -f "${dest}"; wget --no-http-keep-alive --timeout=${longTime} --tries=8 --waitretry=5 --retry-on-http-error=429,500,502,503,504 -O "${dest}" "${url}" ; EC=$?; ` +
          `SZ=$(stat -c%s "${dest}" 2>/dev/null || echo 0); echo "EC=$EC SZ=$SZ"`
        : `mkdir -p "$AIB_PRIVATE_ROOT/tmp" 2>/dev/null; ` +
          `curl --http1.1 -fL --connect-timeout 60 --max-time ${longTime} --retry 8 --retry-delay 5 --retry-all-errors ` +
          `-o "${dest}" "${url}" 2>"$AIB_PRIVATE_ROOT/tmp/aib_curl_err" ; EC=$?; ` +
          `SZ=$(stat -c%s "${dest}" 2>/dev/null || echo 0); ` +
          `if [ "$EC" -ne 0 ] || [ "$SZ" -eq 0 ]; then ` +
          `  rm -f "${dest}"; wget --no-http-keep-alive --timeout=${longTime} --tries=8 --waitretry=5 --retry-on-http-error=429,500,502,503,504 -O "${dest}" "${url}"; EC=$?; ` +
          `  SZ=$(stat -c%s "${dest}" 2>/dev/null || echo 0); ` +
          `fi; ` +
          `echo "EC=$EC SZ=$SZ"`;
      let out = "";
      try {
        const r = await run(cmd, ((isNdk ? 1800 : Math.max(chunkTime, expect > 20_000_000 ? 900 : 90)) + 120) * 1000);
        out = (r.stdout || "") + "\n" + (r.stderr || "");
      } catch (e: unknown) {
        out = errorMessage(e);
      }
      const sec = Math.max(0.5, (Date.now() - t0) / 1000);
      const szMatch = out.match(/SZ=(\d+)/);
      const ecMatch = out.match(/EC=(\d+)/);
      const size = szMatch ? parseInt(szMatch[1], 10) : 0;
      const ec = ecMatch ? parseInt(ecMatch[1], 10) : -1;
      const delta = Math.max(0, size - lastSize);
      const speedKBs = Math.round(delta / sec / 1024);
      lastSize = size;
      const mb = size / (1024 * 1024);
      const percent =
        expect > 0
          ? Math.min(99, Math.max(0, Math.round((size / expect) * 100)))
          : Math.min(99, Math.round(((chunk + 1) / maxChunks) * 100));

      onChunk({
        percent: size > 0 ? Math.max(1, percent) : percent,
        speedKBs,
        mb,
        detail: `${speedKBs} KB/s · ${mb.toFixed(1)} MB`,
      });
      persistentLogger.add("debug", "Packs", `DL chunk ${chunk + 1} ${step.label}: ${speedKBs} KB/s ${mb.toFixed(1)}MB ec=${ec} sz=${size}`);

      // Полный файл: curl exit 0 ИЛИ размер ≈ expect; порог minDoneBytes (не жёсткие 5 МБ)
      const looksComplete =
        (ec === 0 || (expect > 0 && size >= expect * 0.98)) && size >= minDoneBytes;
      if (looksComplete) {
        // Никогда не принимаем HTML/404/обрезанный архив за скачанный файл.
        const archiveLike = /\.(?:zip|7z)$/i.test(dest) || /\.tar(?:\.gz|\.xz|\.bz2)?$/i.test(dest) || isNdk || isCmdline;
        const jarLike = /\.jar$/i.test(dest);
        if (archiveLike || jarLike) {
          const testCmd = archiveLike
            ? ((/\.7z$/i.test(dest) || isNdk) ? `(command -v 7z >/dev/null 2>&1 && 7z t "${dest}" >/dev/null 2>&1) && echo ARCHOK || echo ARCHBAD` : `(tar -tJf "${dest}" >/dev/null 2>&1 || tar -tzf "${dest}" >/dev/null 2>&1 || unzip -tqo "${dest}" >/dev/null 2>&1) && echo ARCHOK || echo ARCHBAD`)
            : `(jar tf "${dest}" >/dev/null 2>&1 || unzip -tqo "${dest}" >/dev/null 2>&1) && echo ARCHOK || echo ARCHBAD`;
          const test = await run(testCmd, 300_000);
          if (/ARCHOK/.test(test.stdout || "")) {
            const hash = await run(
              hasSha256
                ? `sha256sum "${dest}" | awk '{print $1}'`
                : `sha1sum "${dest}" | awk '{print $1}'`,
              300_000
            );
            const actual = (hash.stdout || "").trim().split(/\s+/)[0].toLowerCase();
            const expected = (hasSha256 ? String(dl.sha256 || "") : String(dl.sha1 || "")).toLowerCase();
            if (actual !== expected) {
              lastPostError = `${hasSha256 ? "sha256" : "sha1"} mismatch for ${step.label}: expected ${expected}, got ${actual || "missing"}`;
              persistentLogger.add("error", "Packs", lastPostError);
              await run(`rm -f "${dest}"`, 15_000).catch(() => {});
              break;
            }
            success = true;
            rememberSuccessfulDownloadUrl(step.label, url);
            persistentLogger.add("info", "Packs", `${hasSha256 ? "SHA256" : "SHA1"} verified: ${step.label}`);
            break;
          }
          lastPostError = `invalid downloaded archive from ${url}`;
          break; // битый архив → следующий URL
        }
        const hash = await run(
          hasSha256
            ? `sha256sum "${dest}" | awk '{print $1}'`
            : `sha1sum "${dest}" | awk '{print $1}'`,
          300_000
        );
        const actual = (hash.stdout || "").trim().split(/\s+/)[0].toLowerCase();
        const expected = (hasSha256 ? String(dl.sha256 || "") : String(dl.sha1 || "")).toLowerCase();
        if (actual !== expected) {
          lastPostError = `${hasSha256 ? "sha256" : "sha1"} mismatch for ${step.label}: expected ${expected}, got ${actual || "missing"}`;
          persistentLogger.add("error", "Packs", lastPostError);
          await run(`rm -f "${dest}"`, 15_000).catch(() => {});
          break;
        }
        success = true;
        persistentLogger.add("info", "Packs", `${hasSha256 ? "SHA256" : "SHA1"} verified: ${step.label}`);
        break;
      }
      if (ec === 28 || ec === 18) {
        if (delta === 0) {
          stableEmpty++;
          if (stableEmpty >= 6) break;
        } else stableEmpty = 0;
        continue;
      }
      if (ec !== 0 && size === 0) break;
      if (delta === 0) {
        stableEmpty++;
        if (stableEmpty >= 6) break;
      } else stableEmpty = 0;
    }

    if (success) {
      try {
        const post = await run(step.primary, 300_000);
        if (post.exitCode === 0) return { ok: true };
        lastPostError = (post.stderr || post.stdout || "post-install failed").slice(0, 300);
        persistentLogger.add("warn", "Packs", `Post-install failed for ${step.label} via ${url}: ${lastPostError}`);
      } catch (e: unknown) {
        lastPostError = errorMessage(e);
        persistentLogger.add("warn", "Packs", `Post-install exception for ${step.label} via ${url}: ${lastPostError}`);
      }
      // Post-install мог быть сломан из-за конкретной версии/архива — пробуем следующий URL.
    }
  }

  return { ok: false, error: lastPostError || "all download URLs failed" };
}

/**
 * pkg install — упрощённый прогресс (PACK-012).
 */
async function runAptInstallWithSpeed(
  pkgName: string,
  run: (cmd: string, timeoutMs: number) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  onChunk: SpeedCb
): Promise<{ ok: boolean; error?: string }> {
  onChunk({ percent: 5, speedKBs: 0, mb: 0, detail: `pkg ${pkgName}…` });
  let pct = 5;
  const tick = setInterval(() => {
    pct = Math.min(90, pct + 3);
    onChunk({ percent: pct, speedKBs: 0, mb: 0, detail: `pkg ${pkgName} · ${pct}%` });
  }, 2500);
  try {
    let inst = await run(`pkg install -y ${pkgName}`, 300_000);
    clearInterval(tick);
    if (inst.exitCode === 0) {
      onChunk({ percent: 100, speedKBs: 0, mb: 0, detail: "100%" });
      return { ok: true };
    }
    return {
      ok: false,
      error: (inst.stderr || inst.stdout || `pkg ${pkgName} failed`).slice(0, 400),
    };
  } catch (e: unknown) {
    clearInterval(tick);
    return { ok: false, error: errorMessage(e) };
  }
}

/**
 * Дефолтные checkCmd по label.
 * PACK-002/003/014: functional health (version/help), not only presence.
 */
function defaultCheckCmd(step: InstallStep): string | undefined {
  if (step.checkCmd) return step.checkCmd;
  // Shell steps are scripts — never treat primary as a package/binary name for "command -v".
  if (step.kind === "shell") {
    const L0 = (step.label || "").toLowerCase();
    if (
      L0 === "preflight" ||
      L0 === "pkg update" ||
      L0.includes("license") ||
      L0.includes("host compatibility") ||
      L0.includes("platform-tools") ||
      L0.includes("android-ndk") ||
      L0.includes("cmdline") ||
      L0.includes("termux (") ||
      L0.includes("build-tools")
    ) {
      return undefined;
    }
  }
  const L = step.label.toLowerCase();
  if (L === "preflight") return undefined;
  if (L === "openjdk-21" || L === "openjdk-17") return "command -v java >/dev/null 2>&1 && java -version >/dev/null 2>&1";
  if (L === "kotlin") return "(command -v kotlinc >/dev/null 2>&1 && kotlinc -version >/dev/null 2>&1) || (command -v kotlin >/dev/null 2>&1 && kotlin -version >/dev/null 2>&1)";
  if (L === "aapt") return "(command -v aapt2 >/dev/null 2>&1 && aapt2 version >/dev/null 2>&1) || (command -v aapt >/dev/null 2>&1 && aapt version >/dev/null 2>&1)";
  if (L === "apksigner") return "command -v apksigner >/dev/null 2>&1 && (apksigner --version >/dev/null 2>&1 || apksigner --help >/dev/null 2>&1)";
  if (L === "d8") return "(command -v d8 >/dev/null 2>&1 && d8 --help >/dev/null 2>&1) || (command -v dx >/dev/null 2>&1 && dx --help >/dev/null 2>&1)";
  if (L === "zipalign") return "command -v zipalign >/dev/null 2>&1 && test -x \"$(command -v zipalign)\"";
  if (L === "nodejs") return "command -v node >/dev/null 2>&1 && node --version >/dev/null 2>&1 && command -v npm >/dev/null 2>&1";
  if (L === "protobuf / protoc") return "command -v protoc >/dev/null 2>&1 && protoc --version >/dev/null 2>&1";
  if (L === "termux-elf-cleaner") return "command -v termux-elf-cleaner >/dev/null 2>&1";
  if (L.includes("cmdline")) return 'test -x "$PREFIX/opt/android-sdk/cmdline-tools/latest/bin/sdkmanager"';
  if (L.includes("aarch64") || L.includes("termux (aarch64)")) {
    return 'ADB="$PREFIX/opt/android-sdk/platform-tools/adb"; test -x "$ADB" && "$ADB" version >/dev/null 2>&1 && (ls "$PREFIX/opt/android-sdk/build-tools"/*/aapt2 >/dev/null 2>&1 || ls "$PREFIX/opt/android-sdk/build-tools"/*/aapt >/dev/null 2>&1)';
  }
  if (L.includes("platform-tools")) {
    return '(command -v adb >/dev/null 2>&1 && adb version >/dev/null 2>&1) || (ADB="$PREFIX/opt/android-sdk/platform-tools/adb"; test -x "$ADB" && "$ADB" version >/dev/null 2>&1)';
  }
  if (L.includes("platform-34") || L === "android-sdk platforms") {
    return 'test -f "$PREFIX/opt/android-sdk/platforms/android-34/android.jar"';
  }
  if (L.includes("build-tools") && L.includes("android")) {
    return '(uname -m | grep -qiE "aarch64|arm64" && ((command -v aapt2 >/dev/null 2>&1 && aapt2 version >/dev/null 2>&1) || (command -v aapt >/dev/null 2>&1 && aapt version >/dev/null 2>&1))) || (A=$(ls "$PREFIX/opt/android-sdk/build-tools"/*/aapt2 "$PREFIX/opt/android-sdk/build-tools"/*/aapt 2>/dev/null | head -1); test -n "$A" && "$A" version >/dev/null 2>&1)';
  }
  if (L.includes("ndk")) {
    return 'test -f "$PREFIX/opt/android-ndk/ndk-build" || test -f "$PREFIX/opt/android-ndk/build/ndk-build" || ls "$PREFIX/opt/android-sdk/ndk" 2>/dev/null | grep -q .';
  }
  if (L === "bundletool") return "command -v bundletool >/dev/null 2>&1 && bundletool version >/dev/null 2>&1";
  if (L === "smali") return "(command -v smali >/dev/null 2>&1 && smali --version >/dev/null 2>&1) || (command -v baksmali >/dev/null 2>&1)";
  if (L === "dex2jar") return "command -v d2j-dex2jar >/dev/null 2>&1";
  if (L === "apk-mitm") return "command -v apk-mitm >/dev/null 2>&1";
  if (L.includes("r2frida")) return 'command -v r2pm >/dev/null 2>&1 && (r2pm -l 2>/dev/null | grep -q r2frida || test -d "$HOME/.local/share/radare2/r2pm/git/r2frida")';
  if (L === "gradle") return "command -v gradle >/dev/null 2>&1 && gradle --version >/dev/null 2>&1";
  if (step.kind === "pkg") {
    const p = step.primary;
    if (p === "git") return "command -v git >/dev/null 2>&1 && git --version >/dev/null 2>&1";
    if (p === "clang") return "command -v clang >/dev/null 2>&1 && clang --version >/dev/null 2>&1";
    if (p === "cmake") return "command -v cmake >/dev/null 2>&1 && cmake --version >/dev/null 2>&1";
    if (p === "make") return "command -v make >/dev/null 2>&1";
    if (p === "python") return "(command -v python >/dev/null 2>&1 || command -v python3 >/dev/null 2>&1) && (python --version >/dev/null 2>&1 || python3 --version >/dev/null 2>&1)";
    return `command -v ${p} >/dev/null 2>&1 || dpkg -s ${p} >/dev/null 2>&1`;
  }
  if (step.kind === "pip") {
    const p = step.primary;
    const mod = p.replace(/-/g, "_");
    if (p === "frida-tools") return "command -v frida >/dev/null 2>&1 && frida --version >/dev/null 2>&1";
    if (p === "objection") return "command -v objection >/dev/null 2>&1 && objection --help >/dev/null 2>&1";
    if (p === "androguard") return "(command -v androguard >/dev/null 2>&1 || python -c \"import androguard\" 2>/dev/null) && (androguard --help >/dev/null 2>&1 || true)";
    if (p === "apkid") return "command -v apkid >/dev/null 2>&1 && apkid --help >/dev/null 2>&1";
    if (p === "quark-engine") return "command -v quark >/dev/null 2>&1 || python -c \"import quark\" 2>/dev/null";
    if (p === "enjarify") return "command -v enjarify >/dev/null 2>&1 || python -c \"import enjarify\" 2>/dev/null";
    return `python -c "import ${mod}" 2>/dev/null || pip show ${p} >/dev/null 2>&1`;
  }
  return undefined;
}

/** Проверяет фактическое состояние конкретного инструмента. */
export async function checkToolStepInstalled(
  step: InstallStep,
  run: (cmd: string, timeoutMs: number) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
): Promise<boolean> {
  const check = defaultCheckCmd(step);
  if (!check) return false;
  try {
    const result = await run(`(${check}) >/dev/null 2>&1`, 20_000);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/** Безопасная команда удаления одного шага. Для shell-шагов удаляем только
 * файлы/каталоги, созданные этим инструментом; для pkg/pip используется
 * стандартный uninstall. */
/**
 * Безопасная команда удаления одного шага (PACK-015).
 */
export function getToolStepRemoveCommand(step: InstallStep): string {
  if (step.kind === "pkg") return `pkg uninstall -y ${step.primary}`;
  if (step.kind === "pip") return `pip uninstall -y ${step.primary}`;
  const label = step.label;
  const owned = TOOL_OWNERSHIP[label];
  if (owned && owned.length === 0) {
    // Aggregate / protected — no-op with message
    return 'echo "WARN: aggregate or protected path — remove disabled"; true';
  }
  if (owned && owned.length) {
    const rms = owned.map((p) => `rm -rf ${p}`).join("; ");
    return `${rms}; true`;
  }
  const L = label.toLowerCase();
  if (L === "bundletool") return 'rm -f "$PREFIX/bin/bundletool"; rm -rf "$PREFIX/lib/bundletool"';
  if (L.includes("cmdline")) return 'rm -rf "$PREFIX/opt/android-sdk/cmdline-tools" "$AIB_PRIVATE_ROOT/tmp/cmdtools.zip"';
  if (L.includes("termux (aarch64)")) {
    return 'echo "WARN: aggregate SDK remove disabled to protect shared components. Remove platform-tools/build-tools/ndk individually."; true';
  }
  if (L.includes("platform-tools")) return 'rm -rf "$PREFIX/opt/android-sdk/platform-tools" "$AIB_PRIVATE_ROOT/tmp/platform-tools.zip"';
  if (L.includes("platform-34")) return 'rm -rf "$PREFIX/opt/android-sdk/platforms/android-34" "$AIB_PRIVATE_ROOT/tmp/platform-34.zip"';
  if (L.includes("build-tools")) {
    return 'if [ -d "$PREFIX/opt/android-sdk/build-tools/34.0.0" ]; then rm -rf "$PREFIX/opt/android-sdk/build-tools/34.0.0"; else rm -rf "$PREFIX/opt/android-sdk/build-tools"; fi; rm -f "$AIB_PRIVATE_ROOT/tmp/build-tools.zip"';
  }
  if (L.includes("android-ndk") || L === "android-ndk") return 'rm -rf "$PREFIX/opt/android-ndk" "$PREFIX/opt/android-ndk-r29" "$AIB_PRIVATE_ROOT/tmp/ndk"';
  if (L === "dex2jar") return 'rm -rf "$PREFIX/share/java/dex-tools" "$PREFIX/share/java/dex2jar"; rm -f "$PREFIX/bin/d2j-dex2jar" "$PREFIX/bin/d2j-dex2jar.sh"';
  if (L === "smali") return 'rm -f "$PREFIX/bin/smali" "$PREFIX/bin/baksmali" "$PREFIX/share/java/smali.jar" "$PREFIX/share/java/baksmali.jar"';
  if (L.includes("r2frida")) return 'command -v r2pm >/dev/null 2>&1 && r2pm -r r2frida || true';
  if (L === "apk-mitm") return 'npm uninstall -g apk-mitm || true; rm -f "$PREFIX/bin/apk-mitm"';
  return `true # no dedicated removal command for ${JSON.stringify(step.label)}`;
}

/**
 * Pack-level readiness (PACK-003).
 */
export async function checkToolPackInstalled(
  pack: TermuxToolPack,
  run: (cmd: string, timeoutMs: number) => Promise<{ exitCode: number; stdout: string; stderr: string }>
): Promise<boolean> {
  const required = pack.installSteps.filter((step) => !step.optional);
  if (!required.length) return false;
  for (const step of required) {
    const L = step.label.toLowerCase();
    if (L === "preflight" || L === "pkg update") continue;
    const check = defaultCheckCmd(step);
    if (!check) {
      persistentLogger.add("warn", "Packs", `Required step has no health check: ${step.label}`);
      return false;
    }
    try {
      const result = await run(`(${check}) >/dev/null 2>&1`, 25_000);
      if (result.exitCode !== 0) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export async function runPackSteps(
  steps: InstallStep[],
  mode: "install" | "remove",
  run: (cmd: string, timeoutMs: number) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  onProgress: (progressPercent: number, stepsState: PackStepProgress[]) => void,
  opts?: { shouldAbort?: () => boolean }
): Promise<{ ok: boolean; stepsState: PackStepProgress[]; aborted?: boolean }> {
  const state: PackStepProgress[] = steps.map((s) => ({
    label: s.label,
    status: "pending" as StepStatus,
  }));
  onProgress(0, state.map((s) => ({ ...s })));

  let hardFail = false;
  let httpClient: "curl" | "wget" = "curl";
  if (mode === "install") {
    try {
      httpClient = await ensureHttpClient(run);
      persistentLogger.add("info", "Packs", `HTTP client: ${httpClient}`);
      // httpClient остаётся локальным для этого прогона — параллельная установка
      // другого пакета не сможет переключить транспорт у текущей загрузки.
    } catch (e: unknown) {
      persistentLogger.add("warn", "Packs", `ensureHttpClient: ${errorMessage(e)}`);
      httpClient = "wget";
    }
  }

  for (let i = 0; i < steps.length; i++) {
    if (opts?.shouldAbort?.()) {
      persistentLogger.add("warn", "Packs", `Abort before step ${i + 1}/${steps.length}`);
      return { ok: false, stepsState: state, aborted: true };
    }

    const step = steps[i];

    // Идемпотентность: уже установлено → skip
    if (mode === "install") {
      const chk = defaultCheckCmd(step);
      if (chk) {
        try {
          const cr = await run(`(${chk}) && echo AIB_INSTALLED || echo AIB_MISSING`, 20_000);
          if (/AIB_INSTALLED/.test(cr.stdout || "")) {
            state[i] = { label: step.label, status: "ok", percent: 100, detail: "уже установлено" };
            persistentLogger.add("info", "Packs", `Skip (installed): ${step.label}`);
            onProgress(Math.round(((i + 1) / steps.length) * 100), state.map((s) => ({ ...s })));
            continue;
          }
        } catch {
          /* check failed — ставим */
        }
      }
    }

    state[i] = { label: step.label, status: "running", percent: 0, detail: "старт…" };
    persistentLogger.add(
      "info",
      "Packs",
      `Шаг ${i + 1}/${steps.length} [${mode}] ${step.label} kind=${step.kind}` +
        (step.download ? ` download=${step.download.urls?.length || 0} urls` : "") +
        (step.kind === "pkg" || step.kind === "pip" ? ` pkg=${step.primary}` : "") +
        (step.optional ? " optional" : "")
    );
    onProgress(Math.round((i / steps.length) * 100), state.map((s) => ({ ...s })));

    let succeeded = false;
    let lastErr = "";

    // Реальный KB/s: чанковый download / apt / pip
    const speedCb = (info: { percent: number; speedKBs: number; mb: number; detail: string }) => {
      state[i] = {
        label: step.label,
        status: "running",
        percent: info.percent,
        detail: `${info.percent}% · ${info.detail}`,
      };
      const overall = Math.round(((i + info.percent / 100) / steps.length) * 100);
      onProgress(Math.min(99, overall), state.map((s) => ({ ...s })));
    };

    if (mode === "install" && step.download && step.download.urls?.length) {
      const archResult = await run("uname -m", 5_000).catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
      const isArm = /aarch64|arm64/i.test(archResult.stdout || "");
      const skipForArch = (isArm && step.download.skipDownloadOnArm) || (!isArm && step.download.skipDownloadOnNonArm);
      if (skipForArch) {
        persistentLogger.add("info", "Packs", `Skip host archive download (${isArm ? "ARM" : "non-ARM"}): ${step.label}`);
        const direct = await run(step.primary, 900_000);
        if (direct.exitCode === 0) {
          succeeded = true;
          state[i] = { label: step.label, status: "ok", percent: 100, detail: isArm ? "ARM: native path" : "host: native path" };
          onProgress(Math.round(((i + 1) / steps.length) * 100), state.map((s) => ({ ...s })));
          continue;
        }
        lastErr = direct.stderr || direct.stdout || "architecture-specific native path failed";
        state[i] = { label: step.label, status: "fail", percent: 0, detail: lastErr.slice(0, 120) };
      } else {
        const dlResult = await runChunkedDownload(step, run, speedCb, httpClient, opts?.shouldAbort);
        if (dlResult.ok) {
          succeeded = true;
          state[i] = { label: step.label, status: "ok", percent: 100, detail: "100%" };
          onProgress(Math.round(((i + 1) / steps.length) * 100), state.map((s) => ({ ...s })));
          continue;
        }
        lastErr = dlResult.error || "download failed";
        state[i] = { label: step.label, status: "fail", percent: 0, detail: lastErr.slice(0, 120) };
      }
    } else if (mode === "install" && step.kind === "pkg" && step.label !== "pkg update") {
      const names = [step.primary, ...(step.alternatives || [])];
      for (const name of names) {
        const r = await runAptInstallWithSpeed(name, run, speedCb);
        if (r.ok) {
          // PACK-009: fallback only OK if capability health passes
          const health = defaultCheckCmd({ ...step, primary: name });
          let healthOk = true;
          if (health) {
            try {
              const hr = await run(`(${health}) >/dev/null 2>&1`, 25_000);
              healthOk = hr.exitCode === 0;
            } catch { healthOk = false; }
          }
          if (!healthOk) {
            lastErr = formatInstallerError(makeInstallerError({
              toolId: step.label,
              phase: "verify",
              message: `pkg ${name} installed but capability missing`,
              command: health || name,
            }));
            persistentLogger.add("warn", "Packs", lastErr);
            continue;
          }
          succeeded = true;
          state[i] = {
            label: step.label,
            status: "ok",
            percent: 100,
            detail: name !== step.primary ? `alt: ${name}` : "100%",
          };
          onProgress(Math.round(((i + 1) / steps.length) * 100), state.map((s) => ({ ...s })));
          break;
        }
        lastErr = r.error || `pkg ${name} failed`;
      }
      if (succeeded) continue;
    }

    const candidates: string[] = (() => {
      if (mode === "install" && step.download) return []; // уже обработали чанковой загрузкой
      if (mode === "install") return [step.primary, ...(step.alternatives || [])];
      return [step.primary];
    })();

    for (const candidate of candidates) {
      const cmdStep: InstallStep = { ...step, primary: candidate };
      const cmd = buildCommand(cmdStep, mode);
      const estSec =
        /sdk|ndk|cmdline|platform/i.test(step.label) ? 480 :
        /pkg update|bundletool|smali/i.test(step.label) ? 120 : 45;
      let elapsed = 0;
      const tick = setInterval(() => {
        elapsed += 2;
        const pct = Math.min(95, Math.max(1, Math.round((elapsed / estSec) * 100)));
        state[i] = {
          label: step.label,
          status: "running",
          percent: pct,
          detail: `${pct}% · работа…`,
        };
        onProgress(Math.min(99, Math.round(((i + pct / 100) / steps.length) * 100)), state.map((s) => ({ ...s })));
      }, 2000);
      try {
        const result = await run(cmd, /sdk|ndk|platform/i.test(step.label) ? 1_200_000 : 600_000);
        clearInterval(tick);
        if (result.exitCode === 0) {
          // PACK-014 / PACK-009: post-install health required for required steps
          const health = defaultCheckCmd(step);
          let healthOk = true;
          if (health && mode === "install") {
            try {
              const hr = await run(`(${health}) >/dev/null 2>&1`, 25_000);
              healthOk = hr.exitCode === 0;
            } catch {
              healthOk = false;
            }
          }
          if (!healthOk) {
            const ierr = makeInstallerError({
              toolId: step.label,
              phase: "verify",
              command: health || "health",
              exitCode: 1,
              message: "install exit 0 but health check failed",
              expectedCapability: step.label,
            });
            lastErr = formatInstallerError(ierr);
            persistentLogger.add("warn", "Packs", lastErr);
            if (!step.optional) {
              succeeded = false;
              state[i] = { label: step.label, status: "fail", percent: 0, detail: lastErr.slice(0, 160) };
              // try next alternative
              continue;
            }
            // optional: degraded skip
            succeeded = true;
            state[i] = { label: step.label, status: "skip", percent: 0, detail: "installed but health failed (optional)" };
            break;
          }
          succeeded = true;
          state[i] = {
            label: step.label,
            status: "ok",
            percent: 100,
            detail: candidate !== step.primary ? `alt: ${candidate}` : "100%",
          };
          break;
        }
        lastErr = (result.stderr || result.stdout || `exit ${result.exitCode}`).slice(0, 400);
        state[i] = { label: step.label, status: "running", percent: 0, detail: lastErr.slice(0, 120) };
      } catch (e: unknown) {
        clearInterval(tick);
        lastErr = errorMessage(e);
        // A missing bundled runtime is not repaired by trying another download.
        const low = lastErr.toLowerCase();
        if (
          low.includes("aib_private_package_feed_not_qualified") ||
          low.includes("aib_embedded_runtime_unavailable") ||
          low.includes("unable to start service") ||
          low.includes("termux_run_command_failed") ||
          low.includes("allow-external")
        ) {
          break;
        }
      }
    }

    if (!succeeded) {
      // Для remove отсутствие пакета — не ошибка
      const notInRepo =
        /unable to locate package|no installation candidate|not found/i.test(lastErr || "");
      if (succeeded) {
        onProgress(Math.round(((i + 1) / steps.length) * 100), state.map((s) => ({ ...s })));
        continue;
      }
      if (mode === "remove") {
        state[i] = { label: step.label, status: "skip", percent: 0, detail: lastErr || "not installed" };
      } else if (step.optional) {
        // Optional-инструменты действительно можно пропустить, но обязательные
        // шаги никогда не должны превращать частичную установку в "installed".
        state[i] = {
          label: step.label,
          status: "skip",
          percent: 0,
          detail: lastErr || "optional/unavailable",
        };
        persistentLogger.add("warn", "Packs", `Optional step skipped: ${step.label}: ${lastErr}`);
      } else {
        state[i] = { label: step.label, status: "fail", percent: 0, detail: lastErr || "step failed" };
        hardFail = true;
        const low = (lastErr || "").toLowerCase();
        if (
          low.includes("aib_private_package_feed_not_qualified") ||
          low.includes("aib_embedded_runtime_unavailable") ||
          low.includes("unable to start service") ||
          low.includes("termux_run_command_failed") ||
          low.includes("allow-external")
        ) {
          if (!step.optional) hardFail = true; else persistentLogger.add("warn", "Packs", `optional fail: ${step.label}: ${lastErr}`);
          // Помечаем остальные шаги как aborted, чтобы UI показал полный список причин
          for (let j = i + 1; j < steps.length; j++) {
            state[j] = {
              label: steps[j].label,
              status: "skip",
              detail: "aborted: bundled private runtime unavailable",
            };
          }
          onProgress(100, state.map((s) => ({ ...s })));
          break;
        }
      }
    }

    onProgress(Math.round(((i + 1) / steps.length) * 100), state.map((s) => ({ ...s })));
  }

  const anyOk = state.some((s) => s.status === "ok");
  return { ok: !hardFail && (mode === "remove" || anyOk), stepsState: state };
}
