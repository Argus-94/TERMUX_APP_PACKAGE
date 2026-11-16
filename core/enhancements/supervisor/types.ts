import type { RegisteredProcess } from "../../process/ProcessRegistry";
import type { ManifestProcess } from "../manifest/types";
export type ProcessOutput = Readonly<{ stdout: string; stderr: string }>;
export type InContainerSupervisorAdapter = Readonly<{
  probe(command: string, process: RegisteredProcess): Promise<boolean>;
  restart?(process: RegisteredProcess, spec: ManifestProcess): Promise<boolean>;
  collectOutput?(process: RegisteredProcess): Promise<ProcessOutput | null>;
}>;
