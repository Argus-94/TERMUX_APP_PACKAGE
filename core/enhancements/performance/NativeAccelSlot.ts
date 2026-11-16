/** Non-invasive discovery slot for a host-provided native accelerator capability. */
/** Host-confirmed accelerator discovery states; unsupported is fail-closed. */
export type NativeAccelStatus = "linked" | "available" | "unsupported";
/** Raw capability booleans supplied by the host discovery adapter. */
export type NativeAccelObservation = Readonly<{ linked: boolean; available: boolean; detail?: string }>;
/** Minimal non-invasive host discovery interface. */
export type NativeAccelHost = Readonly<{ discover(): Promise<NativeAccelObservation> }>;
/** Safe presentation contract for capability discovery. */
export type NativeAccelResult = Readonly<{ status: NativeAccelStatus; detail: string }>;

/** Reports only host-confirmed linkage/availability; does not create or simulate acceleration. */
export class NativeAccelSlot {
  /** Creates a discovery slot backed only by a real host adapter. */
  constructor(private readonly host: NativeAccelHost) {}

  /** Returns unsupported on missing capability or adapter failure, without throwing. */
  async inspect(): Promise<NativeAccelResult> {
    try {
      const observation = await this.host.discover();
      const status: NativeAccelStatus = !observation.linked ? "unsupported" : observation.available ? "available" : "linked";
      return { status, detail: typeof observation.detail === "string" ? observation.detail.slice(0, 200) : status === "unsupported" ? "No native accelerator capability detected." : "Host capability detected." };
    } catch {
      return { status: "unsupported", detail: "Native accelerator discovery failed; capability is not assumed." };
    }
  }
}
