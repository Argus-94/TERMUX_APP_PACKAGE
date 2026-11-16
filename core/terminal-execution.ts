/**
 * Runtime-only terminal execution adapter.
 *
 * A concrete process/PTY/container backend is injected later.
 * This layer does not select or modify any build configuration.
 */
import type {
  TerminalAdapter,
  TerminalInput,
  TerminalSession,
  TerminalSessionOptions,
  TerminalSize,
} from "./terminal";

export type TerminalExecutionRequest = {
  sessionId?: string;
  cwd: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  size?: TerminalSize;
};

export interface TerminalExecutionBackend {
  openSession(options: TerminalSessionOptions): Promise<TerminalSession>;
  write(sessionId: string, data: string): Promise<void>;
  resize(sessionId: string, size: TerminalSize): Promise<void>;
  close(sessionId: string): Promise<void>;
}

export class TerminalExecutionAdapter implements TerminalAdapter {
  constructor(private readonly backend: TerminalExecutionBackend) {}

  createSession(options: TerminalSessionOptions): Promise<TerminalSession> {
    return this.backend.openSession(options);
  }

  send(input: TerminalInput): Promise<void> {
    return this.backend.write(input.sessionId, input.data);
  }

  resize(sessionId: string, size: TerminalSize): Promise<void> {
    return this.backend.resize(sessionId, size);
  }

  close(sessionId: string): Promise<void> {
    return this.backend.close(sessionId);
  }
}
