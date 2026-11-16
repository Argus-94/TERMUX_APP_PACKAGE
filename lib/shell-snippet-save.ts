/** Safe shell-command builder for copying a code snippet into Termux. */

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function base64EncodeUtf8(value: string): string {
  const bytes = unescape(encodeURIComponent(value));
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes.charCodeAt(i);
    const hasB = i + 1 < bytes.length;
    const hasC = i + 2 < bytes.length;
    const b = hasB ? bytes.charCodeAt(i + 1) : 0;
    const c = hasC ? bytes.charCodeAt(i + 2) : 0;
    out += alphabet[a >> 2];
    out += alphabet[((a & 3) << 4) | (b >> 4)];
    out += hasB ? alphabet[((b & 15) << 2) | (c >> 6)] : "=";
    out += hasC ? alphabet[c & 63] : "=";
  }
  return out;
}

/** The snippet is data, never shell source; the destination is POSIX-quoted. */
export function buildSaveSnippetCommand(filePath: string, content: string): string {
  if (!filePath.startsWith("/") || filePath.includes("\0") || /[\r\n]/.test(filePath)) {
    throw new Error("SNIPPET_PATH_INVALID");
  }
  const slash = filePath.lastIndexOf("/");
  const directory = slash > 0 ? filePath.slice(0, slash) : "/";
  const encoded = base64EncodeUtf8(content);
  return `mkdir -p -- ${shellQuote(directory)} && printf '%s' '${encoded}' | base64 -d > ${shellQuote(filePath)}`;
}
