import { z } from 'zod';

/** Calendar dates travel as YYYY-MM-DD and are stored in DATE columns (no time zone). */
export const IsoDate = z.iso.date({ message: 'Use the format YYYY-MM-DD' });

export const toDbDate = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
export const fromDbDate = (value: Date): string => value.toISOString().slice(0, 10);
