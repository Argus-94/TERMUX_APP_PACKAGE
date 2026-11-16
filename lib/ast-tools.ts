import { executeGuardedTermuxCommand } from "./termux-executor";

function q(s: string): string { return `'${s.replace(/'/g, `'\\''`)}'`; }
function bin(): string { return "command -v ast-grep >/dev/null 2>&1 && echo ast-grep || (command -v sg >/dev/null 2>&1 && echo sg)"; }

export async function astGrepSearch(pattern: string, projectPath?: string | null, language?: string) {
  const lang = language ? ` --lang ${q(language)}` : "";
  const cmd = `BIN=$(${bin()}); if [ -n "$BIN" ]; then "$BIN" run --pattern ${q(pattern)}${lang} --json=compact; else echo AST_GREP_UNAVAILABLE; fi`;
  return executeGuardedTermuxCommand(cmd, { workdir: projectPath || undefined, timeoutMs: 120000 });
}

/** Preview structural rewrites without changing files. */
export async function astGrepPreview(pattern: string, rewrite: string, projectPath?: string | null, language?: string) {
  const lang = language ? ` --lang ${q(language)}` : "";
  const cmd = `BIN=$(${bin()}); if [ -n "$BIN" ]; then "$BIN" run --pattern ${q(pattern)} --rewrite ${q(rewrite)}${lang} --json=compact; else echo AST_GREP_UNAVAILABLE; fi`;
  return executeGuardedTermuxCommand(cmd, { workdir: projectPath || undefined, timeoutMs: 120000 });
}

/** Apply a structural rewrite only when explicitly requested. */
export async function astGrepEdit(pattern: string, rewrite: string, projectPath?: string | null, language?: string, updateAll = true) {
  const lang = language ? ` --lang ${q(language)}` : "";
  const apply = updateAll ? " --update-all" : " --interactive";
  // Always preview immediately before mutation. This makes AST editing a single guarded
  // transaction from the agent's perspective and prevents an edit based on stale assumptions.
  const cmd = `BIN=$(${bin()}); if [ -n "$BIN" ]; then PREVIEW=$("$BIN" run --pattern ${q(pattern)} --rewrite ${q(rewrite)}${lang} --json=compact) || exit $?; if [ -z "$PREVIEW" ] || [ "$PREVIEW" = "[]" ]; then echo AST_NO_MATCHES; exit 0; fi; echo AST_PREVIEW_OK; "$BIN" run --pattern ${q(pattern)} --rewrite ${q(rewrite)}${lang}${apply}; else echo AST_GREP_UNAVAILABLE; exit 127; fi`;
  return executeGuardedTermuxCommand(cmd, { workdir: projectPath || undefined, timeoutMs: 120000 });
}
