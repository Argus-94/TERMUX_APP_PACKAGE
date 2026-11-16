import * as FileSystem from "expo-file-system/legacy";

export type EvidenceRef = { kind: string; path: string; sha256: string; bytes: number };

/** Evidence is kept inside the project-scoped app sandbox. No model-supplied path is accepted. */
export class DeviceEvidenceStore {
  readonly root: string;
  constructor(projectPath: string, runId: string) {
    const base = `${FileSystem.documentDirectory || "file:///data/data/com.aibuilder/files/"}aibuilder-evidence/`;
    this.root = `${base}${safe(projectPath.split(/[\\/]/).pop() || "project")}/${safe(runId)}/`;
  }
  async init(): Promise<void> { await FileSystem.makeDirectoryAsync(this.root, { intermediates: true }); }
  async write(testId: string, name: string, data: string | Uint8Array, kind = "artifact"): Promise<EvidenceRef> {
    await this.init();
    const path = `${this.root}${safe(testId)}/${safe(name)}`;
    await FileSystem.makeDirectoryAsync(`${this.root}${safe(testId)}/`, { intermediates: true });
    const isBinary = data instanceof Uint8Array;
    const content = isBinary ? data : utf8Bytes(String(data));
    const value = isBinary ? bytesToBase64(content) : String(data);
    await FileSystem.writeAsStringAsync(path, value, {
      encoding: isBinary ? FileSystem.EncodingType.Base64 : FileSystem.EncodingType.UTF8,
    });
    return { kind, path, sha256: sha256Bytes(content), bytes: content.byteLength };
  }
  writeJson(testId: string, name: string, value: unknown): Promise<EvidenceRef> {
    return this.write(testId, name, JSON.stringify(value, null, 2), "json");
  }
  relative(ref: EvidenceRef): string { return ref.path.startsWith(this.root) ? ref.path.slice(this.root.length) : ref.path; }
}

function safe(value: string): string {
  const result = String(value).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
  return result || "item";
}

function utf8Bytes(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    let point = value.codePointAt(i) ?? 0xfffd;
    if (point > 0xffff) i++;
    else if (point >= 0xd800 && point <= 0xdfff) point = 0xfffd;
    if (point <= 0x7f) bytes.push(point);
    else if (point <= 0x7ff) bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
    else if (point <= 0xffff) bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
    else bytes.push(0xf0 | (point >> 18), 0x80 | ((point >> 12) & 0x3f), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
  }
  return Uint8Array.from(bytes);
}

function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const hasB = i + 1 < bytes.length;
    const hasC = i + 2 < bytes.length;
    const b = hasB ? bytes[i + 1] : 0;
    const c = hasC ? bytes[i + 2] : 0;
    output += alphabet[a >> 2];
    output += alphabet[((a & 3) << 4) | (b >> 4)];
    output += hasB ? alphabet[((b & 15) << 2) | (c >> 6)] : "=";
    output += hasC ? alphabet[c & 63] : "=";
  }
  return output;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

/** SHA-256 of the exact byte sequence written to evidence storage. */
export function sha256Bytes(input: Uint8Array): string {
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const highBits = Math.floor(bitLength / 0x1_0000_0000);
  const lowBits = bitLength >>> 0;
  const lengthOffset = paddedLength - 8;
  padded[lengthOffset] = (highBits >>> 24) & 0xff;
  padded[lengthOffset + 1] = (highBits >>> 16) & 0xff;
  padded[lengthOffset + 2] = (highBits >>> 8) & 0xff;
  padded[lengthOffset + 3] = highBits & 0xff;
  padded[lengthOffset + 4] = (lowBits >>> 24) & 0xff;
  padded[lengthOffset + 5] = (lowBits >>> 16) & 0xff;
  padded[lengthOffset + 6] = (lowBits >>> 8) & 0xff;
  padded[lengthOffset + 7] = lowBits & 0xff;

  const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      words[i] = ((padded[j] << 24) | (padded[j + 1] << 16) | (padded[j + 2] << 8) | padded[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15];
      const y = words[i - 2];
      const s0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const s1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
    }
    let a = hash[0], b = hash[1], c = hash[2], d = hash[3];
    let e = hash[4], f = hash[5], g = hash[6], h = hash[7];
    for (let i = 0; i < 64; i++) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choice + SHA256_K[i] + words[i]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0; hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0; hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0; hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0; hash[7] = (hash[7] + h) >>> 0;
  }
  return Array.from(hash, (word) => word.toString(16).padStart(8, "0")).join("");
}
