export type ModelMode = "local" | "online" | "custom" | "opencode" | "manus";

/** Accept only current selectable modes from persisted settings. Unknown/retired values fail closed to Local. */
export function normalizePersistedModelMode(value: unknown): ModelMode {
  switch (value) {
    case "online":
    case "custom":
    case "opencode":
    case "manus":
    case "local":
      return value;
    default:
      return "local";
  }
}
