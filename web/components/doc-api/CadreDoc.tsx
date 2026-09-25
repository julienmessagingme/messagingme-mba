'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { CadrePublic } from '@/components/CadrePublic';
import { useT } from '@/lib/i18n';
import { getSession, type Session } from '@/lib/session';
import { accesAutorise } from '@/lib/nav';
import { GROUPES_DOC, PAGES_DOC, pageDoc, type CleDePage } from '@/lib/doc-api-pages';

/**
 * LE CADRE DE CHAQUE PAGE DE LA DOCUMENTATION (API et serveur MCP) : la navigation de la doc à gauche, collante
 * sur ordinateur, repliée dans un bouton « Documentation » sur mobile, et le contenu à droite.
 *
 * 🔴 ELLE EST PUBLIQUE, TOUTES PAGES COMPRISES (décision de Julien du 2026-09-25) : un intégrateur la lit AVANT
 * d'avoir un compte, depuis la vitrine (`site/`). Qui peut ouvrir l'écran dans la console l'a dans la console
 * (`AppShell`) ; tout autre visiteur la lit dans `CadrePublic`, au lieu d'être renvoyé au login. La décision
 * se prend ICI, une fois pour toutes les pages : une page qui la prendrait elle-même pourrait l'oublier, et
 * `AppShell` seul renverrait au login. Ce qui l'autorise : aucune page de l'API ne lit de donnée d'espace (la
 * page MCP en lit une, la liste des clés, et seulement avec une session).
 * `web/e2e/developers-api.spec.ts` ouvre chaque page sans session.
 */
export function CadreDoc({ page, children }: { page: CleDePage; children: (session: Session | null) => React.ReactNode }) {
  const ecran = page === 'mcp' ? 'mcp' : 'api-docs';
  // `undefined` tant que le navigateur n'a pas été lu : la session vit dans localStorage, absent au rendu serveur.
  const [dansLaConsole, setDansLaConsole] = useState<boolean>();
  useEffect(() => {
    const s = getSession();
    setDansLaConsole(s !== null && accesAutorise(ecran, s.role));
  }, [ecran]);
  if (dansLaConsole === undefined) return null;
  if (dansLaConsole) return <AppShell active={ecran}>{(session) => <Colonnes page={page}>{children(session)}</Colonnes>}</AppShell>;
  return <CadrePublic><Colonnes page={page}>{children(null)}</Colonnes></CadrePublic>;
}

function Colonnes({ page, children }: { page: CleDePage; children: React.ReactNode }) {
  const t = useT();
  // Le contenu n'existe qu'après la lecture de la session : le navigateur a donc déjà renoncé à suivre
  // l'ancre de l'adresse quand il paraît. On la suit ici, une fois, au montage.
  useEffect(() => {
    const ancre = window.location.hash.slice(1);
    if (ancre) document.getElementById(decodeURIComponent(ancre))?.scrollIntoView();
  }, []);

  return (
    <div className="lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-12">
      <aside className="hidden lg:block">
        <div className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto pb-6" data-testid="nav-doc">
          <NavDoc page={page} />
        </div>
      </aside>
      {/* Sur mobile, dans le flux : ouverte, elle POUSSE le contenu, elle ne le recouvre pas. */}
      <details className="group mb-6 rounded-xl border border-ink-200 bg-white lg:hidden" data-testid="nav-doc-mobile">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm [&::-webkit-details-marker]:hidden">
          <span className="font-semibold text-ink-900">{t('Documentation', 'Documentation')}</span>
          <span className="min-w-0 truncate text-ink-500">{t(...pageDoc(page).nav)}</span>
          <svg viewBox="0 0 24 24" className="ml-auto h-4 w-4 shrink-0 text-ink-400 transition-transform group-open:rotate-180" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
        </summary>
        <div className="border-t border-ink-100 px-1 py-3">
          <NavDoc page={page} />
        </div>
      </details>
      {/* `doc-api` borne les vérifications de l'e2e au CONTENU : la barre latérale de la console nomme d'autres
          écrans (dont des intégrations), et ne doit pas faire échouer la règle « aucun outil tiers ». */}
      <div className="min-w-0 max-w-3xl space-y-10" data-testid="doc-api">{children}</div>
    </div>
  );
}

function NavDoc({ page }: { page: CleDePage }) {
  const t = useT();
  return (
    <nav aria-label={t('Documentation', 'Documentation')} className="space-y-5">
      {GROUPES_DOC.map((g) => (
        <div key={g.cle}>
          <p className="px-3 text-xs font-semibold text-ink-400">{t(g.titre[0], g.titre[1])}</p>
          <ul className="mt-1.5 space-y-0.5">
            {PAGES_DOC.filter((p) => p.groupe === g.cle).map((p) => {
              const courante = p.cle === page;
              return (
                <li key={p.cle}>
                  <Link
                    href={p.href}
                    aria-current={courante ? 'page' : undefined}
                    className={`block rounded-md px-3 py-1.5 text-sm transition ${
                      courante ? 'bg-brand-50 font-medium text-brand-700' : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900'
                    }`}
                  >
                    {t(p.nav[0], p.nav[1])}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
