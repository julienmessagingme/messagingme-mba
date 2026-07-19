'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { getSession, clearSession, type Session } from '@/lib/session';
import { Logo } from './Logo';
import { AccountMenu } from './AccountMenu';
import { useT } from '@/lib/i18n';

type Tab = 'accueil' | 'dashboard' | 'contacts' | 'campagnes' | 'workflows' | 'templates' | 'flows' | 'tags' | 'fields' | 'nodes' | 'inbox' | 'admin' | 'support';

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
  flow: 'M5 4h4v4H5zM15 16h4v4h-4zM7 8v4a2 2 0 002 2h6',
  support: 'M12 22a10 10 0 100-20 10 10 0 000 20zM9.1 9a3 3 0 015.8 1c0 2-3 3-3 3M12 17h.01',
};

interface NavChild { key: string; href: string; label: string }
interface NavItem { key: string; href?: string; label: string; d: string; children?: NavChild[] }

/**
 * Coquille commune : garde d'auth + RBAC, SIDEBAR gauche (nav rôle-aware) + header (menu Compte à droite)
 * + contenu pleine largeur. RBAC : seule l'inbox est ouverte à l'agent ; tout le reste exige admin (la
 * vraie autorité reste le serveur, on évite juste d'afficher une page interdite).
 */
export function AppShell({ active, fullBleed = false, children }: { active: Tab; fullBleed?: boolean; children: (session: Session) => React.ReactNode }) {
  const router = useRouter();
  const t = useT();
  const [session, setSession] = useState<Session | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Groupes de nav repliables. Ouvert au départ seulement si la page active est un de ses enfants
  // (`active` est une prop stable, donc pas de flicker : l'état initial est déjà bon au 1er rendu).
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => ({
    contenu: ['templates', 'flows', 'nodes', 'tags', 'fields'].includes(active),
  }));

  // Nav construite au rendu (et non en constante module) pour que les libellés suivent la langue courante.
  const NAV_ADMIN: NavItem[] = [
    { key: 'inbox', href: '/inbox', label: t('Inbox', 'Inbox'), d: icons.inbox },
    // Libellé seulement : l'URL reste `/contacts`, pour ne casser ni les liens existants ni les deep-links.
    { key: 'contacts', href: '/contacts', label: t('mini-CRM', 'mini-CRM'), d: icons.contacts },
    { key: 'campagnes', href: '/campaigns', label: t('Campagnes', 'Campaigns'), d: icons.campaign },
    { key: 'workflows', href: '/workflows', label: t('Scénario', 'Scenario'), d: icons.flow },
    { key: 'contenu', label: t('Contenu', 'Content'), d: icons.content, children: [
      { key: 'templates', href: '/templates', label: t('Templates', 'Templates') },
      { key: 'flows', href: '/flows', label: t('Formulaires', 'Forms') },
      { key: 'nodes', href: '/nodes', label: t('Blocs', 'Blocks') },
      { key: 'tags', href: '/tags', label: t('Tags', 'Tags') },
      { key: 'fields', href: '/fields', label: t('Champs', 'Fields') },
    ] },
    { key: 'analytics', href: '/dashboard', label: t('Analytics', 'Analytics'), d: icons.analytics },
    { key: 'support', href: '/support', label: t('Support', 'Support'), d: icons.support },
  ];
  const NAV_AGENT: NavItem[] = [{ key: 'inbox', href: '/inbox', label: t('Inbox', 'Inbox'), d: icons.inbox }];

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

  // Groupe de nav actif : dashboard -> Analytics ; templates|flows|nodes|tags|fields -> Contenu ; sinon la page elle-même.
  const group =
    active === 'dashboard' ? 'analytics'
      : active === 'templates' || active === 'flows' || active === 'nodes' || active === 'tags' || active === 'fields' ? 'contenu'
        : active;
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
            <button
              type="button"
              onClick={() => setOpenGroups((s) => ({ ...s, [item.key]: !s[item.key] }))}
              aria-expanded={!!openGroups[item.key]}
              className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition hover:bg-ink-100 ${group === item.key ? 'font-medium text-brand-700' : 'text-ink-600'}`}
            >
              <Ico d={item.d} />
              {item.label}
              <svg viewBox="0 0 24 24" className={`ml-auto h-4 w-4 shrink-0 text-ink-400 transition-transform ${openGroups[item.key] ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
            </button>
            {openGroups[item.key] && (
              <div className="ml-[30px] mt-0.5 space-y-0.5 border-l border-ink-100 pl-2">
                {item.children.map((c) => (
                  <Link key={c.key} href={c.href} onClick={() => setDrawerOpen(false)} className={subCls(active === c.key)}>{c.label}</Link>
                ))}
              </div>
            )}
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
      <Link href={session.role === 'admin' ? '/accueil' : '/inbox'} className="flex items-center gap-2 px-3 py-4" title={t('Accueil', 'Home')} onClick={() => setDrawerOpen(false)}>
        <Logo className="h-8 w-8" />
        <span className="text-sm font-semibold tracking-tight text-ink-900">MM Business Agent</span>
      </Link>
      <div className="px-2">{NavList}</div>
    </>
  );

  return (
    <div className={`bg-[#F7F8FB] lg:flex ${fullBleed ? 'min-h-screen lg:h-screen lg:overflow-hidden' : 'min-h-screen'}`}>
      {/* Sidebar desktop */}
      <aside className="hidden w-60 shrink-0 border-r border-ink-200 bg-white lg:block">
        <div className="sticky top-0">{SidebarInner}</div>
      </aside>

      {/* Drawer mobile (z-40, sous les modales z-50) */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button aria-label={t('Fermer le menu', 'Close menu')} className="absolute inset-0 bg-ink-900/30" onClick={() => setDrawerOpen(false)} />
          <div className="absolute left-0 top-0 h-full w-60 border-r border-ink-200 bg-white">{SidebarInner}</div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-ink-200 bg-white px-4 py-2.5">
          <button className="rounded-lg p-1.5 text-ink-600 hover:bg-ink-100 lg:hidden" onClick={() => setDrawerOpen(true)} aria-label={t('Ouvrir le menu', 'Open menu')}>
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
          <div className="ml-auto">
            <AccountMenu session={session} onLogout={logout} />
          </div>
        </header>
        <main className={fullBleed ? 'w-full flex-1 lg:flex lg:min-h-0 lg:flex-col' : 'mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6'}>{children(session)}</main>
      </div>
    </div>
  );
}
