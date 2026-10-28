/** Pure grading arithmetic, kept apart from the database so it's easy to read and test. */

export type Band = { minPercent: number; grade: string; remark: string };
export type Component = { id: string; name: string; maxMarks: number; weight: number };
export type MarkValue = { score: number | null; absent: boolean };
export type Snapshot = { components: Component[]; bands: Band[] };

/** A common A–F scale for basic schools. Schools can replace it. */
export const DEFAULT_BANDS: Band[] = [
  { minPercent: 80, grade: 'A', remark: 'Excellent' },
  { minPercent: 70, grade: 'B', remark: 'Very good' },
  { minPercent: 60, grade: 'C', remark: 'Good' },
  { minPercent: 50, grade: 'D', remark: 'Credit' },
  { minPercent: 40, grade: 'E', remark: 'Pass' },
  { minPercent: 0, grade: 'F', remark: 'Needs improvement' },
];

export const weightsValid = (components: Component[]) =>
  components.length > 0 && components.reduce((n, c) => n + c.weight, 0) === 100;

/**
 * Weighted total out of 100, to one decimal place. Absent counts as zero.
 * Returns null if any component is still unmarked.
 */
export function totalPercent(components: Component[], marks: Map<string, MarkValue>): number | null {
  let total = 0;
  for (const c of components) {
    const m = marks.get(c.id);
    if (!m || (!m.absent && m.score === null)) return null;
    const score = m.absent ? 0 : m.score!;
    total += (score / c.maxMarks) * c.weight;
  }
  return Math.round(total * 10) / 10;
}

export function gradeFor(bands: Band[], percent: number): Band {
  const sorted = [...bands].sort((a, b) => b.minPercent - a.minPercent);
  return sorted.find((b) => percent >= b.minPercent) ?? sorted[sorted.length - 1]!;
}

/** Standard competition ranking: equal totals share a position; the next position skips (1, 2, 2, 4). */
export function positions(totals: { id: string; total: number }[]): Map<string, number> {
  const sorted = [...totals].sort((a, b) => b.total - a.total);
  const result = new Map<string, number>();
  sorted.forEach((t, i) => {
    const prev = sorted[i - 1];
    result.set(t.id, prev && prev.total === t.total ? result.get(prev.id)! : i + 1);
  });
  return result;
}

export function validateBands(bands: Band[]): string | null {
  const mins = bands.map((b) => b.minPercent);
  if (new Set(mins).size !== mins.length) return 'Each band needs a different starting percentage.';
  if (!mins.includes(0)) return 'One band must start at 0% so every mark gets a grade.';
  if (mins.some((m) => m < 0 || m > 100)) return 'Percentages must be between 0 and 100.';
  return null;
}
