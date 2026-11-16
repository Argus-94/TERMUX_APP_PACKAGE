import type { UiSnapshot } from "./AccessibilityTree";

export type DeviceAssertion =
  | { type: "text_present"; value: string }
  | { type: "text_absent"; value: string }
  | { type: "resource_present"; value: string }
  | { type: "content_description_present"; value: string }
  | { type: "package_present"; value: string }
  | { type: "class_present"; value: string };

export type DeviceTestStep = {
  id: string;
  description: string;
  action?: { type: "tap" | "swipe" | "wait" | "launch" | "tap_selector" | "type_text"; selector?: Record<string, string>; text?: string; x1?: number; y1?: number; x2?: number; y2?: number; durationMs?: number };
  assertions: DeviceAssertion[];
};

export type DeviceTestPlan = {
  version: 1;
  packageName?: string;
  goal: string;
  steps: DeviceTestStep[];
};

/** Creates a deterministic baseline plan; an LLM can refine it, but never bypass assertions. */
export function generateDeviceTestPlan(goal: string, packageName?: string, snapshot?: UiSnapshot): DeviceTestPlan {
  const normalized = String(goal || "Verify app launches").trim();
  const assertions: DeviceAssertion[] = [];
  if (packageName) assertions.push({ type: "package_present", value: packageName });
  const quoted = normalized.match(/["“”']([^"“”']+)["“”']/)?.[1];
  if (quoted) assertions.push({ type: "text_present", value: quoted });
  if (!assertions.length && snapshot?.ok) {
    const firstText = snapshot.rawXml?.match(/text="([^"]{2,80})"/)?.[1];
    if (firstText) assertions.push({ type: "text_present", value: firstText });
  }
  return {
    version: 1,
    packageName,
    goal: normalized,
    steps: [{ id: "launch", description: "Application launches and reaches the requested initial state", assertions }],
  };
}
