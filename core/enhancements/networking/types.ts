export type PortForwardProtocol = "tcp" | "udp";
export type PortForwardSource = "user" | "agent" | "restore";
export type PortForwardRule = Readonly<{
  id: string;
  name: string;
  protocol: PortForwardProtocol;
  hostPort: number;
  targetHost: string;
  targetPort: number;
  createdAt: number;
  source: PortForwardSource;
}>;
export type PortForwardStatus = Readonly<{ rule: PortForwardRule; state: "listening" | "starting" | "stopped" | "error" | "unsupported"; message?: string }>;
export type PortForwardStartResult = Readonly<{ processId: string; verified: true }>;
export type PortForwardTransport = Readonly<{
  start(rule: PortForwardRule): Promise<PortForwardStartResult>;
  stop(ruleId: string): Promise<void>;
  isAvailable(): Promise<boolean>;
}>;
export type PortForwardStoreAdapter = Readonly<{ read(): Promise<string | null>; write(value: string): Promise<void> }>;
export type PortForwardCapability = "network.portforward";
export type PortForwardOperation = "add" | "remove" | "clear" | "restore" | "stop";
export type PortForwardAuditSource = PortForwardSource | "lifecycle";
export type PortForwardTimeline = (event: Readonly<{ operation: PortForwardOperation; outcome: "allowed" | "denied" | "failed"; ruleId?: string; hostPort?: number; reason?: string; source: PortForwardAuditSource }>) => Promise<void> | void;
