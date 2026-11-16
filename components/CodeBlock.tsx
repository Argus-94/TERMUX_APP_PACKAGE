import { useState, useCallback, useMemo, memo } from "react";
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Platform } from "react-native";
import * as Clipboard from "expo-clipboard";
import { highlightCode, TOKEN_COLORS } from "../lib/code-highlight";
import { useLanguage } from "./LanguageContext";
import { formatLayoutPreview, parseAndroidLayoutXml } from "../lib/layout-preview";
import { useProjectContext } from "./ProjectContext";
import { useDialog } from "./DialogContext";
import { buildSaveSnippetCommand } from "../lib/shell-snippet-save";


interface Props {
  lang: string;
  code: string;
}

const MONOSPACE = Platform.select({ android: "monospace", ios: "Menlo", default: "monospace" });

// memo() + useMemo(highlightCode) ниже — токенизация регулярками для
// подсветки синтаксиса самая "дорогая" операция на длинный код (много
// строк => много токенов => много вложенных <Text>). Без мемоизации она
// пересчитывалась на каждый рендер родителя, в том числе на каждое
// нажатие клавиши в поле ввода чата (см. app/index.tsx) — на длинных
// ответах именно это и превращало ввод текста в "зависание".
export const CodeBlock = memo(function CodeBlock({ lang, code }: Props) {
  const [copied, setCopied] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const { t } = useLanguage();
  const { project } = useProjectContext();
  const { showDialog } = useDialog();
  const tokens = useMemo(() => highlightCode(code, lang), [code, lang]);
  const canPreview =
    /xml/i.test(lang) &&
    /<(LinearLayout|ConstraintLayout|FrameLayout|RelativeLayout|ScrollView|androidx)/i.test(code) &&
    !!parseAndroidLayoutXml(code);
  const previewText = useMemo(
    () => (canPreview ? formatLayoutPreview(code) : ""),
    [canPreview, code]
  );

  const handleCopy = useCallback(async () => {
    await Clipboard.setStringAsync(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [code]);

  const handleSaveHint = useCallback(async () => {
    const base = project?.path || "/storage/emulated/0/AIBuilderTermux/app";
    const ext =
      /kotlin|kt/i.test(lang) ? "kt" :
      /java/i.test(lang) ? "java" :
      /xml/i.test(lang) ? "xml" :
      /gradle/i.test(lang) ? "gradle" :
      /python|py/i.test(lang) ? "py" :
      /js|ts/i.test(lang) ? "js" : "txt";
    const rel = `from-chat/snippet_${Date.now().toString(36)}.${ext}`;
    const full = `${base.replace(/\/+$/, "")}/${rel}`;
    const shell = buildSaveSnippetCommand(full, code);
    await Clipboard.setStringAsync(shell);
    showDialog(
      t("saveCodeTitle"),
      t("saveCodeBody", { path: full })
    );
  }, [code, lang, project, showDialog, t]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.lang}>{lang}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {canPreview && (
            <TouchableOpacity style={styles.copyBtn} onPress={() => setShowPreview((v) => !v)}>
              <Text style={styles.copyBtnText}>
                {showPreview ? t("layoutPreviewHide") : t("layoutPreviewShow")}
              </Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.copyBtn} onPress={handleSaveHint}>
            <Text style={styles.copyBtnText}>{t("saveCodeBtn")}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.copyBtn} onPress={handleCopy}>
            <Text style={styles.copyBtnText}>{copied ? t("codeCopied") : t("copyCode")}</Text>
          </TouchableOpacity>
        </View>
      </View>
      {showPreview && !!previewText && (
        <Text selectable style={[styles.code, { color: "#9AA3AC", paddingBottom: 4 }]}>
          {previewText}
        </Text>
      )}
      <ScrollView
        style={styles.codeScroll}
        nestedScrollEnabled
        showsVerticalScrollIndicator
        showsHorizontalScrollIndicator={false}
      >
        <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false}>
          <Text selectable style={styles.code}>
            {tokens.map((tok, i) => (
              <Text key={i} style={{ color: TOKEN_COLORS[tok.kind] }}>
                {tok.text}
              </Text>
            ))}
          </Text>
        </ScrollView>
      </ScrollView>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    backgroundColor: "#101418",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#3A4148",
    marginVertical: 6,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#181C20",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: "#3A4148",
  },
  lang: { color: "#9AA3AC", fontSize: 11, fontWeight: "700", textTransform: "uppercase" },
  copyBtn: { paddingHorizontal: 8, paddingVertical: 3 },
  copyBtnText: { color: "#9FCBFF", fontSize: 11, fontWeight: "600" },
  scroll: { maxWidth: "100%" },
  /** Не раздувать весь чат: длинный код скроллится внутри блока */
  codeScroll: {
    maxHeight: 220,
    maxWidth: "100%",
  },
  code: {
    fontFamily: MONOSPACE,
    fontSize: 12.5,
    lineHeight: 18,
    padding: 12,
  },
});
