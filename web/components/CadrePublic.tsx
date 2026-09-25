'use client';

import Link from 'next/link';
import { Logo } from '@/components/Logo';
import { LocaleToggle } from '@/components/LocaleToggle';
import { useT } from '@/lib/i18n';
import { classesBouton } from '@/components/Bouton';

/**
 * Le cadre des documentations lues SANS compte (l'API et le serveur MCP) : un intégrateur y arrive depuis la
 * vitrine (`site/`), avant d'avoir un espace.
 * La marque ramène à la vitrine, « Se connecter » à la console.
 */
export function CadrePublic({ children }: { children: React.ReactNode }) {
  const t = useT();
  return (
    <main className="min-h-screen px-4 py-8">
      <header className="mx-auto mb-8 flex max-w-liste items-center justify-between gap-4">
        <a href="https://engageme.messagingme.fr" className="flex items-center gap-2 text-base font-semibold text-ink-900">
          <Logo className="h-7 w-7" />
          Engage Me
        </a>
        <div className="flex items-center gap-3">
          <LocaleToggle />
          <Link href="/login" className={classesBouton('secondaire')}>
            {t('Se connecter', 'Sign in')}
          </Link>
        </div>
      </header>
      <div className="mx-auto max-w-liste">{children}</div>
    </main>
  );
}
