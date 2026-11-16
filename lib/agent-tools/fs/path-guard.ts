import { quote } from "../common";

export function requireProjectRoot(projectPath?: string | null): string {
  if (!projectPath || !projectPath.trim() || !projectPath.startsWith("/")) {
    throw new Error("PROJECT_ROOT_REQUIRED");
  }
  return projectPath;
}

/**
 * Produce a small host-side Node preflight for the project runtime. The check is
 * intentionally run in the same shell/workdir as aib-hashline so it validates
 * the filesystem actually being mutated (Termux/proot), not the app process FS.
 * Symlinks are rejected at every existing path component to prevent aliases
 * from escaping the canonical project root.
 */
export function projectPathGuardCommand(path: string): string {
  const program = [
    "const fs=require('node:fs'),p=require('node:path');",
    "const input=process.argv[1];",
    "function deny(reason){console.error('PROJECT_PATH_BLOCKED:'+reason);process.exit(86)}",
    "if(typeof input!=='string'||!input||input.includes('\\0')||p.isAbsolute(input)||input.split(/[\\\\/]/).includes('..'))deny('INVALID_PATH');",
    "let root;try{root=fs.realpathSync('.')}catch{deny('PROJECT_ROOT_UNAVAILABLE')}",
    "const target=p.resolve(root,input),prefix=root.endsWith(p.sep)?root:root+p.sep;",
    "if(target!==root&&!target.startsWith(prefix))deny('OUTSIDE_PROJECT');",
    "let cur=root;for(const part of p.relative(root,target).split(p.sep).filter(Boolean)){cur=p.join(cur,part);let st;try{st=fs.lstatSync(cur)}catch(e){if(e&&e.code==='ENOENT')break;deny('PATH_LOOKUP_FAILED')}if(st.isSymbolicLink())deny('SYMLINK_COMPONENT');let real;try{real=fs.realpathSync(cur)}catch(e){if(e&&e.code==='ENOENT')break;deny('PATH_LOOKUP_FAILED')}if(real!==root&&!real.startsWith(prefix))deny('OUTSIDE_PROJECT')}"
  ].join("");
  return `node -e ${quote(program)} -- ${quote(path)}`;
}

export function guardHashlineCommand(path: string, hashlineCommand: string): string {
  return `${projectPathGuardCommand(path)} && ${hashlineCommand}`;
}
