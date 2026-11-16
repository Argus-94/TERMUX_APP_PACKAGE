/**
 * ADB pairing / connect helpers for Termux (Phase E — plan.md).
 * Wireless debugging (Android 11+): pair with code, then connect IP:port.
 */
import { runShellCommand } from "./termux-bridge";
import AsyncStorage from "@react-native-async-storage/async-storage";

const LAST_SERIAL_KEY = "aibuilder.adb.lastSerial";
const LAST_HOST_KEY = "aibuilder.adb.lastHost";

export type AdbDeviceLine = {
  serial: string;
  state: string;
  raw: string;
};

export type AdbStepResult = {
  ok: boolean;
  message: string;
  detail?: string;
  devices?: AdbDeviceLine[];
};

function parseDevices(stdout: string): AdbDeviceLine[] {
  const lines = String(stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("List of devices"));
  const out: AdbDeviceLine[] = [];
  for (const raw of lines) {
    const parts = raw.split(/\s+/);
    if (parts.length < 2) continue;
    if (parts[0] === "*") continue;
    out.push({ serial: parts[0], state: parts[1], raw });
  }
  return out;
}

function validHostPort(value: string): boolean {
  const input = value.trim();
  const v6 = input.match(/^\[([0-9a-f:.]+)\]:(\d{1,5})$/i);
  if (v6) return v6[1].includes(":") && Number(v6[2]) >= 1 && Number(v6[2]) <= 65535;
  const v4 = input.match(/^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/);
  if (!v4) return false;
  const octets = v4[1].split(".").map(Number);
  return octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && Number(v4[2]) >= 1 && Number(v4[2]) <= 65535;
}

function pause(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

function humanizeAdbError(text: string, language: "ru" | "uk" | "en" = "ru"): string {
  const t = text.toLowerCase();
  const map: Record<string, { ru: string; uk: string; en: string }> = {
    not_found: {
      ru: "adb не найден. В Termux: pkg install android-tools",
      uk: "adb не знайдено. У Termux: pkg install android-tools",
      en: "adb not found. In Termux: pkg install android-tools",
    },
    unauthorized: {
      ru: "Устройство unauthorized — подтвердите отладку по USB/беспроводную на экране телефона",
      uk: "Пристрій unauthorized — підтвердіть налагодження на екрані",
      en: "Device unauthorized — accept the debugging prompt on the phone",
    },
    offline: {
      ru: "Устройство offline — переподключите USB или wireless debugging",
      uk: "Пристрій offline — перепідключіть USB або wireless",
      en: "Device offline — reconnect USB or wireless debugging",
    },
    refused: {
      ru: "Соединение отклонено — проверьте IP:порт и что «Беспроводная отладка» включена",
      uk: "З'єднання відхилено — перевірте IP:порт і wireless debugging",
      en: "Connection refused — check IP:port and that wireless debugging is on",
    },
    pair: {
      ru: "Ошибка pair — код и порт сопряжения (не порт подключения) должны совпадать с экраном «Беспроводная отладка»",
      uk: "Помилка pair — код і порт сполучення мають збігатися з екраном",
      en: "Pair failed — use the pairing port and code from Wireless debugging screen",
    },
  };
  if (/not found|no such file|command not found/.test(t)) return map.not_found[language];
  if (/unauthorized/.test(t)) return map.unauthorized[language];
  if (/offline/.test(t)) return map.offline[language];
  if (/refused|timed out|timeout|failed to connect/.test(t)) return map.refused[language];
  if (/pair|pairing/.test(t)) return map.pair[language];
  return text.slice(0, 400);
}

export async function adbEnsureServer(): Promise<AdbStepResult> {
  const check = await runShellCommand("command -v adb >/dev/null 2>&1; echo $?", { timeoutMs: 10_000 });
  if ((check.stdout || "").trim() !== "0") {
    return {
      ok: false,
      message: "adb не установлен",
      detail: "pkg install android-tools",
    };
  }
  await runShellCommand("adb start-server", { timeoutMs: 20_000 });
  return { ok: true, message: "adb server OK" };
}

export async function adbListDevices(): Promise<AdbStepResult> {
  const ready = await adbEnsureServer();
  if (!ready.ok) return ready;
  const r = await runShellCommand("adb devices -l", { timeoutMs: 15_000 });
  const devices = parseDevices(r.stdout || "");
  const online = devices.filter((d) => d.state === "device");
  return {
    ok: online.length > 0,
    message:
      online.length > 0
        ? `Устройств online: ${online.length}`
        : devices.length
          ? "Устройства есть, но не в состоянии device"
          : "Нет устройств — USB или wireless connect",
    detail: (r.stdout || r.stderr || "").slice(0, 800),
    devices,
  };
}

/** Wireless pair (Android 11+): adb pair host:pairingPort code */
export async function adbPair(
  hostPort: string,
  code: string,
): Promise<AdbStepResult> {
  const ready = await adbEnsureServer();
  if (!ready.ok) return ready;
  const hp = hostPort.trim();
  const c = code.trim();
  if (!validHostPort(hp)) {
    return { ok: false, message: "Формат: IP:порт_сопряжения (как на экране «Пара»)" };
  }
  if (!/^\d{6}$/.test(c)) {
    return { ok: false, message: "Код сопряжения — обычно 6 цифр" };
  }
  const r = await runShellCommand(`adb pair ${JSON.stringify(hp)} ${JSON.stringify(c)}`, {
    timeoutMs: 60_000,
  });
  const out = `${r.stdout || ""}\n${r.stderr || ""}`;
  const ok = (r.exitCode ?? 1) === 0 || /successfully paired/i.test(out);
  return {
    ok,
    message: ok ? "Сопряжение OK — теперь Connect IP:порт_подключения" : humanizeAdbError(out),
    detail: out.slice(0, 600),
  };
}

/** adb connect host:port (connect port, not pairing port) */
export async function adbConnect(hostPort: string): Promise<AdbStepResult> {
  const ready = await adbEnsureServer();
  if (!ready.ok) return ready;
  const hp = hostPort.trim();
  if (!validHostPort(hp)) {
    return { ok: false, message: "Укажите IP:порт подключения (не порт pair)" };
  }
  const r = await runShellCommand(`adb connect ${JSON.stringify(hp)}`, { timeoutMs: 30_000 });
  const out = `${r.stdout || ""}\n${r.stderr || ""}`;
  const connectAccepted = /connected to|already connected/i.test(out) && (r.exitCode ?? 1) === 0;
  let listed: AdbStepResult = { ok: false, message: "No devices" };
  let online = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    listed = await adbListDevices();
    online = (listed.devices || []).some((device) => device.serial === hp && device.state === "device");
    if (online) break;
    if (attempt < 2) await pause(350 * (attempt + 1));
  }
  if (connectAccepted && online) {
    try {
      await AsyncStorage.setItem(LAST_HOST_KEY, hp);
      await AsyncStorage.setItem(LAST_SERIAL_KEY, hp);
    } catch {
      /* ignore */
    }
  }
  return {
    ok: online,
    message: online ? `Подключено: ${hp}` : connectAccepted ? `ADB принял connect, но устройство не появилось в состоянии device: ${hp}` : humanizeAdbError(out),
    detail: out.slice(0, 600),
    devices: listed.devices,
  };
}

export async function loadLastAdbHost(): Promise<string> {
  try {
    return (await AsyncStorage.getItem(LAST_HOST_KEY)) || "";
  } catch {
    return "";
  }
}

export async function loadLastAdbSerial(): Promise<string> {
  try {
    return (await AsyncStorage.getItem(LAST_SERIAL_KEY)) || "";
  } catch {
    return "";
  }
}

/** Guide text for UI */
export function adbWizardHelp(language: "ru" | "uk" | "en"): string {
  const texts = {
    ru:
      "1) На телефоне: Параметры → Для разработчиков → Беспроводная отладка.\n" +
      "2) «Пара устройства с кодом» → IP:порт_сопряжения + 6-значный код → Pair.\n" +
      "3) На том же экране IP:порт_подключения → Connect.\n" +
      "USB: включите отладку по USB и нажмите «Список устройств».",
    uk:
      "1) Для розробників → Бездротове налагодження.\n" +
      "2) Пара з кодом → Pair.\n" +
      "3) IP:порт підключення → Connect. Або USB.",
    en:
      "1) Developer options → Wireless debugging.\n" +
      "2) Pair with code → Pair.\n" +
      "3) Use connect IP:port → Connect. Or USB + List devices.",
  };
  return texts[language] || texts.en;
}
