'use client';

import Link from 'next/link';
import { Logo } from '@/components/Logo';
import { LocaleToggle } from '@/components/LocaleToggle';
import { useT } from '@/lib/i18n';

/**
 * Le cadre des documentations lues SANS compte (le serveur MCP, et bientôt l'API, qui porte encore sa
 * copie de ce cadre) : un intégrateur y arrive depuis la vitrine (`site/`), avant d'avoir un espace.
 * La marque ramène à la vitrine, « Se connecter » à la console.
 */
export function CadrePublic({ children }: { children: React.ReactNode }) {
  const t = useT();
  return (
    <main className="min-h-screen px-4 py-8">
      <header className="mx-auto mb-8 flex max-w-3xl items-center justify-between gap-4">
        <a href="https://engageme.messagingme.fr" className="flex items-center gap-2 text-base font-semibold tracking-tight text-ink-900">
          <Logo className="h-7 w-7" />
          Engage Me
        </a>
        <div className="flex items-center gap-3">
          <LocaleToggle />
          <Link href="/login" className="rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-sm font-medium text-ink-800 transition hover:border-brand-500 hover:text-brand-600">
            {t('Se connecter', 'Sign in')}
          </Link>
        </div>
      </header>
      <div className="mx-auto max-w-3xl">{children}</div>
    </main>
  );
}
