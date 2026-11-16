#!/usr/bin/env node
import assert from "node:assert/strict";
import { loadTs } from "./test-helpers/load-ts-module.mjs";

const {
  agentAutonomyPromptBlock,
  installCommandForTool,
} = loadTs("lib/agent-autonomy-policy.ts");

const termux = agentAutonomyPromptBlock("termux");
const ubuntu = agentAutonomyPromptBlock("ubuntu-proot");

assert.match(termux, /selected environment: Termux \/ termux/);
assert.match(termux, /Package manager is pkg \(Termux host\)/);
assert.match(termux, /pkg install -y git/);
assert.match(termux, /APK build IN Termux/);
assert.doesNotMatch(termux, /apt-get install/);

assert.match(ubuntu, /selected environment: Ubuntu \/ ubuntu-proot/);
assert.match(ubuntu, /Package manager is apt-get \(inside guest\)/);
assert.match(ubuntu, /apt-get update -y && apt-get install -y git/);
assert.match(ubuntu, /APK build IN Ubuntu/);
assert.doesNotMatch(ubuntu, /pkg install -y/);

assert.equal(installCommandForTool("git", "termux"), "pkg update -y && pkg install -y git");
assert.equal(installCommandForTool("git", "ubuntu-proot"), "apt-get update -y && apt-get install -y git");
assert.equal(installCommandForTool("unknown", "ubuntu-proot"), null);
console.log("AIB_AGENT_AUTONOMY_POLICY_SELFTEST_OK termux=independent ubuntu=independent managers=pkg,apt-get");
