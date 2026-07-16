import type { Metadata } from 'next';
import { Plus_Jakarta_Sans } from 'next/font/google';
import './globals.css';
import { LocaleProvider } from '@/lib/i18n';

// Police du design system MM Business Agent, self-hostée au build (aucun appel externe au
// runtime). Exposée en variable CSS --font-pjs, consommée par Tailwind (fontFamily.sans).
const pjs = Plus_Jakarta_Sans({ subsets: ['latin'], display: 'swap', variable: '--font-pjs' });

// Métadonnées STATIQUES (SSR) : titre = marque (neutre), description en anglais (audience internationale,
// reviewers Meta). Le contenu de l'app, lui, est bilingue via LocaleProvider.
export const metadata: Metadata = {
  title: 'MM Business Agent',
  description: 'MM Business Agent: WhatsApp contacts, campaigns and inbox console.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // lang="fr" = défaut SSR (1er rendu toujours FR -> pas de mismatch d'hydratation). Le LocaleProvider
    // resynchronise document.documentElement.lang après montage (choix mémorisé OU toggle).
    <html lang="fr" className={pjs.variable}>
      <body><LocaleProvider>{children}</LocaleProvider></body>
    </html>
  );
}
