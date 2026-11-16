/** Pure text-protocol helpers for the Termux agent.
 * Kept separate from execution/orchestration so parsing and sanitization can
 * be tested without touching the Android/Termux runtime.
 */

export const RUN_MARKER = "TERMUX_RUN:";
export const DONE_MARKER = "TERMUX_DONE:";
/** Backend-aware aliases (same semantics as TERMUX_*). */
export const RUN_MARKER_ALIASES = ["TERMUX_RUN:", "UBUNTU_RUN:", "UBUNTU_RUN:"] as const;
export const DONE_MARKER_ALIASES = ["TERMUX_DONE:", "UBUNTU_DONE:", "UBUNTU_DONE:"] as const;
const RUN_MARKER_RE = /(?:^|\n)\s*\*{0,3}\s*(?:TERMUX|UBUNTU|DEBIAN)_RUN\s*:/i;
const DONE_MARKER_RE = /(?:^|\n)\s*\*{0,3}\s*(?:TERMUX|UBUNTU|DEBIAN)_DONE\s*:/i;

const MAX_OUTPUT_CHARS = 1400;
const MAX_LOG_CHARS = 500_000;

type ParsedReply =
  | { kind: "run"; command: string }
  | { kind: "final"; message: string };

export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  return fenced ? fenced[1] : trimmed;
}

/** Only a whole-response, single-object AIB_TOOL envelope is executable. */
export function extractMarkedAibToolPayload(reply: string): string | null {
  const match = String(reply || "").match(/^\s*\*{0,3}\s*AIB_TOOL\s*:\s*([\s\S]*?)\s*\*{0,3}\s*$/i);
  if (!match) return null;
  const payload = stripCodeFence(match[1].trim());
  if (!payload.startsWith("{") || !payload.endsWith("}")) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < payload.length; i += 1) {
    const ch = payload[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth < 0 || (depth === 0 && i !== payload.length - 1)) return null;
    }
  }
  return depth === 0 && !quoted ? payload : null;
}

/** Detect model JSON that resembles an agent tool call but lacks AIB_TOOL:. */
export function isUnmarkedJsonToolCall(reply: string): boolean {
  const text = stripCodeFence(String(reply || "").trim());
  if (!text || /(?:^|\n)\s*AIB_TOOL\s*:/i.test(text)) return false;
  if (!/^\s*\{[\s\S]*\}\s*$/.test(text)) return false;
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const candidate = value as Record<string, unknown>;
    return typeof candidate.tool === "string" && candidate.tool.trim().length > 0;
  } catch {
    return false;
  }
}

/** A tool-shaped JSON object without the machine marker is data, never a call. */
export function unmarkedJsonToolProtocolHint(reply: string): string {
  return isUnmarkedJsonToolCall(reply)
    ? "Unmarked JSON tool-call payload detected: it was not executed; the AIB_TOOL: marker and validated tool schema are required."
    : "Required agent protocol marker is missing; no command or tool call was executed from this reply.";
}

export function shouldRetryInvalidAgentProtocolReply(invalidReplyCount: number): boolean {
  return Number.isFinite(invalidReplyCount) && invalidReplyCount < MAX_INVALID_AGENT_PROTOCOL_REPLIES;
}

export function sanitizeShellCommand(cmd: string): string {
  let c = (cmd || "").trim();
  if (!c) return c;
  // reasoning / think-блоки free-моделей (Laguna и др.)
  c = c.replace(/<\/?think>/gi, "\n");
  c = c.replace(/<\/?thinking>/gi, "\n");
  // markdown fences around the whole command
  c = c.replace(/^```[a-zA-Z]*\s*/i, "").replace(/\s*```$/i, "");
  c = c.replace(/^```[a-zA-Z]*\n?/gm, "").replace(/^```\s*$/gm, "");
  // второй RUN-маркер в том же ответе — обрезать
  const secondRun = c.search(/\n\s*(?:TERMUX|UBUNTU|DEBIAN)_RUN\s*:/i);
  if (secondRun !== -1) c = c.slice(0, secondRun);
  // XML / tool-calling мусор
  c = c.replace(/<\/?arg_value\b[^>]*>[\s\S]*/gi, "");
  c = c.replace(/<\/?tool_call\b[^>]*>[\s\S]*/gi, "");
  c = c.replace(/<\/?[a-zA-Z][\w:-]*\b[^>]*>/g, " ");
  // ведущие **TERMUX** / markdown bold
  c = c.replace(/^\*+\s*/gm, "");
  c = c.replace(/\s*\*+$/gm, "");
  // Never truncate a live Gradle build with `| head`/`| tail`: that can
  // send SIGPIPE to Gradle and make a real build look failed or incomplete.
  if (/(?:gradlew|gradle)\b.*\b(?:assemble|bundle|build)\b/i.test(c)) {
    c = c.replace(/\s+2>&1\s*\|\s*(?:head|tail)\b[^;]*/gi, " 2>&1");
    c = c.replace(/\s*\|\s*(?:head|tail)\s+-?\d+\b[^;]*/gi, "");
  }

  // Do not silently rewrite foreign application namespaces into executable paths.
  // строки только из * или пустые маркеры
  c = c
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => {
      const s = l.trim();
      if (!s) return false;
      if (/^\*+$/.test(s)) return false;
      if (/^TERMUX_(RUN|DONE)\s*:/i.test(s)) return false;
      if (/^\[TERMUX_RESULT\]/i.test(s)) return false;
      if (/^Can you provide/i.test(s)) return false;
      if (/gut feeling/i.test(s)) return false;
      return true;
    })
    .join("\n")
    .trim();

  // Offline/free models often paste reasoning as the "command". Reject it.
  if (
    /\b(we need to|We need craft|Need craft final|could output|need ensure|need formulate|need inspect|I need to|let'?s research|prior command likely|cpa_final_answer|CPA_DONE|need produce exactly|transcript expects)\b/i.test(c) ||
    /\b(Need understand|Could write script|We can create command|AUTONOMOUS REPAIR)\b/i.test(c) ||
    (c.length > 800 && /\b(because|however|therefore|perhaps)\b/i.test(c) && !/\b(cd|mkdir|unzip|gradlew|pkg)\b/i.test(c))
  ) {
    return "";
  }
  // Placeholder ellipsis commands from truncated model output
  if (/\bSRC=\.\.\.|WORK=\.\.\.|mkdir -p \.\.\./i.test(c)) {
    return "";
  }

  // A-08: never download an unpinned NDK directly from the model-generated command path.
  // NDK installation is allowed only through the verified tool-pack downloader.
  if (
    /android-ndk-r\d+.*linux\.zip|repository\/android-ndk.*linux|prebuilt\/linux-x86_64/i.test(c) ||
    (/dl\.google\.com\/android\/repository\/android-ndk/i.test(c) && /linux/i.test(c)) ||
    (/sdkmanager/i.test(c) && /ndk(?:;|"|\s|$)/i.test(c) && !/aarch64/i.test(c))
  ) {
    c = 'echo "BLOCKED: NDK download requires a pinned SHA-256 verified tool-pack installation; direct model-generated NDK downloads are disabled." >&2; exit 2';
    return c;
  }

  // Отсечь явный desktop/PC мусор (не Android/Termux)
  if (
    /ubuntu\.com|debian\.org\/.*amd64|packages\.microsoft\.com|snap install|apt-get install|yum install|dnf install|brew install|choco install|winget /i.test(
      c
    ) ||
    /linux-amd64\.tar|linux-x86_64\.tar|x86_64-unknown-linux|x86_64-linux-gnu|windows-x86|darwin-x64|macos-arm64(?!.*android)/i.test(
      c
    )
  ) {
    c =
      'echo "BLOCKED: desktop/PC package not for Termux Android. Use: pkg install <name> or Android aarch64 builds only." >&2; exit 2';
    return c;
  }

  // Free-модели зацикливают echo лицензий SDK на тысячи строк → timeout 10 мин
  if ((c.match(/licenses\//g) || []).length >= 4 || c.length > 1800) {
    if (/licenses\/|android-sdk-license|mips-abis/i.test(c)) {
      c =
        'SDK="${ANDROID_HOME:-$PREFIX/opt/android-sdk}"; mkdir -p "$SDK/licenses"; ' +
        'printf "%s\\n" "24333f8a63b6825ea9c5514f83c2829b004d1fee" > "$SDK/licenses/android-sdk-license"; ' +
        'printf "%s\\n" "84831b9409646a918e30573bab4c9c91346d8abd" > "$SDK/licenses/android-sdk-preview-license"; ' +
        'echo LICENSES_OK';
    } else if (c.length > 2500) {
      c = c.slice(0, 2500);
    }
  }
  return c;
}

export function parseEmbeddedToolCall(text: string): string | null {
  // Некоторые OpenRouter free-модели игнорируют наш текстовый протокол и
  // возвращают собственный pseudo-tool-call: 
  // <|tool_call_start|>[termux_run(command='...')]<|tool_call_end|>
  // Такой ответ нельзя считать финальным: извлекаем только реальную команду.
  const marker = /termux_run\s*\(\s*command\s*=\s*(['"])/i.exec(text || "");
  if (!marker || marker.index == null) return null;
  const start = marker.index + marker[0].length;
  const quote = marker[1];
  let escaped = false;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === quote) {
      const tail = text.slice(i + 1);
      if (/^\s*\)\s*(?:\]|<\|tool_call_end\|>|$)/i.test(tail)) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;
  const raw = text.slice(start, end);
  return raw
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\(['"])/g, "$1")
    .replace(/\\\\/g, "\\");
}

export function parseAgentReply(reply: string): ParsedReply {
  // Убрать think-блоки до поиска маркеров
  const normalized = (reply || "")
    .replace(/^\uFEFF/, "")
    .replace(/<\/?think>/gi, "\n")
    .replace(/<\/?thinking>/gi, "\n");

  const embeddedTool = parseEmbeddedToolCall(normalized);
  if (embeddedTool) {
    return { kind: "run", command: sanitizeShellCommand(embeddedTool) };
  }
  // Case-insensitive marker search (offline models vary casing / spacing)
  const runMatch = normalized.match(RUN_MARKER_RE);
  const doneMatch = normalized.match(DONE_MARKER_RE);
  const runIndex = runMatch && runMatch.index !== undefined ? runMatch.index : -1;
  const doneIndex = doneMatch && doneMatch.index !== undefined ? doneMatch.index : -1;
  if (runIndex !== -1 && (doneIndex === -1 || runIndex < doneIndex)) {
    const markerEnd = (runMatch?.index ?? runIndex) + (runMatch?.[0].length ?? RUN_MARKER.length);
    let payload = normalized.slice(markerEnd);
    // Модель иногда «склеивает» команду и итог в одном ответе:
    //   TERMUX_RUN:\ntouch ...\n\nTERMUX_DONE:\nФайл создан
    // В bash это превращается в «TERMUX_DONE:: command not found».
    // Обрезаем всё начиная с любого *_DONE: — итог придёт после результата.
    const nestedDone = payload.search(/(?:^|\n)\s*(?:TERMUX|UBUNTU|DEBIAN)_DONE\s*:/i);
    if (nestedDone !== -1) {
      payload = payload.slice(0, nestedDone);
    }
    // Дубль RUN-маркера (после </think>) — только первая команда
    const nestedRun = payload.search(/\n\s*(?:TERMUX|UBUNTU|DEBIAN)_RUN\s*:/i);
    if (nestedRun !== -1) {
      payload = payload.slice(0, nestedRun);
    }
    // Берём только первую непустую строку / блок до пустой строки —
    // остальной текст модели (пояснения) в bash не отправляем.
    const cleaned = stripCodeFence(payload)
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => {
        const s = l.trim();
        // Модель иногда вставляет RUN/DONE-маркеры внутрь блока команды
        if (/^(?:TERMUX|UBUNTU|DEBIAN)_(?:RUN|DONE)\s*:/i.test(s)) return false;
        if (/^\[TERMUX_RESULT\]/i.test(s)) return false;
        return true;
      })
      .filter((l, i, arr) => {
        if (l.trim()) return true;
        return arr.slice(i + 1).some((x) => x.trim());
      })
      .join("\n")
      .trim();
    // Если после TERMUX_RUN: остался только человеческий текст без
    // признаков shell-команды — лучше отдать как финальный ответ.
    if (!cleaned) {
      if (doneIndex !== -1) {
        return {
          kind: "final",
          message: stripCodeFence(normalized.slice(doneIndex + DONE_MARKER.length)).trim(),
        };
      }
      return { kind: "final", message: normalized.trim() };
    }
    return { kind: "run", command: sanitizeShellCommand(cleaned) };
  }
  if (doneIndex !== -1) {
    const markerEnd = (doneMatch?.index ?? doneIndex) + (doneMatch?.[0].length ?? DONE_MARKER.length);
    const payload = normalized.slice(markerEnd);
    return { kind: "final", message: stripCodeFence(payload).trim() };
  }
  // Модель ответила в обычном формате (без протокола) — считаем это
  // финальным ответом, чтобы простые вопросы не "зависали" в цикле.
  return { kind: "final", message: normalized.trim() };
}

/** True when free models dump chat/reasoning instead of TERMUX_RUN/DONE. */
export function looksLikeProtocolViolation(text: string): boolean {
  const msg = (text || "").trim();
  if (!msg) return true;
  const hasMarkerLine = /^(?:TERMUX|UBUNTU|DEBIAN)_(?:RUN|DONE)\s*:/im.test(msg);
  if (hasMarkerLine) return false;
  if (msg.length > 400) return true;
  if (/\b(please provide|please note|I can'?t access|let'?s get started|step by step|we need to|формат відповіді)\b/i.test(msg)) {
    return true;
  }
  if (/\b(Can you provide|any specific instructions|full path to the zip)\b/i.test(msg)) {
    return true;
  }
  return !hasMarkerLine && msg.split("\n").length > 6;
}

export function isDirectSourceMutationCommand(command: string): boolean {

  const c = command.trim();
  // With Hashline enabled, TERMUX_RUN is strictly read-only for *project source*.
  // Shared Android storage (/storage, /sdcard, Download) is outside hashline scope —
  // agent may mkdir/printf there via shell (playbooks + LLM). Build/install still use build.run.
  if (!c) return true;
  if (/\/storage\/emulated\/\d+|\/sdcard\b/i.test(c)) return false;
  if (/[;&|`<>]|\$\(|\n|\r/.test(c)) return true;
  if (/\b(?:sed|perl)\s+.*(?:-i|--in-place)\b/i.test(c)) return true;
  if (/\b(?:python3?|node|ruby|php|deno|bun)\s+(?:-c|-e|--eval)\b/i.test(c)) return true;
  if (/\b(?:tee|dd|install|touch|truncate|mktemp)\b/i.test(c)) return true;
  if (/(?:^|\s)(?:rm|mv|cp|chmod|chown|ln)\b/i.test(c)) return true;
  if (/\bgit\s+(?:add|commit|reset|restore|checkout|clean|apply|am|cherry-pick|revert|merge|rebase)\b/i.test(c)) return true;
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|ci|add|remove|uninstall|update|upgrade)\b/i.test(c)) return true;
  // Mutating build/install commands are deliberately routed through build.run.
  if (/^(?:\.?\/?gradlew(?:\.bat)?|gradle|npx\s+expo|expo|npm|pnpm|yarn|bun)\b/i.test(c) && /(?:assemble|bundle|clean|test|check|lint|prebuild|run:android|export|install|ci\b|add\b|remove\b|rebuild)/i.test(c)) return true;
  if (/\b(?:cat|printf|echo)\b[\s\S]*\>/.test(c)) return true;
  return false;
}

export function truncate(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `\n… (обрезано, ещё ${text.length - limit} симв.)`;
}

/** Full text for AI Builder Log. Persistent logger splits oversized entries. */
export function logTruncate(text: string): string {
  return text ?? "";
}

export function commandFingerprint(cmd: string): string {
  return cmd
    .replace(/["']/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .toLowerCase();
}
export const MAX_INVALID_AGENT_PROTOCOL_REPLIES = 3;
