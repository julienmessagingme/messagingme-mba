'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { Session } from '@/lib/session';
import { useT, useLocale } from '@/lib/i18n';
import { Icone } from '@/components/Icone';

/** Initiales pour la pastille (nom si dispo, sinon partie locale de l'email). */
function initials(email: string): string {
  const local = email.split('@')[0] ?? email;
  const parts = local.split(/[._-]+/).filter(Boolean);
  const s = parts.length >= 2 ? parts[0]![0]! + parts[1]![0]! : local.slice(0, 2);
  return s.toUpperCase();
}

/**
 * Menu « Compte » en dropdown, à droite du header. Clic-dehors + Échap pour fermer. Items rôle-aware :
 * admin -> Compte (gestion équipe), Abonnement + Billing (désactivés, câblage Stripe hors lot), Déconnexion ;
 * agent -> Déconnexion seule. Tailwind pur, aucune dépendance.
 */
export function AccountMenu({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const isAdmin = session.role === 'admin';
  const t = useT();
  const { locale, setLocale } = useLocale();

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const disabledItem = (label: string) => (
    <div className="flex cursor-not-allowed items-center justify-between px-3 py-2 text-sm text-ink-500" title={t('Bientôt disponible', 'Coming soon')}>
      {label}
      <span className="rounded-controle bg-ink-100 px-1.5 py-0.5 text-xs text-ink-500">{t('bientôt', 'soon')}</span>
    </div>
  );

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-controle border border-ink-200 py-1 pl-1 pr-2 text-sm text-ink-900 transition-colors duration-150 hover:bg-ink-50"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white">{initials(session.email)}</span>
        <span className="hidden max-w-[160px] truncate sm:inline">{session.email}</span>
        <Icone nom="deplier" taille="petite" className={`text-ink-400 transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute right-0 z-40 mt-2 w-56 overflow-hidden rounded-carte border border-ink-200 bg-white py-1 shadow-mm-md" role="menu">
          <div className="border-b border-ink-100 px-3 py-2">
            <div className="truncate text-sm font-medium text-ink-900">{session.email}</div>
            <div className="text-xs text-ink-500">{isAdmin ? t('Administrateur', 'Administrator') : t('Agent', 'Agent')}</div>
          </div>
          {/* Langue de l'interface (FR/EN), mémorisée par navigateur. */}
          <div className="flex items-center justify-between border-b border-ink-100 px-3 py-2">
            <span className="text-xs text-ink-500">{t('Langue', 'Language')}</span>
            <div className="inline-flex overflow-hidden rounded-controle border border-ink-200 text-xs">
              {(['fr', 'en'] as const).map((l) => (
                <button
                  key={l}
                  onClick={() => setLocale(l)}
                  aria-pressed={locale === l}
                  className={`px-2 py-0.5 font-medium transition-colors duration-150 ${locale === l ? 'bg-brand-600 text-white' : 'text-ink-500 hover:bg-ink-50'}`}
                >
                  {l.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          {isAdmin && (
            <>
              <Link href="/admin" onClick={() => setOpen(false)} className="block px-3 py-2 text-sm text-ink-900 hover:bg-ink-50">{t('Compte & équipe', 'Account & team')}</Link>
              <Link href="/settings/email" onClick={() => setOpen(false)} className="block px-3 py-2 text-sm text-ink-900 hover:bg-ink-50">{t('Boîtes email', 'Email accounts')}</Link>
              {disabledItem(t('Abonnement', 'Subscription'))}
              {disabledItem(t('Billing', 'Billing'))}
            </>
          )}
          <button onClick={onLogout} className="block w-full border-t border-ink-100 px-3 py-2 text-left text-sm text-danger hover:bg-ink-50">{t('Déconnexion', 'Log out')}</button>
        </div>
      )}
    </div>
  );
}
