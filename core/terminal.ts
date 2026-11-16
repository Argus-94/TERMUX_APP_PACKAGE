/**
 * Runtime-only terminal abstraction.
 *
 * This module describes terminal sessions, process handles and injected
 * execution boundaries. It does not spawn processes and does not modify
 * compilation settings.
 */

export type TerminalSessionId = string;

export type TerminalSize = {
  columns: number;
  rows: number;
};

export type TerminalSessionOptions = {
  id?: TerminalSessionId;
  cwd: string;
  env?: Record<string, string>;
  size?: TerminalSize;
  /** Canonical AIBuilderTermux HOME when available. */
  home?: string;
  /** Project root when terminal is opened from a project. */
  projectRoot?: string;
};

export type TerminalInput = {
  sessionId: TerminalSessionId;
  data: string;
};

export type TerminalOutput = {
  sessionId: TerminalSessionId;
  data: string;
  stream: "stdout" | "stderr";
};

/** Process lifecycle handle for a running terminal / command. */
export type ProcessHandle = {
  readonly id: string;
  readonly sessionId: TerminalSessionId;
  readonly pid?: number | string;
  readonly startedAt: number;
  readonly command?: string;
};

export type ProcessControlAction = "stop" | "interrupt" | "kill";

export interface TerminalSession {
  readonly id: TerminalSessionId;
  readonly cwd: string;
  readonly size: TerminalSize;
  readonly home?: string;
  readonly projectRoot?: string;
  write(input: string): Promise<void>;
  resize(size: TerminalSize): Promise<void>;
  close(): Promise<void>;
  /** Graceful stop of the primary process in the session. */
  stop?(): Promise<void>;
  /** Send interrupt (e.g. SIGINT). */
  interrupt?(): Promise<void>;
  /** Force kill (e.g. SIGKILL). */
  kill?(): Promise<void>;
}

export interface TerminalAdapter {
  createSession(options: TerminalSessionOptions): Promise<TerminalSession>;
  send(input: TerminalInput): Promise<void>;
  resize(sessionId: TerminalSessionId, size: TerminalSize): Promise<void>;
  close(sessionId: TerminalSessionId): Promise<void>;
  /** Optional process control; backends may implement progressively. */
  control?(sessionId: TerminalSessionId, action: ProcessControlAction): Promise<void>;
  /** Optional process handle registry. */
  getProcessHandle?(sessionId: TerminalSessionId): ProcessHandle | undefined;
}
