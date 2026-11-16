/**
 * Сжатый дайджест сессии — экономия токенов на длинных чатах.
 */

export interface DigestTurn {
  role: string;
  content: string;
}

const MAX_DIGEST_CHARS = 1800;

export function buildSessionDigest(messages: DigestTurn[]): string {
  if (messages.length < 12) return "";

  const older = messages.slice(0, -8);
  const bullets: string[] = [];
  const pathRe = /(?:\/[\w./~-]+|\b[\w-]+\.(?:kt|java|xml|gradle|kts|smali|apk|txt|py|js)\b)/gi;
  const paths = new Set<string>();

  for (const m of older) {
    const hits = m.content.match(pathRe);
    if (hits) hits.slice(0, 4).forEach((p) => paths.add(p));
  }

  // last user intents
  for (const m of older.filter((x) => x.role === "user").slice(-6)) {
    const line = m.content.replace(/\s+/g, " ").trim().slice(0, 120);
    if (line) bullets.push(`• USER: ${line}`);
  }
  for (const m of older.filter((x) => x.role === "assistant").slice(-4)) {
    const line = m.content.replace(/\s+/g, " ").trim().slice(0, 120);
    if (line) bullets.push(`• AI: ${line}`);
  }

  if (paths.size) {
    bullets.push(`• Paths/files: ${[...paths].slice(0, 20).join(", ")}`);
  }

  let text =
    "[SESSION_DIGEST — compressed earlier context; recent messages follow in full]\n" +
    bullets.join("\n");
  if (text.length > MAX_DIGEST_CHARS) {
    text = text.slice(0, MAX_DIGEST_CHARS) + "\n…";
  }
  return text;
}
