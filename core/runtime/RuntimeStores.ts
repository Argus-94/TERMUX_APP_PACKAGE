import type { ExecutionEnvironment } from "../environment/ExecutionEnvironment";
import type { JournalStore } from "./RuntimeJournal";
export class EnvironmentTextStore implements JournalStore {
  constructor(private readonly env: ExecutionEnvironment, private readonly path: string) {}
  async read() { return (await this.env.exists(this.path)) ? this.env.read(this.path) : null; }
  async write(value: string) { const slash = this.path.lastIndexOf("/"); if (slash > 0) await this.env.mkdir(this.path.slice(0, slash)); await this.env.write(this.path, value); }
}
