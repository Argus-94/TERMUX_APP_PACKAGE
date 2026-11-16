#!/usr/bin/env node
import assert from "node:assert/strict";
import { createBuiltinFailureFixtures, replayFixtureOffline, validateFailureFixture, createFailureFixture } from "../lib/agent-failure-fixture.ts";
import { createAgentTrajectory, appendAgentTrajectoryStep } from "../lib/agent-trajectory.ts";
const fixtures = createBuiltinFailureFixtures();
assert.equal(fixtures.length, 3);
assert.ok(fixtures.every((fixture) => fixture.steps[0]?.kind === "shell"));
for (const fixture of fixtures) {
  assert.ok(validateFailureFixture(fixture));
  const replay = replayFixtureOffline(fixture);
  assert.equal(replay.ok, true, fixture.id);
}
const t = createAgentTrajectory({ task: "private command token=secret", goalKind: "dir_mkdir", backend: "ubuntu-proot" });
appendAgentTrajectoryStep(t, { kind: "shell", action: "shell-command", status: "fail", backend: "ubuntu-proot", exitCode: 2, path: "/storage/emulated/0/Private" });
const failure = createFailureFixture(t, "token=private-value GOAL_NOT_MET");
assert.ok(validateFailureFixture(failure));
const json = JSON.stringify(failure);
for (const value of ["private command", "secret", "/storage/emulated/0/Private", "private-value"]) assert.equal(json.includes(value), false);
assert.equal(failure.expected.mustContain, "AIB_GOAL_OK");
console.log("AIB_REPLAY_FIXTURE_SELFTEST_OK goldens=3 replay=offline privacy=redacted");
