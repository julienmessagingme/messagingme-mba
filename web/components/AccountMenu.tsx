'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { Session } from '@/lib/session';

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
    <div className="flex cursor-not-allowed items-center justify-between px-3 py-2 text-sm text-ink-300" title="Bientôt disponible">
      {label}
      <span className="rounded bg-ink-100 px-1.5 py-0.5 text-[10px] text-ink-400">bientôt</span>
    </div>
  );

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-lg border border-ink-200 py-1 pl-1 pr-2 text-sm text-ink-700 transition hover:bg-ink-50"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-500 text-xs font-semibold text-white">{initials(session.email)}</span>
        <span className="hidden max-w-[160px] truncate sm:inline">{session.email}</span>
        <svg viewBox="0 0 24 24" className={`h-4 w-4 text-ink-400 transition ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 z-40 mt-2 w-56 overflow-hidden rounded-xl border border-ink-200 bg-white py-1 shadow-lg" role="menu">
          <div className="border-b border-ink-100 px-3 py-2">
            <div className="truncate text-sm font-medium text-ink-900">{session.email}</div>
            <div className="text-xs text-ink-400">{isAdmin ? 'Administrateur' : 'Agent'}</div>
          </div>
          {isAdmin && (
            <>
              <Link href="/admin" onClick={() => setOpen(false)} className="block px-3 py-2 text-sm text-ink-700 hover:bg-ink-50">Compte &amp; équipe</Link>
              {disabledItem('Abonnement')}
              {disabledItem('Billing')}
            </>
          )}
          <button onClick={onLogout} className="block w-full border-t border-ink-100 px-3 py-2 text-left text-sm text-coral hover:bg-ink-50">Déconnexion</button>
        </div>
      )}
    </div>
  );
}
