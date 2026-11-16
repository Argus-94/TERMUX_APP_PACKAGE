export type CommandPolicy = 'default' | 'readonly' | 'trusted';
export interface CommandSpec {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  policy?: CommandPolicy;
}
export function commandToString(spec: CommandSpec): string {
  return [spec.command, ...(spec.args || [])].join(' ');
}
