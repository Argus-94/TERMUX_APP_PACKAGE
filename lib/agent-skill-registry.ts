import { sanitizeMemoryText } from "./session-memory-safety.ts";

export const LOCAL_SKILLS_ROOT = "/storage/emulated/0/AIBuilderTermux/skills" as const;
export type LocalSkillManifest = { name: string; version: string; description: string; content: string; path: string; hash: string };
export type LocalSkillPin = { version: string; hash: string; updatedAt: number };
export type SkillPins = Record<string, LocalSkillPin>;
function q(value: string): string { return `'${String(value).replace(/'/g, `'"'"'`)}'`; }
async function executeSharedCommand(command: string, options: { timeoutMs: number; trustedInternal: true; executionTarget: "embedded-private"; preserveOutput?: true }) {
  const { executeGuardedTermuxCommand } = await import("./termux-executor.ts");
  return executeGuardedTermuxCommand(command, options);
}
export function validSkillName(name: string): boolean { return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name); }
export function skillContentHash(content: string): string {
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ (c + i), 0x85ebca6b);
  }
  return `${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}`;
}
export function parseLocalSkill(name: string, content: string): LocalSkillManifest | null {
  if (!validSkillName(name) || typeof content !== "string" || content.length > 24_000) return null;
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const yaml = match[1];
  const declaredName = yaml.match(/^name:\s*([^\r\n]+)$/m)?.[1]?.trim() || name;
  const version = yaml.match(/^version:\s*([^\r\n]+)$/m)?.[1]?.trim() || "0.0.0";
  const description = yaml.match(/^description:\s*([^\r\n]+)$/m)?.[1]?.trim() || "Local skill";
  if (!validSkillName(declaredName) || !/^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i.test(version)) return null;
  return { name: declaredName, version, description: sanitizeMemoryText(description, 240), content: sanitizeMemoryText(content, 12_000), path: `${LOCAL_SKILLS_ROOT}/${name}/SKILL.md`, hash: skillContentHash(content) };
}
export function checkSkillPin(skill: Pick<LocalSkillManifest, "name" | "version" | "hash">, pins: SkillPins): { ok: boolean; pinned: boolean; warning?: string } {
  const pin = pins[skill.name];
  if (!pin) return { ok: true, pinned: false, warning: "SKILL_UNPINNED" };
  if (pin.version !== skill.version || pin.hash !== skill.hash) return { ok: false, pinned: true, warning: "SKILL_PIN_MISMATCH" };
  return { ok: true, pinned: true };
}
export function serializeSkillPins(pins: SkillPins): string { return JSON.stringify(pins, null, 2); }
export function parseSkillPins(raw: string): SkillPins {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out: SkillPins = {};
    for (const [name, candidate] of Object.entries(value)) {
      if (!validSkillName(name) || !candidate || typeof candidate !== "object") continue;
      const pin = candidate as Record<string, unknown>;
      if (typeof pin.version === "string" && typeof pin.hash === "string" && /^[a-f0-9]{16}$/i.test(pin.hash)) {
        out[name] = { version: pin.version.slice(0, 80), hash: pin.hash.toLowerCase(), updatedAt: Number.isFinite(pin.updatedAt) ? Number(pin.updatedAt) : 0 };
      }
    }
    return out;
  } catch { return {}; }
}
async function listSkillNames(): Promise<string[]> {
  try {
    const r = await executeSharedCommand(`find ${q(LOCAL_SKILLS_ROOT)} -mindepth 2 -maxdepth 2 -type f -name SKILL.md -print 2>/dev/null | sort | head -80`, { timeoutMs: 12_000, trustedInternal: true, executionTarget: "embedded-private", preserveOutput: true });
    return String(r.stdout || "").split(/\r?\n/).map((p) => p.trim()).filter((p) => p.startsWith(`${LOCAL_SKILLS_ROOT}/`) && /^\/storage\/emulated\/0\/AIBuilderTermux\/skills\/[a-z0-9_-]+\/SKILL\.md$/i.test(p)).map((p) => p.slice(`${LOCAL_SKILLS_ROOT}/`.length).split("/")[0]);
  } catch { return []; }
}
export async function readSkillPins(): Promise<SkillPins> {
  try {
    const r = await executeSharedCommand(`cat -- ${q(`${LOCAL_SKILLS_ROOT}/pins.json`)}`, { timeoutMs: 8_000, trustedInternal: true, executionTarget: "embedded-private", preserveOutput: true });
    return parseSkillPins(String(r.stdout || ""));
  } catch { return {}; }
}
export async function listLocalSkills(): Promise<Array<LocalSkillManifest & { pin: ReturnType<typeof checkSkillPin> }>> {
  const pins = await readSkillPins();
  const out: Array<LocalSkillManifest & { pin: ReturnType<typeof checkSkillPin> }> = [];
  for (const name of await listSkillNames()) {
    try {
      const path = `${LOCAL_SKILLS_ROOT}/${name}/SKILL.md`;
      const r = await executeSharedCommand(`cat -- ${q(path)}`, { timeoutMs: 8_000, trustedInternal: true, executionTarget: "embedded-private", preserveOutput: true });
      const skill = parseLocalSkill(name, String(r.stdout || ""));
      if (skill) out.push({ ...skill, pin: checkSkillPin(skill, pins) });
    } catch { /* inaccessible local skill is omitted */ }
  }
  return out;
}
export async function readLocalSkill(name: string): Promise<(LocalSkillManifest & { pin: ReturnType<typeof checkSkillPin> }) | null> {
  if (!validSkillName(name)) return null;
  const skills = await listLocalSkills();
  return skills.find((s) => s.name === name) || null;
}
export async function pinLocalSkill(name: string, unpin = false): Promise<{ ok: boolean; reason?: string; pin?: LocalSkillPin }> {
  if (!validSkillName(name)) return { ok: false, reason: "SKILL_NAME_INVALID" };
  const current = await readSkillPins();
  if (unpin) {
    delete current[name];
  } else {
    const skill = await readLocalSkill(name);
    if (!skill) return { ok: false, reason: "SKILL_NOT_FOUND" };
    current[name] = { version: skill.version, hash: skill.hash, updatedAt: Date.now() };
  }
  try {
    const payload = serializeSkillPins(current);
    const result = await executeSharedCommand(`mkdir -p ${q(LOCAL_SKILLS_ROOT)} && printf '%s' ${q(payload)} > ${q(`${LOCAL_SKILLS_ROOT}/pins.json`)} && echo AIB_SKILL_PINS_SAVED`, { timeoutMs: 12_000, trustedInternal: true, executionTarget: "embedded-private", preserveOutput: true });
    if (result.exitCode !== 0 || !/AIB_SKILL_PINS_SAVED/.test(`${result.stdout || ""}\n${result.stderr || ""}`)) return { ok: false, reason: "SKILL_PINS_WRITE_FAILED" };
    return { ok: true, ...(current[name] ? { pin: current[name] } : {}) };
  } catch { return { ok: false, reason: "SKILL_PINS_WRITE_FAILED" }; }
}
