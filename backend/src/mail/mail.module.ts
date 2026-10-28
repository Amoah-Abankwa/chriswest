import { Global, Module } from '@nestjs/common';
import { createTransport, Mailer, MailTransport, RecordingMailer } from './mailer';

@Global()
@Module({
  providers: [
    // One transport per process, so Resend pacing is shared by everything this process sends.
    { provide: MailTransport, useFactory: createTransport },
    { provide: Mailer, useClass: RecordingMailer },
  ],
  exports: [Mailer, MailTransport],
})
export class MailModule {}
