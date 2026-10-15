import type { Metadata } from 'next';
import { LegalDocument } from '@/components/legal/LegalDocument';

export const metadata: Metadata = { title: 'Terms of Service · DareX' };

export default function TermsPage() {
  return (
    <LegalDocument
      title="Terms of Service"
      updated="15 October 2026"
      other={{ href: '/privacy', label: 'Privacy Policy' }}
      sections={[
        {
          heading: 'What DareX does',
          body: [
            'DareX gives your business a team of AI employees. They read the messages and business information you connect, answer questions, and prepare actions such as replying to a customer or sending a reminder.',
          ],
        },
        {
          heading: 'You stay in control',
          body: [
            'Actions that send a message, move money or change your records wait for a person to approve them, unless you have chosen a more automatic level in Settings. You can change that level, pause an employee, or switch everything off at any time.',
            'AI can be wrong. Read what it prepared before you approve it. You are responsible for what you approve and for the instructions you give.',
          ],
        },
        {
          heading: 'Your account and your team',
          body: [
            'Keep your password private and tell us if you think someone else has used your account. You are responsible for the people you invite and the access you give them.',
          ],
        },
        {
          heading: 'What you may not do',
          body: [
            'Do not use DareX to send spam, to message people who have not agreed to hear from you, to break the rules of the services you connect (such as WhatsApp or Gmail), to deceive people, or to break the law.',
          ],
        },
        {
          heading: 'Your data',
          body: [
            'The business data you add or connect stays yours. We use it only to run your workspace. The Privacy Policy explains what is stored and how to export or delete it.',
          ],
        },
        {
          heading: 'Plans and payment',
          body: [
            'The price and what a plan includes are shown on the Billing page before you buy. You can see your plan and manage it there.',
          ],
        },
        {
          heading: 'Availability and limits',
          body: [
            'We work to keep DareX running and your data safe, but we cannot promise it will never be interrupted or make a mistake. To the extent the law allows, our responsibility to you is limited to the amount you paid in the last three months.',
          ],
        },
        {
          heading: 'Changes and contact',
          body: [
            'We will tell you in the product before we change these terms in a way that matters. Questions: [add your contact email before launch].',
          ],
        },
      ]}
    />
  );
}
