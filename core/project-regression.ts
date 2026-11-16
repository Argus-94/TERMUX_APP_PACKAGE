export type ProjectRegressionBoundary = {
  name: string;
  run: () => void | Promise<void>;
};

export type ProjectRegressionReport = {
  passed: string[];
  failed: Array<{ name: string; error: string }>;
};

export async function runProjectRegression(boundaries: ProjectRegressionBoundary[]): Promise<ProjectRegressionReport> {
  const passed: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  for (const boundary of boundaries) {
    try {
      await boundary.run();
      passed.push(boundary.name);
    } catch (error) {
      failed.push({
        name: boundary.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { passed, failed };
}

export function assertRegressionClean(report: ProjectRegressionReport): void {
  if (report.failed.length === 0) return;
  const detail = report.failed.map((item) => `${item.name}: ${item.error}`).join("; ");
  throw new Error(`PROJECT_REGRESSION_FAILED: ${detail}`);
}
