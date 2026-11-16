/**
 * Кодирование UTF-8 текста в base64 без Node.js API.
 *
 * React Native (Hermes) не имеет глобального `Buffer` — вызов `Buffer.from(...)`
 * в JS-коде приложения приводит к `ReferenceError` в рантайме. Это самодостаточная
 * реализация без внешних зависимостей и без опоры на `btoa`/`unescape` (которые
 * either отсутствуют, либо некорректно работают с многобайтовыми символами).
 */
export function utf8ToBase64(input: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    let code = input.codePointAt(i)!;
    if (code > 0xffff) i++; // символ вне BMP занял суррогатную пару — пропускаем вторую половину
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
  }

  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    result += chars[b0 >> 2];
    result += chars[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    result += b1 === undefined ? "=" : chars[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    result += b2 === undefined ? "=" : chars[b2 & 63];
  }
  return result;
}
