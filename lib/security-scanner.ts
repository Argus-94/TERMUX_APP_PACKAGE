/**
 * Статический security-сканер (план v4.1: SecurityScanner).
 * Работает по тексту Manifest / Gradle / исходников без сети.
 */

export type IssueSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface SecurityIssue {
  severity: IssueSeverity;
  category: string;
  title: string;
  description: string;
  recommendation: string;
}

const SECRET_PATTERNS: Array<{ re: RegExp; title: string }> = [
  { re: /(?:api[_-]?key|apikey|secret|token|password)\s*[:=]\s*["'][^"']{8,}["']/i, title: "Possible hardcoded secret" },
  { re: /sk-or-v1-[a-zA-Z0-9]{20,}/, title: "OpenRouter-like API key in source" },
  { re: /AIza[0-9A-Za-z\-_]{20,}/, title: "Google API key pattern" },
  { re: /-----BEGIN (?:RSA )?PRIVATE KEY-----/, title: "Private key material in source" },
];

export function analyzeManifest(manifestText: string): SecurityIssue[] {
  const issues: SecurityIssue[] = [];
  const t = manifestText;

  if (/android:allowBackup\s*=\s*"true"/i.test(t) || (!/android:allowBackup/i.test(t) && /<application/i.test(t))) {
    if (/android:allowBackup\s*=\s*"true"/i.test(t)) {
      issues.push({
        severity: "medium",
        category: "BACKUP",
        title: "allowBackup=true",
        description: "App data may be extracted via adb backup.",
        recommendation: 'Set android:allowBackup="false" on <application>.',
      });
    }
  }

  if (/usesCleartextTraffic\s*=\s*"true"/i.test(t)) {
    issues.push({
      severity: "critical",
      category: "NETWORK",
      title: "Cleartext traffic allowed",
      description: "HTTP traffic may leak tokens and passwords.",
      recommendation: 'Remove usesCleartextTraffic or set to "false"; use HTTPS + Network Security Config.',
    });
  }

  if (/android:debuggable\s*=\s*"true"/i.test(t)) {
    issues.push({
      severity: "high",
      category: "DEBUG",
      title: "debuggable=true",
      description: "App can be debugged via adb on any device.",
      recommendation: 'Set android:debuggable="false" for release builds.',
    });
  }

  if (/android:exported\s*=\s*"true"/i.test(t)) {
    const exportedCount = (t.match(/android:exported\s*=\s*"true"/gi) || []).length;
    issues.push({
      severity: "medium",
      category: "EXPORT",
      title: `Exported components: ${exportedCount}`,
      description: "Exported activities/services/receivers are reachable by other apps.",
      recommendation: "Export only what is required; protect with permissions or signature level.",
    });
  }

  if (/REQUEST_INSTALL_PACKAGES/i.test(t)) {
    issues.push({
      severity: "high",
      category: "PERMISSION",
      title: "REQUEST_INSTALL_PACKAGES",
      description: "App can request installing other packages.",
      recommendation: "Keep only if sideloading is intentional; document why.",
    });
  }

  if (/WRITE_EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE/i.test(t)) {
    issues.push({
      severity: "low",
      category: "PERMISSION",
      title: "Broad storage permission",
      description: "Wide storage access increases data-exposure risk.",
      recommendation: "Prefer scoped storage / SAF where possible.",
    });
  }

  if (/<intent-filter>[\s\S]*android\.intent\.action\.VIEW/i.test(t) && /http/i.test(t)) {
    issues.push({
      severity: "info",
      category: "DEEPLINK",
      title: "HTTP deep links",
      description: "Deep links over http are spoofable.",
      recommendation: "Prefer https App Links with autoVerify.",
    });
  }

  return issues;
}

export function analyzeSourceText(source: string): SecurityIssue[] {
  const issues: SecurityIssue[] = [];
  for (const { re, title } of SECRET_PATTERNS) {
    if (re.test(source)) {
      issues.push({
        severity: "critical",
        category: "SECRETS",
        title,
        description: "Sensitive value appears embedded in source text.",
        recommendation: "Move secrets to secure storage / remote config; rotate exposed keys.",
      });
    }
  }
  if (/Log\.(?:d|e|i|v|w)\s*\([^)]*(?:password|token|secret|apiKey)/i.test(source)) {
    issues.push({
      severity: "medium",
      category: "LOGGING",
      title: "Sensitive data may be logged",
      description: "Logs can leak credentials on shared devices.",
      recommendation: "Never log secrets; redact before logging.",
    });
  }
  return issues;
}

export function analyzeGradle(gradleText: string): SecurityIssue[] {
  const issues: SecurityIssue[] = [];
  if (/com\.squareup\.okhttp3:okhttp:3\./i.test(gradleText)) {
    issues.push({
      severity: "high",
      category: "CVE",
      title: "okhttp 3.x",
      description: "Older okhttp lines had known security issues (e.g. pinning bypass class).",
      recommendation: "Upgrade to okhttp 4.9+ / current stable.",
    });
  }
  if (/com\.google\.code\.gson:gson:2\.8\.[0-5]/i.test(gradleText)) {
    issues.push({
      severity: "medium",
      category: "CVE",
      title: "gson 2.8.x",
      description: "Older gson versions had deserialization-related CVEs.",
      recommendation: "Upgrade gson to 2.9.1+.",
    });
  }
  if (/jcenter\(\)/i.test(gradleText)) {
    issues.push({
      severity: "low",
      category: "SUPPLY",
      title: "jcenter() repository",
      description: "JCenter is read-only/shutdown; builds may break or pull stale artifacts.",
      recommendation: "Use mavenCentral() / google().",
    });
  }
  return issues;
}

/** Универсальный разбор текста (manifest / gradle / source). */
export function analyzeProjectText(text: string): SecurityIssue[] {
  const lower = text.slice(0, 2000).toLowerCase();
  const issues: SecurityIssue[] = [];
  if (lower.includes("<manifest") || lower.includes("android:")) {
    issues.push(...analyzeManifest(text));
  }
  if (lower.includes("dependencies") || lower.includes("implementation(") || lower.includes("plugins {")) {
    issues.push(...analyzeGradle(text));
  }
  issues.push(...analyzeSourceText(text));
  // de-dupe by title
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.category}:${i.title}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const SEV_ICON: Record<IssueSeverity, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "🟢",
  info: "ℹ️",
};

export function formatSecurityReport(issues: SecurityIssue[]): string {
  if (issues.length === 0) {
    return "✅ Security scan: no issues matched the local static rules.";
  }
  const lines = issues.map(
    (i) =>
      `${SEV_ICON[i.severity]} [${i.severity.toUpperCase()}] ${i.title}\n` +
      `   ${i.description}\n` +
      `   → ${i.recommendation}`
  );
  return `Security scan (${issues.length}):\n\n` + lines.join("\n\n");
}
