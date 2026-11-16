import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
import { getPermissionsOnboarding } from "../lib/permissions-onboarding";
import type { PermissionOnboardingState } from "../core/enhancements/onboarding/types";

/**
 * Startup and resume status refresh only. Permission requests remain gated by
 * an explicit feature action or the optional Permissions & access screen.
 */
export function usePermissions() {
  const [state, setState] = useState<PermissionOnboardingState | null>(null);
  const refresh = useCallback(async () => {
    try {
      setState(await getPermissionsOnboarding().refresh());
    } catch {
      // Permission review is diagnostic and must never block application startup.
    }
  }, []);

  useEffect(() => {
    void refresh();
    let leftForeground = false;
    const sub = AppState.addEventListener("change", (next) => {
      if (next !== "active") leftForeground = true;
      else if (leftForeground) {
        leftForeground = false;
        void refresh();
      }
    });
    return () => sub.remove();
  }, [refresh]);

  return { state, refresh };
}
