import { ForbiddenException, Injectable } from '@nestjs/common';
import { ScopeService } from '../access/scope.service';
import type { PermissionKey } from '../access/permissions';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import { badRequest, conflict, notFound } from '../common/errors';
import type { Prisma, ResultSheetStatus } from '../generated/prisma/client';
import { enqueue } from '../outbox/outbox';
import { PrismaService } from '../prisma/prisma.service';
import type { SchoolContext } from '../tenancy/host-context';
import { AssessmentsService } from './assessments.service';
import { gradeFor, positions, totalPercent, weightsValid, type Component, type MarkValue, type Snapshot } from './grading';
import type { CorrectInput, SaveMarksInput, SheetKeyInput } from './results.schemas';

type Ctx = {
  school: SchoolContext;
  auth: AuthContext;
  correlationId?: string;
};

const EDITABLE: (ResultSheetStatus | 'NOT_STARTED')[] = ['NOT_STARTED', 'DRAFT', 'RETURNED'];

const toNumber = (d: Prisma.Decimal | null) => (d === null ? null : d.toNumber());

const forbidden = (message: string) => new ForbiddenException({ code: 'FORBIDDEN', message });

/**
 * Result sheets: one per class, subject and term.
 *   DRAFT/RETURNED --submit--> SUBMITTED --approve--> APPROVED --publish (whole class)--> PUBLISHED
 *   SUBMITTED/APPROVED --return--> RETURNED
 * Every transition is checked here; the UI only shows what's allowed.
 */
@Injectable()
export class SheetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly assessments: AssessmentsService,
  ) {}

  /** Class-subject pairs the caller can see for a term, with each sheet's status. */
  async list(ctx: Ctx, termId: string, classId?: string) {
    const { schoolId } = ctx.school;
    const term = await this.prisma.term.findUnique({ where: { schoolId_id: { schoolId, id: termId } }, select: { academicYearId: true } });
    if (!term) throw notFound('Term not found');

    const classes = await this.prisma.schoolClass.findMany({
      where: {
        AND: [
          { schoolId, academicYearId: term.academicYearId, ...(classId ? { id: classId } : {}) },
          { OR: [this.scope.classFilter(ctx.auth, 'results.read'), this.scope.classFilter(ctx.auth, 'marks.enter')] },
        ],
      },
      select: {
        id: true,
        name: true,
        subjects: {
          select: {
            subject: { select: { id: true, name: true } },
            teacher: { select: { membershipId: true, membership: { select: { user: { select: { fullName: true, email: true } } } } } },
          },
          orderBy: { subject: { name: 'asc' } },
        },
      },
      orderBy: [{ level: { sortOrder: 'asc' } }, { name: 'asc' }],
    });
    const sheets = await this.prisma.resultSheet.findMany({
      where: { schoolId, termId, classId: { in: classes.map((c) => c.id) } },
      select: { classId: true, subjectId: true, status: true, updatedAt: true },
    });
    const statusOf = new Map(sheets.map((s) => [`${s.classId}:${s.subjectId}`, s]));
    const enterSchoolWide = this.scope.isSchoolWide(ctx.auth, 'marks.enter');

    return {
      data: classes.map((c) => {
        const subjects = c.subjects.map((cs) => {
          const sheet = statusOf.get(`${c.id}:${cs.subject.id}`);
          return {
            subjectId: cs.subject.id,
            subjectName: cs.subject.name,
            teacher: cs.teacher ? (cs.teacher.membership.user.fullName ?? cs.teacher.membership.user.email) : null,
            status: (sheet?.status ?? 'NOT_STARTED') as ResultSheetStatus | 'NOT_STARTED',
            updatedAt: sheet?.updatedAt ?? null,
            canEnter: ctx.auth.permissions.has('marks.enter') && (enterSchoolWide || cs.teacher?.membershipId === ctx.auth.membershipId),
          };
        });
        return {
          classId: c.id,
          className: c.name,
          subjects,
          readyToPublish: subjects.length > 0 && subjects.every((s) => s.status === 'APPROVED'),
          published: subjects.length > 0 && subjects.every((s) => s.status === 'PUBLISHED'),
        };
      }),
    };
  }

  async get(ctx: Ctx, key: SheetKeyInput) {
    const base = await this.base(ctx, key, ['results.read', 'marks.enter']);
    const sheet = await this.prisma.resultSheet.findUnique({
      where: { termId_classId_subjectId: key },
      select: {
        id: true,
        status: true,
        returnReason: true,
        submittedAt: true,
        submittedByUserId: true,
        approvedAt: true,
        approvedByUserId: true,
        publishedAt: true,
        snapshot: true,
        marks: { select: { studentId: true, assessmentId: true, score: true, absent: true } },
        results: { select: { studentId: true, totalPercent: true, grade: true, remark: true, position: true } },
        corrections: { orderBy: { createdAt: 'desc' }, select: { studentId: true, assessmentId: true, fromScore: true, fromAbsent: true, toScore: true, toAbsent: true, reason: true, correctedByUserId: true, createdAt: true } },
      },
    });
    const status = sheet?.status ?? 'NOT_STARTED';
    const published = status === 'PUBLISHED';
    const { components, bands } = published
      ? (sheet!.snapshot as unknown as Snapshot)
      : { components: base.components, bands: (await this.assessments.bands(ctx.school.schoolId)).bands };

    const marks = this.marksByStudent(sheet?.marks ?? []);
    const results = new Map(sheet?.results.map((r) => [r.studentId, r]) ?? []);
    const live = base.roster.map((s) => ({ id: s.id, total: totalPercent(components, marks.get(s.id) ?? new Map()) }));
    const livePositions = positions(live.filter((l) => l.total !== null).map((l) => ({ id: l.id, total: l.total! })));
    const names = await this.userNames([sheet?.submittedByUserId, sheet?.approvedByUserId, ...(sheet?.corrections.map((c) => c.correctedByUserId) ?? [])]);
    const [canEnter, canSubmit] = await Promise.all([
      this.canSubject(ctx.auth, 'marks.enter', key.classId, key.subjectId),
      this.canSubject(ctx.auth, 'results.submit', key.classId, key.subjectId),
    ]);

    return {
      data: {
        key,
        class: base.class,
        subject: base.subject,
        term: base.term,
        status,
        returnReason: sheet?.returnReason ?? null,
        submitted: sheet?.submittedAt ? { at: sheet.submittedAt, by: names.get(sheet.submittedByUserId!) ?? null } : null,
        approved: sheet?.approvedAt ? { at: sheet.approvedAt, by: names.get(sheet.approvedByUserId!) ?? null } : null,
        publishedAt: sheet?.publishedAt ?? null,
        assessments: components,
        weightsValid: weightsValid(components),
        bands,
        students: base.roster.map((s) => {
          const r = results.get(s.id);
          const total = published && r ? r.totalPercent.toNumber() : live.find((l) => l.id === s.id)!.total;
          const band = total === null ? null : published && r ? { grade: r.grade, remark: r.remark } : gradeFor(bands, total);
          return {
            studentId: s.id,
            name: `${s.lastName}, ${s.firstName}${s.otherNames ? ` ${s.otherNames}` : ''}`,
            admissionNumber: s.admissionNumber,
            marks: Object.fromEntries([...(marks.get(s.id) ?? new Map())]),
            totalPercent: total,
            grade: band?.grade ?? null,
            remark: band?.remark ?? null,
            position: published ? (r?.position ?? null) : (livePositions.get(s.id) ?? null),
          };
        }),
        can: {
          enter: canEnter && EDITABLE.includes(status) && base.yearOpen,
          submit: canSubmit && (status === 'DRAFT' || status === 'RETURNED'),
          approve: ctx.auth.permissions.has('results.approve') && status === 'SUBMITTED',
          return: ctx.auth.permissions.has('results.approve') && (status === 'SUBMITTED' || status === 'APPROVED'),
          correct: ctx.auth.permissions.has('results.publish') && published,
        },
        corrections: (sheet?.corrections ?? []).map((c) => ({
          student: base.roster.find((s) => s.id === c.studentId)?.firstName ?? 'Former student',
          assessment: components.find((x) => x.id === c.assessmentId)?.name ?? '',
          from: c.fromAbsent ? 'Absent' : String(toNumber(c.fromScore) ?? '—'),
          to: c.toAbsent ? 'Absent' : String(toNumber(c.toScore) ?? '—'),
          reason: c.reason,
          by: names.get(c.correctedByUserId) ?? 'Unknown',
          at: c.createdAt,
        })),
      },
    };
  }

  async saveMarks(ctx: Ctx, input: SaveMarksInput) {
    const key = { termId: input.termId, classId: input.classId, subjectId: input.subjectId };
    const base = await this.base(ctx, key, ['results.read', 'marks.enter']);
    if (!(await this.canSubject(ctx.auth, 'marks.enter', key.classId, key.subjectId))) {
      throw forbidden('Only the teacher of this subject can enter its marks.');
    }
    if (!base.yearOpen) throw conflict('YEAR_CLOSED', 'This term belongs to a closed academic year.');
    const existing = await this.prisma.resultSheet.findUnique({ where: { termId_classId_subjectId: key }, select: { status: true } });
    if (existing && !EDITABLE.includes(existing.status)) {
      throw conflict('SHEET_LOCKED', 'These marks have been submitted. Ask for them to be returned if they need changing.');
    }

    const byId = new Map(base.components.map((c) => [c.id, c]));
    const roster = new Set(base.roster.map((s) => s.id));
    for (const m of input.marks) {
      const comp = byId.get(m.assessmentId);
      if (!comp) throw badRequest('UNKNOWN_ASSESSMENT', 'One of the assessments isn’t part of this term. Reload the page.');
      if (m.score !== null && m.score > comp.maxMarks) throw badRequest('SCORE_TOO_HIGH', `${comp.name} is out of ${comp.maxMarks}.`);
      if (!roster.has(m.studentId)) throw badRequest('NOT_IN_CLASS', 'A student in this list isn’t in the class for this term. Reload the page.');
    }

    const sheetId = await this.prisma.$transaction(async (tx) => {
      const sheet = await tx.resultSheet.upsert({
        where: { termId_classId_subjectId: key },
        create: { schoolId: ctx.school.schoolId, ...key },
        update: {},
        select: { id: true, status: true },
      });
      // Re-check under the transaction in case it was submitted a moment ago.
      if (!EDITABLE.includes(sheet.status)) throw conflict('SHEET_LOCKED', 'These marks have just been submitted.');
      for (const m of input.marks) {
        const where = { sheetId_assessmentId_studentId: { sheetId: sheet.id, assessmentId: m.assessmentId, studentId: m.studentId } };
        if (m.score === null && !m.absent) {
          await tx.mark.deleteMany({ where: { sheetId: sheet.id, assessmentId: m.assessmentId, studentId: m.studentId } });
        } else {
          const data = { score: m.absent ? null : m.score, absent: m.absent, enteredByUserId: ctx.auth.userId };
          await tx.mark.upsert({
            where,
            create: { schoolId: ctx.school.schoolId, sheetId: sheet.id, assessmentId: m.assessmentId, studentId: m.studentId, ...data },
            update: data,
          });
        }
      }
      return sheet.id;
    });
    await this.log('results.marks_saved', sheetId, ctx, { marks: input.marks.length });
    return this.get(ctx, key);
  }

  async submit(ctx: Ctx, key: SheetKeyInput) {
    const base = await this.base(ctx, key, ['results.read', 'marks.enter', 'results.submit']);
    if (!(await this.canSubject(ctx.auth, 'results.submit', key.classId, key.subjectId))) {
      throw forbidden('Only the teacher of this subject can submit its results.');
    }
    if (!weightsValid(base.components)) throw conflict('WEIGHTS_INVALID', 'This term’s assessments don’t add up to 100% yet.');
    const sheet = await this.prisma.resultSheet.findUnique({
      where: { termId_classId_subjectId: key },
      select: { id: true, status: true, marks: { select: { studentId: true, assessmentId: true, score: true, absent: true } } },
    });
    if (!sheet) throw conflict('INCOMPLETE', 'No marks have been entered yet.');
    if (sheet.status !== 'DRAFT' && sheet.status !== 'RETURNED') throw conflict('INVALID_TRANSITION', 'These results have already been submitted.');
    const missing = this.missingMarks(base.components, base.roster, sheet.marks);
    if (missing > 0) throw conflict('INCOMPLETE', `${missing} mark${missing === 1 ? ' is' : 's are'} still missing. Enter a score or mark the student absent.`, { missing });

    await this.transition(sheet.id, ['DRAFT', 'RETURNED'], { status: 'SUBMITTED', submittedAt: new Date(), submittedByUserId: ctx.auth.userId, returnReason: null });
    await this.log('results.submit', sheet.id, ctx, {});
    return this.get(ctx, key);
  }

  async approve(ctx: Ctx, key: SheetKeyInput) {
    await this.base(ctx, key, ['results.approve']);
    const sheet = await this.prisma.resultSheet.findUnique({ where: { termId_classId_subjectId: key }, select: { id: true } });
    if (!sheet) throw notFound('No results to approve');
    await this.transition(sheet.id, ['SUBMITTED'], { status: 'APPROVED', approvedAt: new Date(), approvedByUserId: ctx.auth.userId });
    await this.log('results.approve', sheet.id, ctx, {});
    return this.get(ctx, key);
  }

  async returnForCorrection(ctx: Ctx, key: SheetKeyInput, reason: string) {
    await this.base(ctx, key, ['results.approve']);
    const sheet = await this.prisma.resultSheet.findUnique({ where: { termId_classId_subjectId: key }, select: { id: true } });
    if (!sheet) throw notFound('No results to return');
    await this.transition(sheet.id, ['SUBMITTED', 'APPROVED'], { status: 'RETURNED', returnReason: reason, approvedAt: null, approvedByUserId: null });
    await this.log('results.return', sheet.id, ctx, { reason });
    return this.get(ctx, key);
  }

  /**
   * Publishes every subject of a class at once, so report cards are complete. Each sheet's weights
   * and grading scale are frozen into its snapshot, and grades and positions are stored.
   */
  async publish(ctx: Ctx, termId: string, classId: string) {
    const { schoolId } = ctx.school;
    const cls = await this.prisma.schoolClass.findFirst({
      where: { schoolId, id: classId },
      select: { id: true, name: true, academicYearId: true, subjects: { select: { subject: { select: { id: true, name: true } } } } },
    });
    if (!cls) throw notFound('Class not found');
    const term = await this.prisma.term.findUnique({ where: { schoolId_id: { schoolId, id: termId } }, select: { id: true, name: true, startDate: true, endDate: true, academicYearId: true } });
    if (!term || term.academicYearId !== cls.academicYearId) throw notFound('Term not found');
    if (cls.subjects.length === 0) throw conflict('NO_SUBJECTS', 'This class has no subjects.');

    const sheets = await this.prisma.resultSheet.findMany({
      where: { schoolId, termId, classId },
      select: { id: true, subjectId: true, status: true, marks: { select: { studentId: true, assessmentId: true, score: true, absent: true } } },
    });
    const bySubject = new Map(sheets.map((s) => [s.subjectId, s]));
    const notReady = cls.subjects
      .filter((cs) => bySubject.get(cs.subject.id)?.status !== 'APPROVED')
      .map((cs) => ({ subject: cs.subject.name, status: bySubject.get(cs.subject.id)?.status ?? 'NOT_STARTED' }));
    if (notReady.length) throw conflict('NOT_READY', 'Every subject must be approved before the class’s results can be published.', { notReady });

    const components = await this.assessments.components(schoolId, termId);
    if (!weightsValid(components)) throw conflict('WEIGHTS_INVALID', 'This term’s assessments don’t add up to 100%.');
    const { bands } = await this.assessments.bands(schoolId);
    const snapshot: Snapshot = { components, bands };
    const roster = await this.roster(schoolId, classId, term);

    for (const sheet of sheets) {
      if (this.missingMarks(components, roster, sheet.marks) > 0) {
        const subject = cls.subjects.find((cs) => cs.subject.id === sheet.subjectId)!.subject.name;
        throw conflict('INCOMPLETE', `${subject} has missing marks, probably for a student who joined after it was approved. Return it for completion.`);
      }
    }

    const now = new Date();
    await this.prisma.$transaction(
      async (tx) => {
        for (const sheet of sheets) {
          const updated = await tx.resultSheet.updateMany({
            where: { id: sheet.id, status: 'APPROVED' },
            data: { status: 'PUBLISHED', publishedAt: now, publishedByUserId: ctx.auth.userId, snapshot: snapshot as unknown as Prisma.InputJsonObject },
          });
          if (updated.count !== 1) throw conflict('CHANGED', 'Someone else just changed these results. Reload and try again.');
          await this.writeResults(tx, schoolId, sheet.id, snapshot, roster.map((r) => r.id), sheet.marks);
        }
        await enqueue(
          tx,
          roster.map((s) => ({
            schoolId,
            type: 'results.published',
            payload: { termId, classId, studentId: s.id },
            dedupeKey: `results.published:${termId}:${classId}:${s.id}`,
          })),
        );
      },
      { timeout: 60_000 },
    );
    await this.audit.record({
      action: 'results.publish',
      outcome: 'SUCCESS',
      resourceType: 'class',
      resourceId: classId,
      schoolId,
      actorUserId: ctx.auth.userId,
      summary: { termId, subjects: sheets.length, students: roster.length },
      correlationId: ctx.correlationId,
    });
    return this.list(ctx, termId, classId);
  }

  /** Changes one published mark, with a reason. Grades and positions for the subject are recalculated from the snapshot. */
  async correct(ctx: Ctx, input: CorrectInput) {
    const key = { termId: input.termId, classId: input.classId, subjectId: input.subjectId };
    const base = await this.base(ctx, key, ['results.publish']);
    const sheet = await this.prisma.resultSheet.findUnique({ where: { termId_classId_subjectId: key }, select: { id: true, status: true, snapshot: true } });
    if (!sheet || sheet.status !== 'PUBLISHED') throw conflict('NOT_PUBLISHED', 'Only published results are corrected this way. Unpublished marks can be edited directly.');
    const snapshot = sheet.snapshot as unknown as Snapshot;
    const comp = snapshot.components.find((c) => c.id === input.assessmentId);
    if (!comp) throw badRequest('UNKNOWN_ASSESSMENT', 'That assessment isn’t part of these results.');
    if (input.score !== null && input.score > comp.maxMarks) throw badRequest('SCORE_TOO_HIGH', `${comp.name} is out of ${comp.maxMarks}.`);
    if (!base.roster.some((s) => s.id === input.studentId)) throw notFound('Student not found in this class');

    await this.prisma.$transaction(async (tx) => {
      const where = { sheetId_assessmentId_studentId: { sheetId: sheet.id, assessmentId: input.assessmentId, studentId: input.studentId } };
      const before = await tx.mark.findUnique({ where, select: { score: true, absent: true } });
      await tx.mark.upsert({
        where,
        create: { schoolId: ctx.school.schoolId, sheetId: sheet.id, assessmentId: input.assessmentId, studentId: input.studentId, score: input.score, absent: input.absent, enteredByUserId: ctx.auth.userId },
        update: { score: input.score, absent: input.absent, enteredByUserId: ctx.auth.userId },
      });
      await tx.resultCorrection.create({
        data: {
          schoolId: ctx.school.schoolId,
          sheetId: sheet.id,
          studentId: input.studentId,
          assessmentId: input.assessmentId,
          fromScore: before?.score ?? null,
          fromAbsent: before?.absent ?? false,
          toScore: input.score,
          toAbsent: input.absent,
          reason: input.reason,
          correctedByUserId: ctx.auth.userId,
        },
      });
      const marks = await tx.mark.findMany({ where: { sheetId: sheet.id }, select: { studentId: true, assessmentId: true, score: true, absent: true } });
      const resultIds = (await tx.subjectResult.findMany({ where: { sheetId: sheet.id }, select: { studentId: true } })).map((r) => r.studentId);
      await this.writeResults(tx, ctx.school.schoolId, sheet.id, snapshot, resultIds, marks);
    });
    await this.log('results.correct', sheet.id, ctx, { studentId: input.studentId, assessment: comp.name, reason: input.reason });
    return this.get(ctx, key);
  }

  // ---------- helpers ----------

  /** Resolves and checks the class, term and subject, and loads the roster and current assessments. */
  private async base(ctx: Ctx, key: SheetKeyInput, visibleWith: PermissionKey[]) {
    const { schoolId } = ctx.school;
    const filters = visibleWith.map((p) => this.scope.classFilter(ctx.auth, p));
    const cls = await this.prisma.schoolClass.findFirst({
      where: { AND: [{ schoolId, id: key.classId }, { OR: filters }] },
      select: { id: true, name: true, academicYearId: true, academicYear: { select: { status: true } } },
    });
    if (!cls) throw notFound('Class not found');
    const [term, classSubject] = await Promise.all([
      this.prisma.term.findUnique({ where: { schoolId_id: { schoolId, id: key.termId } }, select: { id: true, name: true, startDate: true, endDate: true, academicYearId: true } }),
      this.prisma.classSubject.findUnique({
        where: { schoolId_classId_subjectId: { schoolId, classId: key.classId, subjectId: key.subjectId } },
        select: { subject: { select: { id: true, name: true } } },
      }),
    ]);
    if (!term || term.academicYearId !== cls.academicYearId) throw notFound('Term not found for this class');
    if (!classSubject) throw notFound('This class doesn’t take that subject');
    const [components, roster] = await Promise.all([this.assessments.components(schoolId, key.termId), this.roster(schoolId, key.classId, term)]);
    return {
      class: { id: cls.id, name: cls.name },
      subject: classSubject.subject,
      term: { id: term.id, name: term.name },
      yearOpen: cls.academicYear.status !== 'CLOSED',
      components,
      roster,
    };
  }

  /** Students in the class during the term, excluding those who moved class or left. */
  private async roster(schoolId: string, classId: string, term: { startDate: Date; endDate: Date }) {
    const rows = await this.prisma.enrollment.findMany({
      where: {
        schoolId,
        classId,
        status: { in: ['ACTIVE', 'COMPLETED'] },
        startDate: { lte: term.endDate },
        OR: [{ endDate: null }, { endDate: { gte: term.startDate } }],
      },
      select: { student: { select: { id: true, firstName: true, lastName: true, otherNames: true, admissionNumber: true } } },
      orderBy: [{ student: { lastName: 'asc' } }, { student: { firstName: 'asc' } }],
    });
    return [...new Map(rows.map((r) => [r.student.id, r.student])).values()];
  }

  /** Subject-level check: assigned-only permissions need the person to teach this subject in this class. */
  private async canSubject(auth: AuthContext, permission: PermissionKey, classId: string, subjectId: string) {
    const scope = auth.permissions.get(permission);
    if (scope === 'SCHOOL') return true;
    if (scope !== 'ASSIGNED' || !auth.membershipId) return false;
    return (await this.prisma.subjectTeacher.count({ where: { classId, subjectId, membershipId: auth.membershipId } })) > 0;
  }

  private marksByStudent(rows: { studentId: string; assessmentId: string; score: Prisma.Decimal | null; absent: boolean }[]) {
    const map = new Map<string, Map<string, MarkValue>>();
    for (const m of rows) {
      const inner = map.get(m.studentId) ?? new Map<string, MarkValue>();
      inner.set(m.assessmentId, { score: toNumber(m.score), absent: m.absent });
      map.set(m.studentId, inner);
    }
    return map;
  }

  private missingMarks(components: Component[], roster: { id: string }[], marks: { studentId: string; assessmentId: string }[]) {
    const have = new Set(marks.map((m) => `${m.studentId}:${m.assessmentId}`));
    let missing = 0;
    for (const s of roster) for (const c of components) if (!have.has(`${s.id}:${c.id}`)) missing++;
    return missing;
  }

  private async writeResults(
    tx: Prisma.TransactionClient,
    schoolId: string,
    sheetId: string,
    snapshot: Snapshot,
    studentIds: string[],
    marks: { studentId: string; assessmentId: string; score: Prisma.Decimal | null; absent: boolean }[],
  ) {
    const byStudent = this.marksByStudent(marks);
    const totals = studentIds.map((id) => ({ id, total: totalPercent(snapshot.components, byStudent.get(id) ?? new Map()) ?? 0 }));
    const ranks = positions(totals);
    await tx.subjectResult.deleteMany({ where: { sheetId } });
    await tx.subjectResult.createMany({
      data: totals.map((t) => {
        const band = gradeFor(snapshot.bands, t.total);
        return { schoolId, sheetId, studentId: t.id, totalPercent: t.total, grade: band.grade, remark: band.remark, position: ranks.get(t.id)! };
      }),
    });
  }

  private async transition(id: string, from: ResultSheetStatus[], data: Prisma.ResultSheetUpdateManyMutationInput) {
    const updated = await this.prisma.resultSheet.updateMany({ where: { id, status: { in: from } }, data });
    if (updated.count !== 1) throw conflict('INVALID_TRANSITION', 'These results aren’t at a stage where that can be done. Reload to see their current status.');
  }

  private async userNames(ids: (string | null | undefined)[]) {
    const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
    if (!unique.length) return new Map<string, string>();
    const users = await this.prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, fullName: true, email: true } });
    return new Map(users.map((u) => [u.id, u.fullName ?? u.email]));
  }

  private log(action: string, sheetId: string, ctx: Ctx, summary: Prisma.InputJsonObject) {
    return this.audit.record({
      action,
      outcome: 'SUCCESS',
      resourceType: 'result_sheet',
      resourceId: sheetId,
      schoolId: ctx.school.schoolId,
      actorUserId: ctx.auth.userId,
      summary,
      correlationId: ctx.correlationId,
    });
  }
}
