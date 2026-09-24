import { describe, expect, it } from "vitest";
import { PlansUnavailable, planCatalog, PLANS } from "../../apps/mcp-service/src/plans.js";
import type { AddonClient, AddonPlan } from "../../apps/mcp-service/src/addon.js";

const wire: AddonPlan[] = [
  { type: "static", pid: 223, name: "AI Deploy - Speed", monthlyCents: 3590, annualCents: 38770 },
  { type: "php", pid: 224, name: "AI Deploy - Boost", monthlyCents: 5590, annualCents: 60372 },
];

function setup(behavior: () => Promise<AddonPlan[]>) {
  const state = { calls: 0, t: 1_000_000, behavior };
  const addon = { plans: () => (state.calls++, state.behavior()), createCheckout: async () => { throw new Error("unused"); } } as AddonClient;
  const provider = planCatalog({ addon, ttlMs: 60_000, now: () => state.t });
  return { state, provider };
}

describe("planCatalog", () => {
  it("without an addon (dev) it serves the seed plans", async () => {
    expect(await planCatalog({})()).toBe(PLANS);
  });

  it("maps the addon's products to plans, adding the limits and project types per kind", async () => {
    const { provider } = setup(async () => wire);
    expect(await provider()).toEqual([
      { pid: 223, name: "AI Deploy - Speed", monthlyCents: 3590, annualCents: 38770, diskGb: 20, domains: 1, types: ["estatico", "spa"], blurb: expect.any(String) },
      { pid: 224, name: "AI Deploy - Boost", monthlyCents: 5590, annualCents: 60372, diskGb: 50, domains: 2, types: ["php"], blurb: expect.any(String) },
    ]);
  });

  it("caches for the TTL and refreshes afterwards", async () => {
    const { state, provider } = setup(async () => wire);
    await provider();
    await provider();
    expect(state.calls).toBe(1);
    state.t += 60_001;
    await provider();
    expect(state.calls).toBe(2);
  });

  it("when the addon fails, the last good answer keeps serving", async () => {
    const { state, provider } = setup(async () => wire);
    await provider();
    state.t += 61_000;
    state.behavior = async () => {
      throw new Error("addon down");
    };
    expect((await provider()).map((p) => p.pid)).toEqual([223, 224]);
  });

  it("with no cache it fails instead of inventing plans, and does not hammer a dead addon", async () => {
    const { state, provider } = setup(async () => {
      throw new Error("addon down");
    });
    await expect(provider()).rejects.toBeInstanceOf(PlansUnavailable);
    await expect(provider()).rejects.toBeInstanceOf(PlansUnavailable);
    expect(state.calls).toBe(1); // second call inside the 30s pause did not reach the addon
    state.t += 31_000;
    state.behavior = async () => wire;
    expect((await provider()).length).toBe(2); // recovers by itself
    expect(state.calls).toBe(2);
  });
});
