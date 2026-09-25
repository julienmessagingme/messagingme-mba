import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { LocaleProvider } from '@/lib/i18n';
import { ConfirmationProvider } from '@/components/Confirmation';

// Polices de la console, self-hostées au build (aucun appel externe au runtime). Exposées en variables CSS,
// consommées par Tailwind (`fontFamily.sans` et `fontFamily.mono`). La mono sert les numéros, identifiants
// et extraits de code : sans police déclarée, elle retombait sur Consolas ou Courier selon la machine.
const geist = Geist({ subsets: ['latin'], display: 'swap', variable: '--font-geist-sans' });
const geistMono = Geist_Mono({ subsets: ['latin'], display: 'swap', variable: '--font-geist-mono' });

// Métadonnées STATIQUES (SSR) : titre = marque (neutre), description en anglais (audience internationale,
// reviewers Meta). Le contenu de l'app, lui, est bilingue via LocaleProvider.
export const metadata: Metadata = {
  title: 'Engage Me',
  description: 'Engage Me: WhatsApp contacts, campaigns and inbox console.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // lang="fr" = défaut SSR (1er rendu toujours FR -> pas de mismatch d'hydratation). Le LocaleProvider
    // resynchronise document.documentElement.lang après montage (choix mémorisé OU toggle).
    <html lang="fr" className={`${geist.variable} ${geistMono.variable}`}>
      <body><LocaleProvider><ConfirmationProvider>{children}</ConfirmationProvider></LocaleProvider></body>
    </html>
  );
}
