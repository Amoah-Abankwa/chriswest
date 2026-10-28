import { Controller, Get, Header, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth, RequirePermissions } from '../auth/decorators';
import { IsoDate } from '../common/dates';
import { ZodPipe } from '../common/zod.pipe';
import { PlatformGuard, PlatformRoles } from '../platform/platform.guard';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentSchool } from '../tenancy/current-school.decorator';
import type { SchoolContext } from '../tenancy/host-context';
import { ReportsService } from './reports.service';

const RangeQ = z.object({ from: IsoDate.optional(), to: IsoDate.optional(), threshold: z.coerce.number().int().min(50).max(100).default(90) });
const TermQ = z.object({ termId: z.uuid() });
const CsvQ = z.object({ termId: z.uuid().optional(), from: IsoDate.optional(), to: IsoDate.optional() });
const CSV_KINDS = { students: ['students.read', 'student records'], attendance: ['attendance.read', 'attendance'], results: ['results.read', 'results'], balances: ['fees.read', 'fees'] } as const;

@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly audit: AuditService,
  ) {}

  /** Dashboard numbers; each part appears only if the person may see that area. */
  @Get('overview')
  overview(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext) {
    return this.reports.overview(s.schoolId, auth);
  }

  @Get('enrollment')
  @RequirePermissions('reports.read', 'students.read')
  enrollment(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext) {
    this.reports.requireArea(auth, 'students.read', 'student records');
    return this.reports.enrollment(s.schoolId);
  }

  @Get('attendance')
  @RequirePermissions('reports.read', 'attendance.read')
  attendance(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Query(new ZodPipe(RangeQ)) q: z.infer<typeof RangeQ>) {
    this.reports.requireArea(auth, 'attendance.read', 'attendance');
    return this.reports.attendance(s.schoolId, q.from, q.to, q.threshold);
  }

  @Get('academic')
  @RequirePermissions('reports.read', 'results.read')
  academic(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Query(new ZodPipe(TermQ)) q: { termId: string }) {
    this.reports.requireArea(auth, 'results.read', 'results');
    return this.reports.academic(s.schoolId, q.termId);
  }

  @Get('finance')
  @RequirePermissions('reports.read', 'fees.read')
  finance(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Query(new ZodPipe(TermQ)) q: { termId: string }) {
    this.reports.requireArea(auth, 'fees.read', 'fees');
    return this.reports.finance(s.schoolId, q.termId);
  }

  /** Downloads are audited: they take personal data out of the system. */
  @Get('csv/:kind')
  @RequirePermissions('reports.read')
  @Header('Cache-Control', 'private, no-store')
  async csv(
    @CurrentSchool() s: SchoolContext,
    @CurrentAuth() auth: AuthContext,
    @Param('kind', new ZodPipe(z.enum(['students', 'attendance', 'results', 'balances']))) kind: keyof typeof CSV_KINDS,
    @Query(new ZodPipe(CsvQ)) q: z.infer<typeof CsvQ>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const [permission, label] = CSV_KINDS[kind];
    this.reports.requireArea(auth, permission, label);
    const body = await this.reports.csv(s.schoolId, kind, q);
    await this.audit.record({ action: 'report.export', outcome: 'SUCCESS', resourceType: 'report', resourceId: kind, schoolId: s.schoolId, actorUserId: auth.userId, summary: { kind, ...q }, correlationId: req.correlationId });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${kind}-${new Date().toISOString().slice(0, 10)}.csv"`);
    return body;
  }
}

/** Platform-wide counts for operators. Totals only, never a school's records. */
@Controller('platform/metrics')
@UseGuards(PlatformGuard)
export class PlatformMetricsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @PlatformRoles('SUPER_ADMIN', 'SUPPORT')
  async metrics() {
    const monthAgo = new Date(Date.now() - 30 * 86_400_000);
    const [schools, students, activeUsers, staff, parents] = await Promise.all([
      this.prisma.school.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.student.count({ where: { status: 'ACTIVE' } }),
      this.prisma.session.findMany({ where: { lastSeenAt: { gte: monthAgo } }, distinct: ['userId'], select: { userId: true } }).then((r) => r.length),
      this.prisma.schoolMembership.count({ where: { kind: 'STAFF', status: 'ACTIVE' } }),
      this.prisma.schoolMembership.count({ where: { kind: 'PARENT', status: 'ACTIVE' } }),
    ]);
    return {
      data: {
        schools: Object.fromEntries(schools.map((r) => [r.status, r._count._all])),
        activeStudents: students,
        staffAccounts: staff,
        parentAccounts: parents,
        activeUsersLast30Days: activeUsers,
      },
    };
  }
}
