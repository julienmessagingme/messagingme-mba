import type { Metadata } from 'next';
import { Plus_Jakarta_Sans } from 'next/font/google';
import './globals.css';
import { LocaleProvider } from '@/lib/i18n';

// Police du design system MM Business Agent, self-hostée au build (aucun appel externe au
// runtime). Exposée en variable CSS --font-pjs, consommée par Tailwind (fontFamily.sans).
const pjs = Plus_Jakarta_Sans({ subsets: ['latin'], display: 'swap', variable: '--font-pjs' });

export const metadata: Metadata = {
  title: 'MM Business Agent',
  description: 'MM Business Agent : contacts, campagnes, agent WhatsApp.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className={pjs.variable}>
      <body><LocaleProvider>{children}</LocaleProvider></body>
    </html>
  );
}
