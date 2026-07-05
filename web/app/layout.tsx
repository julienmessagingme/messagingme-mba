import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'messagingme - Console MBA',
  description: 'Console WhatsApp Business : contacts, campagnes, agent.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
