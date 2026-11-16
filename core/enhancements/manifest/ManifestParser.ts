import { ManifestError, type RuntimeManifest } from "./types";
import { validateManifest } from "./RuntimeManifest";

type Line = { indent: number; text: string; number: number };
function colonIndex(text: string): number {
  let quote: string | null = null; let escaped = false;
  for (let i = 0; i < text.length; i++) { const c = text[i]; if (escaped) { escaped = false; continue; } if (c === "\\" && quote === '"') { escaped = true; continue; } if (quote) { if (c === quote) quote = null; continue; } if (c === '"' || c === "'") { quote = c; continue; } if (c === ":") return i; }
  return -1;
}
function scalar(source: string): unknown {
  const text = source.trim();
  if (!text) return null;
  if (/^(?:!|&|\*|<<\s*:)/.test(text) || /[|>]\s*$/.test(text)) throw new Error("unsupported YAML feature");
  if (text === "true") return true; if (text === "false") return false; if (/^(?:null|~)$/.test(text)) return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return Number(text);
  if (text.startsWith('"')) return JSON.parse(text);
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) throw new Error("unterminated quote");
    const inner = text.slice(1, -1);
    let decoded = "";
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === "'") {
        if (inner[i + 1] !== "'") throw new Error("unescaped single quote");
        decoded += "'";
        i++;
      } else decoded += inner[i];
    }
    return decoded;
  }
  if (/^[\[{]/.test(text)) throw new Error("inline collection not supported");
  return text.replace(/\s+#.*$/, "").trim();
}
function stripComment(text: string): string {
  let quote: string | null = null; let escaped = false;
  for (let i = 0; i < text.length; i++) { const c = text[i]; if (escaped) { escaped = false; continue; } if (c === "\\" && quote === '"') { escaped = true; continue; } if (quote) { if (c === quote) quote = null; continue; } if (c === '"' || c === "'") quote = c; else if (c === "#" && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i).trimEnd(); }
  return text.trimEnd();
}
function parseYaml(source: string): unknown {
  const lines: Line[] = [];
  source.split(/\r?\n/).forEach((raw, i) => { if (raw.includes("\t")) throw new Error(`tab indentation at line ${i + 1}`); const trimmed = stripComment(raw); if (!trimmed.trim() || /^\s*---\s*$/.test(trimmed)) return; const indent = trimmed.length - trimmed.trimStart().length; lines.push({ indent, text: trimmed.trimStart(), number: i + 1 }); });
  if (!lines.length) throw new Error("empty manifest");
  const pair = (target: Record<string, unknown>, text: string, line: Line, mapIndent: number, nextIndex: number): number => {
    const at = colonIndex(text); if (at <= 0) throw new Error(`expected key:value at line ${line.number}`);
    const rawKey = text.slice(0, at).trim(); const keyValue = scalar(rawKey); if (typeof keyValue !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(keyValue)) throw new Error(`invalid key at line ${line.number}`);
    if (Object.prototype.hasOwnProperty.call(target, keyValue)) throw new Error(`duplicate key at line ${line.number}`);
    const rest = text.slice(at + 1).trim();
    if (rest) { target[keyValue] = scalar(rest); return nextIndex; }
    if (nextIndex < lines.length && lines[nextIndex].indent > mapIndent) { const parsed = block(nextIndex, lines[nextIndex].indent); target[keyValue] = parsed.value; return parsed.next; }
    target[keyValue] = null; return nextIndex;
  };
  const block = (start: number, indent: number): { value: unknown; next: number } => {
    const sequence = lines[start].text === "-" || lines[start].text.startsWith("- ");
    if (sequence) {
      const arr: unknown[] = []; let i = start;
      while (i < lines.length && lines[i].indent === indent && (lines[i].text === "-" || lines[i].text.startsWith("- "))) {
        const line = lines[i]; const rest = line.text === "-" ? "" : line.text.slice(2).trim(); i++;
        if (!rest) { if (i < lines.length && lines[i].indent > indent) { const child = block(i, lines[i].indent); arr.push(child.value); i = child.next; } else arr.push(null); continue; }
        const at = colonIndex(rest);
        if (at > 0) {
          const obj: Record<string, unknown> = {}; i = pair(obj, rest, line, indent + 2, i);
          while (i < lines.length && lines[i].indent === indent + 2 && !(lines[i].text === "-" || lines[i].text.startsWith("- "))) { const next = lines[i]; i = pair(obj, next.text, next, indent + 2, i + 1); }
          arr.push(obj);
        } else arr.push(scalar(rest));
      }
      return { value: arr, next: i };
    }
    const obj: Record<string, unknown> = {}; let i = start;
    while (i < lines.length && lines[i].indent === indent && !(lines[i].text === "-" || lines[i].text.startsWith("- "))) { const line = lines[i]; i = pair(obj, line.text, line, indent, i + 1); }
    return { value: obj, next: i };
  };
  if (lines[0].indent !== 0) throw new Error(`root indentation must be zero (line ${lines[0].number})`);
  const parsed = block(0, 0); if (parsed.next !== lines.length) throw new Error(`unexpected indentation at line ${lines[parsed.next].number}`); return parsed.value;
}

/** Parse JSON or the intentionally small, non-executable YAML subset used by AI Builder. */
export function parseManifest(yamlOrJson: string): RuntimeManifest {
  let value: unknown;
  try { value = yamlOrJson.trim().startsWith("{") ? JSON.parse(yamlOrJson) : parseYaml(yamlOrJson); }
  catch { throw new ManifestError("PARSE_FAILED", "Manifest syntax is invalid or uses unsupported YAML features"); }
  const result = validateManifest(value);
  if (!result.ok) throw new ManifestError("VALIDATION_FAILED", "Manifest failed schema validation", result.issues);
  return value as RuntimeManifest;
}
