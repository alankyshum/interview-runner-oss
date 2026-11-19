export type CountdownState = { remainingMs: number; endTime?: number };
type Store = Pick<Storage, "getItem" | "setItem">;

export const countdownRemaining = (state: CountdownState, now: number) => state.endTime === undefined ? state.remainingMs : Math.max(0, state.endTime - now);

export function readCountdown(store: Store, key: string, durationMs: number, now: number): CountdownState {
  try {
    const raw = JSON.parse(store.getItem(key) ?? "null") as Partial<CountdownState> | null;
    if (!raw || typeof raw.remainingMs !== "number" || !Number.isFinite(raw.remainingMs)) return { remainingMs: durationMs };
    const state = { remainingMs: Math.max(0, Math.min(durationMs, raw.remainingMs)), ...(typeof raw.endTime === "number" && Number.isFinite(raw.endTime) ? { endTime: raw.endTime } : {}) };
    const remainingMs = countdownRemaining(state, now);
    return remainingMs === 0 ? { remainingMs: 0 } : { ...state, remainingMs };
  } catch { return { remainingMs: durationMs }; }
}

export function persistCountdown(store: Store, key: string, state: CountdownState): void {
  try { store.setItem(key, JSON.stringify(state)); } catch { /* storage may be unavailable */ }
}

// Keep the countdown reset separate from the attempt's cumulative active-time history.
export function readCountdownReset(store: Store, key: string, attemptNumber: number, startedAt: string): number {
  try {
    const reset = JSON.parse(store.getItem(`${key}:reset`) ?? "null") as { attemptNumber?: unknown; startedAt?: unknown; elapsedMs?: unknown } | null;
    return reset?.attemptNumber === attemptNumber && reset.startedAt === startedAt && typeof reset.elapsedMs === "number" && Number.isFinite(reset.elapsedMs) && reset.elapsedMs >= 0 ? reset.elapsedMs : 0;
  } catch { return 0; }
}

export function persistCountdownReset(store: Store, key: string, attemptNumber: number, startedAt: string, elapsedMs: number): void {
  try { store.setItem(`${key}:reset`, JSON.stringify({ attemptNumber, startedAt, elapsedMs })); } catch { /* storage may be unavailable */ }
}

export const startCountdown = (state: CountdownState, now: number): CountdownState => {
  const remainingMs = countdownRemaining(state, now);
  return remainingMs > 0 ? { remainingMs, endTime: now + remainingMs } : { remainingMs: 0 };
};
export const pauseCountdown = (state: CountdownState, now: number): CountdownState => ({ remainingMs: countdownRemaining(state, now) });
export const restartCountdown = (durationMs: number): CountdownState => ({ remainingMs: durationMs });
