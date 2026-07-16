'use client';

import { useLocale } from '@/lib/i18n';

/**
 * Pill FR/EN pour les pages PRÉ-connexion (login, signup, forgot, invite, reset) : le menu Compte (qui porte
 * le toggle post-login) n'y est pas monté. Même mécanique (useLocale, persistance localStorage, <html lang>).
 */
export function LocaleToggle({ className = '' }: { className?: string }) {
  const { locale, setLocale } = useLocale();
  return (
    <div className={`inline-flex gap-1 rounded-lg bg-ink-100 p-1 text-xs ${className}`}>
      {(['fr', 'en'] as const).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => setLocale(l)}
          className={`rounded-md px-2 py-0.5 font-medium uppercase ${locale === l ? 'bg-white text-brand-700 shadow-sm' : 'text-ink-500 hover:text-ink-800'}`}
          aria-pressed={locale === l}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
