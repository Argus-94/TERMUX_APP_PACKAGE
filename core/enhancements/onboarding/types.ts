export type PermissionId = "notifications" | "storage" | "accessibility" | "battery-optimization" | "termux-run-command" | "install-packages";
export type PermissionRiskLevel = "low" | "medium";
export type PermissionGrantStatus = "granted" | "denied" | "manual-required" | "unavailable" | "not-applicable";
export type OpenSettingsAction = "app-details" | "accessibility-settings" | "battery-settings" | "unknown-sources-settings";
export type PermissionDescription = Readonly<{
  id: PermissionId;
  title: string;
  shortWhy: string;
  detailedWhy: string;
  riskLevel: PermissionRiskLevel;
  isRequired: boolean;
  openSettingsAction: OpenSettingsAction;
}>;
export type PermissionStatusAdapter = Readonly<{
  check(id: PermissionId): Promise<PermissionGrantStatus>;
  request?(id: PermissionId): Promise<PermissionGrantStatus>;
  openSettings?(action: OpenSettingsAction): Promise<boolean>;
}>;
export type PermissionOnboardingState = Readonly<{
  statuses: Readonly<Record<PermissionId, PermissionGrantStatus>>;
  granted: number;
  total: number;
  dismissed: boolean;
  revoked: readonly PermissionId[];
}>;
