import { Controller, Get, HttpStatus, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { RangeQuery, type RangeInput } from '../attendance/attendance.schemas';
import { AttendanceService } from '../attendance/attendance.service';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { FinanceReportsService } from '../finance/finance-reports.service';
import { PaymentsService } from '../finance/payments.service';
import { ReportCardsService } from '../results/report-cards.service';
import { CurrentSchool } from '../tenancy/current-school.decorator';
import type { SchoolContext } from '../tenancy/host-context';
import { TimetableService } from '../timetable/timetable.service';
import { LibraryService } from '../library/library.service';
import { TransportService } from '../transport/transport.service';
import { PortalService } from './portal.service';

const id = new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.NOT_FOUND });

/**
 * The parent and student portal. Any signed-in member can call these; what they see is decided
 * entirely by PortalService: a parent's links to their children, or a student's own record.
 * The routes say "children" for both; for a student the only "child" is themselves.
 */
@Controller('portal')
export class PortalController {
  constructor(
    private readonly portal: PortalService,
    private readonly attendance: AttendanceService,
    private readonly finance: FinanceReportsService,
    private readonly payments: PaymentsService,
    private readonly reportCards: ReportCardsService,
    private readonly timetable: TimetableService,
    private readonly library: LibraryService,
    private readonly transport: TransportService,
  ) {}

  @Get('me')
  me(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext) {
    return this.portal.me(s.schoolId, auth.userId);
  }

  @Get('children')
  children(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext) {
    return this.portal.children(s.schoolId, auth.userId);
  }

  @Get('children/:id')
  child(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Param('id', id) studentId: string) {
    return this.portal.child(s.schoolId, auth.userId, studentId);
  }

  /** One call for a dashboard card: attendance this term, balance (if allowed), latest report card. */
  @Get('children/:id/overview')
  async overview(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Param('id', id) studentId: string) {
    const relation = await this.portal.assertCanView(s.schoolId, auth.userId, studentId);
    const canSeeFees = relation !== 'SELF' || (await this.portal.assertCanView(s.schoolId, auth.userId, studentId, 'fees').then(() => true, () => false));
    const [att, cards, account] = await Promise.all([
      this.attendance.forStudent(s, studentId),
      this.reportCards.terms(s.schoolId, studentId),
      canSeeFees ? this.finance.studentAccount(s.schoolId, studentId) : Promise.resolve(null),
    ]);
    return {
      data: {
        attendance: { rate: att.data.rate, from: att.data.from, to: att.data.to, absent: att.data.totals.absent },
        balance: account ? { balanceMinor: account.data.balanceMinor, currency: account.data.currency } : null,
        latestReportCard: cards.data[0] ?? null,
      },
    };
  }

  @Get('children/:id/attendance')
  async attendanceFor(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Param('id', id) studentId: string, @Query(new ZodPipe(RangeQuery)) q: RangeInput) {
    await this.portal.assertCanView(s.schoolId, auth.userId, studentId, 'attendance');
    return this.attendance.forStudent(s, studentId, q.from, q.to);
  }

  @Get('children/:id/timetable')
  async timetableFor(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Param('id', id) studentId: string) {
    await this.portal.assertCanView(s.schoolId, auth.userId, studentId, 'timetable');
    const classId = await this.portal.currentClassId(s.schoolId, studentId);
    if (!classId) return { data: null };
    return this.timetable.forClass(s.schoolId, classId);
  }

  /** The child's invoices, payments and balance. Staff-only details (who recorded what) are left out. */
  @Get('children/:id/fees')
  async fees(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Param('id', id) studentId: string) {
    await this.portal.assertCanView(s.schoolId, auth.userId, studentId, 'fees');
    const account = await this.finance.studentAccount(s.schoolId, studentId);
    return {
      data: {
        ...account.data,
        invoices: account.data.invoices
          .filter((i) => i.status !== 'VOID')
          .map(({ adjustments, ...i }) => ({ ...i, discountsMinor: adjustments.filter((a) => a.kind !== 'CHARGE').reduce((n, a) => n + a.amountMinor, 0) })),
      },
    };
  }

  @Get('children/:id/receipts/:receiptId')
  async receipt(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Param('id', id) studentId: string, @Param('receiptId', id) receiptId: string) {
    await this.portal.assertCanView(s.schoolId, auth.userId, studentId, 'fees');
    const r = await this.payments.receipt(s.schoolId, receiptId, [studentId]);
    return { data: { ...r.data, recordedBy: null } };
  }

  /** Only published results ever reach parents and students. */
  @Get('children/:id/report-cards')
  async reportCardTerms(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Param('id', id) studentId: string) {
    await this.portal.assertCanView(s.schoolId, auth.userId, studentId, 'results');
    return this.reportCards.terms(s.schoolId, studentId);
  }

  @Get('children/:id/report-cards/:termId')
  async reportCard(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Param('id', id) studentId: string, @Param('termId', id) termId: string) {
    await this.portal.assertCanView(s.schoolId, auth.userId, studentId, 'results');
    return this.reportCards.card(s.schoolId, studentId, termId);
  }

  /** Books the child has out now. */
  @Get('children/:id/library')
  async libraryFor(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Param('id', id) studentId: string) {
    await this.portal.assertCanView(s.schoolId, auth.userId, studentId);
    return this.library.studentLoans(s.schoolId, studentId);
  }

  /** The child's bus, stop, times and driver contact. */
  @Get('children/:id/transport')
  async transportFor(@CurrentSchool() s: SchoolContext, @CurrentAuth() auth: AuthContext, @Param('id', id) studentId: string) {
    await this.portal.assertCanView(s.schoolId, auth.userId, studentId);
    return this.transport.forStudent(s.schoolId, studentId);
  }
}
