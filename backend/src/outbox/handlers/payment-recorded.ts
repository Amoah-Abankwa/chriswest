import { Injectable } from '@nestjs/common';
import { loadReceipt } from '../../finance/payments.service';
import { Mailer } from '../../mail/mailer';
import { receiptPdf } from '../../pdf/pdf';
import { NotificationsService } from '../../notifications/notifications.service';
import { recipientsForStudent } from '../../notifications/recipients';
import { PrismaService } from '../../prisma/prisma.service';

/** Confirms a payment to the family, with the receipt number. Skipped if the payment was reversed in the meantime. */
@Injectable()
export class PaymentRecordedHandler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: Mailer,
    private readonly notifications: NotificationsService,
  ) {}

  async handle(schoolId: string, payload: { paymentId: string }): Promise<'sent' | 'skipped'> {
    const p = await this.prisma.payment.findFirst({
      where: { schoolId, id: payload.paymentId },
      select: { status: true, amountMinor: true, currency: true, receivedOn: true, studentId: true, student: { select: { firstName: true } }, receipt: { select: { id: true, number: true } } },
    });
    if (!p || p.status !== 'RECORDED') return 'skipped';
    const school = await this.prisma.school.findUniqueOrThrow({ where: { id: schoolId }, select: { name: true, contactEmail: true, status: true, studentPortalFees: true } });
    if (school.status !== 'ACTIVE') return 'skipped';

    const amount = new Intl.NumberFormat('en-GH', { style: 'currency', currency: p.currency }).format(p.amountMinor / 100);
    const date = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(p.receivedOn);
    const to = await recipientsForStudent(this.prisma, schoolId, p.studentId, { includeStudent: school.studentPortalFees });
    const body = `${amount} received for ${p.student.firstName} on ${date}. Receipt ${p.receipt?.number ?? ''}.`.replace(' .', '.');

    await this.notifications.create(to.userIds.map((userId) => ({ schoolId, userId, kind: 'payment.recorded', title: 'Payment received', body, link: to.link })));
    const receipt = p.receipt ? await loadReceipt(this.prisma, schoolId, p.receipt.id) : null;
    const attachments = receipt ? [{ filename: `receipt-${receipt.number}.pdf`, content: await receiptPdf(receipt), contentType: 'application/pdf' }] : [];
    for (const email of to.emails) {
      await this.mailer.send({ to: email, subject: `${school.name}: payment received`, text: `Thank you. ${body}\n\nYour receipt is attached.`, attachments, replyTo: school.contactEmail, idempotencyKey: `payment:${payload.paymentId}:${email}` }, { schoolId, kind: 'payment.recorded' });
    }
    return to.userIds.length || to.emails.length ? 'sent' : 'skipped';
  }
}
