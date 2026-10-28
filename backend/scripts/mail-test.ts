// Sends one test email using the current backend/.env settings, bypassing the queue, and prints
// exactly what the provider says. Usage: npm run mail:test -w backend -- you@example.com
import 'dotenv/config';
import { getEnv } from '../src/config/env';
import { createTransport } from '../src/mail/mailer';

async function main() {
  const to = process.argv[2];
  if (!to) throw new Error('Usage: npm run mail:test -w backend -- you@example.com');
  const env = getEnv();
  console.log(`MAIL_DRIVER=${env.MAIL_DRIVER}  MAIL_FROM=${env.MAIL_FROM ?? '(not set)'}  NODE_ENV=${env.NODE_ENV}`);
  if (env.MAIL_DRIVER === 'resend') console.log(`RESEND_API_KEY=${env.RESEND_API_KEY?.slice(0, 6)}… (${env.RESEND_API_KEY?.length} characters)`);

  const result = await createTransport().deliver(
    { to, subject: 'School portal test email', text: 'If you can read this, email sending works.' },
    { kind: 'test' },
  );
  if (!result.messageId) {
    console.log('\nNothing was sent: the dev driver only prints emails. Set MAIL_DRIVER=resend in backend/.env.');
    return;
  }
  console.log(`\nAccepted by ${env.MAIL_DRIVER}. Message ID: ${result.messageId}`);
  if (env.MAIL_DRIVER !== 'resend') return;

  // Ask Resend what happened next. Needs a key with read access; sending-only keys get 401/403.
  console.log('Checking delivery status for 20 seconds…');
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(`https://api.resend.com/emails/${result.messageId}`, { headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` } });
    if (res.status === 401 || res.status === 403) {
      console.log('This key can only send, so it can’t read the status (that’s the safe setup).');
      console.log(`Open Resend → Emails and search for ${result.messageId} to see what happened.`);
      return;
    }
    const email = (await res.json()) as { last_event?: string; to?: string[]; from?: string };
    console.log(`  status: ${email.last_event ?? 'unknown'}  (from ${email.from} to ${email.to?.join(', ')})`);
    if (email.last_event && !['queued', 'sent', 'scheduled'].includes(email.last_event)) break;
  }
  console.log('\nMeaning: delivered = reached the inbox server (check spam/promotions); bounced = recipient server refused it;');
  console.log('complained = marked as spam; delivery_delayed = recipient server is slow, Resend keeps trying; sent = still waiting.');
}

main().catch((err) => {
  console.error('\nFAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});