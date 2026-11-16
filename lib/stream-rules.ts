export interface StreamRule { id: string; pattern: RegExp; message: string; }
export const DEFAULT_STREAM_RULES: StreamRule[] = [
  { id: "fake-termux-result", pattern: /\[TERMUX_RESULT\]/i, message: "Do not fabricate tool output; execute the command." },
  { id: "fake-build-success", pattern: /BUILD SUCCESSFUL|build successful/i, message: "Verify the real build exit code and APK before claiming success." },
  { id: "dangerous-broad-delete", pattern: /rm\s+-rf\s+(?:\/|~|\$HOME)\b/i, message: "Refuse broad filesystem deletion; narrow the path and ask for confirmation." },
];
export function checkStreamRules(text: string, rules = DEFAULT_STREAM_RULES) {
  return rules.filter(r => r.pattern.test(text)).map(r => ({ id: r.id, message: r.message }));
}
