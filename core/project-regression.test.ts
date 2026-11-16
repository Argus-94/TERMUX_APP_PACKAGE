import {
  assertRegressionClean,
  runProjectRegression,
} from "./project-regression";

describe("project subsystem regression harness", () => {
  it("reports all project boundaries as passing", async () => {
    const report = await runProjectRegression([
      { name: "manager", run: () => undefined },
      { name: "storage", run: async () => undefined },
      { name: "metadata", run: () => undefined },
      { name: "lifecycle", run: async () => undefined },
      { name: "transfer", run: () => undefined },
    ]);

    expect(report.failed).toHaveLength(0);
    expect(report.passed).toEqual([
      "manager", "storage", "metadata", "lifecycle", "transfer",
    ]);
    expect(() => assertRegressionClean(report)).not.toThrow();
  });

  it("propagates a failed boundary", async () => {
    const report = await runProjectRegression([
      { name: "manager", run: () => undefined },
      { name: "transfer", run: () => { throw new Error("boundary failure"); } },
    ]);

    expect(report.passed).toEqual(["manager"]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].name).toBe("transfer");
    expect(() => assertRegressionClean(report)).toThrow(/transfer/);
  });
});
