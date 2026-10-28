/**
 * Builds CSV safely: quotes every cell, and neutralises values a spreadsheet would treat as a
 * formula (starting with = + - @ or a tab/CR), so an exported name like "=HYPERLINK(...)" is shown
 * as text instead of running.
 */
export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    if (v === null || v === undefined) return '""';
    let s = String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  // A byte-order mark so Excel opens UTF-8 names correctly.
  return '\uFEFF' + [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
