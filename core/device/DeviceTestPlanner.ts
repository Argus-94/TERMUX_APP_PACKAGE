import type { DeviceAssertion, DeviceTestPlan, DeviceTestStep } from "./DeviceTestPlan";

export type DeviceTestCase = DeviceTestPlan & { id: string; title: string; preconditions: string[] };
export type DeviceTestSuite = { version: 1; goal: string; packageName?: string; cases: DeviceTestCase[] };
export type TestPlanModel = (prompt: string) => Promise<string>;

/**
 * Converts a natural-language QA request into bounded, machine-checkable test cases.
 * A model may refine the suite, but every returned value is validated locally and
 * a deterministic fallback is always available.
 */
export async function generateDeviceTestSuite(goal: string, packageName?: string, model?: TestPlanModel): Promise<DeviceTestSuite> {
  const fallback = buildFallbackSuite(goal, packageName);
  if (!model) return fallback;
  try {
    const raw = await model([
      "Generate an Android UI test suite.",
      `Goal: ${String(goal || "Verify app").trim()}`,
      `Package: ${packageName || "unknown"}`,
      "Return ONLY JSON matching {version:1,goal:string,packageName?:string,cases:[{id,title,preconditions,version:1,goal,packageName?,steps:[{id,description,action?,assertions:[...]}]}]}.",
      "Allowed actions: launch, tap_selector, type_text, swipe, wait.",
      "Selectors use only text, resourceId, contentDescription, className.",
      "Allowed assertions: text_present, text_absent, resource_present, content_description_present, package_present, class_present.",
      "Maximum 8 cases and 12 steps per case. Do not include shell commands or coordinates.",
    ].join("\n"));
    const parsed = parseSuiteJson(raw, packageName);
    if (parsed && parsed.cases.length) return parsed;
  } catch {
    // Deterministic fallback is intentional.
  }
  return fallback;
}

export function buildFallbackSuite(goal: string, packageName?: string): DeviceTestSuite {
  const text = String(goal || "Verify app launches").trim();
  const lower = text.toLowerCase();
  const cases: DeviceTestCase[] = [];
  const add = (id: string, title: string, assertions: DeviceAssertion[], steps: DeviceTestStep[] = []) => {
    cases.push({ id, title, preconditions: ["APK is installed by the runner"], version: 1, packageName, goal: title, steps: [
      { id: "launch", description: "Launch application", action: { type: "launch" }, assertions: packageName ? [{ type: "package_present", value: packageName }] : [] },
      ...steps,
      ...(assertions.length ? [{ id: "verify", description: "Verify expected UI state", assertions }] : []),
    ] });
  };
  const hasLogin = /(login|sign[ -]?in|вход|авторизац)/i.test(lower);
  const hasRegistration = /(register|registration|sign[ -]?up|регистрац)/i.test(lower);
  const hasLogout = /(logout|sign[ -]?out|выход)/i.test(lower);
  const hasWrong = /(wrong|invalid|incorrect|неверн|ошибочн).*(password|парол)/i.test(lower) || /(password|парол).*(wrong|invalid|incorrect|неверн|ошибочн)/i.test(lower);
  if (hasLogin) add("login", "Login flow", [{ type: "text_present", value: "Login" }], [{ id: "find-login", description: "Find login control", action: { type: "tap_selector", selector: { text: "Login" } }, assertions: [] }]);
  if (hasRegistration) add("registration", "Registration flow", [{ type: "text_present", value: "Register" }], [{ id: "find-register", description: "Find registration control", action: { type: "tap_selector", selector: { text: "Register" } }, assertions: [] }]);
  if (hasLogout) add("logout", "Logout flow", [{ type: "text_present", value: "Login" }], [{ id: "find-logout", description: "Find logout control", action: { type: "tap_selector", selector: { text: "Logout" } }, assertions: [] }]);
  if (hasWrong) add("wrong-password", "Wrong password validation", [{ type: "text_present", value: "password" }], [{ id: "find-password", description: "Find password field", action: { type: "tap_selector", selector: { text: "Password" } }, assertions: [] }]);
  if (!cases.length) {
    const smokeAssertions: DeviceAssertion[] = packageName ? [{ type: "package_present", value: packageName }] : [];
    add("smoke", text, smokeAssertions);
  }
  return { version: 1, goal: text, packageName, cases: cases.slice(0, 8) };
}

function parseSuiteJson(raw: string, packageName?: string): DeviceTestSuite | null {
  const cleaned = String(raw || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  let value: any;
  try { value = JSON.parse(cleaned); } catch { const m = cleaned.match(/\{[\s\S]*\}/); if (!m) return null; try { value = JSON.parse(m[0]); } catch { return null; } }
  if (!value || value.version !== 1 || !Array.isArray(value.cases)) return null;
  const cases: DeviceTestCase[] = [];
  for (const c of value.cases.slice(0, 8)) {
    if (!c || typeof c.id !== "string" || typeof c.title !== "string" || !Array.isArray(c.steps)) continue;
    const steps: DeviceTestStep[] = [];
    for (const s of c.steps.slice(0, 12)) {
      if (!s || typeof s.id !== "string" || typeof s.description !== "string" || !Array.isArray(s.assertions)) continue;
      const assertions = s.assertions.map(normalizeAssertion).filter(Boolean) as DeviceAssertion[];
      const action = normalizeAction(s.action);
      steps.push({ id: s.id.slice(0, 80), description: s.description.slice(0, 300), action, assertions });
    }
    if (steps.length) cases.push({ id: c.id.slice(0, 80), title: c.title.slice(0, 160), preconditions: Array.isArray(c.preconditions) ? c.preconditions.slice(0, 8).map(String) : [], version: 1, goal: c.goal ? String(c.goal).slice(0, 500) : c.title, packageName: packageName || (typeof c.packageName === "string" ? c.packageName : undefined), steps });
  }
  return cases.length ? { version: 1, goal: String(value.goal || "Android test suite").slice(0, 1000), packageName, cases } : null;
}

function normalizeAssertion(a: any): DeviceAssertion | null {
  if (!a || typeof a.value !== "string") return null;
  const types = ["text_present", "text_absent", "resource_present", "content_description_present", "package_present", "class_present"];
  return types.includes(a.type) ? { type: a.type, value: a.value.slice(0, 300) } as DeviceAssertion : null;
}
function normalizeAction(a: any): DeviceTestStep["action"] | undefined {
  if (!a || typeof a.type !== "string") return undefined;
  if (a.type === "launch" || a.type === "wait") return { type: a.type, durationMs: clampNum(a.durationMs, 100, 10000, a.type === "wait" ? 500 : undefined) } as any;
  if (a.type === "tap_selector" || a.type === "type_text") {
    if (!a.selector || typeof a.selector !== "object") return undefined;
    const selector: Record<string,string> = {};
    for (const k of ["text", "resourceId", "contentDescription", "className"]) if (typeof a.selector[k] === "string" && a.selector[k]) selector[k] = a.selector[k].slice(0, 200);
    if (!Object.keys(selector).length) return undefined;
    return a.type === "type_text" ? { type: "type_text", selector, text: typeof a.text === "string" ? a.text.slice(0, 500) : "" } as any : { type: "tap_selector", selector } as any;
  }
  if (a.type === "swipe" && [a.x1,a.y1,a.x2,a.y2].every((n) => typeof n === "number" && Number.isFinite(n))) return { type: "swipe", x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, durationMs: clampNum(a.durationMs, 50, 5000, 300) } as any;
  return undefined;
}
function clampNum(v: any, min: number, max: number, fallback?: number): number { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : (fallback ?? min); }
