import React from "react";
import { Platform, requireNativeComponent, type ViewProps } from "react-native";

type NativeProps = ViewProps & {
  /** Starts the embedded shell and installs the pinned private bootstrap on first use if needed. */
  enabled?: boolean;
  /** Stable identifier for the visible PTY session. Changing it closes the previous PTY. */
  sessionId?: string;
  /** Validated project working directory; native code rejects missing or out-of-scope paths. */
  workingDirectory?: string;
  /** Validated project root exported to the embedded shell as PROJECT_ROOT. */
  projectRoot?: string;
  /** Terminal font size in SP. */
  fontSize?: number;
  /** UI language used by native install/readiness messages. */
  language?: "en" | "ru" | "uk";
};

const NativeEmbeddedTerminal = Platform.OS === "android"
  ? requireNativeComponent<NativeProps>("AibEmbeddedTermuxTerminalView")
  : null;

/**
 * Android-native Termux TerminalView host. First use installs the bundled, hash-pinned
 * Termux-compatible userland into app-private storage; no external Termux app is required.
 */
export function EmbeddedTermuxTerminalView(props: NativeProps) {
  if (!NativeEmbeddedTerminal) return null;
  return <NativeEmbeddedTerminal {...props} />;
}
