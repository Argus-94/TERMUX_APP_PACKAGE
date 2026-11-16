const PRIVATE_FILES_ROOTS = [
  "/data/user/0/com.karat.aibuilder/files",
  "/data/data/com.karat.aibuilder/files",
];

/** Compare only the two Android aliases for this app's exact private files root. */
function isSamePrivateRuntimePath(filesDir, termuxPrefix) {
  if (!PRIVATE_FILES_ROOTS.includes(filesDir)) return false;
  const expected = `${filesDir}/usr`;
  if (termuxPrefix === expected) return true;
  const alias = filesDir.startsWith("/data/user/0/")
    ? filesDir.replace("/data/user/0/", "/data/data/")
    : filesDir.replace("/data/data/", "/data/user/0/");
  return termuxPrefix === `${alias}/usr`;
}
module.exports = { isSamePrivateRuntimePath };
