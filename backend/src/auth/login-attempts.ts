import { Injectable } from '@nestjs/common';

const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;

/**
 * Per-account failed-login limiter (the IP limit is handled by the throttler).
 * In-memory, so it's per process: fine for one VPS instance. Move to the database or Redis
 * before running more than one backend instance.
 */
@Injectable()
export class LoginAttemptLimiter {
  private readonly failures = new Map<string, { count: number; resetAt: number }>();

  isBlocked(key: string): boolean {
    const entry = this.failures.get(key);
    if (!entry) return false;
    if (entry.resetAt <= Date.now()) {
      this.failures.delete(key);
      return false;
    }
    return entry.count >= MAX_FAILURES;
  }

  recordFailure(key: string): void {
    const now = Date.now();
    const entry = this.failures.get(key);
    if (!entry || entry.resetAt <= now) {
      this.failures.set(key, { count: 1, resetAt: now + WINDOW_MS });
    } else {
      entry.count += 1;
    }
    if (this.failures.size > 10_000) {
      for (const [k, v] of this.failures) if (v.resetAt <= now) this.failures.delete(k);
    }
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}
