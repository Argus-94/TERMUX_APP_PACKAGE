#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadTs } from "./aib-interceptor-test-helper.mjs";

const { ProotContainerManager } = loadTs("core/container/ProotContainerManager.ts");
const { createHomeLayout } = loadTs("core/home/HomeLayout.ts");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-proot-mount-security-"));
try {
  const home = createHomeLayout(path.join(temp, "AIBuilderTermux"));
  fs.mkdirSync(home.projects, { recursive: true });
  fs.mkdirSync(home.metadata, { recursive: true });
  const projectRoot = path.join(home.projects, "project");
  fs.mkdirSync(projectRoot, { recursive: true });
  const outside = path.join(temp, "outside-secret");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.txt"), "fixture");
  const escapeLink = path.join(home.projects, "escape-link");
  fs.symlinkSync(outside, escapeLink, "dir");

  const state = new Map();
  const executed = [];
  let omitExitCodeForMarker = false;
  let holdExec = false;
  let releaseHeldExec;
  const environment = {
    async exec(command) {
      executed.push(command);
      if (command.includes("AIB_LIST_BEGIN") && command.includes("AIB_LOGIN_BEGIN")) return {
        exitCode: 0,
        stdout: "AIB_PROBE_BEGIN\nAIB_PROOT_TOOL:AVAILABLE\nAIB_HOST_UNAME:aarch64\nAIB_LIST_EXIT:0\nAIB_LIST_BEGIN\nInstalled distributions:\n  Debian (debian)\nAIB_LIST_END\nAIB_LOGIN_EXIT:0\nAIB_LOGIN_BEGIN\nAIB_PROBE_ID:debian\nAIB_PROBE_UID:0\nAIB_PROBE_UNAME:aarch64\nAIB_LOGIN_END\nAIB_PROBE_END\n",
        stderr: "",
      };
      if (holdExec && command.includes("exec node") && command.includes("hold")) await new Promise((resolve) => { releaseHeldExec = resolve; });
      if (omitExitCodeForMarker && command.includes("exec ls") && command.includes("missing-status")) return { stdout: "looks successful\n", stderr: "" };
      return { exitCode: 0, stdout: "ok\n", stderr: "" };
    },
    async spawn(command) { executed.push(command); return { exitCode: 0, stdout: "", stderr: "" }; },
    async read(file) { if (!state.has(file)) throw new Error("ENOENT"); return state.get(file); },
    async write(file, value) { state.set(file, value); },
    async exists(file) { return fs.existsSync(file) || state.has(file); },
    async mkdir(dir) { fs.mkdirSync(dir, { recursive: true }); },
    async resolvePath(file) { return fs.realpathSync(file); },
    getHome() { return home.root; },
  };
  const manager = new ProotContainerManager(environment, home);
  manager.registerImage({ id: "debian:stable" });

  const symlinkMount = await manager.create({
    imageId: "debian:stable", name: "symlink-escape",
    mounts: [{ hostPath: escapeLink, containerPath: "/workspace", mode: "rw" }],
  });
  await manager.start(symlinkMount.id);
  await assert.rejects(manager.exec(symlinkMount.id, "ls"), /CONTAINER_MOUNT_HOST_OUTSIDE_PROJECTS/,
    "a project-root symlink resolving outside projects must never be bind-mounted");

  const traversalMount = await manager.create({
    imageId: "debian:stable", name: "destination-traversal", projectId: "project",
    mounts: [{ hostPath: projectRoot, containerPath: "/workspace/../../etc", mode: "rw" }],
  });
  await manager.start(traversalMount.id);
  await assert.rejects(manager.exec(traversalMount.id, "ls"), /CONTAINER_MOUNT_PATH_INVALID/,
    "destination traversal must not redirect an allowed /workspace bind onto container system paths");

  const lexicalEscape = await manager.create({
    imageId: "debian:stable", name: "lexical-escape", projectId: "project",
    mounts: [{ hostPath: path.join(home.projects, "..", "outside-secret"), containerPath: "/workspace", mode: "rw" }],
  });
  await manager.start(lexicalEscape.id);
  await assert.rejects(manager.exec(lexicalEscape.id, "ls"), /CONTAINER_MOUNT_HOST_OUTSIDE_PROJECTS/);

  const valid = await manager.create({ imageId: "debian:stable", name: "valid-project", projectId: "project" });
  await manager.start(valid.id);
  const result = await manager.exec(valid.id, "ls", [], { cwd: "/workspace" });
  assert.equal(result.exitCode, 0);
  assert.ok(executed.at(-1).includes(`${fs.realpathSync(projectRoot)}:/workspace`), "safe mount binds the canonical in-project path");
  assert.ok(!executed.at(-1).includes("-lc"), "container task shell must not source login startup files");
  omitExitCodeForMarker = true;
  const missingStatus = await manager.exec(valid.id, "ls", ["missing-status"], { cwd: "/workspace" });
  assert.equal(missingStatus.exitCode, -1, "missing RUN_COMMAND status is never synthesized as exit 0");
  assert.equal((await manager.getAsync(valid.id))?.status, "error", "missing native status cannot persist a false running state");
  omitExitCodeForMarker = false;
  assert.equal((await manager.inspect(valid.id)).status, "running", "a fresh complete guest identity probe may restore the container status");
  assert.equal((await manager.findByProjectId("project"))?.id, valid.id, "most recently used project's persisted container is resolved for task wake");
  holdExec = true;
  const active = manager.exec(valid.id, "node", ["hold"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.isExecuting(valid.id), true);
  await assert.rejects(manager.start(valid.id), /CONTAINER_BUSY/, "container start must not race an active command");
  await assert.rejects(manager.stop(valid.id), /CONTAINER_BUSY/, "pressure sleep must not mark an active command stopped");
  await assert.rejects(manager.remove(valid.id), /CONTAINER_BUSY/, "container removal must not race an active command");
  releaseHeldExec?.();
  await active;
  holdExec = false;
  assert.equal(manager.isExecuting(valid.id), false);
  const reloaded = new ProotContainerManager(environment, home);
  assert.equal((await reloaded.findByProjectId("project"))?.id, valid.id, "project mapping survives a fresh manager and durable state reload");
  assert.equal((await reloaded.getAsync(valid.id))?.status, "unknown", "stale persisted running metadata is not live until identity is rechecked");
  await assert.rejects(reloaded.exec(valid.id, "ls"), /CONTAINER_NOT_RUNNING/);
  assert.equal((await reloaded.inspect(valid.id)).status, "running", "a fresh matching guest identity restores the usable running status");
  let failNextRead = true;
  const retryEnvironment = {
    ...environment,
    async read(file) {
      if (file === `${home.metadata}/proot-containers.json` && failNextRead) { failNextRead = false; throw new Error("transient storage failure"); }
      return environment.read(file);
    },
  };
  const retryManager = new ProotContainerManager(retryEnvironment, home);
  await assert.rejects(retryManager.findByProjectId("project"), /PROOT_CONTAINER_STATE_LOAD_FAILED/);
  assert.equal((await retryManager.findByProjectId("project"))?.id, valid.id, "transient reads must be retried without marking the state as an empty loaded store");
  console.log("AIB_PROOT_CONTAINER_MOUNT_SECURITY_SELFTEST_OK symlink_escape=blocked destination_traversal=blocked lexical_escape=blocked canonical_project_bind=pass");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
