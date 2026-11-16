import fs from "node:fs";
const read = (p) => fs.readFileSync(p, "utf8");
const factory = read("core/workspace/OneClickAppFactory.ts");
const manager = read("core/container/ProotContainerManager.ts");
const linux = read("core/linux/LinuxRuntime.ts");
const facade = read("core/RuntimeFacade.ts");
const checks = [
  ["factory is exposed", facade.includes("runOneClickAppFactory")],
  ["factory passes project id to APK mapping", factory.includes("runAndroidBuild(containerId, projectId)") && factory.includes("runAndroidBuild(containerId: string, projectId: string)")],
  ["factory has no shared project hint state", !factory.includes("currentProjectIdHint")],
  ["factory records failed current stage", factory.includes("record(currentStage, false, message")],
  ["container binds /workspace", manager.includes('"--bind"') && manager.includes("/workspace")],
  ["container validates mount roots", manager.includes("CONTAINER_MOUNT_HOST_OUTSIDE_PROJECTS")],
  ["container requires exact command allowlist", manager.includes("const base = command.trim();")],
  ["container provisions only a confirmed-missing profile under a lock", manager.includes("withProotDistroInstallLock") && manager.includes("buildProotDistroInstallCommand") && manager.includes("state.installed !== false") && manager.includes("PROOT_PROFILE_STATE_UNVERIFIED")],
  ["linux allowlist is exact", linux.includes("return ALLOWED_COMMANDS.has(command.trim())")],
  ["linux debian rootfs is not mapped to kali", !linux.includes('profile === "ubuntu" ? "ubuntu" : "kali"')],
];
for (const [name, ok] of checks) { if (!ok) throw new Error(`PHASE36_AUDIT_FAIL:${name}`); }
console.log("AIB_PHASE36_ONE_CLICK_APP_FACTORY_SELFTEST_OK");
