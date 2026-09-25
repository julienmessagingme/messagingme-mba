'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useT } from '@/lib/i18n';
import { BASE } from '@/lib/http';
import type { NomDeCode } from '@/lib/api-exemples';
import { pageDoc, type AncreDe, type CleDePage } from '@/lib/doc-api-pages';

/**
 * LES BRIQUES DES PAGES DE LA DOCUMENTATION (refonte du 2026-09-25) : seulement ce que plusieurs pages répètent.
 *
 * 🔴 LES EXEMPLES NE S'ÉCRIVENT PAS DANS LES PAGES. Chaque corps et chaque réponse vient de `@/lib/api-exemples`,
 * que `tests/api-exemples.test.ts` passe aux règles de SA route ; le même test refuse un objet JSON écrit en dur
 * dans un fichier de la doc (`FICHIERS_DOC`, `@/lib/doc-api-pages`).
 *
 * 🔴 AUCUN OUTIL TIERS NOMMÉ (décision de Julien du 2026-09-24) : la doc sert à tous les intégrateurs. La suite
 * racine le vérifie sur chaque fichier de la doc, `web/e2e/developers-api.spec.ts` sur chaque page rendue.
 */

/**
 * L'adresse PUBLIQUE de l'API, telle qu'un intégrateur doit la taper.
 *
 * ⚠️ Dérivée de la MÊME source que les appels de la console (`BASE`), jamais réécrite à la main : une adresse en
 * dur, recopiée par un intégrateur après une bascule d'hébergement, l'aurait mené sur un chemin mort qu'il aurait
 * découvert en production, chez lui. `web/lib/api-base.test.ts` exige qu'elle soit définie ici, une seule fois.
 *
 * Le repli conserve l'adresse historique tant que la variable n'est pas posée : le préfixe `/api/backend` est
 * alors juste, puisque c'est bien le proxy qui sert l'API.
 */
export const ADRESSE_API = BASE.startsWith('http') ? BASE : 'https://mba.messagingme.app/api/backend';
export const CLE_EXEMPLE = 'mba_xxxxxxxxxxxxxxxx';

/** Un exemple du module, indenté pour être lu. */
export const json = (v: unknown): string => JSON.stringify(v, null, 2);

/**
 * Une commande prête à copier. Le corps part entre apostrophes droites : la suite refuse donc toute apostrophe
 * droite dans un exemple, qui fermerait la chaîne du shell au milieu du JSON.
 */
export function curl(chemin: string, corps: unknown): string {
  return [
    `curl -X POST ${ADRESSE_API}${chemin} \\`,
    `  -H "Authorization: Bearer ${CLE_EXEMPLE}" \\`,
    '  -H "Content-Type: application/json" \\',
    `  -d '${JSON.stringify(corps)}'`,
  ].join('\n');
}

const inlineCls = 'rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[0.85em] text-ink-800 [overflow-wrap:anywhere]';
const lienCls = 'font-medium text-brand-600 underline decoration-brand-200 underline-offset-2 hover:text-brand-700 hover:decoration-brand-500';

/** Le titre de la page, son seul `h1`, tiré de la carte de la doc ; `children` est la phrase d'introduction. */
export function EnTetePage({ page, children }: { page: CleDePage; children?: React.ReactNode }) {
  const t = useT();
  return (
    <header className="space-y-3">
      <h1 className="text-3xl font-semibold tracking-tight text-ink-900">{t(...pageDoc(page).titre)}</h1>
      {children && <div className="space-y-2 text-base leading-relaxed text-ink-600">{children}</div>}
    </header>
  );
}

/** Une section de concept : un `h2` et son ancre. `scroll-mt` laisse passer l'entête collante de la console. */
export function Section({ id, titre, children }: { id?: string; titre: React.ReactNode; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 space-y-4 border-t border-ink-200 pt-8">
      <h2 className="text-xl font-semibold tracking-tight text-ink-900">{titre}</h2>
      <div className="space-y-4 text-[15px] leading-relaxed text-ink-700">{children}</div>
    </section>
  );
}

type Methode = 'GET' | 'POST' | 'PATCH';
const COULEUR_METHODE: Record<Methode, string> = {
  GET: 'bg-mint-50 text-mint-700 ring-mint-200',
  POST: 'bg-brand-50 text-brand-700 ring-brand-200',
  PATCH: 'bg-amber-50 text-amber-800 ring-amber-200',
};

/**
 * Une route : son `h2` porte la méthode (en badge) et le chemin, repérables d'un coup d'œil ; le droit exigé
 * suit juste en dessous.
 */
export function Route({ id, methode, chemin, droit, children }: {
  id: string; methode: Methode; chemin: string; droit: string; children: React.ReactNode;
}) {
  const t = useT();
  return (
    <section id={id} className="scroll-mt-20 space-y-4 border-t border-ink-200 pt-8">
      <div className="space-y-1.5">
        <h2 className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-lg font-semibold text-ink-900">
          {/* L'espace entre les deux compte : sans lui, le nom lu par un lecteur d'écran serait « POST/v1/… ». */}
          <span className={`rounded-md px-2 py-0.5 text-sm ring-1 ring-inset ${COULEUR_METHODE[methode]}`}>{methode}</span>{' '}
          <span className="min-w-0 [overflow-wrap:anywhere]">{chemin}</span>
        </h2>
        <p className="text-sm text-ink-500">
          {t('Droit :', 'Scope:')} <C>{droit}</C>
        </p>
      </div>
      <div className="space-y-4 text-[15px] leading-relaxed text-ink-700">{children}</div>
    </section>
  );
}

/** Le `h3` d'une route ou d'un concept : Requête, Réponse, Erreurs, Notes. */
export function Sous({ id, children }: { id?: string; children: React.ReactNode }) {
  return <h3 id={id} className="scroll-mt-20 pt-2 text-base font-semibold text-ink-900">{children}</h3>;
}

/** Une subdivision d'un `h3`, quand une requête a plusieurs volets (la cible, les destinataires…). */
export function SousSous({ id, children }: { id?: string; children: React.ReactNode }) {
  return <h4 id={id} className="scroll-mt-20 pt-1 text-[15px] font-semibold text-ink-800">{children}</h4>;
}

export function C({ children }: { children: React.ReactNode }) {
  return <code className={inlineCls}>{children}</code>;
}

/** Un code d'erreur cité dans le texte : typé sur la table des codes, donc un code inventé ne compile pas. */
export function Code({ c, testid }: { c: NomDeCode; testid?: string }) {
  return <code className={inlineCls} data-testid={testid}>{c}</code>;
}

/** Un lien vers une page de la doc, ou vers une de ses ancres DÉCLARÉES (`@/lib/doc-api-pages`). */
export function LienDoc<P extends CleDePage>({ page, ancre, children }: { page: P; ancre?: AncreDe<P>; children: React.ReactNode }) {
  const { href } = pageDoc(page);
  return <Link href={ancre ? `${href}#${ancre}` : href} className={lienCls}>{children}</Link>;
}

export function Liste({ children }: { children: React.ReactNode }) {
  return <ul className="list-disc space-y-2 pl-5 marker:text-ink-300">{children}</ul>;
}

/** Copier dans le presse-papier. Échec silencieux : sans permission, le texte reste sélectionnable à la main. */
export function BoutonCopier({ texte, sombre = false }: { texte: string; sombre?: boolean }) {
  const t = useT();
  const [copie, setCopie] = useState(false);
  return (
    <button
      type="button"
      data-testid="copier"
      onClick={() => {
        void navigator.clipboard?.writeText(texte).then(() => { setCopie(true); setTimeout(() => setCopie(false), 2000); }).catch(() => {});
      }}
      className={`shrink-0 rounded-md px-2 py-1 text-xs font-semibold transition ${
        sombre ? 'text-ink-200 hover:bg-white/10 hover:text-white' : 'border border-ink-200 bg-white text-ink-600 hover:bg-ink-50'
      }`}
    >
      {copie ? t('Copié', 'Copied') : t('Copier', 'Copy')}
    </button>
  );
}

/**
 * Un bloc de code, toujours copiable. `legende` nomme ce qu'il montre (« Corps », « Commande »…). Seul le bloc
 * défile en largeur, jamais la page.
 */
export function Bloc({ children, legende }: { children: string; legende?: string }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg bg-ink-900">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 py-1 pl-4 pr-1.5">
        <span className="text-xs font-medium text-ink-300">{legende ?? ''}</span>
        <BoutonCopier texte={children} sombre />
      </div>
      <pre className="overflow-x-auto px-4 py-3 font-mono text-xs leading-relaxed text-ink-50">{children}</pre>
    </div>
  );
}

type SorteEncadre = 'note' | 'attention' | 'obligatoire';
const STYLE_ENCADRE: Record<SorteEncadre, { boite: string; titre: string; libelle: readonly [string, string] }> = {
  note: { boite: 'border-brand-300 bg-brand-50/60', titre: 'text-brand-700', libelle: ['Note', 'Note'] },
  attention: { boite: 'border-amber-400 bg-amber-50', titre: 'text-amber-800', libelle: ['Attention', 'Caution'] },
  obligatoire: { boite: 'border-coral bg-coral/5', titre: 'text-coral', libelle: ['Obligatoire', 'Required'] },
};

/**
 * Trois sortes d'encadré, pas une de plus : c'est lui qui porte l'importance d'une phrase, à la place des
 * majuscules d'emphase de l'ancienne page.
 */
export function Encadre({ sorte, children }: { sorte: SorteEncadre; children: React.ReactNode }) {
  const t = useT();
  const s = STYLE_ENCADRE[sorte];
  return (
    <div className={`rounded-r-lg border-l-4 px-4 py-3 text-[15px] leading-relaxed text-ink-800 ${s.boite}`} data-encadre={sorte}>
      <p className={`mb-1 text-sm font-semibold ${s.titre}`}>{t(s.libelle[0], s.libelle[1])}</p>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

/** Un tableau : seul lui défile en largeur sur un petit écran. */
export function Tableau({ entetes, lignes }: { entetes: string[]; lignes: Array<{ cle: string; cellules: React.ReactNode[] }> }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-ink-200">
      <table className="w-full text-left text-sm">
        <thead className="bg-ink-50">
          <tr className="border-b border-ink-200">
            {entetes.map((e, i) => <th key={`${i}-${e}`} className="px-3 py-2 text-xs font-semibold text-ink-600">{e}</th>)}
          </tr>
        </thead>
        <tbody>
          {lignes.map((l) => (
            <tr key={l.cle} className="border-b border-ink-100 last:border-0">
              {l.cellules.map((c, i) => <td key={i} className="px-3 py-2 align-top text-ink-700">{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
