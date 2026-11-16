import {
  assertTransferProjectName,
  createProjectTransferManifest,
  normalizeTransferPath,
} from "./project-transfer";

describe("project transfer boundary", () => {
  it("accepts safe project names", () => {
    expect(assertTransferProjectName("demo-project_1")).toBe("demo-project_1");
  });

  it("rejects project-name traversal", () => {
    expect(() => assertTransferProjectName("../demo")).toThrow();
  });

  it("rejects path traversal", () => {
    expect(() => normalizeTransferPath("../outside")).toThrow();
    expect(() => normalizeTransferPath("src/../../outside")).toThrow();
  });

  it("normalizes separators without escaping the root", () => {
    expect(normalizeTransferPath("./src\\main.ts")).toBe("src/main.ts");
  });

  it("keeps HOME metadata outside the portable payload", () => {
    const manifest = createProjectTransferManifest("demo", [
      "src/main.ts",
      ".ai-builder/metadata.json",
      "README.md",
    ]);
    expect(manifest.files).toEqual(["README.md", "src/main.ts"]);
  });
});
