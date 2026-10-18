import { Session } from '../src/session.js';
import type { Timers } from '../src/session.js';

/** Manually driven timers for deterministic Run tests. */
export class FakeTimers implements Timers {
  private handlers = new Map<number, () => void>();
  private next = 1;

  setInterval(fn: () => void): unknown {
    const id = this.next++;
    this.handlers.set(id, fn);
    return id;
  }

  clearInterval(h: unknown): void {
    this.handlers.delete(h as number);
  }

  get active(): number {
    return this.handlers.size;
  }

  fire(times = 1): void {
    for (let i = 0; i < times; i++) for (const fn of [...this.handlers.values()]) fn();
  }
}

export function newSession(): { session: Session; timers: FakeTimers } {
  const timers = new FakeTimers();
  return { session: new Session(undefined, timers), timers };
}

export function channel(session: Session, ch: number): (string | number | null)[] {
  return session.history.map((f) => f.channels[ch] ?? null);
}
