import type { RealtimeEvent, RealtimeEventType } from "@codex-control/shared";

export class EventHub {
  readonly #events: RealtimeEvent[] = [];
  readonly #listeners = new Set<(event: RealtimeEvent) => void>();
  #sequence = 0;

  constructor(private readonly capacity = 2_000) {}

  get sequence(): number {
    return this.#sequence;
  }

  publish<T>(type: RealtimeEventType, payload: T): RealtimeEvent<T> {
    const event: RealtimeEvent<T> = {
      sequence: ++this.#sequence,
      type,
      timestamp: new Date().toISOString(),
      payload,
    };
    this.#events.push(event);
    if (this.#events.length > this.capacity) this.#events.splice(0, this.#events.length - this.capacity);
    for (const listener of this.#listeners) listener(event);
    return event;
  }

  replay(after: number): { expired: boolean; events: RealtimeEvent[] } {
    const first = this.#events[0]?.sequence ?? this.#sequence + 1;
    if (after > 0 && after < first - 1) return { expired: true, events: [] };
    return { expired: false, events: this.#events.filter((event) => event.sequence > after) };
  }

  subscribe(listener: (event: RealtimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

