/** Remove plaintext credential fields from settings while preserving one retired provider blob opaquely. */
export function stripPersistedCredentialFields<T>(node: T, sanitizeExtraHeadersJson: (raw: string) => string): T {
  const scrub = (value: any): any => {
    if (Array.isArray(value)) return value.map(scrub);
    if (!value || typeof value !== "object") return value;
    for (const key of Object.keys(value)) {
      // Preserve the deprecated provider blob byte-for-byte as opaque data; do not inspect or mutate its value.
      if (key.toLowerCase() === "deepseek") continue;
      if (/^(?:api[_-]?key|authorization|x-api-key|access[_-]?token|auth[_-]?token|credential|secret|password)$/i.test(key)) {
        delete value[key];
      } else if (key === "extraHeadersJson" && typeof value[key] === "string") {
        value[key] = sanitizeExtraHeadersJson(value[key]);
      } else {
        value[key] = scrub(value[key]);
      }
    }
    return value;
  };
  return scrub(node);
}
