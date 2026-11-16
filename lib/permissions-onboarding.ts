import AsyncStorage from "@react-native-async-storage/async-storage";
import { Linking, PermissionsAndroid, Platform } from "react-native";
import type { Permission } from "react-native/Libraries/PermissionsAndroid/PermissionsAndroid";
import { PermissionsOnboarding } from "../core/enhancements/onboarding/PermissionsOnboarding";
import type { PermissionGrantStatus, PermissionId, PermissionStatusAdapter } from "../core/enhancements/onboarding/types";
import { getRuntimeFacade } from "./runtime-facade";
import { getTermuxNative } from "./termux-bridge";
import { getIgnoreBatteryOptimizationsStatus, requestIgnoreBatteryOptimizations } from "./background-survival";

const POST_NOTIFICATIONS: Permission = "android.permission.POST_NOTIFICATIONS";
let singleton: PermissionsOnboarding | null = null;

function checkedStatus(granted: boolean): PermissionGrantStatus { return granted ? "granted" : "denied"; }

/** Create the permission flow from currently installed runtime/platform adapters only. */
export function getPermissionsOnboarding(): PermissionsOnboarding {
  if (singleton) return singleton;
  const adapter: PermissionStatusAdapter = {
    async check(id) {
      if (Platform.OS !== "android") return id === "accessibility" || id === "battery-optimization" ? "unavailable" : "not-applicable";
      if (id === "notifications") {
        if (Number(Platform.Version) < 33) return "not-applicable";
        try { return checkedStatus(await PermissionsAndroid.check(POST_NOTIFICATIONS)); } catch { return "unavailable"; }
      }
      // Compatibility permission identifier: same-app execution has no Android grant.
      if (id === "termux-run-command") return "not-applicable";
      if (id === "battery-optimization") {
        if (Number(Platform.Version) < 23) return "not-applicable";
        const exempt = await getIgnoreBatteryOptimizationsStatus();
        return exempt === null ? "unavailable" : exempt ? "granted" : "manual-required";
      }
      if (id === "install-packages") {
        if (Number(Platform.Version) < 26) return "not-applicable";
        try {
          const native = getTermuxNative();
          if (!native?.canInstallPackages) return "unavailable";
          return (await native.canInstallPackages()) ? "granted" : "manual-required";
        } catch { return "unavailable"; }
      }
      // Imports use Android's scoped system document/photo pickers. The app
      // does not need broad READ_MEDIA or all-files access for this workflow.
      if (id === "storage") return "not-applicable";
      if (id === "accessibility") {
        try {
          const status = await getRuntimeFacade().accessibility.status();
          return status.state === "available" ? "granted" : status.state === "permission_required" ? "denied" : "unavailable";
        } catch { return "unavailable"; }
      }
      return "manual-required";
    },
    async request(id) {
      if (Platform.OS !== "android") return "not-applicable";
      if (id === "notifications") {
        if (Number(Platform.Version) < 33) return "not-applicable";
        try {
          await PermissionsAndroid.request(POST_NOTIFICATIONS, {
            title: "AI Builder notifications",
            message: "Allow notifications to follow long-running task progress. This is optional.",
            buttonPositive: "Allow",
            buttonNegative: "Not now",
          });
          return checkedStatus(await PermissionsAndroid.check(POST_NOTIFICATIONS));
        } catch { return "unavailable"; }
      }
      if (id === "storage") return "not-applicable";
      // Bundled execution does not use an Android command permission or request
      // adapter; its only supported action is explicit Settings navigation.
      if (id === "termux-run-command" || id === "install-packages") return this.check(id);
      return this.check(id);
    },
    async openSettings(action) {
      try {
        if (action === "app-details") { await Linking.openSettings(); return true; }
        if (action === "accessibility-settings") { await getRuntimeFacade().accessibility.openSettings(); return true; }
        if (action === "battery-settings") {
          if (await getIgnoreBatteryOptimizationsStatus() === true) return true;
          return requestIgnoreBatteryOptimizations();
        }
        if (action === "unknown-sources-settings") {
          const native = getTermuxNative();
          return !!(native?.openUnknownSourcesSettings && await native.openUnknownSourcesSettings());
        }
        await Linking.openSettings(); return true;
      } catch { return false; }
    },
  };
  singleton = new PermissionsOnboarding(adapter, {
    get: (key) => AsyncStorage.getItem(key),
    set: (key, value) => AsyncStorage.setItem(key, value),
  }, undefined, async (event) => {
    await getRuntimeFacade().timeline.append({
      type: "permissions.onboarding",
      actor: "user",
      level: event.status === "denied" ? "warn" : "info",
      payload: { action: event.action, permissionId: event.permissionId, status: event.status },
    });
  });
  return singleton;
}
