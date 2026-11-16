export type AgentOperationClass = "read" | "write-shared" | "write-project" | "shell-destructive" | "network" | "github";
export type AgentOperationClassificationInput = {
  command?: string;
  tool?: string;
  projectPath?: string | null;
  targetPath?: string;
};

/** Coarse audit class only; classification never grants execution permission. */
export function classifyAgentOperationClass(input: AgentOperationClassificationInput): AgentOperationClass {
  const tool = String(input.tool || "").toLowerCase();
  const command = String(input.command || "").trim();
  const text = `${tool} ${command}`;
  if (tool.startsWith("github.")) return "github";
  if (tool === "skills.pin") return "write-shared";
  if (tool === "memory.retain") return "write-project";
  if (/\b(?:curl|wget|git\s+(?:clone|fetch|pull|push)|npm\s+(?:install|view)|pip\s+install)\b/i.test(text)) return "network";
  const recursiveRemove = /\brm\s+(?=[^\n]*(?:--recursive|-[a-z]*r[a-z]*(?:\s|$)))/i.test(text);
  if (recursiveRemove || /\b(?:proot-distro\s+(?:reset|remove|uninstall)|apktool\s+b|zip\s+[^\n]*(?:-FS|--overwrite|--force))\b/i.test(text)) return "shell-destructive";
  const writes = /\b(?:mkdir|touch|tee|install|mv|cp|rm|truncate|printf|echo|sed\s+-i|fs\.(?:create|delete|replace(?:range)?)|ast\.edit|interceptor\.(?:enable|disable|command))\b/i.test(text) || /(?:^|\s)(?:>|>>)/.test(command);
  if (writes) {
    const target = String(input.targetPath || "");
    if (/\/storage\/emulated\/\d+\/|\/sdcard\//i.test(`${target} ${command}`)) return "write-shared";
    if (input.projectPath) return "write-project";
  }
  if (/^\s*(?:cat|ls|find|grep|rg|head|tail|stat|file|pwd|git\s+(?:status|log|diff|show))\b/i.test(command) || /^(?:fs\.(?:read|list)|skills\.(?:list|read|verify)|memory\.(?:recall|reflect))$/.test(tool)) return "read";
  return writes ? "write-project" : "read";
}
