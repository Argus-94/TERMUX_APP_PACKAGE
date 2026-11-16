/** Shared bounded ZIP inspection and streaming extraction. Entries are data only: never executed or written to their archive paths. */
import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";

export type ArchiveFormat = "zip" | "apk" | "aab";

export interface ArchiveInspection {
  format: ArchiveFormat;
  safe: boolean;
  entryCount: number;
  totalUncompressedBytes: number;
  projectType?: "android" | "expo" | "generic";
  keyFiles: string[];
  warnings: string[];
}

export interface ZipByteSource {
  size: number;
  read(start: number, end: number): Promise<Uint8Array>;
}

export interface SelectedZipMember {
  name: string;
  compressedBytes: number;
  uncompressedBytes: number;
  localOffset: number;
  flags: number;
  compression: number;
  crc32: number;
  nameBytes: Uint8Array;
}

export interface ZipEntryMetadata {
  name: string;
  compressedBytes: number;
  uncompressedBytes: number;
  compression: number;
  crc32: number;
}

export interface ZipExtractionLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

export interface ZipExtractionResult {
  ok: boolean;
  inspection: ArchiveInspection;
  entries: Map<string, Uint8Array>;
  error?: string;
}

export interface ZipExtractionSink {
  begin(name: string): void;
  write(name: string, bytes: Uint8Array): void;
  finish(name: string, sizeBytes: number): void;
}

const MAX_ARCHIVE_ENTRIES = 100_000;
const MAX_ARCHIVE_UNCOMPRESSED = 2 * 1024 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 1000;
const MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 64 * 1024;

function u16(view: DataView, offset: number): number { return view.getUint16(offset, true); }
function u32(view: DataView, offset: number): number { return view.getUint32(offset, true); }

export function hasZipStartSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
     (bytes[2] === 0x05 && bytes[3] === 0x06) ||
     (bytes[2] === 0x07 && bytes[3] === 0x08));
}

export function byteArrayZipSource(bytes: Uint8Array): ZipByteSource {
  return {
    size: bytes.byteLength,
    async read(start, end) {
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > bytes.byteLength) {
        throw new Error("ZIP_RANGE_INVALID");
      }
      return bytes.subarray(start, end);
    },
  };
}

function isUnsafePath(name: string): boolean {
  const normalized = name.replace(/\\/g, "/");
  return normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some(part => part === "..") || normalized.includes("\0");
}

function readU16At(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}
function readU32At(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  return true;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32Update(crc: number, bytes: Uint8Array): number {
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc >>> 0;
}

function crc32(bytes: Uint8Array): number {
  return (crc32Update(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
}

interface ParsedZipDirectory {
  inspection: ArchiveInspection;
  selected: SelectedZipMember[];
  centralOffset: number;
}

async function parseZipDirectory(
  source: ZipByteSource,
  format: ArchiveFormat,
  selector?: (name: string) => boolean,
  maxSelectedEntries = MAX_ARCHIVE_ENTRIES,
): Promise<ParsedZipDirectory> {
  let entryCount = 0;
  let totalUncompressedBytes = 0;
  let totalCompressedBytes = 0;
  let projectType: ArchiveInspection["projectType"];
  const keyFiles: string[] = [];
  const warnings: string[] = [];
  const selected: SelectedZipMember[] = [];
  const selectedNames = new Set<string>();
  const fail = (warning: string, centralOffset = 0): ParsedZipDirectory => ({
    inspection: { format, safe: false, entryCount, totalUncompressedBytes, projectType, keyFiles, warnings: [...warnings, warning] },
    selected,
    centralOffset,
  });

  if (!Number.isSafeInteger(source.size) || source.size < 22) return fail("ZIP EOCD not found in trailing window");
  let tail: Uint8Array;
  try {
    tail = await source.read(Math.max(0, source.size - 65_557), source.size);
  } catch {
    return fail("ZIP tail could not be read");
  }
  if (tail.length < 22) return fail("ZIP EOCD not found in trailing window");
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const tailStart = source.size - tail.length;
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tailView, i) !== 0x06054b50) continue;
    const commentLength = u16(tailView, i + 20);
    if (i + 22 + commentLength === tail.length) { eocd = i; break; }
  }
  if (eocd < 0) return fail("ZIP EOCD not found in trailing window");

  const eocdAbsolute = tailStart + eocd;
  const diskNumber = u16(tailView, eocd + 4);
  const centralDisk = u16(tailView, eocd + 6);
  const entriesOnDisk = u16(tailView, eocd + 8);
  const declaredEntries = u16(tailView, eocd + 10);
  const centralSize = u32(tailView, eocd + 12);
  const centralOffset = u32(tailView, eocd + 16);
  const zip64Locator = eocdAbsolute >= 20 && eocd >= 20 && u32(tailView, eocd - 20) === 0x07064b50;
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== declaredEntries) return fail("multi-disk ZIP is unsupported");
  if (zip64Locator || declaredEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) return fail("ZIP64 is unsupported");
  if (declaredEntries > MAX_ARCHIVE_ENTRIES) return fail(`entry-count exceeds ${MAX_ARCHIVE_ENTRIES}`);
  if (centralSize > MAX_CENTRAL_DIRECTORY_BYTES) return fail("central directory exceeds inspection limit");
  if (centralOffset > eocdAbsolute || centralSize > eocdAbsolute - centralOffset) return fail("central-directory bounds are invalid");

  let central: Uint8Array;
  try {
    central = await source.read(centralOffset, centralOffset + centralSize);
  } catch {
    return fail("central directory could not be read", centralOffset);
  }
  if (central.length !== centralSize) return fail("central directory is truncated", centralOffset);
  const view = new DataView(central.buffer, central.byteOffset, central.byteLength);
  let cursor = 0;
  const seenSelected = new Set<string>();

  const hasZip64Extra = (start: number, end: number): boolean | null => {
    let offset = start;
    while (offset < end) {
      if (end - offset < 4) return null;
      const id = u16(view, offset);
      const length = u16(view, offset + 2);
      offset += 4;
      if (length > end - offset) return null;
      if (id === 0x0001) return true;
      offset += length;
    }
    return offset === end ? false : null;
  };

  for (let index = 0; index < declaredEntries; index++) {
    if (cursor > central.length || central.length - cursor < 46 || u32(view, cursor) !== 0x02014b50) return fail("corrupt or truncated central-directory entry", centralOffset);
    const flags = u16(view, cursor + 8);
    const compression = u16(view, cursor + 10);
    const crc32 = u32(view, cursor + 16);
    const compressedBytes = u32(view, cursor + 20);
    const uncompressedBytes = u32(view, cursor + 24);
    const nameLength = u16(view, cursor + 28);
    const extraLength = u16(view, cursor + 30);
    const commentLength = u16(view, cursor + 32);
    const diskStart = u16(view, cursor + 34);
    const attributes = u32(view, cursor + 38);
    const localOffset = u32(view, cursor + 42);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    if (recordLength > central.length - cursor) return fail("truncated central-directory entry data", centralOffset);
    if (diskStart !== 0) return fail("multi-disk ZIP entry is unsupported", centralOffset);
    if (compressedBytes === 0xffffffff || uncompressedBytes === 0xffffffff || localOffset === 0xffffffff) return fail("ZIP64 entry is unsupported", centralOffset);
    const extraStart = cursor + 46 + nameLength;
    const zip64Extra = hasZip64Extra(extraStart, extraStart + extraLength);
    if (zip64Extra === null) return fail("malformed central-directory extra data", centralOffset);
    if (zip64Extra) return fail("ZIP64 entry is unsupported", centralOffset);

    const nameStart = cursor + 46;
    const nameBytes = central.subarray(nameStart, nameStart + nameLength).slice();
    const name = Array.from(nameBytes, byte => String.fromCharCode(byte)).join("");
    const unsafePath = isUnsafePath(name);
    if (unsafePath) warnings.push("unsafe archive path");

    const unixMode = attributes >>> 16;
    const memberType = unixMode & 0xf000;
    const dosAttributes = attributes & 0xffff;
    if ((memberType !== 0 && memberType !== 0x8000 && memberType !== 0x4000) || (dosAttributes & 0x0400) !== 0) {
      warnings.push("link or special archive member");
    }

    if (localOffset >= centralOffset || centralOffset - localOffset < 30) return fail("invalid local file header offset", centralOffset);
    if (flags & (0x0001 | 0x0040 | 0x2000)) warnings.push("encrypted or masked ZIP entry is unsupported");
    if (uncompressedBytes > MAX_ARCHIVE_UNCOMPRESSED - totalUncompressedBytes) return fail(`declared extracted size exceeds ${MAX_ARCHIVE_UNCOMPRESSED} bytes`, centralOffset);
    totalUncompressedBytes += uncompressedBytes;
    totalCompressedBytes += compressedBytes;
    if (compressedBytes === 0 ? uncompressedBytes > 0 : uncompressedBytes / compressedBytes > MAX_COMPRESSION_RATIO) warnings.push("entry compression ratio too high");
    entryCount++;

    if (!unsafePath && keyFiles.length < 80 && /(?:^|\/)(settings\.gradle(?:\.kts)?|build\.gradle(?:\.kts)?|gradle\.properties|AndroidManifest\.xml|app\/build\.gradle(?:\.kts)?|package\.json|app\.config\.(?:js|ts))$/i.test(name)) keyFiles.push(name);
    if (!unsafePath && /(^|\/)AndroidManifest\.xml$/i.test(name)) projectType = "android";
    if (!unsafePath && /(^|\/)(app\.config\.(?:js|ts)|app\.json)$/i.test(name)) projectType = projectType === "android" ? "android" : "expo";

    if (!unsafePath && selector?.(name)) {
      if (selected.length >= maxSelectedEntries) return fail(`selected entry count exceeds ${maxSelectedEntries}`, centralOffset);
      if (seenSelected.has(name)) warnings.push("duplicate selected archive entry");
      else {
        seenSelected.add(name);
        selected.push({ name, compressedBytes, uncompressedBytes, localOffset, flags, compression, crc32, nameBytes });
      }
    }
    cursor += recordLength;
  }
  if (cursor !== central.length) return fail("central-directory length does not match its entries", centralOffset);
  if (totalCompressedBytes > 0 && totalUncompressedBytes / totalCompressedBytes > MAX_COMPRESSION_RATIO) warnings.push("archive-wide compression ratio is too high");
  return {
    inspection: { format, safe: warnings.length === 0, entryCount, totalUncompressedBytes, projectType, keyFiles, warnings },
    selected,
    centralOffset,
  };
}

export async function inspectZip(source: ZipByteSource, format: ArchiveFormat): Promise<ArchiveInspection> {
  return (await parseZipDirectory(source, format)).inspection;
}

export async function listZipEntryNames(
  source: ZipByteSource,
  format: ArchiveFormat,
  maxEntries = MAX_ARCHIVE_ENTRIES,
): Promise<{ inspection: ArchiveInspection; names: string[]; entries: ZipEntryMetadata[]; error?: string }> {
  const parsed = await parseZipDirectory(source, format, () => true, maxEntries);
  if (!parsed.inspection.safe) return { inspection: parsed.inspection, names: [], entries: [], error: "archive failed bounded ZIP directory checks" };
  return {
    inspection: parsed.inspection,
    names: parsed.selected.map(member => member.name),
    entries: parsed.selected.map(({ name, compressedBytes, uncompressedBytes, compression, crc32 }) => ({ name, compressedBytes, uncompressedBytes, compression, crc32 })),
  };
}

async function verifyLocalHeader(source: ZipByteSource, member: SelectedZipMember, centralOffset: number): Promise<boolean> {
  try {
    const header = await source.read(member.localOffset, member.localOffset + 30);
    if (header.length !== 30 || readU32At(header, 0) !== 0x04034b50) return false;
    const flags = readU16At(header, 6);
    const compression = readU16At(header, 8);
    const localCrc = readU32At(header, 14);
    const localCompressed = readU32At(header, 18);
    const localUncompressed = readU32At(header, 22);
    const nameLength = readU16At(header, 26);
    const extraLength = readU16At(header, 28);
    if (nameLength !== member.nameBytes.length || compression !== member.compression || flags !== member.flags) return false;
    if (flags & (0x0001 | 0x0040 | 0x2000)) return false;
    const nameStart = member.localOffset + 30;
    const payloadStart = nameStart + nameLength + extraLength;
    if (payloadStart > centralOffset || member.compressedBytes > centralOffset - payloadStart) return false;
    const localName = await source.read(nameStart, nameStart + nameLength);
    if (!equalBytes(localName, member.nameBytes)) return false;
    const hasDescriptor = (flags & 0x0008) !== 0;
    if (!hasDescriptor && (localCrc !== member.crc32 || localCompressed !== member.compressedBytes || localUncompressed !== member.uncompressedBytes)) return false;
    if (hasDescriptor && ((localCompressed !== 0 && localCompressed !== member.compressedBytes) || (localUncompressed !== 0 && localUncompressed !== member.uncompressedBytes))) return false;
    return true;
  } catch {
    return false;
  }
}

function concatChunks(chunks: Uint8Array[], length: number): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

export async function extractSelectedZipEntries(
  source: ZipByteSource,
  format: ArchiveFormat,
  selector: (name: string) => boolean,
  limits: ZipExtractionLimits,
): Promise<ZipExtractionResult> {
  const parsed = await parseZipDirectory(source, format, selector, limits.maxEntries);
  const result: ZipExtractionResult = { ok: false, inspection: parsed.inspection, entries: new Map() };
  if (!parsed.inspection.safe) { result.error = "archive failed structural safety checks"; return result; }
  if (parsed.selected.length > limits.maxEntries) { result.error = "selected entry count exceeds extraction limit"; return result; }
  if (parsed.selected.some(member => member.uncompressedBytes > limits.maxEntryBytes || (member.compression !== 0 && member.compression !== 8))) {
    result.error = "selected entry exceeds extraction limits or uses unsupported compression"; return result;
  }
  for (const member of parsed.selected) {
    if (!(await verifyLocalHeader(source, member, parsed.centralOffset))) {
      result.error = "selected local ZIP record does not match its central-directory record";
      return result;
    }
  }

  let failure: string | undefined;
  let outputTotal = 0;
  const seen = new Set<string>();
  const expected = new Map(parsed.selected.map(member => [member.name, member]));
  const chunksByName = new Map<string, Uint8Array[]>();
  const sizesByName = new Map<string, number>();
  const unzip = new Unzip(file => {
    if (failure || !expected.has(file.name)) return;
    if (seen.has(file.name)) { failure = "duplicate selected entry encountered during extraction"; file.terminate(); return; }
    seen.add(file.name);
    const central = expected.get(file.name)!;
    if (file.compression !== central.compression || (file.originalSize !== undefined && file.originalSize > limits.maxEntryBytes)) {
      failure = "selected entry metadata differs from the safe preflight"; file.terminate(); return;
    }
    const chunks: Uint8Array[] = [];
    chunksByName.set(file.name, chunks);
    let memberSize = 0;
    file.ondata = (error, chunk, final) => {
      if (error) { failure = "selected entry decompression failed"; file.terminate(); return; }
      if (chunk.length > limits.maxEntryBytes - memberSize || chunk.length > limits.maxTotalBytes - outputTotal) {
        failure = "actual decompressed data exceeds extraction limit"; file.terminate(); return;
      }
      if (chunk.length) {
        chunks.push(chunk.slice());
        memberSize += chunk.length;
        outputTotal += chunk.length;
      }
      if (final) sizesByName.set(file.name, memberSize);
    };
    try { file.start(); } catch { failure = "selected entry compression is unsupported"; }
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);

  try {
    for (let offset = 0; offset < source.size && !failure; offset += STREAM_CHUNK_BYTES) {
      const end = Math.min(source.size, offset + STREAM_CHUNK_BYTES);
      const chunk = await source.read(offset, end);
      if (chunk.length !== end - offset) { failure = "archive stream ended unexpectedly"; break; }
      unzip.push(chunk, end === source.size);
    }
  } catch {
    failure = "archive stream could not be read";
  }
  if (failure) { result.error = failure; return result; }

  for (const member of parsed.selected) {
    const chunks = chunksByName.get(member.name);
    const actualSize = sizesByName.get(member.name);
    if (!chunks || actualSize === undefined || actualSize !== member.uncompressedBytes) {
      result.error = "selected entry is missing or its actual size differs from the index";
      return result;
    }
    const bytes = concatChunks(chunks, actualSize);
    if (crc32(bytes) !== member.crc32) {
      result.entries.clear();
      result.error = "selected entry CRC does not match the archive index";
      return result;
    }
    result.entries.set(member.name, bytes);
  }
  result.ok = true;
  return result;
}

/** Streams exact selected ZIP entries to a caller-owned private sink without buffering all payloads in memory. */
export async function extractSelectedZipEntriesToSink(
  source: ZipByteSource,
  format: ArchiveFormat,
  selector: (name: string) => boolean,
  limits: ZipExtractionLimits,
  sink: ZipExtractionSink,
): Promise<{ ok: boolean; inspection: ArchiveInspection; error?: string; names?: string[] }> {
  const parsed = await parseZipDirectory(source, format, selector, limits.maxEntries);
  const result: { ok: boolean; inspection: ArchiveInspection; error?: string; names?: string[] } = { ok: false, inspection: parsed.inspection };
  if (!parsed.inspection.safe) { result.error = "archive failed structural safety checks"; return result; }
  if (parsed.selected.length > limits.maxEntries) { result.error = "selected entry count exceeds extraction limit"; return result; }
  if (parsed.selected.some(member => member.uncompressedBytes > limits.maxEntryBytes || (member.compression !== 0 && member.compression !== 8))) {
    result.error = "selected entry exceeds extraction limits or uses unsupported compression"; return result;
  }
  for (const member of parsed.selected) {
    if (!(await verifyLocalHeader(source, member, parsed.centralOffset))) {
      result.error = "selected local ZIP record does not match its central-directory record";
      return result;
    }
  }

  let failure: string | undefined;
  let outputTotal = 0;
  const seen = new Set<string>();
  const expected = new Map(parsed.selected.map(member => [member.name, member]));
  const sizes = new Map<string, number>();
  const unzip = new Unzip(file => {
    if (failure || !expected.has(file.name)) return;
    if (seen.has(file.name)) { failure = "duplicate selected entry encountered during extraction"; file.terminate(); return; }
    seen.add(file.name);
    const central = expected.get(file.name)!;
    if (file.compression !== central.compression || (file.originalSize !== undefined && file.originalSize > limits.maxEntryBytes)) {
      failure = "selected entry metadata differs from the safe preflight"; file.terminate(); return;
    }
    let memberSize = 0;
    let memberCrc = 0xffffffff;
    try { sink.begin(file.name); }
    catch { failure = "selected entry sink could not be opened"; file.terminate(); return; }
    file.ondata = (error, chunk, final) => {
      if (error) { failure = "selected entry decompression failed"; file.terminate(); return; }
      if (chunk.length > limits.maxEntryBytes - memberSize || chunk.length > limits.maxTotalBytes - outputTotal) {
        failure = "actual decompressed data exceeds extraction limit"; file.terminate(); return;
      }
      if (chunk.length) {
        try { sink.write(file.name, chunk); }
        catch { failure = "selected entry sink write failed"; file.terminate(); return; }
        memberCrc = crc32Update(memberCrc, chunk);
        memberSize += chunk.length;
        outputTotal += chunk.length;
      }
      if (final) {
        if (memberSize !== central.uncompressedBytes || ((memberCrc ^ 0xffffffff) >>> 0) !== central.crc32) {
          failure = "selected entry size or CRC does not match the archive index"; file.terminate(); return;
        }
        try { sink.finish(file.name, memberSize); }
        catch { failure = "selected entry sink could not be finalized"; file.terminate(); return; }
        sizes.set(file.name, memberSize);
      }
    };
    try { file.start(); } catch { failure = "selected entry compression is unsupported"; }
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);

  try {
    for (let offset = 0; offset < source.size && !failure; offset += STREAM_CHUNK_BYTES) {
      const end = Math.min(source.size, offset + STREAM_CHUNK_BYTES);
      const chunk = await source.read(offset, end);
      if (chunk.length !== end - offset) { failure = "archive stream ended unexpectedly"; break; }
      unzip.push(chunk, end === source.size);
    }
  } catch {
    failure = "archive stream could not be read";
  }
  if (failure) { result.error = failure; return result; }
  if (parsed.selected.some(member => !seen.has(member.name) || sizes.get(member.name) !== member.uncompressedBytes)) {
    result.error = "selected archive entry is missing or its actual size differs from the index";
    return result;
  }
  result.ok = true;
  result.names = [...sizes.keys()];
  return result;
}
