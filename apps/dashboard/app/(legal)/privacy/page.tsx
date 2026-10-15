import type { Metadata } from 'next';
import { LegalDocument } from '@/components/legal/LegalDocument';

export const metadata: Metadata = { title: 'Privacy Policy · DareX' };

export default function PrivacyPage() {
  return (
    <LegalDocument
      title="Privacy Policy"
      updated="15 October 2026"
      other={{ href: '/terms', label: 'Terms of Service' }}
      sections={[
        {
          heading: 'What we keep',
          body: [
            'Your account (name, email, a protected form of your password), the team you invite, and the business information you add or connect: customer messages, contacts, listings, documents, bookings and what is owed.',
            'We also keep a record of what each AI employee did and who approved it, so you can check it later.',
          ],
        },
        {
          heading: 'How it is used',
          body: [
            'To answer questions, prepare actions and run the employees you set up for your business. Each workspace is kept apart from every other workspace, and that separation is enforced in the database itself, not only in the screens.',
          ],
        },
        {
          heading: 'AI and connected apps',
          body: [
            'To write an answer, the relevant text from your workspace is sent to the AI model service the product is set up with. Apps you connect (such as Gmail, WhatsApp or Google Calendar) are used only for the things you ask the employees to do, and you can disconnect any of them at any time.',
          ],
        },
        {
          heading: 'Export and delete',
          body: [
            'You can export your data or ask for it to be deleted from Settings, under Privacy and data requests. An export is a file you can download. A deletion removes your workspace data and takes a little time to finish.',
          ],
        },
        {
          heading: 'Security',
          body: [
            'Sign-in is protected by a password and, if you turn it on, a second step. Access inside a workspace depends on the role you were given, and sensitive actions are recorded.',
          ],
        },
        {
          heading: 'Contact',
          body: ['Questions or requests about your data: [add your contact email before launch].'],
        },
      ]}
    />
  );
}
