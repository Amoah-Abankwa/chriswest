import PDFDocument from 'pdfkit';

/**
 * Plain, printable PDFs built with pdfkit (no browser needed). The built-in Helvetica font only
 * covers Western European characters, so amounts use the currency code ("GHS 1,250.00").
 */

type Doc = InstanceType<typeof PDFDocument>;

export const pdfMoney = (minor: number, currency: string) =>
  `${currency} ${new Intl.NumberFormat('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(minor / 100)}`;

const day = (d: string | Date) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(typeof d === 'string' ? new Date(`${d.slice(0, 10)}T00:00:00Z`) : d);

/** Characters outside the PDF font are replaced rather than rendered as garbage. */
const safe = (s: string | null | undefined) => (s ?? '').replace(/[^\u0000-\u00ff\u2018\u2019\u201c\u201d\u2013\u2014\u2026]/g, '?');

function render(build: (doc: Doc) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Producer: 'School portal', Creator: 'School portal' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    build(doc);
    doc.end();
  });
}

type SchoolHeader = { name: string; motto?: string | null; addressLine?: string | null; city?: string | null; phone?: string | null; contactEmail?: string | null };

function header(doc: Doc, school: SchoolHeader, title: string) {
  doc.font('Helvetica-Bold').fontSize(18).text(safe(school.name), { align: 'center' });
  if (school.motto) doc.font('Helvetica-Oblique').fontSize(10).text(safe(school.motto), { align: 'center' });
  const contact = [school.addressLine, school.city, school.phone, school.contactEmail].filter(Boolean).join('  ·  ');
  if (contact) doc.font('Helvetica').fontSize(9).text(safe(contact), { align: 'center' });
  doc.moveDown(0.5);
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).lineWidth(1.5).stroke();
  doc.moveDown(0.8);
  doc.font('Helvetica-Bold').fontSize(14).text(safe(title));
  doc.moveDown(0.5);
}

function facts(doc: Doc, rows: [string, string][]) {
  for (const [k, v] of rows) {
    doc.font('Helvetica').fontSize(9).fillColor('#555555').text(safe(k), { continued: true }).text('  ');
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#000000').text(safe(v));
    doc.moveDown(0.2);
  }
  doc.moveDown(0.5);
}

/** A simple ruled table. `widths` are fractions of the usable width; `right` marks numeric columns. */
function table(doc: Doc, headers: string[], rows: string[][], widths: number[], right: boolean[]) {
  const left = doc.page.margins.left;
  const usable = doc.page.width - left - doc.page.margins.right;
  const xs = widths.reduce<number[]>((acc, w, i) => [...acc, i === 0 ? left : acc[i - 1]! + widths[i - 1]! * usable], []);
  const drawRow = (cells: string[], bold: boolean) => {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 30) doc.addPage();
    const y = doc.y;
    let h = 0;
    cells.forEach((c, i) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5);
      const w = widths[i]! * usable - 6;
      doc.text(safe(c), xs[i]! + 3, y + 4, { width: w, align: right[i] ? 'right' : 'left' });
      h = Math.max(h, doc.heightOfString(safe(c), { width: w }) + 8);
    });
    doc.moveTo(left, y + h).lineTo(left + usable, y + h).lineWidth(0.5).strokeColor('#bbbbbb').stroke().strokeColor('#000000');
    doc.y = y + h;
  };
  drawRow(headers, true);
  rows.forEach((r) => drawRow(r, false));
  doc.x = left;
  doc.moveDown(0.8);
}

export type ReceiptPdfData = {
  number: string;
  issuedAt: Date | string;
  voidedAt: Date | string | null;
  school: SchoolHeader;
  payment: {
    amountMinor: number;
    currency: string;
    method: string;
    reference: string | null;
    receivedOn: string;
    payerName: string | null;
    student: { firstName: string; lastName: string; admissionNumber: string };
    allocations: { invoiceNumber: string; termName: string; amountMinor: number }[];
  };
  balanceAfterMinor: number;
};

const METHOD: Record<string, string> = { CASH: 'Cash', BANK_TRANSFER: 'Bank transfer', MOBILE_MONEY: 'Mobile money', CARD: 'Card', CHEQUE: 'Cheque', OTHER: 'Other' };

export function receiptPdf(r: ReceiptPdfData): Promise<Buffer> {
  return render((doc) => {
    header(doc, r.school, `Receipt ${r.number}`);
    if (r.voidedAt) {
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#a32121').text(`VOID: this payment was reversed on ${day(r.voidedAt as string)}`).fillColor('#000000');
      doc.moveDown(0.5);
    }
    const p = r.payment;
    facts(doc, [
      ['Date received', day(p.receivedOn)],
      ['Student', `${p.student.firstName} ${p.student.lastName} (${p.student.admissionNumber})`],
      ...(p.payerName ? ([['Paid by', p.payerName]] as [string, string][]) : []),
      ['Method', `${METHOD[p.method] ?? p.method}${p.reference ? `, ref. ${p.reference}` : ''}`],
    ]);
    table(
      doc,
      ['For', 'Amount'],
      [...p.allocations.map((a) => [`Invoice ${a.invoiceNumber} (${a.termName})`, pdfMoney(a.amountMinor, p.currency)]), ['Total received', pdfMoney(p.amountMinor, p.currency)]],
      [0.7, 0.3],
      [false, true],
    );
    doc.font('Helvetica').fontSize(10).text(`Balance still owing after this payment: ${pdfMoney(r.balanceAfterMinor, p.currency)}`);
    doc.moveDown(1);
    doc.fontSize(8).fillColor('#666666').text(`Issued ${day(r.issuedAt as string)}. Keep this receipt for your records.`);
  });
}

export type ReportCardPdfData = {
  school: SchoolHeader;
  student: { firstName: string; lastName: string; otherNames: string | null; admissionNumber: string };
  term: { name: string; yearName: string };
  className: string;
  classSize: number;
  subjects: { subject: string; components: { name: string; maxMarks: number; weight: number; score: number | null; absent: boolean }[]; totalPercent: number; grade: string; remark: string; position: number; outOf: number }[];
  average: number | null;
  overallPosition: number | null;
  attendance: { present: number; late: number; absent: number; excused: number };
};

const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};

function reportCardPage(doc: Doc, c: ReportCardPdfData) {
  header(doc, c.school, `Report card: ${c.term.name}, ${c.term.yearName}`);
  facts(doc, [
    ['Student', [c.student.firstName, c.student.otherNames, c.student.lastName].filter(Boolean).join(' ')],
    ['Admission number', c.student.admissionNumber],
    ['Class', `${c.className} (${c.classSize} students)`],
    ['Overall', `${c.average !== null ? `${c.average}% average` : '-'}${c.overallPosition ? `, ${ordinal(c.overallPosition)} in class` : ''}`],
  ]);
  const comps = c.subjects[0]?.components ?? [];
  const compW = comps.length ? 0.3 / comps.length : 0;
  table(
    doc,
    ['Subject', ...comps.map((x) => `${x.name} /${x.maxMarks}`), 'Total %', 'Grade', 'Position', 'Remark'],
    c.subjects.map((s) => [
      s.subject,
      ...s.components.map((x) => (x.absent ? 'Abs' : String(x.score ?? '-'))),
      String(s.totalPercent),
      s.grade,
      `${ordinal(s.position)} of ${s.outOf}`,
      s.remark,
    ]),
    [0.22, ...comps.map(() => compW), 0.1, 0.08, 0.12, 0.18],
    [false, ...comps.map(() => true), true, false, true, false],
  );
  const a = c.attendance;
  doc.font('Helvetica').fontSize(10).text(`Attendance this term: ${a.present + a.late} of ${a.present + a.late + a.absent + a.excused} days${a.late ? ` (${a.late} late)` : ''}${a.absent ? `, ${a.absent} absent` : ''}${a.excused ? `, ${a.excused} excused` : ''}.`);
  doc.moveDown(0.3);
  doc.fontSize(8).fillColor('#666666').text(`Weighting: ${comps.map((x) => `${x.name} ${x.weight}%`).join(', ')}. Equal totals share a position.`).fillColor('#000000');
}

export function reportCardsPdf(cards: ReportCardPdfData[]): Promise<Buffer> {
  return render((doc) => {
    cards.forEach((c, i) => {
      if (i > 0) doc.addPage();
      reportCardPage(doc, c);
    });
  });
}

export const pdfDisposition = (name: string) => `attachment; filename="${name.replace(/[^A-Za-z0-9._-]+/g, '_')}"`;
