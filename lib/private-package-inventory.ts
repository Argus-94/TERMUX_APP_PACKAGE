import type { ToolArgs, ToolExecutionContext } from "./agent-tools/types";

export const PRIVATE_PACKAGE_QUERY_MAX_LIMIT = 100;
export const PRIVATE_PACKAGE_QUERY_DEFAULT_LIMIT = 50;
export const PRIVATE_PACKAGE_QUERY_MAX_OUTPUT_BYTES = 32 * 1024;
export const PRIVATE_PACKAGE_QUERY_TIMEOUT_MS = 5_000;
export const PRIVATE_PACKAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9+.-]{0,127}$/;
const PACKAGE_OUTPUT_NAME_PATTERN = /^[a-z0-9][a-z0-9+.-]{0,127}(?::[a-z0-9][a-z0-9_-]{0,31})?$/;
const KNOWN_PACKAGE_STATES = new Set([
  "installed",
  "config-files",
  "not-installed",
  "unpacked",
  "half-configured",
  "half-installed",
  "triggers-awaited",
  "triggers-pending",
]);

export type NativePrivatePackageQueryResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  outputTruncated: boolean;
}>;

export type NativePrivatePackageQuery = (
  name: string | null,
  limit: number,
) => Promise<NativePrivatePackageQueryResult>;

export function validatePrivatePackageInventoryArgs(args: ToolArgs): string | null {
  const keys = Object.keys(args);
  if (keys.some((key) => key !== "name" && key !== "limit")) {
    return "AIB_PRIVATE_PACKAGE_QUERY_ARGS_UNSUPPORTED";
  }
  if (args.name !== undefined &&
    (typeof args.name !== "string" || !PRIVATE_PACKAGE_NAME_PATTERN.test(args.name))) {
    return "AIB_PRIVATE_PACKAGE_NAME_INVALID";
  }
  if (args.limit !== undefined &&
    (!Number.isSafeInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > PRIVATE_PACKAGE_QUERY_MAX_LIMIT)) {
    return "AIB_PRIVATE_PACKAGE_LIMIT_INVALID";
  }
  return null;
}

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function queryError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const code = message.match(/^(AIB_PRIVATE_PACKAGE_QUERY_[A-Z0-9_]{1,64})$/)?.[1];
  return code ?? "AIB_PRIVATE_PACKAGE_QUERY_FAILED";
}

function parseRows(
  stdout: string,
  requestedName: string | null,
  limit: number,
  truncated: boolean,
): { packages: Array<{ name: string; version: string; status: string }>; valid: boolean } {
  if (utf8ByteLength(stdout) > PRIVATE_PACKAGE_QUERY_MAX_OUTPUT_BYTES) return { packages: [], valid: false };
  let completeText = stdout;
  if (truncated && completeText && !completeText.endsWith("\n")) {
    const lastNewline = completeText.lastIndexOf("\n");
    completeText = lastNewline < 0 ? "" : completeText.slice(0, lastNewline + 1);
  } else if (!truncated && completeText && !completeText.endsWith("\n")) {
    return { packages: [], valid: false };
  }

  const lines = completeText === "" ? [] : completeText.slice(0, -1).split("\n");
  if (lines.length > limit) return { packages: [], valid: false };
  const packages: Array<{ name: string; version: string; status: string }> = [];
  for (const line of lines) {
    const fields = line.split("\t");
    if (fields.length !== 3) return { packages: [], valid: false };
    const [name, version, rawStatus] = fields;
    if (!PACKAGE_OUTPUT_NAME_PATTERN.test(name) ||
      !version || version.length > 160 || /[^\x21-\x7e]/.test(version) ||
      !/^[a-z-]{1,32}$/.test(rawStatus)) {
      return { packages: [], valid: false };
    }
    if (requestedName !== null && name !== requestedName && !name.startsWith(`${requestedName}:`)) {
      return { packages: [], valid: false };
    }
    packages.push({
      name,
      version,
      status: KNOWN_PACKAGE_STATES.has(rawStatus) ? rawStatus : "unknown",
    });
  }
  return { packages, valid: true };
}

/**
 * Builds the Agent tool around one dedicated native, fixed-argv package query.
 * It has no shell, selected-backend, proot, external-Termux, host, or mutation route.
 */
export function createPrivatePackageInventoryTool(query: NativePrivatePackageQuery) {
  return Object.freeze({
    validate: validatePrivatePackageInventoryArgs,
    async execute(args: ToolArgs, context?: ToolExecutionContext) {
      if (context?.executionTarget !== "embedded-private") {
        throw new Error("AIB_PRIVATE_PACKAGE_QUERY_PRIVATE_TARGET_REQUIRED");
      }
      const validationError = validatePrivatePackageInventoryArgs(args);
      if (validationError) throw new Error(validationError);

      const name = typeof args.name === "string" ? args.name : null;
      const limit = args.limit === undefined ? PRIVATE_PACKAGE_QUERY_DEFAULT_LIMIT : Number(args.limit);
      let result: NativePrivatePackageQueryResult;
      try {
        result = await query(name, limit);
      } catch (error: unknown) {
        return { ok: false, error: queryError(error), source: "embedded-private" } as const;
      }
      if (!result || typeof result !== "object" || typeof result.stdout !== "string" ||
        typeof result.stderr !== "string" || !Number.isInteger(result.exitCode) ||
        typeof result.timedOut !== "boolean" || typeof result.outputTruncated !== "boolean") {
        return { ok: false, error: "AIB_PRIVATE_PACKAGE_QUERY_RESULT_INVALID", source: "embedded-private" } as const;
      }
      if (result.timedOut) {
        return { ok: false, error: "AIB_PRIVATE_PACKAGE_QUERY_TIMEOUT", source: "embedded-private" } as const;
      }
      if (utf8ByteLength(result.stderr) > 4 * 1024 || utf8ByteLength(result.stdout) > PRIVATE_PACKAGE_QUERY_MAX_OUTPUT_BYTES) {
        return { ok: false, error: "AIB_PRIVATE_PACKAGE_QUERY_OUTPUT_LIMIT_EXCEEDED", source: "embedded-private" } as const;
      }

      if (result.exitCode !== 0) {
        const expectedMissing = name !== null && result.exitCode === 1 && !result.outputTruncated &&
          result.stdout === "" && result.stderr.trim() === `dpkg-query: no packages found matching ${name}`;
        if (!expectedMissing) {
          return { ok: false, error: "AIB_PRIVATE_PACKAGE_QUERY_FAILED", source: "embedded-private" } as const;
        }
        return {
          ok: true,
          source: "embedded-private",
          name,
          packages: [{ name, version: "", status: "not-installed" }],
          complete: true,
          truncated: false,
          limit,
        } as const;
      }
      if (result.stderr !== "") {
        return { ok: false, error: "AIB_PRIVATE_PACKAGE_QUERY_DIAGNOSTIC", source: "embedded-private" } as const;
      }

      const parsed = parseRows(result.stdout, name, limit, result.outputTruncated);
      if (!parsed.valid) {
        return { ok: false, error: "AIB_PRIVATE_PACKAGE_QUERY_OUTPUT_INVALID", source: "embedded-private" } as const;
      }
      if (name !== null && parsed.packages.length === 0) {
        return { ok: false, error: "AIB_PRIVATE_PACKAGE_QUERY_RESULT_UNKNOWN", source: "embedded-private" } as const;
      }
      return {
        ok: true,
        source: "embedded-private",
        name,
        packages: parsed.packages,
        complete: !result.outputTruncated,
        truncated: result.outputTruncated,
        limit,
      } as const;
    },
  });
}
