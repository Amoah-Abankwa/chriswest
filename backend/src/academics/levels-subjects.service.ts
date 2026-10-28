import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/decorators';
import { conflict, isUniqueViolation, notFound } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import {
  STAGES,
  type CreateLevelInput,
  type CreateSubjectInput,
  type Stage,
  type UpdateLevelInput,
  type UpdateSubjectInput,
} from './academics.schemas';

/** A starting point for Ghanaian basic schools. Schools rename, hide or add levels as needed. */
export const STANDARD_LEVELS: Record<Stage, string[]> = {
  CRECHE: ['Crèche'],
  NURSERY: ['Nursery 1', 'Nursery 2'],
  KINDERGARTEN: ['KG 1', 'KG 2'],
  PRIMARY: ['Primary 1', 'Primary 2', 'Primary 3', 'Primary 4', 'Primary 5', 'Primary 6'],
  JHS: ['JHS 1', 'JHS 2', 'JHS 3'],
};

/** An editable starter list, not a statement of any official curriculum. */
export const COMMON_SUBJECTS = [
  { code: 'ENG', name: 'English Language' },
  { code: 'MATH', name: 'Mathematics' },
  { code: 'SCI', name: 'Science' },
  { code: 'SOC', name: 'Social Studies' },
  { code: 'RME', name: 'Religious and Moral Education' },
  { code: 'CMP', name: 'Computing' },
  { code: 'CA', name: 'Creative Arts' },
  { code: 'GHL', name: 'Ghanaian Language' },
  { code: 'FRE', name: 'French' },
  { code: 'PE', name: 'Physical Education' },
];

@Injectable()
export class LevelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(schoolId: string) {
    const levels = await this.prisma.educationLevel.findMany({
      where: { schoolId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, stage: true, sortOrder: true, isActive: true, _count: { select: { classes: true } } },
    });
    return { data: levels.map(({ _count, ...l }) => ({ ...l, classCount: _count.classes })) };
  }

  /** Adds any missing standard levels for the chosen stages. Safe to run more than once. */
  async addStandard(schoolId: string, stages: Stage[], actor: Actor) {
    const data = STAGES.filter((s) => stages.includes(s)).flatMap((stage) =>
      STANDARD_LEVELS[stage].map((name, i) => ({
        schoolId,
        name,
        stage,
        sortOrder: STAGES.indexOf(stage) * 100 + (i + 1) * 10,
      })),
    );
    const result = await this.prisma.educationLevel.createMany({ data, skipDuplicates: true });
    await this.audit.record({
      action: 'education_level.add_standard',
      outcome: 'SUCCESS',
      resourceType: 'education_level',
      schoolId,
      actorUserId: actor.userId,
      summary: { stages, added: result.count },
      correlationId: actor.correlationId,
    });
    return this.list(schoolId);
  }

  async create(schoolId: string, input: CreateLevelInput, actor: Actor) {
    const sortOrder =
      input.sortOrder ??
      ((await this.prisma.educationLevel.aggregate({ where: { schoolId }, _max: { sortOrder: true } }))._max.sortOrder ?? 0) + 10;
    try {
      const level = await this.prisma.educationLevel.create({
        data: { schoolId, name: input.name, stage: input.stage, sortOrder },
        select: { id: true },
      });
      await this.audit.record({
        action: 'education_level.create',
        outcome: 'SUCCESS',
        resourceType: 'education_level',
        resourceId: level.id,
        schoolId,
        actorUserId: actor.userId,
        correlationId: actor.correlationId,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('NAME_TAKEN', 'A level with this name already exists.');
      throw err;
    }
    return this.list(schoolId);
  }

  async update(schoolId: string, id: string, input: UpdateLevelInput, actor: Actor) {
    const exists = await this.prisma.educationLevel.findUnique({ where: { schoolId_id: { schoolId, id } }, select: { id: true } });
    if (!exists) throw notFound('Level not found');
    try {
      await this.prisma.educationLevel.update({ where: { id }, data: input });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('NAME_TAKEN', 'A level with this name already exists.');
      throw err;
    }
    await this.audit.record({
      action: 'education_level.update',
      outcome: 'SUCCESS',
      resourceType: 'education_level',
      resourceId: id,
      schoolId,
      actorUserId: actor.userId,
      summary: { fields: Object.keys(input) },
      correlationId: actor.correlationId,
    });
    return this.list(schoolId);
  }
}

@Injectable()
export class SubjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(schoolId: string) {
    const subjects = await this.prisma.subject.findMany({
      where: { schoolId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, code: true, isActive: true, _count: { select: { classSubjects: true } } },
    });
    return { data: subjects.map(({ _count, ...s }) => ({ ...s, classCount: _count.classSubjects })) };
  }

  async addCommon(schoolId: string, actor: Actor) {
    const existing = await this.prisma.subject.findMany({ where: { schoolId }, select: { name: true, code: true } });
    const names = new Set(existing.map((s) => s.name.toLowerCase()));
    const codes = new Set(existing.map((s) => s.code));
    const data = COMMON_SUBJECTS.filter((s) => !names.has(s.name.toLowerCase()) && !codes.has(s.code)).map((s) => ({
      schoolId,
      ...s,
    }));
    const result = await this.prisma.subject.createMany({ data, skipDuplicates: true });
    await this.audit.record({
      action: 'subject.add_common',
      outcome: 'SUCCESS',
      resourceType: 'subject',
      schoolId,
      actorUserId: actor.userId,
      summary: { added: result.count },
      correlationId: actor.correlationId,
    });
    return this.list(schoolId);
  }

  async create(schoolId: string, input: CreateSubjectInput, actor: Actor) {
    try {
      const subject = await this.prisma.subject.create({ data: { schoolId, ...input }, select: { id: true } });
      await this.audit.record({
        action: 'subject.create',
        outcome: 'SUCCESS',
        resourceType: 'subject',
        resourceId: subject.id,
        schoolId,
        actorUserId: actor.userId,
        correlationId: actor.correlationId,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('DUPLICATE_SUBJECT', 'A subject with this name or code already exists.');
      throw err;
    }
    return this.list(schoolId);
  }

  async update(schoolId: string, id: string, input: UpdateSubjectInput, actor: Actor) {
    const exists = await this.prisma.subject.findUnique({ where: { schoolId_id: { schoolId, id } }, select: { id: true } });
    if (!exists) throw notFound('Subject not found');
    try {
      await this.prisma.subject.update({ where: { id }, data: input });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('DUPLICATE_SUBJECT', 'A subject with this name or code already exists.');
      throw err;
    }
    await this.audit.record({
      action: 'subject.update',
      outcome: 'SUCCESS',
      resourceType: 'subject',
      resourceId: id,
      schoolId,
      actorUserId: actor.userId,
      summary: { fields: Object.keys(input) },
      correlationId: actor.correlationId,
    });
    return this.list(schoolId);
  }
}
