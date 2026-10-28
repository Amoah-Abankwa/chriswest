import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/decorators';
import { badRequest, conflict, notFound } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_BANDS, validateBands, weightsValid, type Band } from './grading';
import type { AssessmentsInput } from './results.schemas';

@Injectable()
export class AssessmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async components(schoolId: string, termId: string) {
    return this.prisma.assessment.findMany({
      where: { schoolId, termId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, maxMarks: true, weight: true },
    });
  }

  async bands(schoolId: string): Promise<{ bands: Band[]; isDefault: boolean }> {
    const rows = await this.prisma.gradingBand.findMany({
      where: { schoolId },
      orderBy: { minPercent: 'desc' },
      select: { minPercent: true, grade: true, remark: true },
    });
    return rows.length ? { bands: rows, isDefault: false } : { bands: DEFAULT_BANDS, isDefault: true };
  }

  async get(schoolId: string, termId: string) {
    const term = await this.prisma.term.findUnique({ where: { schoolId_id: { schoolId, id: termId } }, select: { id: true, name: true } });
    if (!term) throw notFound('Term not found');
    const [components, published] = await Promise.all([
      this.components(schoolId, termId),
      this.prisma.resultSheet.count({ where: { schoolId, termId, status: 'PUBLISHED' } }),
    ]);
    return { data: { term, components, weightsValid: weightsValid(components), locked: published > 0 } };
  }

  /**
   * Replaces a term's assessment scheme. Refused once any result in the term is published,
   * if it would delete an assessment that already has marks, or lower a maximum below a mark given.
   */
  async set(schoolId: string, input: AssessmentsInput, actor: Actor) {
    const term = await this.prisma.term.findUnique({
      where: { schoolId_id: { schoolId, id: input.termId } },
      select: { academicYear: { select: { status: true } } },
    });
    if (!term) throw notFound('Term not found');
    if (term.academicYear.status === 'CLOSED') throw conflict('YEAR_CLOSED', 'This term belongs to a closed academic year.');
    if (await this.prisma.resultSheet.count({ where: { schoolId, termId: input.termId, status: 'PUBLISHED' } })) {
      throw conflict('TERM_PUBLISHED', 'Results for this term have been published, so its assessments can no longer change.');
    }

    const existing = await this.components(schoolId, input.termId);
    const keptIds = new Set(input.components.flatMap((c) => (c.id ? [c.id] : [])));
    for (const id of keptIds) {
      if (!existing.some((e) => e.id === id)) throw notFound('Assessment not found');
    }
    const removed = existing.filter((e) => !keptIds.has(e.id));
    if (removed.length && (await this.prisma.mark.count({ where: { assessmentId: { in: removed.map((r) => r.id) } } }))) {
      throw conflict('ASSESSMENT_HAS_MARKS', 'Marks have been entered for an assessment you removed. Clear those marks first.');
    }
    for (const c of input.components) {
      if (!c.id) continue;
      const max = await this.prisma.mark.aggregate({ where: { assessmentId: c.id }, _max: { score: true } });
      if (max._max.score && max._max.score.toNumber() > c.maxMarks) {
        throw conflict('MARKS_ABOVE_MAX', `Some marks for ${c.name} are higher than ${c.maxMarks}.`);
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.assessment.deleteMany({ where: { id: { in: removed.map((r) => r.id) } } });
      // Temporary names avoid clashing with the unique (term, name) while renaming.
      for (const c of input.components.filter((x) => x.id)) {
        await tx.assessment.update({ where: { id: c.id }, data: { name: `__renaming__${c.id}` } });
      }
      for (const [i, c] of input.components.entries()) {
        const data = { name: c.name, maxMarks: c.maxMarks, weight: c.weight, sortOrder: i };
        if (c.id) await tx.assessment.update({ where: { id: c.id }, data });
        else await tx.assessment.create({ data: { schoolId, termId: input.termId, ...data } });
      }
    });
    await this.audit.record({
      action: 'assessments.set',
      outcome: 'SUCCESS',
      resourceType: 'term',
      resourceId: input.termId,
      schoolId,
      actorUserId: actor.userId,
      summary: { components: input.components.map((c) => `${c.name} /${c.maxMarks} ${c.weight}%`) },
      correlationId: actor.correlationId,
    });
    return this.get(schoolId, input.termId);
  }

  /** Changes the scale for results not yet published. Published results keep the scale they were published with. */
  async setBands(schoolId: string, bands: Band[], actor: Actor) {
    const problem = validateBands(bands);
    if (problem) throw badRequest('INVALID_BANDS', problem);
    await this.prisma.$transaction([
      this.prisma.gradingBand.deleteMany({ where: { schoolId } }),
      this.prisma.gradingBand.createMany({ data: bands.map((b) => ({ schoolId, ...b })) }),
    ]);
    await this.audit.record({
      action: 'grading.set',
      outcome: 'SUCCESS',
      resourceType: 'school',
      resourceId: schoolId,
      schoolId,
      actorUserId: actor.userId,
      summary: { bands: bands.map((b) => `${b.grade}>=${b.minPercent}`) },
      correlationId: actor.correlationId,
    });
    return { data: await this.bands(schoolId) };
  }
}
