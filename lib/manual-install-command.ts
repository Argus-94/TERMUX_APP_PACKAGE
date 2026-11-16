import { adaptTermuxPackageCommand } from "./package-command-routing";

const HEREDOC_DELIMITER = "AIB_MANUAL_INSTALL_EOF";

/**
 * Builds a command the user can paste into Termux by hand.
 * Single-line commands are returned as-is (apt-get -> pkg).
 * Multi-line scripts, or scripts containing `exit`, are wrapped in a bash
 * heredoc so that pasting them never closes the interactive Termux session.
 */
export function buildManualTermuxInstallCommand(installCmd: string): string {
  const adapted = adaptTermuxPackageCommand(String(installCmd || "")).trim();
  const refresh = "pkg update -y";
  if (!adapted) return refresh;
  const simple = !adapted.includes("\n") && !/\bexit\b/.test(adapted);
  if (simple) return `${refresh} && ${adapted}`;
  return `${refresh}\nbash <<'${HEREDOC_DELIMITER}'\n${adapted}\n${HEREDOC_DELIMITER}\n`;
}
