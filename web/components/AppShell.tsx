'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { getSession, clearSession, type Session } from '@/lib/session';
import { Logo } from './Logo';

type Tab = 'dashboard' | 'contacts' | 'campagnes' | 'templates' | 'inbox' | 'admin';

/** Coquille commune : garde d'auth + RBAC, header (logo, email, logout) et navigation.
 *  RBAC : seule l'inbox est ouverte à l'agent. Toute page hors inbox exige le rôle admin ;
 *  un agent qui y accède (URL directe) est renvoyé sur /inbox. Barrière de confort : la vraie
 *  autorité reste le serveur (preHandler admin), mais on évite d'afficher une page vide/403. */
export function AppShell({ active, children }: { active: Tab; children: (session: Session) => React.ReactNode }) {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);

  // Fail-safe : tout ce qui n'est pas l'inbox est réservé aux admins (une nouvelle page admin
  // est gardée par défaut sans rien oublier). L'inbox est le seul périmètre agent.
  const adminOnly = active !== 'inbox';

  useEffect(() => {
    const s = getSession();
    if (!s) {
      router.replace('/login');
      return;
    }
    if (adminOnly && s.role !== 'admin') {
      router.replace('/inbox');
      return;
    }
    setSession(s);
  }, [router, adminOnly]);

  if (!session) return null;
  // Ceinture + bretelles : ne rend pas le contenu admin à un agent même le temps du replace.
  if (adminOnly && session.role !== 'admin') return null;

  function logout() {
    clearSession();
    router.replace('/login');
  }

  // Templates est un sous-onglet de Campagnes -> l'onglet principal actif est « campagnes »
  // quand on est sur Templates.
  const topActive = active === 'templates' ? 'campagnes' : active;

  const tab = (href: string, key: string, label: string) =>
    key === topActive ? (
      <span key={key} className="rounded-lg bg-brand-50 px-3 py-1.5 font-medium text-brand-700">{label}</span>
    ) : (
      <Link key={key} href={href} className="rounded-lg px-3 py-1.5 text-ink-500 hover:bg-ink-100 hover:text-ink-800">{label}</Link>
    );

  const subTab = (href: string, key: string, label: string) =>
    key === active ? (
      <span key={key} className="rounded-md bg-white px-3 py-1 font-medium text-brand-700 shadow-sm">{label}</span>
    ) : (
      <Link key={key} href={href} className="rounded-md px-3 py-1 text-ink-500 hover:text-ink-800">{label}</Link>
    );

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-ink-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <div className="flex shrink-0 items-center gap-2">
            <Logo className="h-8 w-8" />
            <span className="text-sm font-semibold tracking-tight text-ink-900">MM Business Agent</span>
          </div>
          <nav className="flex gap-1 text-sm">
            {session.role === 'admin' ? (
              <>
                {tab('/dashboard', 'dashboard', 'Dashboard')}
                {tab('/inbox', 'inbox', 'Inbox')}
                {tab('/contacts', 'contacts', 'Contacts')}
                {tab('/campaigns', 'campagnes', 'Campagnes')}
                {tab('/admin', 'admin', 'Admin')}
              </>
            ) : (
              // Agent : l'inbox est son seul périmètre.
              tab('/inbox', 'inbox', 'Inbox')
            )}
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-3 text-sm text-ink-500">
            <span className="hidden max-w-[200px] truncate sm:inline">{session.email}</span>
            <button onClick={logout} className="rounded-lg border border-ink-300 px-2.5 py-1 text-ink-700 hover:bg-ink-50">
              Déconnexion
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-10">
        {topActive === 'campagnes' && (
          <nav className="mb-6 inline-flex gap-1 rounded-lg bg-ink-100 p-1 text-xs">
            {subTab('/campaigns', 'campagnes', 'Campagnes')}
            {subTab('/templates', 'templates', 'Templates')}
          </nav>
        )}
        {children(session)}
      </main>
    </div>
  );
}
