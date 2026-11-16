/**
 * Runtime polyfills for Hermes builds that lack newer JS builtins.
 * Must load before RuntimeFacade / presets / agent-trace / package scans.
 */
export function installRuntimePolyfills(): void {
  const g = globalThis as any;

  if (typeof g.structuredClone !== "function") {
    g.structuredClone = function structuredClonePolyfill<T>(value: T): T {
      return JSON.parse(JSON.stringify(value)) as T;
    };
  }

  if (typeof Object.fromEntries !== "function") {
    (Object as any).fromEntries = function fromEntriesPolyfill(entries: Iterable<readonly [PropertyKey, any]>): any {
      const out: Record<string, any> = {};
      for (const pair of entries) {
        if (!pair || (pair as any).length < 2) continue;
        out[pair[0] as string] = pair[1];
      }
      return out;
    };
  }

  if (typeof (Object as any).hasOwn !== "function") {
    (Object as any).hasOwn = function hasOwnPolyfill(obj: object, prop: PropertyKey): boolean {
      return Object.prototype.hasOwnProperty.call(obj, prop);
    };
  }

  if (typeof String.prototype.replaceAll !== "function") {
    // eslint-disable-next-line no-extend-native
    String.prototype.replaceAll = function replaceAllPolyfill(this: string, search: string | RegExp, replacement: any): string {
      if (search instanceof RegExp) {
        const flags = search.flags.includes("g") ? search.flags : search.flags + "g";
        return this.replace(new RegExp(search.source, flags), replacement);
      }
      const s = String(search);
      if (!s) return String(this);
      return String(this).split(s).join(String(replacement));
    };
  }

  // Hermes on some Android builds still lacks String.prototype.matchAll — used heavily
  // by proot-distro-state, termux-guard, log-redaction, package scans.
  if (typeof String.prototype.matchAll !== "function") {
    // eslint-disable-next-line no-extend-native
    String.prototype.matchAll = function matchAllPolyfill(this: string, regexp: RegExp): RegExpStringIterator<RegExpExecArray> {
      const flags = regexp.flags.includes("g") ? regexp.flags : regexp.flags + "g";
      const re = new RegExp(regexp.source, flags);
      const str = String(this);
      const results: RegExpMatchArray[] = [];
      let m: RegExpExecArray | null;
      // Guard against zero-length matches to avoid infinite loops.
      let lastIndex = -1;
      while ((m = re.exec(str)) !== null) {
        if (m.index === lastIndex) {
          re.lastIndex = m.index + 1;
          continue;
        }
        lastIndex = m.index;
        results.push(m as unknown as RegExpMatchArray);
        if (!re.global) break;
      }
      return results[Symbol.iterator]() as RegExpStringIterator<RegExpExecArray>;
    };
  }

  if (typeof Array.prototype.flat !== "function") {
    // eslint-disable-next-line no-extend-native
    (Array.prototype as any).flat = function flatPolyfill(this: any[], depth?: number): any[] {
      const d = depth === undefined ? 1 : Math.floor(depth);
      const out: any[] = [];
      const walk = (arr: any[], depthLeft: number) => {
        for (const item of arr) {
          if (Array.isArray(item) && depthLeft > 0) walk(item, depthLeft - 1);
          else out.push(item);
        }
      };
      walk(this, d);
      return out;
    };
  }

  if (typeof Array.prototype.flatMap !== "function") {
    // eslint-disable-next-line no-extend-native
    (Array.prototype as any).flatMap = function flatMapPolyfill(this: any[], fn: any, thisArg?: any): any[] {
      const mapped = this.map(fn, thisArg);
      return (Array.prototype as any).flat.call(mapped, 1);
    };
  }
}

// Install on import so any eager importer gets the builtins.
installRuntimePolyfills();
