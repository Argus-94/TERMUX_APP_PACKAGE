import { githubCreateRepository } from "../../github-tools";
import type { ToolArgs } from "../types";

export function validate(args: ToolArgs): string | null {
  const name = String(args.name || args.repo || "").trim();
  if (!name) return "GITHUB_REPO_NAME_REQUIRED";
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(name) || name.length > 100) {
    return "GITHUB_REPO_NAME_INVALID";
  }
  return null;
}

export async function execute(args: ToolArgs) {
  const name = String(args.name || args.repo || "").trim();
  const isPrivate =
    args.private === true ||
    args.private === "true" ||
    args.private === 1 ||
    String(args.visibility || "").toLowerCase() === "private" ||
    // default private when user said «только мне» — playbook sets private:true
    (args.private !== false && args.private !== "false" && args.visibility !== "public");
  const description = String(args.description || "").trim();
  const autoInit = args.autoInit !== false && args.auto_init !== false;
  return githubCreateRepository(name, {
    private: isPrivate !== false,
    description,
    autoInit,
  });
}
