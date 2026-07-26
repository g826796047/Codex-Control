import { describe, expect, it } from "vitest";
import { EventHub } from "../src/events.js";

describe("EventHub", () => {
  it("replays only events newer than the client sequence", () => {
    const hub = new EventHub(10);
    hub.publish("status-changed", { state: 1 });
    hub.publish("status-changed", { state: 2 });
    hub.publish("status-changed", { state: 3 });
    expect(hub.replay(1).events.map((event) => event.sequence)).toEqual([2, 3]);
  });

  it("marks replay as expired after the ring buffer rolls over", () => {
    const hub = new EventHub(2);
    hub.publish("status-changed", { state: 1 });
    hub.publish("status-changed", { state: 2 });
    hub.publish("status-changed", { state: 3 });
    hub.publish("status-changed", { state: 4 });
    expect(hub.replay(0).expired).toBe(false);
    expect(hub.replay(1).expired).toBe(true);
    expect(hub.replay(0).events).toHaveLength(2);
  });
});
