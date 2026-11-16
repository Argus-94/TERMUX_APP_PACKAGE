import { memo, useMemo } from "react";
import { View, Text, StyleSheet, Platform } from "react-native";
import { splitMessageIntoBlocks } from "../lib/markdown-lite";
import { CodeBlock } from "./CodeBlock";

interface Props {
  content: string;
  textColor: string;
}

const MONOSPACE = Platform.select({ android: "monospace", ios: "Menlo", default: "monospace" });

// Разбивает обычный текстовый кусок на сегменты вокруг `инлайн-кода`,
// чтобы короткие фрагменты кода в середине предложения тоже были
// моноширинными — без полноценного блока с кнопкой копирования.
function renderInlineText(text: string, textColor: string, keyPrefix: string) {
  const parts = text.split(/(`[^`\n]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      return (
        <Text key={`${keyPrefix}-${i}`} style={[styles.inlineCode, { color: textColor }]}>
          {part.slice(1, -1)}
        </Text>
      );
    }
    return <Text key={`${keyPrefix}-${i}`}>{part}</Text>;
  });
}

/**
 * Поддержка отображения кода (Java, XML, Smali, C/C++ и т.д.) в окне
 * вопроса/ответа: сообщение разбирается на обычный текст и блоки ```lang```,
 * текст выводится как выделяемый (selectable) — это даёт нативное
 * копирование как отдельного слова (двойной тап), так и произвольного
 * выделения (см. системное меню "Копировать"), а код — отдельным
 * компонентом с подсветкой синтаксиса и своей кнопкой копирования.
 */
export const MessageContent = memo(function MessageContent({ content, textColor }: Props) {
  // useMemo — без него разбор на блоки кода/текста (регулярками, см.
  // lib/markdown-lite.ts) пересчитывался бы заново при каждом рендере, даже
  // если сам текст сообщения не менялся. Для длинных ответов с несколькими
  // блоками кода это заметная лишняя работа на каждый чих родителя.
  const blocks = useMemo(() => splitMessageIntoBlocks(content), [content]);

  return (
    <View>
      {blocks.map((block, i) =>
        block.type === "code" ? (
          <CodeBlock key={i} lang={block.lang} code={block.content} />
        ) : (
          <Text key={i} selectable style={[styles.text, { color: textColor }]}>
            {renderInlineText(block.content.trim(), textColor, String(i))}
          </Text>
        )
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  text: { fontSize: 14, lineHeight: 20 },
  inlineCode: {
    fontFamily: MONOSPACE,
    fontSize: 13,
    backgroundColor: "rgba(148, 163, 184, 0.15)",
    borderRadius: 4,
  },
});
