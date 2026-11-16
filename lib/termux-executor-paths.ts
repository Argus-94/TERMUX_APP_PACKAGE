/** Rewrite absolute Termux PREFIX/home paths so shell guards see safe environment variables. */
export function normalizeTermuxCommandPaths(command: string): string {
  let c = String(command || "");
  // Protect ${...} expansions so defaults like
  // PREFIX="${PREFIX:-/data/data/com.karat.aibuilder/files/usr}" are not turned into
  // PREFIX="${PREFIX:-$PREFIX}" (which leaves PREFIX empty when unset).
  const protectedParts: string[] = [];
  c = c.replace(/\$\{[^}]*\}/g, (m) => {
    const i = protectedParts.length;
    protectedParts.push(m);
    return `__AIB_PROT_${i}__`;
  });
  // Common absolute PREFIX → $PREFIX (safe in Termux shell)
  c = c.replace(/\/data\/data\/com\.karat\.aibuilder\/files\/usr\b/g, "$PREFIX");
  c = c.replace(/\/data\/data\/com\.karat\.aibuilder\/files\/home\b/g, "$HOME");
  // JAVA_HOME under openjdk packages (paths outside ${...} only)
  c = c.replace(
    /\/data\/data\/com\.karat\.aibuilder\/files\/usr\/(?:lib\/jvm|share)\/[^\s"']+/g,
    (m) => m.replace("/data/data/com.karat.aibuilder/files/usr", "$PREFIX"),
  );
  for (let i = 0; i < protectedParts.length; i++) {
    c = c.split(`__AIB_PROT_${i}__`).join(protectedParts[i]);
  }
  return c;
}
