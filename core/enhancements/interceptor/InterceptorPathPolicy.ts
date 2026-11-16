import type { ExecutionEnvironment } from "../../environment/ExecutionEnvironment";

const SENSITIVE_PATH = /(?:^|\/)(?:\.git|\.ssh|\.env(?:\.[^/]*)?|secrets?|credentials?)(?:\/|$)|\.(?:pem|p12|pfx|jks|keystore)$/i;
/** File access for Map Local is restricted to one dedicated HOME subtree and requires canonical-path support. */
export class InterceptorPathPolicy {
  private readonly root: string;
  private readonly allowedBase: string;
  constructor(private readonly environment: ExecutionEnvironment, root: string, allowedBase: string) {
    if (!root.startsWith("/") || root.includes("\\") || root.includes("\0") || root.includes("\n") || root.includes("\r") || root.split("/").some((part) => part === "..")) throw new Error("INTERCEPTOR_MAP_ROOT_INVALID");
    if (!allowedBase.startsWith("/") || allowedBase.includes("\\") || allowedBase.includes("\0") || allowedBase.includes("\n") || allowedBase.includes("\r") || allowedBase.split("/").some((part) => part === "..")) throw new Error("INTERCEPTOR_MAP_BASE_INVALID");
    this.root = root.replace(/\/+$/, "");
    this.allowedBase = allowedBase.replace(/\/+$/, "");
  }
  async readText(path: string): Promise<string> {
    if (!this.environment.resolvePath) throw new Error("INTERCEPTOR_CANONICAL_PATH_UNAVAILABLE");
    if (!path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.includes("\n") || path.includes("\r") || SENSITIVE_PATH.test(path) || path.split("/").some((part) => part === "..")) throw new Error("INTERCEPTOR_MAP_PATH_DENIED");
    let canonicalRoot: string; let canonicalPath: string; let canonicalBase: string;
    try { [canonicalBase, canonicalRoot, canonicalPath] = await Promise.all([this.environment.resolvePath(this.allowedBase), this.environment.resolvePath(this.root), this.environment.resolvePath(path)]); }
    catch { throw new Error("INTERCEPTOR_CANONICAL_PATH_FAILED"); }
    if (SENSITIVE_PATH.test(canonicalPath)) throw new Error("INTERCEPTOR_MAP_PATH_DENIED");
    if (canonicalRoot !== canonicalBase && !canonicalRoot.startsWith(`${canonicalBase.replace(/\/+$/, "")}/`)) throw new Error("INTERCEPTOR_MAP_ROOT_ESCAPE");
    if (canonicalPath === canonicalRoot || !canonicalPath.startsWith(`${canonicalRoot.replace(/\/+$/, "")}/`)) throw new Error("INTERCEPTOR_MAP_PATH_DENIED");
    if (!(await this.environment.exists(canonicalPath))) throw new Error("INTERCEPTOR_MAP_FILE_NOT_FOUND");
    const content = await this.environment.read(canonicalPath);
    if (content.length > 256_000) throw new Error("INTERCEPTOR_MAP_FILE_TOO_LARGE");
    return content;
  }
}
