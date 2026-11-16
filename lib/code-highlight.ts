/**
 * Лёгкая подсветка синтаксиса для блоков кода в чате — без дополнительных
 * нативных зависимостей (в проекте нет react-native-syntax-highlighter и
 * подобных пакетов, а добавлять новый нативный модуль в офлайн-среде без
 * доступа в интернет для `pnpm install` рискованно). Вместо этого — простой
 * токенайзер на регулярках, покрывающий Java/Kotlin, C/C++, XML/HTML,
 * Smali, JS/TS, Python и несколько похожих языков.
 *
 * Это не полноценный парсер (не понимает вложенность строк/шаблонов на
 * 100%), но для читаемости кода в чате (ключевые слова, строки, числа,
 * комментарии) этого достаточно.
 */

export type TokenKind =
  | "plain"
  | "keyword"
  | "string"
  | "comment"
  | "number"
  | "type"
  | "tag"
  | "attr"
  | "directive";

export interface HighlightToken {
  text: string;
  kind: TokenKind;
}

const C_FAMILY_KEYWORDS = new Set([
  // Java / Kotlin / C / C++ / JS / TS — общий костяк ключевых слов
  "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char",
  "class", "const", "continue", "default", "do", "double", "else", "enum",
  "extends", "final", "finally", "float", "for", "goto", "if", "implements",
  "import", "instanceof", "int", "interface", "long", "native", "new",
  "package", "private", "protected", "public", "return", "short", "static",
  "strictfp", "super", "switch", "synchronized", "this", "throw", "throws",
  "transient", "try", "void", "volatile", "while", "var", "val", "fun",
  "when", "is", "as", "object", "companion", "data", "sealed", "override",
  "internal", "lateinit", "suspend", "let", "vararg", "typealias",
  "true", "false", "null", "nullptr", "namespace", "template", "typename",
  "using", "struct", "union", "auto", "constexpr", "override", "virtual",
  "friend", "operator", "explicit", "inline", "mutable", "delete", "sizeof",
  "function", "export", "extends", "implements", "async", "await", "yield",
  "let", "const", "type", "interface", "enum", "readonly", "public",
  "private", "protected", "declare", "module", "namespace", "in", "of",
]);

const C_FAMILY_TYPES = new Set([
  "String", "Integer", "Boolean", "Double", "Float", "Long", "Short", "Byte",
  "Object", "List", "Map", "Set", "Array", "ArrayList", "HashMap", "Bundle",
  "Intent", "Activity", "Context", "View", "TextView", "Button", "Runnable",
  "size_t", "uint8_t", "int32_t", "int64_t", "std", "vector", "string",
  "number", "any", "unknown", "void", "never",
]);

const PYTHON_KEYWORDS = new Set([
  "def", "class", "import", "from", "as", "return", "if", "elif", "else",
  "for", "while", "in", "is", "not", "and", "or", "try", "except", "finally",
  "with", "lambda", "pass", "break", "continue", "yield", "global",
  "nonlocal", "assert", "del", "raise", "async", "await", "True", "False",
  "None", "self",
]);

const SMALI_KEYWORDS = new Set([
  "invoke-virtual", "invoke-direct", "invoke-static", "invoke-super",
  "invoke-interface", "move-result", "move-result-object", "move-result-wide",
  "return", "return-void", "return-object", "return-wide", "const",
  "const-string", "const/4", "const/16", "goto", "if-eqz", "if-nez",
  "if-eq", "if-ne", "if-lt", "if-ge", "new-instance", "new-array",
  "check-cast", "instance-of", "iget", "iput", "sget", "sput", "aget",
  "aput", "monitor-enter", "monitor-exit", "throw", "nop",
]);

const SMALI_DIRECTIVES = new Set([
  ".class", ".super", ".source", ".method", ".end", ".field", ".locals",
  ".param", ".prologue", ".line", ".implements", ".annotation",
  ".registers", ".catch",
]);

function langFamily(lang: string): "c" | "xml" | "smali" | "python" | "plain" {
  const l = lang.toLowerCase().trim();
  if (["java", "kotlin", "kt", "c", "cpp", "c++", "cc", "h", "hpp", "js",
       "jsx", "ts", "tsx", "javascript", "typescript", "swift", "go", "rs",
       "rust", "cs", "csharp", "groovy", "gradle"].includes(l)) {
    return "c";
  }
  if (["xml", "html", "htm", "manifest", "layout", "svg"].includes(l)) return "xml";
  if (["smali"].includes(l)) return "smali";
  if (["py", "python"].includes(l)) return "python";
  return "plain";
}

/** Общая токенизация строк/комментариев/чисел, используется всеми "c-подобными" языками. */
function tokenizeGeneric(
  code: string,
  keywords: Set<string>,
  types: Set<string>,
  opts: { hashComments?: boolean } = {}
): HighlightToken[] {
  const tokens: HighlightToken[] = [];
  // Порядок важен: сначала комментарии/строки (чтобы не подсвечивать
  // ключевые слова внутри них), затем числа, затем идентификаторы.
  const pattern = opts.hashComments
    ? /(\/\/[^\n]*|#[^\n]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b)/g
    : /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d+(?:\.\d+[fFdD]?)?[lLfFdD]?\b|\b[A-Za-z_][A-Za-z0-9_]*\b)/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ text: code.slice(lastIndex, match.index), kind: "plain" });
    }
    const text = match[0];
    let kind: TokenKind = "plain";
    if (text.startsWith("//") || text.startsWith("/*") || text.startsWith("#")) {
      kind = "comment";
    } else if (text.startsWith('"') || text.startsWith("'") || text.startsWith("`")) {
      kind = "string";
    } else if (/^\d/.test(text)) {
      kind = "number";
    } else if (keywords.has(text)) {
      kind = "keyword";
    } else if (types.has(text)) {
      kind = "type";
    }
    tokens.push({ text, kind });
    lastIndex = match.index + text.length;
  }
  if (lastIndex < code.length) {
    tokens.push({ text: code.slice(lastIndex), kind: "plain" });
  }
  return tokens;
}

function tokenizeXml(code: string): HighlightToken[] {
  const tokens: HighlightToken[] = [];
  const pattern = /(<!--[\s\S]*?-->|<\/?[a-zA-Z][\w:.-]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[a-zA-Z_:][\w:.-]*=|\/?>)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ text: code.slice(lastIndex, match.index), kind: "plain" });
    }
    const text = match[0];
    let kind: TokenKind = "plain";
    if (text.startsWith("<!--")) kind = "comment";
    else if (text.startsWith("<")) kind = "tag";
    else if (text.startsWith('"') || text.startsWith("'")) kind = "string";
    else if (text.endsWith("=")) kind = "attr";
    else kind = "plain";
    tokens.push({ text, kind });
    lastIndex = match.index + text.length;
  }
  if (lastIndex < code.length) tokens.push({ text: code.slice(lastIndex), kind: "plain" });
  return tokens;
}

function tokenizeSmali(code: string): HighlightToken[] {
  const tokens: HighlightToken[] = [];
  const pattern = /(#[^\n]*|"(?:[^"\\]|\\.)*"|\.\.?[A-Za-z][\w-]*|\b[A-Za-z][\w-]*(?:\/[A-Za-z][\w-]*)*\b|[vp]\d+)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ text: code.slice(lastIndex, match.index), kind: "plain" });
    }
    const text = match[0];
    let kind: TokenKind = "plain";
    if (text.startsWith("#")) kind = "comment";
    else if (text.startsWith('"')) kind = "string";
    else if (SMALI_DIRECTIVES.has(text) || (text.startsWith(".") && text.length > 1)) kind = "directive";
    else if (SMALI_KEYWORDS.has(text)) kind = "keyword";
    else if (/^[vp]\d+$/.test(text)) kind = "type";
    tokens.push({ text, kind });
    lastIndex = match.index + text.length;
  }
  if (lastIndex < code.length) tokens.push({ text: code.slice(lastIndex), kind: "plain" });
  return tokens;
}

/** Разбивает код на подсвеченные токены по языку (из info-строки ```lang). */
export function highlightCode(code: string, lang: string): HighlightToken[] {
  const family = langFamily(lang);
  switch (family) {
    case "c":
      return tokenizeGeneric(code, C_FAMILY_KEYWORDS, C_FAMILY_TYPES);
    case "python":
      return tokenizeGeneric(code, PYTHON_KEYWORDS, new Set(), { hashComments: true });
    case "xml":
      return tokenizeXml(code);
    case "smali":
      return tokenizeSmali(code);
    default:
      return [{ text: code, kind: "plain" }];
  }
}

import { GOLD } from "../theme/colors";

/** Цвета токенов для тёмной темы приложения (см. theme/colors.ts). */
export const TOKEN_COLORS: Record<TokenKind, string> = {
  plain: "#E2E2E6",
  keyword: "#F472B6",
  string: "#4ADE80",
  comment: "#9AA3AC",
  number: GOLD,
  type: "#9FCBFF",
  tag: "#F472B6",
  attr: "#9FCBFF",
  directive: "#A78BFA",
};
