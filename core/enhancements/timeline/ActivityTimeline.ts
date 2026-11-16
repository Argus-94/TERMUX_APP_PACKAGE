import { EventStore, type TimelineEvent, type TimelineEventInput } from "./EventStore";

/** Product-facing activity timeline that preserves structured project/task metadata. */
export class ActivityTimeline {
  constructor(private readonly store: EventStore) {}
  /** Record a structured action; sensitive payload fields are removed by EventStore. */
  append(event: TimelineEventInput): Promise<TimelineEvent> { return this.store.append(event); }
  /** List recent filtered events for runtime or project screens. */
  list(projectId?: string, since?: number, limit = 100): Promise<readonly TimelineEvent[]> { return this.store.list(projectId, since, limit); }
  /** Return the project timeline in chronological order. */
  getTimeline(projectId: string, limit = 500): Promise<readonly TimelineEvent[]> { return this.store.list(projectId, undefined, limit); }
  /** Return an in-memory, newest-first slice for responsive UI refresh. */
  recent(limit = 50): readonly TimelineEvent[] { return this.store.recent(limit); }
}
