import type { Disposable } from './types';

/** Minimal typed event emitter shared by both adapters. */
export class Emitter<T> {
  private readonly listeners = new Set<(value: T) => void>();

  readonly event = (listener: (value: T) => void): Disposable => {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      }
    };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch {
        // A misbehaving consumer must not break the producer's stream.
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

/** Monotonic id helper for threads, turns and items. */
export function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

