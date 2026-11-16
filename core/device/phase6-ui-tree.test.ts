import { parseUiHierarchy, findUiNodes, nodeCenter } from "./AccessibilityTree";
import { generateDeviceTestPlan } from "./DeviceTestPlan";
import { evaluateDeviceTestPlan } from "./DeviceTestAssertions";

const xml = `<hierarchy><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example.app" clickable="false" enabled="true" bounds="[0,0][1080,1920]"><node index="1" text="Continue" resource-id="com.example.app:id/continue" class="android.widget.Button" package="com.example.app" clickable="true" enabled="true" bounds="[100,1600][980,1720]"/></node></hierarchy>`;
const snapshot = parseUiHierarchy(xml);
if (!snapshot.ok || snapshot.nodeCount !== 2) throw new Error("UI_TREE_PARSE_FAILED");
const matches = findUiNodes(snapshot.root, { text: "Continue" });
if (matches.length !== 1 || nodeCenter(matches[0])?.x !== 540) throw new Error("UI_TREE_QUERY_FAILED");
const plan = generateDeviceTestPlan('Tap "Continue" and verify it is visible', "com.example.app", snapshot);
const result = evaluateDeviceTestPlan(plan, snapshot);
if (!result.passed) throw new Error("UI_ASSERTION_FAILED");
console.log("AIB_PHASE6_UI_TREE_SELFTEST_OK");
