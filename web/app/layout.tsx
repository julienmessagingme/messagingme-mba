import type { Metadata } from 'next';
import { Manrope } from 'next/font/google';
import './globals.css';

// Police premium self-hostée au build (aucun appel externe au runtime).
const manrope = Manrope({ subsets: ['latin'], display: 'swap' });

export const metadata: Metadata = {
  title: 'messagingme - Console MBA',
  description: 'Console WhatsApp Business : contacts, campagnes, agent.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className={manrope.className}>
      <body>{children}</body>
    </html>
  );
}
