'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { getSession, clearSession, type Session } from '@/lib/session';

/** Coquille commune : garde d'auth, header (logo, email, logout) et navigation. */
export function AppShell({ active, children }: { active: 'contacts' | 'campagnes' | 'templates' | 'inbox'; children: (session: Session) => React.ReactNode }) {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    const s = getSession();
    if (!s) router.replace('/login');
    else setSession(s);
  }, [router]);

  if (!session) return null;

  function logout() {
    clearSession();
    router.replace('/login');
  }

  const tab = (href: string, key: string, label: string) =>
    key === active ? (
      <span key={key} className="rounded-lg bg-brand-50 px-3 py-1.5 font-medium text-brand-700">{label}</span>
    ) : (
      <Link key={key} href={href} className="rounded-lg px-3 py-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800">{label}</Link>
    );

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-500 text-sm font-bold text-white">m</div>
            <span className="text-sm font-semibold">Console MBA</span>
          </div>
          <div className="flex items-center gap-3 text-sm text-slate-500">
            <span>{session.email}</span>
            <button onClick={logout} className="rounded-lg border border-slate-300 px-2.5 py-1 text-slate-700 hover:bg-slate-50">
              Déconnexion
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">
        <nav className="mb-6 flex gap-1 text-sm">
          {tab('/inbox', 'inbox', 'Inbox')}
          {tab('/contacts', 'contacts', 'Contacts')}
          {tab('/campaigns', 'campagnes', 'Campagnes')}
          {tab('/templates', 'templates', 'Templates')}
        </nav>
        {children(session)}
      </main>
    </div>
  );
}
