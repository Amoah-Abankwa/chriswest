import { Global, Injectable, Module } from '@nestjs/common';

/**
 * The current time, in one place, so date-dependent rules (correction windows, "today")
 * can be tested deterministically.
 */
@Injectable()
export class Clock {
  private fixed: Date | null = null;

  now(): Date {
    return this.fixed ?? new Date();
  }

  /** YYYY-MM-DD in the given time zone. */
  today(timeZone: string): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(this.now());
  }

  /** Tests only. */
  setForTests(date: Date | null) {
    this.fixed = date;
  }
}

@Global()
@Module({ providers: [Clock], exports: [Clock] })
export class ClockModule {}
