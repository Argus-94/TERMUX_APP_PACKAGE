import type { RuntimeManifest } from "./types";
export type RuntimePresetName = "android-build" | "debian-shell" | "kali-tools" | "node-dev" | "python-fastapi" | "offline-gguf";
export type RuntimePreset = Readonly<{ manifest: RuntimeManifest; seedFiles: Readonly<Record<string, string>> }>;
const PRESETS: Readonly<Record<RuntimePresetName, RuntimePreset>> = {
  "android-build": { manifest: { version: 1, build: { command: "./gradlew assembleDebug", afterTask: true }, capabilities: ["terminal", "build", "filesystem.read", "filesystem.write"] }, seedFiles: {} },
  "debian-shell": { manifest: { version: 1, workers: [], capabilities: ["terminal", "filesystem.read", "filesystem.write"] }, seedFiles: {} },
  "kali-tools": { manifest: { version: 1, workers: [], capabilities: ["terminal", "network", "filesystem.read", "filesystem.write"] }, seedFiles: { ".aib/profile": "kali-tools\n" } },
  "node-dev": { manifest: { version: 1, web: { command: "npm run dev", port: 3000, health: "curl -fsS http://127.0.0.1:3000/" }, health: { command: "node --version", intervalMs: 30_000 }, restartAfterTask: true, capabilities: ["terminal", "web", "filesystem.read", "filesystem.write"] }, seedFiles: {} },
  "python-fastapi": { manifest: { version: 1, web: { command: "uvicorn app:app --host 0.0.0.0 --port 8000", port: 8000, health: "python -c 'import urllib.request; urllib.request.urlopen(\"http://127.0.0.1:8000/health\", timeout=2)'" }, health: { command: "python --version", intervalMs: 30_000 }, restartAfterTask: true, capabilities: ["terminal", "web", "filesystem.read", "filesystem.write"] }, seedFiles: { "app.py": "from fastapi import FastAPI\napp = FastAPI()\n@app.get('/health')\ndef health(): return {'ok': True}\n" } },
  "offline-gguf": { manifest: { version: 1, workers: [{ name: "local-model", command: "./llama-server --model ./models/model.gguf --host 127.0.0.1 --port 8080", restart: false }], capabilities: ["terminal", "filesystem.read"] }, seedFiles: {} },
};
/** Return a fresh copy of the selected preset, preventing caller mutation of shared constants. */
export function getRuntimePreset(name: RuntimePresetName): RuntimePreset {
  const preset = PRESETS[name];
  return { manifest: structuredClone(preset.manifest), seedFiles: { ...preset.seedFiles } };
}
export const runtimePresetNames: readonly RuntimePresetName[] = Object.freeze(Object.keys(PRESETS) as RuntimePresetName[]);
