import { DOMParser } from "@xmldom/xmldom";
import { strFromU8 } from "fflate";
import { extractSelectedZipEntries, type ZipByteSource } from "./archive-utils";

export interface ExtractedDocumentContent {
  text: string;
  summary: string;
  truncated: boolean;
}

const OUTPUT_LIMIT = 12_000;
const XML_PART_LIMIT = 2 * 1024 * 1024;
const DOX_TOTAL_LIMIT = 8 * 1024 * 1024;
const XLSX_TOTAL_LIMIT = 12 * 1024 * 1024;
const APK_TEXT_TOTAL_LIMIT = 2 * 1024 * 1024;
const GENERIC_ZIP_TOTAL_LIMIT = 512 * 1024;

type XmlNodeLike = {
  nodeType?: number;
  nodeName?: string;
  localName?: string | null;
  textContent?: string | null;
  childNodes?: { length: number; item(index: number): XmlNodeLike | null };
  getAttribute?: (name: string) => string | null;
};
type XmlListLike<T> = { length: number; item(index: number): T | null };
type XmlDocumentLike = XmlNodeLike & {
  documentElement?: XmlNodeLike;
  getElementsByTagName: (name: string) => XmlListLike<XmlNodeLike>;
};

class BoundedText {
  private readonly parts: string[] = [];
  private length = 0;
  truncated = false;

  constructor(private readonly maxLength: number) {}

  add(value: string): void {
    if (!value || this.length >= this.maxLength) {
      if (value) this.truncated = true;
      return;
    }
    const remaining = this.maxLength - this.length;
    if (value.length > remaining) {
      this.parts.push(value.slice(0, remaining));
      this.length += remaining;
      this.truncated = true;
      return;
    }
    this.parts.push(value);
    this.length += value.length;
  }

  value(): string {
    const body = this.parts.join("");
    return this.truncated ? `${body}\n[... извлечение ограничено безопасным лимитом ...]` : body;
  }
}

function localName(node: XmlNodeLike): string {
  const local = node.localName;
  if (typeof local === "string" && local) return local;
  return (node.nodeName || "").split(":").pop() || "";
}

function elementsByLocalName(root: XmlNodeLike, wanted: string): XmlNodeLike[] {
  const getElements = (root as XmlDocumentLike).getElementsByTagName;
  if (typeof getElements !== "function") return [];
  const nodes = getElements.call(root, "*");
  const matches: XmlNodeLike[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes.item(i);
    if (node && localName(node) === wanted) matches.push(node);
  }
  return matches;
}

function firstChildByLocalName(root: XmlNodeLike, wanted: string): XmlNodeLike | undefined {
  const children = root.childNodes;
  if (!children) return undefined;
  for (let i = 0; i < children.length; i++) {
    const node = children.item(i);
    if (node && localName(node) === wanted) return node;
  }
  return undefined;
}

function attribute(node: XmlNodeLike, name: string): string {
  if (typeof node.getAttribute !== "function") return "";
  return node.getAttribute(name) || "";
}

function parseXml(bytes: Uint8Array): XmlDocumentLike {
  if (bytes.byteLength === 0 || bytes.byteLength > XML_PART_LIMIT) throw new Error("XML_PART_SIZE_LIMIT");
  const xml = strFromU8(bytes);
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error("XML_DTD_UNSUPPORTED");
  let parseError = false;
  const parser = new DOMParser({
    onError: (level) => { if (level !== "warning") parseError = true; },
  });
  const document = parser.parseFromString(xml, "application/xml") as unknown as XmlDocumentLike;
  if (parseError || !document.documentElement || localName(document.documentElement) === "parsererror") throw new Error("XML_PARSE_FAILED");
  return document;
}

function collectTextChildren(root: XmlNodeLike, textName: string): string {
  const nodes = elementsByLocalName(root, textName);
  let out = "";
  for (const node of nodes) out += node.textContent || "";
  return out;
}

function collectWordInlineText(root: XmlNodeLike, output: string[]): void {
  const name = localName(root);
  if (name === "delText" || name === "instrText") return;
  if (name === "t") { output.push(root.textContent || ""); return; }
  if (name === "tab") { output.push("\t"); return; }
  if (name === "br" || name === "cr") { output.push("\n"); return; }
  const children = root.childNodes;
  if (!children) return;
  for (let i = 0; i < children.length; i++) {
    const child = children.item(i);
    if (child) collectWordInlineText(child, output);
  }
}

export async function extractDocxContent(source: ZipByteSource): Promise<ExtractedDocumentContent> {
  let chosen = 0;
  const result = await extractSelectedZipEntries(
    source,
    "zip",
    name => {
      const wanted = /^word\/(?:document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/i.test(name);
      if (!wanted || chosen >= 24) return false;
      chosen++;
      return true;
    },
    { maxEntries: 24, maxEntryBytes: XML_PART_LIMIT, maxTotalBytes: DOX_TOTAL_LIMIT },
  );
  if (!result.ok) return { text: "[DOCX: архив или выбранные XML-части не прошли локальные проверки; содержимое не извлечено.]", summary: "DOCX не удалось безопасно прочитать", truncated: false };
  const main = result.entries.get("word/document.xml");
  if (!main) return { text: "[DOCX: основной word/document.xml отсутствует; текст не извлечён.]", summary: "DOCX без основного текстового документа", truncated: false };

  const output = new BoundedText(OUTPUT_LIMIT);
  for (const [name, bytes] of result.entries) {
    let document: XmlDocumentLike;
    try { document = parseXml(bytes); }
    catch { return { text: "[DOCX: XML-часть повреждена или содержит неподдерживаемые конструкции; текст не извлечён.]", summary: "DOCX XML не прошёл проверку", truncated: false }; }
    const paragraphs = elementsByLocalName(document, "p");
    if (paragraphs.length === 0 && name === "word/document.xml") {
      const text = document.documentElement?.textContent || "";
      if (text.trim()) output.add(`${text}\n`);
    }
    for (const paragraph of paragraphs) {
      const pieces: string[] = [];
      collectWordInlineText(paragraph, pieces);
      const line = pieces.join("");
      if (line.trim()) output.add(`${line}\n`);
    }
    if (output.truncated) break;
  }
  if (!output.value().trim()) return { text: "[DOCX распознан, но извлекаемого цифрового текста не найдено. OCR не выполняется.]", summary: "DOCX: цифровой текст не найден", truncated: false };
  const text = output.value();
  return { text, summary: `DOCX: извлечён текст из ${result.entries.size} XML-частей`, truncated: output.truncated };
}

function safeWorksheetTarget(target: string): string | undefined {
  const normalized = target.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0") || normalized.split("/").some(part => part === "..")) return undefined;
  const path = normalized.startsWith("xl/") ? normalized : `xl/${normalized}`;
  return /^xl\/worksheets\/[A-Za-z0-9_.-]+\.xml$/i.test(path) ? path : undefined;
}

function shortCellText(value: string, limit = 500): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ").replace(/\s+/g, " ").slice(0, limit);
}

export async function extractXlsxContent(source: ZipByteSource): Promise<ExtractedDocumentContent> {
  const wantedNames = new Set(["xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/sharedStrings.xml"]);
  let chosen = 0;
  const result = await extractSelectedZipEntries(
    source,
    "zip",
    name => {
      const wanted = wantedNames.has(name) || /^xl\/worksheets\/[A-Za-z0-9_.-]+\.xml$/i.test(name);
      if (!wanted || chosen >= 64) return false;
      chosen++;
      return true;
    },
    { maxEntries: 64, maxEntryBytes: XML_PART_LIMIT, maxTotalBytes: XLSX_TOTAL_LIMIT },
  );
  if (!result.ok) return { text: "[XLSX: архив или выбранные workbook XML-части не прошли локальные проверки; содержимое не извлечено.]", summary: "XLSX не удалось безопасно прочитать", truncated: false };
  const workbookBytes = result.entries.get("xl/workbook.xml");
  const relBytes = result.entries.get("xl/_rels/workbook.xml.rels");
  if (!workbookBytes || !relBytes) return { text: "[XLSX: обязательные workbook XML-части отсутствуют; таблица не извлечена.]", summary: "XLSX неполный", truncated: false };

  try {
    const workbook = parseXml(workbookBytes);
    const rels = parseXml(relBytes);
    const targetById = new Map<string, string>();
    for (const relationship of elementsByLocalName(rels, "Relationship")) {
      const id = attribute(relationship, "Id");
      const target = attribute(relationship, "Target");
      if (id && target && id.length <= 128 && target.length <= 1024) targetById.set(id, target);
    }
    const sharedStrings: string[] = [];
    const sharedBytes = result.entries.get("xl/sharedStrings.xml");
    if (sharedBytes) {
      const sharedDoc = parseXml(sharedBytes);
      const items = elementsByLocalName(sharedDoc, "si");
      if (items.length > 100_000) throw new Error("SHARED_STRING_COUNT_LIMIT");
      for (const item of items) {
        sharedStrings.push(collectTextChildren(item, "t").slice(0, 2_000));
      }
    }

    const output = new BoundedText(OUTPUT_LIMIT);
    let cellCount = 0;
    const sheets = elementsByLocalName(workbook, "sheet").slice(0, 32);
    for (let sheetIndex = 0; sheetIndex < sheets.length && cellCount < 1_000; sheetIndex++) {
      const sheet = sheets[sheetIndex];
      const sheetName = shortCellText(attribute(sheet, "name") || `Sheet ${sheetIndex + 1}`, 100);
      const relationshipId = attribute(sheet, "r:id") || attribute(sheet, "id");
      const target = relationshipId ? targetById.get(relationshipId) : undefined;
      const worksheetPath = target ? safeWorksheetTarget(target) : undefined;
      const sheetBytes = worksheetPath ? result.entries.get(worksheetPath) : undefined;
      if (!sheetBytes) continue;
      const worksheet = parseXml(sheetBytes);
      output.add(`\n[Лист: ${sheetName}]\n`);
      const cells = elementsByLocalName(worksheet, "c");
      for (const cell of cells) {
        if (cellCount >= 1_000 || output.truncated) break;
        const reference = attribute(cell, "r");
        if (!/^[A-Z]{1,3}[1-9][0-9]{0,6}$/i.test(reference)) continue;
        const type = attribute(cell, "t");
        const valueNode = firstChildByLocalName(cell, "v");
        const formulaNode = firstChildByLocalName(cell, "f");
        let value = valueNode?.textContent || "";
        if (type === "s") {
          const sharedIndex = Number.parseInt(value, 10);
          value = Number.isInteger(sharedIndex) && sharedIndex >= 0 && sharedIndex < sharedStrings.length ? sharedStrings[sharedIndex] : "[invalid shared-string index]";
        } else if (type === "inlineStr") {
          const inline = firstChildByLocalName(cell, "is");
          value = inline ? collectTextChildren(inline, "t") : "";
        } else if (type === "b") {
          value = value === "1" ? "TRUE" : value === "0" ? "FALSE" : value;
        }
        const formula = formulaNode?.textContent ? ` = ${shortCellText(formulaNode.textContent, 500)}` : "";
        if (!value && !formula) continue;
        output.add(`${reference}: ${shortCellText(value)}${formula}\n`);
        cellCount++;
      }
    }
    if (!cellCount) return { text: "[XLSX распознан, но ячейки с извлекаемыми значениями не найдены. Формулы не исполняются; OCR не выполняется.]", summary: "XLSX: извлекаемые ячейки не найдены", truncated: false };
    const text = output.value();
    return { text: `${text}\n[Значения формул не вычислялись; отображаются только сохранённые значения и текст формул.]`, summary: `XLSX: извлечено ${cellCount} непустых ячеек`, truncated: output.truncated || cellCount >= 1_000 };
  } catch {
    return { text: "[XLSX: workbook XML повреждён или содержит неподдерживаемую структуру; содержимое не извлечено.]", summary: "XLSX XML не прошёл проверку", truncated: false };
  }
}

const GENERIC_TEXT_EXT = /\.(?:txt|md|csv|tsv|json|xml|html|htm|yml|yaml|toml|ini|properties|conf|log|js|jsx|ts|tsx|py|java|kt|kts|c|h|hpp|cpp|rs|go|sh|sql)$/i;

export async function extractGenericZipContent(source: ZipByteSource): Promise<ExtractedDocumentContent> {
  let chosen = 0;
  const result = await extractSelectedZipEntries(
    source,
    "zip",
    name => {
      if (!GENERIC_TEXT_EXT.test(name) || chosen >= 40) return false;
      chosen++;
      return true;
    },
    { maxEntries: 40, maxEntryBytes: 128 * 1024, maxTotalBytes: GENERIC_ZIP_TOTAL_LIMIT },
  );
  if (!result.ok) return { text: "[ZIP-архив не прошёл структурные проверки; файлы не извлечены.]", summary: "ZIP не удалось безопасно прочитать", truncated: false };
  if (result.entries.size === 0) return { text: "[ZIP проверен локально; безопасных текстовых файлов для извлечения не найдено.]", summary: "ZIP: текстовые файлы не найдены", truncated: false };
  const output = new BoundedText(OUTPUT_LIMIT);
  for (const [name, bytes] of result.entries) {
    const content = strFromU8(bytes);
    if (content.includes("\0")) continue;
    output.add(`\n[Файл внутри архива: ${shortCellText(name, 160)}]\n${content}\n`);
    if (output.truncated) break;
  }
  if (!output.value().trim()) return { text: "[ZIP содержит выбранные записи, но они не прошли текстовую проверку.]", summary: "ZIP: нет читаемого текста", truncated: false };
  const text = output.value();
  return { text, summary: `ZIP: извлечён текст из ${result.entries.size} файлов`, truncated: output.truncated };
}

const APK_TEXT_ENTRY = /^(?:assets\/|res\/xml\/|META-INF\/)[^\0]*\.(?:txt|md|json|xml|properties|mf|sf)$/i;

function u16(view: DataView, offset: number): number { return view.getUint16(offset, true); }
function u32(view: DataView, offset: number): number { return view.getUint32(offset, true); }
function checkedString(strings: string[], index: number): string {
  return index >= 0 && index < strings.length ? strings[index] : "";
}
function decodeLength8(bytes: Uint8Array, offset: number): { length: number; next: number } {
  if (offset >= bytes.length) throw new Error("AXML_TRUNCATED_STRING");
  const first = bytes[offset];
  if ((first & 0x80) === 0) return { length: first, next: offset + 1 };
  if (offset + 1 >= bytes.length) throw new Error("AXML_TRUNCATED_STRING");
  return { length: ((first & 0x7f) << 8) | bytes[offset + 1], next: offset + 2 };
}
function decodeLength16(view: DataView, offset: number, end: number): { length: number; next: number } {
  if (offset + 2 > end) throw new Error("AXML_TRUNCATED_STRING");
  const first = u16(view, offset);
  if ((first & 0x8000) === 0) return { length: first, next: offset + 2 };
  if (offset + 4 > end) throw new Error("AXML_TRUNCATED_STRING");
  return { length: ((first & 0x7fff) << 16) | u16(view, offset + 2), next: offset + 4 };
}

function parseStringPool(bytes: Uint8Array, offset: number, chunkSize: number, headerSize: number): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (chunkSize < 28 || headerSize < 28) throw new Error("AXML_BAD_STRING_POOL");
  const stringCount = u32(view, offset + 8);
  const styleCount = u32(view, offset + 12);
  const flags = u32(view, offset + 16);
  const stringsStart = u32(view, offset + 20);
  if (stringCount > 50_000 || styleCount > 50_000 || stringsStart > chunkSize || headerSize + (stringCount + styleCount) * 4 > chunkSize) throw new Error("AXML_STRING_POOL_LIMIT");
  const utf8 = (flags & 0x100) !== 0;
  const offsetsStart = offset + headerSize;
  const stringsBase = offset + stringsStart;
  const end = offset + chunkSize;
  const strings: string[] = [];
  for (let i = 0; i < stringCount; i++) {
    const stringOffset = u32(view, offsetsStart + i * 4);
    let position = stringsBase + stringOffset;
    if (position < stringsBase || position >= end) throw new Error("AXML_STRING_OFFSET_INVALID");
    if (utf8) {
      const charLength = decodeLength8(bytes, position); position = charLength.next;
      const byteLength = decodeLength8(bytes, position); position = byteLength.next;
      if (byteLength.length > 16_384 || position + byteLength.length > end) throw new Error("AXML_STRING_LENGTH_INVALID");
      strings.push(strFromU8(bytes.subarray(position, position + byteLength.length)));
    } else {
      const length = decodeLength16(view, position, end); position = length.next;
      const byteLength = length.length * 2;
      if (length.length > 16_384 || position + byteLength > end) throw new Error("AXML_STRING_LENGTH_INVALID");
      let value = "";
      for (let j = 0; j < byteLength; j += 2) value += String.fromCharCode(u16(view, position + j));
      strings.push(value);
    }
  }
  return strings;
}

function typedValue(bytes: Uint8Array, strings: string[], attributeOffset: number): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rawIndex = u32(view, attributeOffset + 8);
  if (rawIndex !== 0xffffffff) {
    const raw = checkedString(strings, rawIndex);
    if (raw) return raw;
  }
  const dataType = view.getUint8(attributeOffset + 15);
  const data = u32(view, attributeOffset + 16);
  if (dataType === 0x03) return checkedString(strings, data);
  if (dataType === 0x12) return data === 0 ? "false" : "true";
  if (dataType === 0x10) return String(data | 0);
  if (dataType === 0x11) return `0x${data.toString(16)}`;
  if (dataType === 0x01) return `@0x${data.toString(16)}`;
  return dataType === 0 ? "" : `0x${data.toString(16)}`;
}

export function parseAndroidBinaryManifest(bytes: Uint8Array): string {
  if (bytes.byteLength < 8 || bytes.byteLength > 1024 * 1024) throw new Error("AXML_SIZE_LIMIT");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (u16(view, 0) !== 0x0003) throw new Error("AXML_NOT_BINARY_XML");
  const documentSize = u32(view, 4);
  if (documentSize < 8 || documentSize > bytes.byteLength) throw new Error("AXML_DOCUMENT_SIZE_INVALID");
  let offset = u16(view, 2);
  if (offset < 8 || offset > documentSize) throw new Error("AXML_HEADER_INVALID");
  let strings: string[] = [];
  let packageName = "";
  let versionName = "";
  let versionCode = "";
  let minSdkVersion = "";
  let targetSdkVersion = "";
  let applicationLabel = "";
  let manifestSeen = false;
  const permissions = new Set<string>();
  const componentCounts: Record<string, number> = { activity: 0, service: 0, receiver: 0, provider: 0 };
  let chunkCount = 0;

  while (offset + 8 <= documentSize) {
    if (++chunkCount > 100_000) throw new Error("AXML_CHUNK_COUNT_LIMIT");
    const type = u16(view, offset);
    const headerSize = u16(view, offset + 2);
    const chunkSize = u32(view, offset + 4);
    if (headerSize < 8 || chunkSize < headerSize || offset + chunkSize > documentSize) throw new Error("AXML_CHUNK_BOUNDS_INVALID");
    if (type === 0x0001) {
      strings = parseStringPool(bytes, offset, chunkSize, headerSize);
    } else if (type === 0x0102) {
      if (headerSize < 16 || chunkSize < 36) throw new Error("AXML_START_ELEMENT_INVALID");
      const elementName = checkedString(strings, u32(view, offset + 20));
      const attributeStart = u16(view, offset + 24);
      const attributeSize = u16(view, offset + 26);
      const attributeCount = u16(view, offset + 28);
      const attributesBase = offset + 16 + attributeStart;
      if (attributeSize < 20 || attributeCount > 2_000 || attributesBase < offset + headerSize || attributesBase + attributeCount * attributeSize > offset + chunkSize) throw new Error("AXML_ATTRIBUTES_INVALID");
      const attributes = new Map<string, string>();
      for (let i = 0; i < attributeCount; i++) {
        const attributeOffset = attributesBase + i * attributeSize;
        const nameIndex = u32(view, attributeOffset + 4);
        const name = checkedString(strings, nameIndex);
        if (name) attributes.set(name, typedValue(bytes, strings, attributeOffset));
      }
      if (elementName === "manifest") {
        manifestSeen = true;
        packageName = attributes.get("package") || packageName;
        versionName = attributes.get("versionName") || versionName;
        versionCode = attributes.get("versionCode") || versionCode;
      } else if (elementName.startsWith("uses-permission")) {
        const name = attributes.get("name");
        if (name && permissions.size < 200) permissions.add(name);
      } else if (elementName === "uses-sdk") {
        minSdkVersion = attributes.get("minSdkVersion") || minSdkVersion;
        targetSdkVersion = attributes.get("targetSdkVersion") || targetSdkVersion;
      } else if (elementName === "application") {
        applicationLabel = attributes.get("label") || applicationLabel;
      } else if (Object.prototype.hasOwnProperty.call(componentCounts, elementName)) {
        componentCounts[elementName]++;
      }
    }
    offset += chunkSize;
  }
  if (!manifestSeen) throw new Error("AXML_MANIFEST_ELEMENT_MISSING");
  const lines = [
    "AndroidManifest.xml decoded locally as untrusted metadata; APK signature, code and runtime behavior were not verified.",
    `package: ${packageName || "not present"}`,
    `versionName: ${versionName || "not present"}`,
    `versionCode: ${versionCode || "not present"}`,
    `minSdkVersion: ${minSdkVersion || "not present"}`,
    `targetSdkVersion: ${targetSdkVersion || "not present"}`,
    `applicationLabel: ${applicationLabel || "not resolved (resource table not read)"}`,
    `permissions (${permissions.size}): ${Array.from(permissions).slice(0, 80).join(", ") || "none listed"}`,
    `components: activities=${componentCounts.activity}, services=${componentCounts.service}, receivers=${componentCounts.receiver}, providers=${componentCounts.provider}`,
  ];
  return lines.join("\n");
}

export async function extractApkContent(source: ZipByteSource): Promise<ExtractedDocumentContent> {
  let selectedTextCount = 0;
  const result = await extractSelectedZipEntries(
    source,
    "apk",
    name => {
      if (name === "AndroidManifest.xml") return true;
      if (!APK_TEXT_ENTRY.test(name) || selectedTextCount >= 48) return false;
      selectedTextCount++;
      return true;
    },
    { maxEntries: 49, maxEntryBytes: 1024 * 1024, maxTotalBytes: APK_TEXT_TOTAL_LIMIT },
  );
  if (!result.ok) return { text: "[APK не прошёл локальные ZIP-проверки; содержимое не извлечено и установка не выполнялась.]", summary: "APK не прошёл безопасный разбор", truncated: false };
  const output = new BoundedText(OUTPUT_LIMIT);
  const manifest = result.entries.get("AndroidManifest.xml");
  if (manifest) {
    try { output.add(`${parseAndroidBinaryManifest(manifest)}\n`); }
    catch { output.add("AndroidManifest.xml присутствует, но его binary XML не удалось безопасно декодировать.\n"); }
  } else {
    output.add("AndroidManifest.xml не найден в корне APK; сведения о пакете не определены.\n");
  }
  let textCount = 0;
  for (const [name, bytes] of result.entries) {
    if (name === "AndroidManifest.xml") continue;
    const text = strFromU8(bytes);
    if (text.includes("\0")) continue;
    output.add(`\n[Текстовая запись APK: ${name.slice(0, 160)}]\n${text}\n`);
    textCount++;
    if (output.truncated) break;
  }
  const body = output.value();
  return {
    text: body,
    summary: `APK: манифест ${manifest ? "прочитан" : "не найден"}, текстовых записей ${textCount}; подпись и поведение не проверялись`,
    truncated: output.truncated,
  };
}
