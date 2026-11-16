import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { createFirstRunPromptDeferralStore } from "./first-run-app-store";

/** A defer applies only to this app version; a later version may surface setup again. */
export const FIRST_RUN_PROMPT_VERSION = Constants.expoConfig?.version ?? Constants.nativeAppVersion ?? "unknown";

export const firstRunPromptDeferralStore = createFirstRunPromptDeferralStore({
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
  removeItem: (key) => AsyncStorage.removeItem(key),
});
