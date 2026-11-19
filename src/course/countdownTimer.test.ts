import { describe, expect, it } from "vitest";
import { countdownRemaining, pauseCountdown, persistCountdown, persistCountdownReset, readCountdown, readCountdownReset, restartCountdown, startCountdown } from "./countdownTimer";

const memoryStore = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } }; };

describe("countdown timer", () => {
  it("starts from remaining time and stays accurate from its end timestamp", () => {
    const running = startCountdown({ remainingMs: 60_000 }, 1_000);
    expect(running).toEqual({ remainingMs: 60_000, endTime: 61_000 });
    expect(countdownRemaining(running, 11_000)).toBe(50_000);
  });

  it("pauses, restarts, and reaches zero without going negative", () => {
    expect(pauseCountdown({ remainingMs: 60_000, endTime: 61_000 }, 21_000)).toEqual({ remainingMs: 40_000 });
    expect(restartCountdown(90_000)).toEqual({ remainingMs: 90_000 });
    expect(countdownRemaining({ remainingMs: 1_000, endTime: 2_000 }, 3_000)).toBe(0);
  });

  it("persists running and expired states across reloads", () => {
    const store = memoryStore();
    persistCountdown(store, "timer", { remainingMs: 60_000, endTime: 61_000 });
    expect(readCountdown(store, "timer", 120_000, 11_000)).toEqual({ remainingMs: 50_000, endTime: 61_000 });
    expect(readCountdown(store, "timer", 120_000, 70_000)).toEqual({ remainingMs: 0 });
  });

  it("retains the reset baseline only for its attempt", () => {
    const store = memoryStore();
    persistCountdownReset(store, "timer", 2, "first", 45_000);
    expect(readCountdownReset(store, "timer", 2, "first")).toBe(45_000);
    expect(readCountdownReset(store, "timer", 3, "first")).toBe(0);
    expect(readCountdownReset(store, "timer", 2, "replacement")).toBe(0);
    store.setItem("timer:reset", "invalid");
    expect(readCountdownReset(store, "timer", 2, "first")).toBe(0);
  });
});
