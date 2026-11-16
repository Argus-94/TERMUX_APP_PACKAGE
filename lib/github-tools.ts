import { NativeModules } from "react-native";
import { executeGuardedTermuxCommand } from "./termux-executor";
import { AI_BUILDER_SHARED_ROOT, isWithinSharedAppRoot } from "./writable-path-policy";
import { normalizeGithubApiPath, normalizeGithubFetchUrl } from "./github-url-policy";

function esc(s:string){return s.replace(/'/g, "'\\''");}

/** Owner/repo must be safe path segments (no shell/URL injection). */
export function assertGithubRepo(owner: string, repo: string): void {
  const o = String(owner || "").trim();
  const r = String(repo || "").trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(o)) throw new Error("GITHUB_OWNER_INVALID");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(r)) throw new Error("GITHUB_REPO_INVALID");
  if (o.length > 100 || r.length > 100) throw new Error("GITHUB_REPO_INVALID");
}

export type GithubFileChange = { path: string; content?: string; delete?: boolean };

function nativeGithubModule(): any { return (NativeModules as any)?.AibGithubTool || null; }

async function secureGithubToken(): Promise<string> {
  const mod = nativeGithubModule();
  if (!mod?.secretGet) throw new Error("GITHUB_NATIVE_BRIDGE_UNAVAILABLE");
  const token = String(await mod.secretGet("unzipgit_token") || "").trim();
  if (!token) throw new Error("GITHUB_TOKEN_NOT_CONNECTED");
  return token;
}

async function nativeGithubRequest(method:string, path:string, body?:unknown): Promise<any> {
  const mod = nativeGithubModule();
  if (!mod?.httpRequest) throw new Error("GITHUB_NATIVE_BRIDGE_UNAVAILABLE");
  const token = await secureGithubToken();
  const cleanPath = normalizeGithubApiPath(path);
  const payload = JSON.stringify({
    url: `https://api.github.com${cleanPath}`,
    method: method.toUpperCase(),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2026-03-10",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await mod.httpRequest(payload);
  let parsed:any;
  try { parsed = JSON.parse(String(raw)); } catch { throw new Error("GITHUB_HTTP_INVALID_RESPONSE"); }
  if (!parsed?.ok) {
    const status = parsed?.status || 0;
    let detail = parsed?.error || "GitHub request failed";
    try { const b = JSON.parse(parsed?.body || "{}"); detail = b?.message || detail; } catch { /* keep detail */ }
    throw new Error(`GITHUB_HTTP_${status}: ${detail}`);
  }
  try { return JSON.parse(parsed.body || "null"); } catch { return parsed.body || null; }
}

export function githubRawUrl(owner:string,repo:string,path:string,ref="HEAD"){
  assertGithubRepo(owner, repo);
  const rawPath = String(path || "");
  const refValue = String(ref || "HEAD");
  if (rawPath.includes("\\") || rawPath.includes("\0") || rawPath.split("/").some((part) => part === "." || part === "..")) throw new Error("GITHUB_FILE_PATH_INVALID");
  if (refValue.includes("\\") || refValue.includes("\0") || refValue.split("/").some((part) => part === "." || part === "..")) throw new Error("GITHUB_REF_INVALID");
  const cleanPath = rawPath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(refValue)}/${cleanPath}`;
}
export async function githubFetch(url:string){const safeUrl=normalizeGithubFetchUrl(url); return executeGuardedTermuxCommand(`curl -L --fail --max-time 30 '${esc(safeUrl)}'`,{timeoutMs:45000});}

/** Agent-facing GitHub API. The token is resolved only from the encrypted native vault; callers cannot supply one. */
export async function githubApi(path:string){
  const cleanPath = normalizeGithubApiPath(path);
  if (nativeGithubModule()?.httpRequest) {
    return nativeGithubRequest("GET", cleanPath);
  }
  // Non-native environments may read public GitHub data only. Authenticated access stays native-only.
  const url=`https://api.github.com${cleanPath}`;
  return executeGuardedTermuxCommand(`curl -L --fail --max-time 30 -H 'Accept: application/vnd.github+json' '${esc(url)}'`,{timeoutMs:45000});
}

export async function githubApiWrite(method:string,path:string,body?:unknown){
  return nativeGithubRequest(method, path, body);
}

export async function githubRepoContents(owner:string,repo:string,path="",ref="HEAD"){assertGithubRepo(owner,repo);const clean=path.split("/").filter(Boolean).map(encodeURIComponent).join("/"); const suffix=clean?`/${clean}`:""; return githubApi(`repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents${suffix}?ref=${encodeURIComponent(ref)}`);}
export async function githubIssueOrPr(owner:string,repo:string,number:number){return githubApi(`repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`);}
export async function githubPullRequest(owner:string,repo:string,number:number){return githubApi(`repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`);}
export async function githubSearchCode(q:string){return githubApi(`search/code?q=${encodeURIComponent(q)}`);}

/** Decode Contents API file payload to UTF-8 text (no Buffer dependency). */
function decodeGithubFileContent(payload: any): string {
  if (payload == null) return "";
  if (typeof payload === "string") return payload;
  const content = payload.content;
  if (typeof content !== "string") return String(payload?.content ?? "");
  if (String(payload.encoding || "").toLowerCase() !== "base64") return content;
  const b64 = content.replace(/\s+/g, "");
  // Prefer global atob when present (RN/Hermes); else pure JS base64.
  const binary = typeof atob === "function"
    ? atob(b64)
    : (() => {
        const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let str = b64.replace(/=+$/, "");
        let output = "";
        for (let i = 0; i < str.length; i += 4) {
          const enc1 = alphabet.indexOf(str.charAt(i));
          const enc2 = alphabet.indexOf(str.charAt(i + 1));
          const enc3 = alphabet.indexOf(str.charAt(i + 2));
          const enc4 = alphabet.indexOf(str.charAt(i + 3));
          const bits = (enc1 << 18) | (enc2 << 12) | ((enc3 & 63) << 6) | (enc4 & 63);
          output += String.fromCharCode((bits >> 16) & 255);
          if (enc3 !== -1 && str.charAt(i + 2) !== "") output += String.fromCharCode((bits >> 8) & 255);
          if (enc4 !== -1 && str.charAt(i + 3) !== "") output += String.fromCharCode(bits & 255);
        }
        return output;
      })();
  // UTF-8 decode
  try {
    if (typeof TextDecoder !== "undefined") return new TextDecoder("utf-8").decode(
      Uint8Array.from(binary, (c) => c.charCodeAt(0))
    );
  } catch { /* fall through */ }
  let out = "";
  for (let i = 0; i < binary.length; ) {
    const c = binary.charCodeAt(i++);
    if (c < 128) out += String.fromCharCode(c);
    else if (c > 191 && c < 224) {
      const c2 = binary.charCodeAt(i++);
      out += String.fromCharCode(((c & 31) << 6) | (c2 & 63));
    } else {
      const c2 = binary.charCodeAt(i++);
      const c3 = binary.charCodeAt(i++);
      out += String.fromCharCode(((c & 15) << 12) | ((c2 & 63) << 6) | (c3 & 63));
    }
  }
  return out;
}

export function normalizeGithubReadUri(uri:string){
  const value=String(uri||"").trim();
  if(/^github:\/\//i.test(value)) return value;
  if(!/^https:\/\/github\.com\//i.test(value)) throw new Error("Invalid GitHub read URI");
  let u:URL;
  try { u=new URL(value); } catch { throw new Error("Invalid GitHub URL"); }
  if(u.protocol!=="https:" || u.hostname.toLowerCase()!=="github.com") throw new Error("Only https://github.com URLs are allowed");
  if(u.search || u.hash) throw new Error("GitHub URL query/hash is not allowed");
  const parts=u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if(parts.length<2) throw new Error("GitHub repository is required");
  const [owner,repo,...rest]=parts;
  if(!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("Invalid GitHub repository");
  if(rest.length===0) return `github://${owner}/${repo}`;
  if(rest[0]==="pull" && /^\d+$/.test(rest[1]||"") && rest.length===2) return `github://${owner}/${repo}#pr/${rest[1]}`;
  if(rest[0]==="issues" && /^\d+$/.test(rest[1]||"") && rest.length===2) return `github://${owner}/${repo}#issue/${rest[1]}`;
  if((rest[0]==="blob" || rest[0]==="tree") && rest.length>=2){
    const ref=rest[1];
    const path=rest.slice(2).join("/");
    return `github://${owner}/${repo}/${path}@${ref}`;
  }
  throw new Error("Unsupported GitHub URL shape; use blob/tree, pull, or issues URL");
}

export async function githubReadUri(uri:string){
  const normalized=normalizeGithubReadUri(uri);
  const m=normalized.match(/^github:\/\/([^/]+)\/([^/#]+)(?:#(pr|issue)\/(\d+)|\/([^@]*)@?(.*))?$/i);
  if(!m) throw new Error("Invalid github:// URI");
  const [,owner,repo,kind,num,path="",ref="HEAD"]=m;
  if(kind==="pr") return githubPullRequest(owner,repo,Number(num));
  if(kind==="issue") return githubIssueOrPr(owner,repo,Number(num));
  const raw = await githubRepoContents(owner,repo,path,ref||"HEAD");
  // Directory listing — return as-is (array of entries).
  if (Array.isArray(raw)) {
    return { type: "dir", owner, repo, path: path || "", ref: ref || "HEAD", entries: raw };
  }
  // File — decode base64 content for the agent (UTF-8 text).
  if (raw && typeof raw === "object" && (raw as any).type === "file") {
    const content = typeof decodeGithubFileContent === "function"
      ? decodeGithubFileContent(raw)
      : String((raw as any).content || "");
    return {
      type: "file",
      owner,
      repo,
      path: String((raw as any).path || path || ""),
      ref: ref || "HEAD",
      sha: (raw as any).sha,
      size: (raw as any).size,
      encoding: "utf-8",
      content,
      html_url: (raw as any).html_url,
    };
  }
  return raw;
}

/** Read a repo file by owner/repo/path/ref (agent-friendly; decoded UTF-8). */
export async function githubReadFile(owner: string, repo: string, path: string, ref = "HEAD") {
  assertGithubRepo(owner, repo);
  const p = String(path || "").trim().replace(/^\/+/, "");
  if (!p || p.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("GITHUB_FILE_PATH_INVALID");
  return githubReadUri(`github://${owner}/${repo}/${p}@${ref || "HEAD"}`);
}

/**
 * Parse owner/repo[/path][@ref] or https://github.com/owner/repo/... from free text.
 * Used by the agent when the user pastes a URL without structured args.
 */
export function parseGithubRepoRef(text: string): {
  owner: string;
  repo: string;
  path?: string;
  ref?: string;
  kind?: "repo" | "blob" | "tree" | "pr" | "issue";
  number?: number;
} | null {
  const raw = String(text || "").trim();
  if (!raw) return null;
  // https://github.com/owner/repo[/blob|tree/ref/path|/pull/N|/issues/N]
  const url = raw.match(/https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(\/[^\s)#]+)?/i);
  if (url) {
    const owner = url[1];
    const repo = url[2].replace(/\.git$/i, "");
    const rest = (url[3] || "").replace(/^\//, "").split("/").filter(Boolean);
    if (rest[0] === "pull" && /^\d+$/.test(rest[1] || "")) return { owner, repo, kind: "pr", number: Number(rest[1]) };
    if (rest[0] === "issues" && /^\d+$/.test(rest[1] || "")) return { owner, repo, kind: "issue", number: Number(rest[1]) };
    if ((rest[0] === "blob" || rest[0] === "tree") && rest.length >= 2) {
      return { owner, repo, kind: rest[0] as "blob" | "tree", ref: rest[1], path: rest.slice(2).join("/") || undefined };
    }
    return { owner, repo, kind: "repo" };
  }
  // owner/repo or owner/repo@branch
  const short = raw.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:@([A-Za-z0-9._\/-]+))?$/);
  if (short) return { owner: short[1], repo: short[2], ref: short[3], kind: "repo" };
  // github://owner/repo/...
  if (/^github:\/\//i.test(raw)) {
    try {
      const n = normalizeGithubReadUri(raw);
      const m = n.match(/^github:\/\/([^/]+)\/([^/#]+)(?:#(pr|issue)\/(\d+)|\/([^@]*)@?(.*))?$/i);
      if (!m) return null;
      if (m[3] === "pr") return { owner: m[1], repo: m[2], kind: "pr", number: Number(m[4]) };
      if (m[3] === "issue") return { owner: m[1], repo: m[2], kind: "issue", number: Number(m[4]) };
      return { owner: m[1], repo: m[2], path: m[5] || undefined, ref: m[6] || undefined, kind: m[5] ? "blob" : "repo" };
    } catch { return null; }
  }
  return null;
}


export async function githubRepoTree(owner:string,repo:string,ref="HEAD"){ assertGithubRepo(owner,repo); return githubApi(`repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`); }
export async function githubSearchIssues(q:string){ return githubApi(`search/issues?q=${encodeURIComponent(q)}`); }
export async function githubPullRequestFiles(owner:string,repo:string,number:number){ assertGithubRepo(owner,repo); if(!Number.isInteger(number)||number<1||number>999999) throw new Error("GITHUB_PR_NUMBER_REQUIRED"); return githubApi(`repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/files`); }
export async function githubRepoDiff(owner:string,repo:string,base:string,head:string){assertGithubRepo(owner,repo);return githubApi(`repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);}
export async function githubRepoList(owner:string,repo:string,path="",ref="HEAD"){return githubRepoContents(owner,repo,path,ref);}

export async function githubRepoInfo(owner:string,repo:string){
  assertGithubRepo(owner,repo);
  return nativeGithubRequest("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
}

/** Create a repository under the authenticated user (token from vault). Default: private. */
export async function githubCreateRepository(
  name: string,
  opts?: { private?: boolean; description?: string; autoInit?: boolean },
): Promise<unknown> {
  const n = String(name || "").trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(n) || n.length > 100) {
    throw new Error("GITHUB_REPO_NAME_INVALID");
  }
  const isPrivate = opts?.private !== false;
  return nativeGithubRequest("POST", "/user/repos", {
    name: n,
    private: isPrivate,
    description: String(opts?.description || "").slice(0, 350),
    auto_init: opts?.autoInit !== false,
  });
}

export async function githubCreateBranch(owner:string,repo:string,branch:string,base=""){ 
  assertGithubRepo(owner,repo);
  if(!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/.test(branch) || branch.includes("..")) throw new Error("GITHUB_BRANCH_INVALID");
  const info=await githubRepoInfo(owner,repo);
  if (info?.archived) throw new Error("GITHUB_REPO_ARCHIVED");
  if (info?.permissions && info.permissions.push !== true) throw new Error("GITHUB_PUSH_PERMISSION_REQUIRED");
  const baseRef=base.trim() || String(info.default_branch || "main");
  const ref=await nativeGithubRequest("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(baseRef)}`);
  try {
    return await nativeGithubRequest("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`, { ref:`refs/heads/${branch}`, sha:ref.object.sha });
  } catch(e:any) {
    if(/GITHUB_HTTP_422/.test(String(e?.message||e))) return { existing:true, ref:`refs/heads/${branch}`, sha:ref.object.sha };
    throw e;
  }
}


function isGithubNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bGITHUB_HTTP_404:/.test(message);
}

export async function githubApplyFiles(owner:string,repo:string,branch:string,message:string,files:GithubFileChange[],base=""){ 
  assertGithubRepo(owner,repo);
  if(!branch.trim()) throw new Error("GITHUB_BRANCH_REQUIRED");
  if(!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/.test(branch) || branch.includes("..")) throw new Error("GITHUB_BRANCH_INVALID");
  if(!message.trim()) throw new Error("GITHUB_COMMIT_MESSAGE_REQUIRED");
  if(!Array.isArray(files) || files.length<1 || files.length>100) throw new Error("GITHUB_FILES_INVALID");
  const seenPaths = new Set<string>();
  for(const f of files){
    if(!f || typeof f.path!=="string" || !f.path.trim() || f.path.startsWith("/") || f.path.split("/").some((part) => !part || part === "." || part === "..") || seenPaths.has(f.path)) throw new Error("GITHUB_FILE_PATH_INVALID");
    seenPaths.add(f.path);
    if(!f.delete && typeof f.content!=="string") throw new Error("GITHUB_FILE_CONTENT_REQUIRED");
  }
  const info=await githubRepoInfo(owner,repo);
  if (info?.archived) throw new Error("GITHUB_REPO_ARCHIVED");
  if (info?.permissions && info.permissions.push !== true) throw new Error("GITHUB_PUSH_PERMISSION_REQUIRED");
  const baseBranch=base.trim() || String(info.default_branch || "main");
  let branchRef:any = null;
  let createFirstRef = false;
  try {
    branchRef=await nativeGithubRequest("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(branch)}`);
  } catch (error) {
    if (!isGithubNotFound(error)) throw error;
    if (Number(info?.size) === 0) {
      if (files.every((file) => file.delete)) throw new Error("GITHUB_EMPTY_REPO_INITIAL_FILE_REQUIRED");
      createFirstRef = true;
    } else {
      await githubCreateBranch(owner,repo,branch,baseBranch);
      branchRef=await nativeGithubRequest("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(branch)}`);
    }
  }
  const parentSha=String(branchRef?.object?.sha || "");
  if (!createFirstRef && !parentSha) throw new Error("GITHUB_BRANCH_REF_INVALID");
  const parentCommit=parentSha
    ? await nativeGithubRequest("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${encodeURIComponent(parentSha)}`)
    : null;
  if (parentSha && !parentCommit?.tree?.sha) throw new Error("GITHUB_PARENT_COMMIT_INVALID");
  const entries:any[]=[];
  for(const f of files){
    if(f.delete) entries.push({ path:f.path, mode:"100644", type:"blob", sha:null });
    else {
      const blob=await nativeGithubRequest("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs`, { content:f.content, encoding:"utf-8" });
      entries.push({ path:f.path, mode:"100644", type:"blob", sha:blob.sha });
    }
  }
  const treeBody:any = { tree:entries };
  if (parentCommit?.tree?.sha) treeBody.base_tree=parentCommit.tree.sha;
  const tree=await nativeGithubRequest("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees`, treeBody);
  if (!tree?.sha) throw new Error("GITHUB_TREE_CREATE_FAILED");
  const commit=await nativeGithubRequest("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits`, { message, tree:tree.sha, parents:parentSha ? [parentSha] : [] });
  if (!commit?.sha) throw new Error("GITHUB_COMMIT_CREATE_FAILED");
  if (createFirstRef) {
    await nativeGithubRequest("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`, { ref:`refs/heads/${branch}`, sha:commit.sha });
  } else {
    await nativeGithubRequest("PATCH", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs/heads/${encodeURIComponent(branch)}`, { sha:commit.sha, force:false });
  }
  const verify=await nativeGithubRequest("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(branch)}`);
  const verifiedSha=String(verify?.object?.sha || "");
  if (verifiedSha !== commit.sha) throw new Error("GITHUB_COMMIT_VERIFY_FAILED");
  return { branch, commitSha:commit.sha, commitUrl:commit.html_url, refSha:verifiedSha, verified:true, changedFiles:files.map(f=>f.path) };
}

/** Single-file create/update on a branch (thin wrapper over githubApplyFiles). */
export async function githubWriteFile(
  owner: string,
  repo: string,
  branch: string,
  path: string,
  content: string,
  message = "",
  base = "",
) {
  const p = String(path || "").trim().replace(/^\/+/, "");
  if (!p) throw new Error("GITHUB_FILE_PATH_INVALID");
  const msg = String(message || "").trim() || `Update ${p}`;
  return githubApplyFiles(owner, repo, branch, msg, [{ path: p, content: String(content ?? "") }], base);
}

/** Copy/move-within-repo via read + apply (keeps history as new blob). */
export async function githubCopyFile(
  owner: string,
  repo: string,
  branch: string,
  fromPath: string,
  toPath: string,
  message = "",
  deleteSource = false,
  base = "",
) {
  assertGithubRepo(owner, repo);
  const from = String(fromPath || "").trim().replace(/^\/+/, "");
  const to = String(toPath || "").trim().replace(/^\/+/, "");
  if (!from || !to || from === to) throw new Error("GITHUB_COPY_PATHS_INVALID");
  const file = await githubReadFile(owner, repo, from, branch);
  const content = typeof (file as any)?.content === "string" ? (file as any).content : "";
  const files: GithubFileChange[] = [{ path: to, content }];
  if (deleteSource) files.unshift({ path: from, delete: true });
  const msg = String(message || "").trim() || (deleteSource ? `Move ${from} → ${to}` : `Copy ${from} → ${to}`);
  return githubApplyFiles(owner, repo, branch, msg, files, base);
}



export async function githubCreatePullRequest(owner:string,repo:string,title:string,head:string,base="",body=""){
  assertGithubRepo(owner,repo);
  if(!title.trim()||!head.trim()) throw new Error("GITHUB_PR_FIELDS_REQUIRED");
  const info=await githubRepoInfo(owner,repo);
  if (info?.archived) throw new Error("GITHUB_REPO_ARCHIVED");
  const targetBase=base.trim() || String(info.default_branch || "main");
  return nativeGithubRequest("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, { title, head, base:targetBase, body });
}


/** Sanitize ref for filesystem segment (branch/tag/sha). */
function sanitizeRefForPath(ref: string): string {
  return String(ref || "HEAD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "HEAD";
}

/**
 * Materialize a GitHub repository onto the phone under the shared AIBuilder root.
 * Authenticated zipball download; token only in a 0600 header file, never returned to the model.
 * Default path: /storage/emulated/0/AIBuilderTermux/github/<owner>/<repo>-<ref>/
 *
 * Shell script avoids $() / backticks (Termux hard-block) — uses only pipes/files.
 */

export async function githubListBranches(owner: string, repo: string, page = 1, perPage = 100) {
  assertGithubRepo(owner, repo);
  const p = Math.max(1, Math.min(100, Number(page) || 1));
  const pp = Math.max(1, Math.min(100, Number(perPage) || 100));
  return nativeGithubRequest("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=${pp}&page=${p}`);
}

export async function githubListCommits(owner: string, repo: string, ref = "", path = "", page = 1, perPage = 30) {
  assertGithubRepo(owner, repo);
  const p = Math.max(1, Math.min(100, Number(page) || 1));
  const pp = Math.max(1, Math.min(100, Number(perPage) || 30));
  const qs = [`per_page=${pp}`, `page=${p}`];
  if (String(ref || "").trim()) qs.push(`sha=${encodeURIComponent(String(ref).trim())}`);
  if (String(path || "").trim()) qs.push(`path=${encodeURIComponent(String(path).trim())}`);
  return nativeGithubRequest("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?${qs.join("&")}`);
}

export async function githubGetCommit(owner: string, repo: string, sha: string) {
  assertGithubRepo(owner, repo);
  const s = String(sha || "").trim();
  if (!/^[0-9a-fA-F]{7,40}$/.test(s)) throw new Error("GITHUB_COMMIT_SHA_INVALID");
  return nativeGithubRequest("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(s)}`);
}

export async function githubListTags(owner: string, repo: string, page = 1, perPage = 100) {
  assertGithubRepo(owner, repo);
  const p = Math.max(1, Math.min(100, Number(page) || 1));
  const pp = Math.max(1, Math.min(100, Number(perPage) || 100));
  return nativeGithubRequest("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tags?per_page=${pp}&page=${p}`);
}

export async function githubListReleases(owner: string, repo: string, page = 1, perPage = 30) {
  assertGithubRepo(owner, repo);
  const p = Math.max(1, Math.min(100, Number(page) || 1));
  const pp = Math.max(1, Math.min(100, Number(perPage) || 30));
  return nativeGithubRequest("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=${pp}&page=${p}`);
}

export async function githubGetRelease(owner: string, repo: string, tagOrId: string) {
  assertGithubRepo(owner, repo);
  const t = String(tagOrId || "").trim();
  if (!t) throw new Error("GITHUB_RELEASE_REF_REQUIRED");
  if (/^\d+$/.test(t)) {
    return nativeGithubRequest("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/${encodeURIComponent(t)}`);
  }
  return nativeGithubRequest("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/tags/${encodeURIComponent(t)}`);
}

export async function githubListPulls(owner: string, repo: string, state = "open", page = 1, perPage = 30) {
  assertGithubRepo(owner, repo);
  const st = ["open", "closed", "all"].includes(String(state)) ? String(state) : "open";
  const p = Math.max(1, Math.min(100, Number(page) || 1));
  const pp = Math.max(1, Math.min(100, Number(perPage) || 30));
  return nativeGithubRequest("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=${st}&per_page=${pp}&page=${p}`);
}

export async function githubMergePullRequest(
  owner: string,
  repo: string,
  number: number,
  mergeMethod: "merge" | "squash" | "rebase" = "squash",
  commitTitle = "",
) {
  assertGithubRepo(owner, repo);
  if (!Number.isInteger(number) || number < 1 || number > 999999) throw new Error("GITHUB_PR_NUMBER_REQUIRED");
  const method = ["merge", "squash", "rebase"].includes(mergeMethod) ? mergeMethod : "squash";
  const body: Record<string, string> = { merge_method: method };
  if (String(commitTitle || "").trim()) body.commit_title = String(commitTitle).trim();
  return nativeGithubRequest("PUT", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/merge`, body);
}

export async function githubCreateIssue(owner: string, repo: string, title: string, body = "", labels: string[] = []) {
  assertGithubRepo(owner, repo);
  if (!String(title || "").trim()) throw new Error("GITHUB_ISSUE_TITLE_REQUIRED");
  const payload: Record<string, unknown> = { title: String(title).trim(), body: String(body || "") };
  if (Array.isArray(labels) && labels.length) payload.labels = labels.map(String).slice(0, 20);
  return nativeGithubRequest("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, payload);
}

export async function githubCommentIssue(owner: string, repo: string, number: number, body: string) {
  assertGithubRepo(owner, repo);
  if (!Number.isInteger(number) || number < 1 || number > 999999) throw new Error("GITHUB_ISSUE_NUMBER_REQUIRED");
  if (!String(body || "").trim()) throw new Error("GITHUB_COMMENT_BODY_REQUIRED");
  return nativeGithubRequest("POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`, {
    body: String(body).trim(),
  });
}

/** Rename/move a file on a branch: read old content → atomic delete+create via apply. */
export async function githubRenameFile(
  owner: string,
  repo: string,
  branch: string,
  fromPath: string,
  toPath: string,
  message = "",
  base = "",
) {
  assertGithubRepo(owner, repo);
  const from = String(fromPath || "").trim().replace(/^\/+/, "");
  const to = String(toPath || "").trim().replace(/^\/+/, "");
  if (!from || !to || from === to) throw new Error("GITHUB_RENAME_PATHS_INVALID");
  if (from.split("/").some((p) => p === ".." || p === ".") || to.split("/").some((p) => p === ".." || p === ".")) {
    throw new Error("GITHUB_FILE_PATH_INVALID");
  }
  const ref = String(branch || "").trim() || "HEAD";
  const meta = await githubRepoContents(owner, repo, from, ref);
  if (!meta || Array.isArray(meta) || (meta as any).type !== "file") throw new Error("GITHUB_RENAME_SOURCE_NOT_FILE");
  // Contents API returns base64 for files under 1MB; decodeGithubFileContent handles both shapes.
  const content = decodeGithubFileContent(meta);
  const msg = String(message || "").trim() || `Rename ${from} → ${to}`;
  return githubApplyFiles(owner, repo, branch, msg, [
    { path: from, delete: true },
    { path: to, content },
  ], base);
}

/**
 * Download a release asset (or any allowlisted GitHub binary URL) to shared storage / Download.
 * Uses authenticated curl; token never returned to the model.
 */
export async function githubDownloadReleaseAsset(
  owner: string,
  repo: string,
  assetUrl: string,
  destPath = "",
  fileName = "",
) {
  assertGithubRepo(owner, repo);
  const url = String(assetUrl || "").trim();
  if (!/^https:\/\/(api\.github\.com|github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com|codeload\.github\.com)\//i.test(url)) {
    throw new Error("GITHUB_ASSET_URL_NOT_ALLOWED");
  }
  const token = await secureGithubToken();
  const name = String(fileName || url.split("?")[0].split("/").pop() || "github-asset.bin").replace(/[^A-Za-z0-9._+-]+/g, "_").slice(0, 180);
  const dest = String(destPath || `/storage/emulated/0/Download/${name}`).trim();
  if (!dest.startsWith("/storage/emulated/") && !isWithinSharedAppRoot(dest)) {
    throw new Error("GITHUB_DOWNLOAD_DEST_NOT_ALLOWED");
  }
  if (dest.includes("\0") || /[\r\n]/.test(dest)) throw new Error("GITHUB_DOWNLOAD_PATH_INVALID");

  const script = [
    "set -eu",
    `URL='${esc(url)}'`,
    `OUT='${esc(dest)}'`,
    `TOKEN='${esc(token)}'`,
    'TMPDIR="${TMPDIR:-$PREFIX/tmp}"',
    'mkdir -p "$TMPDIR"',
    'HDR="$TMPDIR/aib-gh-dl-hdr-$$"',
    'META="$TMPDIR/aib-gh-dl-meta-$$"',
    'PARENT="${OUT%/*}"',
    'mkdir -p "$PARENT"',
    'printf "Authorization: Bearer %s\\nAccept: application/octet-stream\\n" "$TOKEN" > "$HDR"',
    'chmod 600 "$HDR"',
    'TOKEN=x',
    'curl -fsSL --max-time 600 -L -H @"$HDR" -o "$OUT" "$URL"',
    'rm -f "$HDR"',
    'wc -c < "$OUT" > "$META"',
    'read BYTES < "$META"',
    'rm -f "$META"',
    'if [ -z "$BYTES" ] || [ "$BYTES" -le 0 ]; then echo GITHUB_DOWNLOAD_EMPTY; exit 2; fi',
    'echo "AIB_GH_DOWNLOAD_OK path=$OUT bytes=$BYTES"',
  ].join("\n");

  const result = await executeGuardedTermuxCommand(script, {
    timeoutMs: 660_000,
    trustedInternal: true,
    executionTarget: "embedded-private",
  });
  const out = `${result.stdout || ""}\n${result.stderr || ""}`;
  const okLine = out.split("\n").find((l) => l.includes("AIB_GH_DOWNLOAD_OK"));
  if (!okLine) throw new Error(`GITHUB_DOWNLOAD_FAILED: ${out.slice(-800)}`);
  const bytesMatch = /bytes=(\d+)/.exec(okLine);
  return { path: dest, bytes: bytesMatch ? Number(bytesMatch[1]) : 0, owner, repo };
}


export async function githubMaterializeRepo(
  owner: string,
  repo: string,
  ref = "",
  destDir = "",
): Promise<{
  localPath: string;
  owner: string;
  repo: string;
  ref: string;
  defaultBranch: string;
  zipBytes: number;
  extractedEntries: number;
}> {
  assertGithubRepo(owner, repo);
  const info = await githubRepoInfo(owner, repo);
  const targetRef = (ref || String(info.default_branch || "main")).trim() || "main";
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/.test(targetRef) || targetRef.includes("..")) {
    throw new Error("GITHUB_REF_INVALID");
  }
  const token = await secureGithubToken();
  const defaultDest = `${AI_BUILDER_SHARED_ROOT}/github/${owner}/${repo}-${sanitizeRefForPath(targetRef)}`;
  const dest = String(destDir || defaultDest).trim().replace(/\/+$/, "");
  if (!isWithinSharedAppRoot(dest)) throw new Error("GITHUB_MATERIALIZE_PATH_OUTSIDE_SHARED_ROOT");
  if (dest.includes("\0") || /[\r\n]/.test(dest)) throw new Error("GITHUB_MATERIALIZE_PATH_INVALID");

  const zipUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zipball/${encodeURIComponent(targetRef)}`;
  // Paths are fixed under $PREFIX/tmp — no mktemp/$() needed.
  const script = [
    "set -eu",
    `DEST='${esc(dest)}'`,
    `ZIP_URL='${esc(zipUrl)}'`,
    `TOKEN='${esc(token)}'`,
    'TMPDIR="${TMPDIR:-$PREFIX/tmp}"',
    'mkdir -p "$TMPDIR"',
    'HDR="$TMPDIR/aib-gh-hdr-$$"',
    'ZIP="$TMPDIR/aib-gh-zip-$$.zip"',
    'EXTRACT="$TMPDIR/aib-gh-extract-$$"',
    'META="$TMPDIR/aib-gh-meta-$$"',
    'rm -f "$HDR" "$ZIP" "$META"',
    'rm -rf "$EXTRACT"',
    'mkdir -p "$EXTRACT"',
    'printf "Authorization: Bearer %s\\nAccept: application/vnd.github+json\\n" "$TOKEN" > "$HDR"',
    'chmod 600 "$HDR"',
    'TOKEN=x',
    'curl -fsSL --max-time 300 -H @"$HDR" -o "$ZIP" "$ZIP_URL"',
    'rm -f "$HDR"',
    'wc -c < "$ZIP" > "$META"',
    'read BYTES < "$META"',
    'if [ -z "$BYTES" ] || [ "$BYTES" -le 64 ]; then echo GITHUB_ZIPBALL_EMPTY; exit 2; fi',
    'unzip -q -o "$ZIP" -d "$EXTRACT"',
    'rm -f "$ZIP"',
    'find "$EXTRACT" -mindepth 1 -maxdepth 1 -type d -print > "$META"',
    'read INNER < "$META"',
    'if [ -z "$INNER" ] || [ ! -d "$INNER" ]; then echo GITHUB_ZIPBALL_NO_ROOT; exit 3; fi',
    'rm -rf "$DEST"',
    'mkdir -p "$DEST"',
    'PARENT="${DEST%/*}"',
    'mkdir -p "$PARENT"',
    'rm -rf "$DEST"',
    'mv "$INNER" "$DEST"',
    'rm -rf "$EXTRACT"',
    'find "$DEST" | wc -l > "$META"',
    'read ENTRIES < "$META"',
    'rm -f "$META"',
    'echo "AIB_GH_MATERIALIZE_OK dest=$DEST bytes=$BYTES entries=$ENTRIES"',
  ].join("\n");

  // Strip TS comments that leaked into script if any
  const result = await executeGuardedTermuxCommand(script, {
    timeoutMs: 360_000,
    trustedInternal: true,
    executionTarget: "embedded-private",
  });
  const out = `${result.stdout || ""}\n${result.stderr || ""}`;
  const okLine = out.split("\n").find((l) => l.includes("AIB_GH_MATERIALIZE_OK"));
  const exitCode = typeof result.exitCode === "number" ? result.exitCode : 0;
  if (!okLine || exitCode !== 0) {
    const err = out.slice(-2000);
    if (/GITHUB_ZIPBALL_EMPTY/.test(err)) throw new Error("GITHUB_ZIPBALL_EMPTY");
    if (/404|Not Found/i.test(err)) throw new Error("GITHUB_REPO_OR_REF_NOT_FOUND");
    if (/401|Bad credentials|Requires authentication/i.test(err)) throw new Error("GITHUB_AUTH_FAILED");
    if (/403|rate limit|Resource not accessible/i.test(err)) throw new Error("GITHUB_ACCESS_DENIED");
    throw new Error(`GITHUB_MATERIALIZE_FAILED: ${err.slice(-800)}`);
  }
  const bytesMatch = /bytes=(\d+)/.exec(okLine);
  const entriesMatch = /entries=(\d+)/.exec(okLine);
  return {
    localPath: dest,
    owner,
    repo,
    ref: targetRef,
    defaultBranch: String(info.default_branch || "main"),
    zipBytes: bytesMatch ? Number(bytesMatch[1]) : 0,
    extractedEntries: entriesMatch ? Number(entriesMatch[1]) : 0,
  };
}

/**
 * Pack a directory under the shared AIBuilder root into a ZIP on the phone.
 * Default archive: /storage/emulated/0/Download/<dirname>.zip
 */
export async function githubPackLocalDir(
  sourceDir: string,
  archivePath = "",
): Promise<{ archivePath: string; bytes: number }> {
  const src = String(sourceDir || "").trim().replace(/\/+$/, "");
  if (!isWithinSharedAppRoot(src)) throw new Error("GITHUB_PACK_SOURCE_OUTSIDE_SHARED_ROOT");
  const baseName = src.split("/").filter(Boolean).pop() || "repo";
  const dest = String(archivePath || `/storage/emulated/0/Download/${baseName}.zip`).trim();
  if (!dest.startsWith("/storage/emulated/") && !isWithinSharedAppRoot(dest)) {
    throw new Error("GITHUB_PACK_DEST_NOT_ALLOWED");
  }
  if (dest.includes("\0") || /[\r\n]/.test(dest) || src.includes("\0")) throw new Error("GITHUB_PACK_PATH_INVALID");

  const script = [
    "set -eu",
    `SRC='${esc(src)}'`,
    `OUT='${esc(dest)}'`,
    'if [ ! -d "$SRC" ]; then echo GITHUB_PACK_SOURCE_MISSING; exit 2; fi',
    'PY="$PREFIX/bin/python3"',
    'if [ ! -x "$PY" ]; then echo GITHUB_PACK_PRIVATE_PYTHON_MISSING >&2; exit 78; fi',
    'PARENT="${OUT%/*}"',
    'mkdir -p "$PARENT"',
    '"$PY" - "$SRC" "$OUT" <<\'AIB_GH_ZIP_PY\'',
    "import os, sys, tempfile, zipfile",
    "src, out = map(os.path.abspath, sys.argv[1:3])",
    "prefix = os.path.realpath(os.environ[\"PREFIX\"])",
    "runtime = os.path.realpath(sys.executable)",
    "if os.path.commonpath((prefix, runtime)) != prefix: raise SystemExit(\"GITHUB_PACK_PRIVATE_PYTHON_OUTSIDE_PREFIX\")",
    "if not os.path.isdir(src): raise SystemExit(\"GITHUB_PACK_SOURCE_MISSING\")",
    "excluded = {\".git\", \"node_modules\", \".gradle\", \"android\", \"build\"}",
    "count = 0",
    "fd, temporary = tempfile.mkstemp(prefix=\".aib-source-\", suffix=\".zip.part\", dir=os.path.dirname(out))",
    "os.close(fd)",
    "try:",
    "  with zipfile.ZipFile(temporary, \"w\", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:",
    "    for root, dirs, files in os.walk(src, topdown=True, followlinks=False):",
    "      dirs[:] = [d for d in dirs if d not in excluded and not os.path.islink(os.path.join(root, d))]",
    "      for name in files:",
    "        path = os.path.join(root, name)",
    "        if (name.startswith(\".env\") and name != \".env.example\") or os.path.islink(path) or not os.path.isfile(path): continue",
    "        full = os.path.abspath(path)",
    "        if full in (out, temporary): continue",
    "        rel = os.path.relpath(full, src).replace(os.sep, \"/\")",
    "        archive.write(full, rel); count += 1",
    "  if count == 0: raise SystemExit(\"GITHUB_PACK_EMPTY\")",
    "  os.replace(temporary, out)",
    "finally:",
    "  if os.path.lexists(temporary): os.unlink(temporary)",
    'AIB_GH_ZIP_PY',
    'META="${TMPDIR:-$PREFIX/tmp}/aib-gh-pack-$$"',
    'wc -c < "$OUT" > "$META"',
    'read BYTES < "$META"',
    'rm -f "$META"',
    'if [ -z "$BYTES" ] || [ "$BYTES" -le 22 ]; then echo GITHUB_PACK_EMPTY; exit 3; fi',
    'echo "AIB_GH_PACK_OK path=$OUT bytes=$BYTES"',
  ].join("\n");

  const result = await executeGuardedTermuxCommand(script, {
    timeoutMs: 300_000,
    trustedInternal: true,
    executionTarget: "embedded-private",
  });
  const out = `${result.stdout || ""}\n${result.stderr || ""}`;
  const okLine = result.stdout.split("\n").find((line) => line.startsWith("AIB_GH_PACK_OK path="));
  if (result.exitCode !== 0 || result.timedOut || result.outputTruncated || !okLine) {
    throw new Error(`GITHUB_PACK_FAILED: ${out.slice(-800)}`);
  }
  const bytesMatch = /bytes=(\d+)/.exec(okLine);
  return { archivePath: dest, bytes: bytesMatch ? Number(bytesMatch[1]) : 0 };
}
