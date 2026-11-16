/**
 * DeviceManager — thin facade over AndroidBridge device info + notifications.
 */

import type { AndroidBridge, DeviceInfo } from "./AndroidBridge";

export class DeviceManager {
  constructor(private readonly bridge: AndroidBridge) {}

  async info(): Promise<DeviceInfo> {
    return this.bridge.getDeviceInfo();
  }

  async notify(title: string, body: string): Promise<void> {
    await this.bridge.notify(title, body);
  }

  async ping(token?: string): Promise<boolean> {
    const res = await this.bridge.request({
      id: `ping-${Date.now()}`,
      method: "ping",
      token,
    });
    return res.ok;
  }
}

export function createDeviceManager(bridge: AndroidBridge): DeviceManager {
  return new DeviceManager(bridge);
}
