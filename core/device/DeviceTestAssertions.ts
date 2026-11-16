import { flattenUiTree, type UiSnapshot } from "./AccessibilityTree";
import type { DeviceAssertion, DeviceTestPlan } from "./DeviceTestPlan";

export type AssertionResult = { assertion: DeviceAssertion; passed: boolean; message: string };
export type DeviceTestResult = { passed: boolean; stepResults: Array<{ stepId: string; passed: boolean; assertions: AssertionResult[] }> };

export function evaluateDeviceTestPlan(plan: DeviceTestPlan, snapshot: UiSnapshot): DeviceTestResult {
  const nodes = flattenUiTree(snapshot.root);
  const all = nodes.map((n) => ({
    text: n.text || "", resourceId: n.resourceId || "", contentDescription: n.contentDescription || "",
    packageName: n.packageName || "", className: n.className || "",
  }));
  const stepResults = plan.steps.map((step) => {
    const assertions = step.assertions.map((a) => evaluate(a, all));
    return { stepId: step.id, passed: assertions.every((x) => x.passed), assertions };
  });
  return { passed: snapshot.ok && stepResults.every((s) => s.passed), stepResults };
}

function evaluate(a: DeviceAssertion, nodes: Array<Record<string, string>>): AssertionResult {
  const map: Record<DeviceAssertion["type"], keyof (typeof nodes)[number]> = {
    text_present: "text", text_absent: "text", resource_present: "resourceId",
    content_description_present: "contentDescription", package_present: "packageName", class_present: "className",
  };
  const key = map[a.type];
  const found = nodes.some((n) => n[key].toLowerCase().includes(a.value.toLowerCase()));
  const passed = a.type === "text_absent" ? !found : found;
  return { assertion: a, passed, message: passed ? `PASS ${a.type}: ${a.value}` : `FAIL ${a.type}: ${a.value}` };
}
