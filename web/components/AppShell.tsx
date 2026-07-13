'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { getSession, clearSession, type Session } from '@/lib/session';
import { Logo } from './Logo';
import { AccountMenu } from './AccountMenu';

type Tab = 'accueil' | 'dashboard' | 'contacts' | 'campagnes' | 'templates' | 'flows' | 'tags' | 'fields' | 'inbox' | 'admin' | 'support';

/** Icônes de nav (SVG inline, aucune dépendance). */
const ICON = 'h-[18px] w-[18px] shrink-0';
const Ico = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
);
const icons = {
  inbox: 'M4 13h4l2 3h4l2-3h4M4 13V6a2 2 0 012-2h12a2 2 0 012 2v7M4 13v5a2 2 0 002 2h12a2 2 0 002-2v-5',
  contacts: 'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75',
  campaign: 'M3 11l18-5v12L3 14v-3zM11.6 16.8a3 3 0 11-5.8-1.6',
  content: 'M4 4h16v4H4zM4 12h10v8H4zM18 12h2v8h-2z',
  analytics: 'M3 3v18h18M8 17V9M13 17V5M18 17v-6',
  support: 'M12 22a10 10 0 100-20 10 10 0 000 20zM9.1 9a3 3 0 015.8 1c0 2-3 3-3 3M12 17h.01',
};

interface NavChild { key: string; href: string; label: string }
interface NavItem { key: string; href?: string; label: string; d: string; children?: NavChild[] }

const NAV_ADMIN: NavItem[] = [
  { key: 'inbox', href: '/inbox', label: 'Inbox', d: icons.inbox },
  { key: 'contacts', href: '/contacts', label: 'Contacts', d: icons.contacts },
  { key: 'campagnes', href: '/campaigns', label: 'Campagnes', d: icons.campaign },
  { key: 'contenu', label: 'Contenu', d: icons.content, children: [
    { key: 'templates', href: '/templates', label: 'Templates' },
    { key: 'flows', href: '/flows', label: 'Formulaires' },
    { key: 'tags', href: '/tags', label: 'Tags' },
    { key: 'fields', href: '/fields', label: 'Champs' },
  ] },
  { key: 'analytics', href: '/dashboard', label: 'Analytics', d: icons.analytics },
  { key: 'support', href: '/support', label: 'Support', d: icons.support },
];
const NAV_AGENT: NavItem[] = [{ key: 'inbox', href: '/inbox', label: 'Inbox', d: icons.inbox }];

/**
 * Coquille commune : garde d'auth + RBAC, SIDEBAR gauche (nav rôle-aware) + header (menu Compte à droite)
 * + contenu pleine largeur. RBAC : seule l'inbox est ouverte à l'agent ; tout le reste exige admin (la
 * vraie autorité reste le serveur, on évite juste d'afficher une page interdite).
 */
export function AppShell({ active, children }: { active: Tab; children: (session: Session) => React.ReactNode }) {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Fail-safe : tout ce qui n'est pas l'inbox est réservé aux admins.
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
  if (adminOnly && session.role !== 'admin') return null;

  function logout() {
    clearSession();
    router.replace('/login');
  }

  // Groupe de nav actif : dashboard -> Analytics ; templates|flows -> Contenu ; sinon la page elle-même.
  const group =
    active === 'dashboard' ? 'analytics' : active === 'templates' || active === 'flows' || active === 'tags' || active === 'fields' ? 'contenu' : active;
  const nav = session.role === 'admin' ? NAV_ADMIN : NAV_AGENT;

  const itemCls = (on: boolean) =>
    `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${on ? 'bg-brand-50 font-medium text-brand-700' : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900'}`;
  const subCls = (on: boolean) =>
    `block rounded-md px-3 py-1.5 text-sm transition ${on ? 'bg-brand-50 font-medium text-brand-700' : 'text-ink-500 hover:bg-ink-100 hover:text-ink-800'}`;

  const NavList = (
    <nav className="space-y-1">
      {nav.map((item) =>
        item.children ? (
          <div key={item.key}>
            <div className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm ${group === item.key ? 'font-medium text-brand-700' : 'text-ink-600'}`}>
              <Ico d={item.d} />
              {item.label}
            </div>
            <div className="ml-[30px] space-y-0.5 border-l border-ink-100 pl-2">
              {item.children.map((c) => (
                <Link key={c.key} href={c.href} onClick={() => setDrawerOpen(false)} className={subCls(active === c.key)}>{c.label}</Link>
              ))}
            </div>
          </div>
        ) : (
          <Link key={item.key} href={item.href!} onClick={() => setDrawerOpen(false)} className={itemCls(group === item.key)}>
            <Ico d={item.d} />
            {item.label}
          </Link>
        ),
      )}
    </nav>
  );

  const SidebarInner = (
    <>
      <Link href={session.role === 'admin' ? '/accueil' : '/inbox'} className="flex items-center gap-2 px-3 py-4" title="Accueil" onClick={() => setDrawerOpen(false)}>
        <Logo className="h-8 w-8" />
        <span className="text-sm font-semibold tracking-tight text-ink-900">MM Business Agent</span>
      </Link>
      <div className="px-2">{NavList}</div>
    </>
  );

  return (
    <div className="min-h-screen bg-[#F7F8FB] lg:flex">
      {/* Sidebar desktop */}
      <aside className="hidden w-60 shrink-0 border-r border-ink-200 bg-white lg:block">
        <div className="sticky top-0">{SidebarInner}</div>
      </aside>

      {/* Drawer mobile (z-40, sous les modales z-50) */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button aria-label="Fermer le menu" className="absolute inset-0 bg-ink-900/30" onClick={() => setDrawerOpen(false)} />
          <div className="absolute left-0 top-0 h-full w-60 border-r border-ink-200 bg-white">{SidebarInner}</div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-ink-200 bg-white px-4 py-2.5">
          <button className="rounded-lg p-1.5 text-ink-600 hover:bg-ink-100 lg:hidden" onClick={() => setDrawerOpen(true)} aria-label="Ouvrir le menu">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
          <div className="ml-auto">
            <AccountMenu session={session} onLogout={logout} />
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6">{children(session)}</main>
      </div>
    </div>
  );
}
