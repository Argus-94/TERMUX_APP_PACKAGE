/**
 * Минимальный разбор сообщений чата: находит блоки кода в тройных
 * обратных кавычках (```java ... ```) и отделяет их от обычного текста,
 * чтобы код можно было отрисовать отдельным компонентом (моноширинный
 * шрифт, подсветка синтаксиса, кнопка "Копировать код") — см.
 * components/CodeBlock.tsx и components/MessageContent.tsx.
 */

export interface TextBlock {
  type: "text";
  content: string;
}

export interface CodeBlockData {
  type: "code";
  lang: string;
  content: string;
}

export type MessageBlock = TextBlock | CodeBlockData;

const FENCE_RE = /```([a-zA-Z0-9_+#-]*)\n?([\s\S]*?)```/g;

export function splitMessageIntoBlocks(content: string): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  FENCE_RE.lastIndex = 0;
  while ((match = FENCE_RE.exec(content)) !== null) {
    if (match.index > lastIndex) {
      const text = content.slice(lastIndex, match.index);
      if (text.trim().length > 0) blocks.push({ type: "text", content: text });
    }
    const lang = (match[1] || "").trim() || "text";
    const code = match[2].replace(/\n$/, "");
    blocks.push({ type: "code", lang, content: code });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    let text = content.slice(lastIndex);
    // Незакрытый ```... — не раздувать весь хвост как код
    const open = text.match(/^```([a-zA-Z0-9_+#-]*)\n?([\s\S]*)$/);
    if (open) {
      const lang = (open[1] || "").trim() || "text";
      let code = open[2] || "";
      // ограничим визуальный объём незакрытого блока
      const lines = code.split("\n");
      if (lines.length > 40) code = lines.slice(0, 40).join("\n") + "\n…";
      blocks.push({ type: "code", lang, content: code.replace(/\n$/, "") });
    } else if (text.trim().length > 0 || blocks.length === 0) {
      blocks.push({ type: "text", content: text });
    }
  }

  return blocks;
}
