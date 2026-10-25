import crypto from "node:crypto";
import fs from "node:fs";

const [, , encryptedPath, outputPath] = process.argv;
const keyHex = process.env.AIB_V500_DECRYPT_KEY_HEX || "";
if (!encryptedPath || !outputPath || !/^[0-9a-fA-F]{64}$/.test(keyHex)) {
  console.error("AIB_V500_DECRYPT_INPUT_INVALID");
  process.exit(2);
}

const encrypted = fs.readFileSync(encryptedPath);
if (encrypted.length < 28) {
  console.error("AIB_V500_CIPHERTEXT_INVALID");
  process.exit(2);
}

try {
  const iv = encrypted.subarray(0, 12);
  const tag = encrypted.subarray(encrypted.length - 16);
  const ciphertext = encrypted.subarray(12, encrypted.length - 16);
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(keyHex, "hex"),
    iv,
  );
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  fs.writeFileSync(outputPath, plaintext, { mode: 0o600, flag: "wx" });
  console.log("AIB_V500_DECRYPTION_AND_AUTHENTICATION_OK");
} catch {
  console.error("AIB_V500_DECRYPTION_OR_AUTHENTICATION_FAILED");
  process.exit(1);
}
