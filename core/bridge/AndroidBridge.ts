/**
 * Runtime-only Android Bridge interface and in-memory implementation.
 */

export type BridgeAuthToken = string;

export type BridgeRequest = {
  readonly id: string;
  readonly method: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly token?: BridgeAuthToken;
};

export type BridgeResponse = {
  readonly id: string;
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: string;
};

export type DeviceInfo = {
  readonly model?: string;
  readonly androidVersion?: string;
  readonly sdkInt?: number;
  readonly manufacturer?: string;
};

export interface AndroidBridge {
  authenticate(token: BridgeAuthToken): Promise<boolean> | boolean;
  request(req: BridgeRequest): Promise<BridgeResponse>;
  getDeviceInfo(): Promise<DeviceInfo> | DeviceInfo;
  notify(title: string, body: string): Promise<void> | void;
}

export class InMemoryAndroidBridge implements AndroidBridge {
  private readonly validTokens = new Set<string>();
  private device: DeviceInfo = {
    model: "AIBuilder-Emulated",
    androidVersion: "14",
    sdkInt: 34,
    manufacturer: "karat",
  };

  issueToken(): BridgeAuthToken {
    const token = `aib-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    this.validTokens.add(token);
    return token;
  }

  authenticate(token: BridgeAuthToken): boolean {
    return this.validTokens.has(token);
  }

  async request(req: BridgeRequest): Promise<BridgeResponse> {
    if (req.token && !this.authenticate(req.token)) {
      return { id: req.id, ok: false, error: "UNAUTHORIZED" };
    }
    if (req.method === "device.info") {
      return { id: req.id, ok: true, data: this.device };
    }
    if (req.method === "ping") {
      return { id: req.id, ok: true, data: { pong: true } };
    }
    return { id: req.id, ok: false, error: `Unknown method: ${req.method}` };
  }

  getDeviceInfo(): DeviceInfo {
    return { ...this.device };
  }

  notify(_title: string, _body: string): void {
    // no-op skeleton
  }

  setDeviceInfo(info: DeviceInfo): void {
    this.device = { ...info };
  }
}

export function createInMemoryAndroidBridge(): InMemoryAndroidBridge {
  return new InMemoryAndroidBridge();
}
