const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_FETCH_HOSTS = new Set(["github.com", "raw.githubusercontent.com"]);

/** Normalize an HTTPS fetch URL only when its hostname is exactly on the GitHub allowlist. */
export function normalizeGithubFetchUrl(input: string): string {
  const value = String(input || "").trim();
  if (!value) throw new Error("GITHUB_URL_INVALID");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("GITHUB_URL_INVALID");
  }
  if (
    url.protocol !== "https:" ||
    !GITHUB_FETCH_HOSTS.has(url.hostname.toLowerCase()) ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    throw new Error("GITHUB_URL_NOT_ALLOWED");
  }
  return url.toString();
}

/**
 * Validate a relative GitHub API resource path and return its normalized
 * pathname + query. Absolute URLs, ambiguous path segments and non-API routes
 * are rejected before they reach either the native bridge or curl.
 */
export function normalizeGithubApiPath(input: string): string {
  const value = String(input || "").trim();
  if (
    !value ||
    value.startsWith("//") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) ||
    /[\u0000-\u0020\u007f\\]/.test(value)
  ) {
    throw new Error("GITHUB_API_PATH_INVALID");
  }

  const rawPath = value.split(/[?#]/, 1)[0];
  for (const segment of rawPath.split("/")) {
    if (!segment) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error("GITHUB_API_PATH_INVALID");
    }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
      throw new Error("GITHUB_API_PATH_INVALID");
    }
  }

  let url: URL;
  try {
    url = new URL(value.startsWith("/") ? value : `/${value}`, GITHUB_API_ORIGIN);
  } catch {
    throw new Error("GITHUB_API_PATH_INVALID");
  }
  if (url.origin !== GITHUB_API_ORIGIN || url.username || url.password || url.port || url.hash) {
    throw new Error("GITHUB_API_PATH_INVALID");
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    throw new Error("GITHUB_API_PATH_INVALID");
  }
  const allowedRoute =
    /^\/(?:repos|search|users|user)(?:\/|$)/i.test(decodedPath) ||
    /^\/orgs\/[^/]+\/repos(?:\/|$)/i.test(decodedPath);
  if (!allowedRoute) throw new Error("GITHUB_API_ROUTE_NOT_ALLOWED");
  return `${url.pathname}${url.search}`;
}
