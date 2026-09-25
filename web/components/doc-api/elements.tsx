'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useT } from '@/lib/i18n';
import { BASE } from '@/lib/http';
import { statutDe, type NomDeCode } from '@/lib/api-exemples';
import type { ChampDoc, TableDeChamps } from '@/lib/api-champs';
import { hrefDe, pageDoc, type AncreDe, type CleDePage, type LienVers } from '@/lib/doc-api-pages';
import { ENDPOINTS, GROUPES_ENDPOINTS, endpoint, type CleEndpoint, type EndpointDoc, type Methode } from '@/lib/api-doc-endpoints';

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
 * Une commande prête à copier, corps indenté pour être lu. Le corps part entre apostrophes droites : la suite
 * refuse donc toute apostrophe droite dans un exemple, qui fermerait la chaîne du shell au milieu du JSON.
 */
export function curl(chemin: string, corps: unknown, methode: 'POST' | 'PATCH' = 'POST'): string {
  return [
    `curl -X ${methode} ${ADRESSE_API}${chemin} \\`,
    `  -H "Authorization: Bearer ${CLE_EXEMPLE}" \\`,
    '  -H "Content-Type: application/json" \\',
    `  -d '${json(corps)}'`,
  ].join('\n');
}

/** Une lecture prête à copier : pas de corps. */
export function curlGet(chemin: string): string {
  return [`curl ${ADRESSE_API}${chemin} \\`, `  -H "Authorization: Bearer ${CLE_EXEMPLE}"`].join('\n');
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

const COULEUR_METHODE: Record<Methode, string> = {
  GET: 'bg-mint-50 text-mint-700 ring-mint-200',
  POST: 'bg-brand-50 text-brand-700 ring-brand-200',
  PATCH: 'bg-amber-50 text-amber-800 ring-amber-200',
};

export function BadgeMethode({ methode, petit = false }: { methode: Methode; petit?: boolean }) {
  return (
    <span className={`inline-block rounded-md font-mono font-semibold ring-1 ring-inset ${petit ? 'px-1.5 py-px text-[11px]' : 'px-2 py-0.5 text-sm'} ${COULEUR_METHODE[methode]}`}>
      {methode}
    </span>
  );
}

/**
 * Une route, toujours dans le même ordre : son `h2` (la méthode en badge, puis le chemin), sa phrase, son droit,
 * puis ses sous-parties (Requête, Réponse, Erreurs, Notes). Méthode, chemin, phrase, droit et ancre viennent de
 * l'index des endpoints (`@/lib/api-doc-endpoints`) : la page ne les réécrit pas.
 */
export function Route({ ep, children }: { ep: CleEndpoint; children: React.ReactNode }) {
  const t = useT();
  const e = endpoint(ep);
  return (
    <section id={e.lien.ancre} className="scroll-mt-20 space-y-4 border-t border-ink-200 pt-8">
      <div className="space-y-1.5">
        <h2 className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-lg font-semibold text-ink-900">
          {/* L'espace entre les deux compte : sans lui, le nom lu par un lecteur d'écran serait « POST/v1/… ». */}
          <BadgeMethode methode={e.methode} />{' '}
          <span className="min-w-0 [overflow-wrap:anywhere]">{e.chemin}</span>
        </h2>
        <p className="text-[15px] leading-relaxed text-ink-700">{t(e.resume[0], e.resume[1])}</p>
        <p className="text-sm text-ink-500">
          {t('Droit :', 'Scope:')} <C>{e.droit}</C>
        </p>
      </div>
      <div className="space-y-4 text-[15px] leading-relaxed text-ink-700">{children}</div>
    </section>
  );
}

/** Une ligne de l'index : badge, chemin (le lien), phrase, droit (masqué sur mobile). */
function LignesEndpoints({ endpoints, droit }: { endpoints: readonly EndpointDoc[]; droit: boolean }) {
  const t = useT();
  return (
    <div className="overflow-hidden rounded-lg border border-ink-200">
      <table className="w-full text-left text-sm">
        <tbody>
          {endpoints.map((e) => (
            <tr key={`${e.methode} ${e.chemin}`} className="border-b border-ink-100 align-top last:border-0">
              <td className="w-16 py-2 pl-3 pr-1"><BadgeMethode methode={e.methode} petit /></td>
              <td className="px-2 py-2">
                <Link href={hrefDe(e.lien)} className={`font-mono text-[13px] [overflow-wrap:anywhere] ${lienCls}`}>{e.chemin}</Link>
                <span className="mt-0.5 block text-ink-600">{t(e.resume[0], e.resume[1])}</span>
              </td>
              {droit && <td className="hidden w-40 whitespace-nowrap px-3 py-2 sm:table-cell"><C>{e.droit}</C></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** « Tous les endpoints » : l'index complet, par groupe (accueil). */
export function IndexEndpoints() {
  const t = useT();
  return (
    <div className="space-y-5" data-testid="index-endpoints">
      {GROUPES_ENDPOINTS.map((g) => (
        <div key={g.cle} className="space-y-2">
          <h3 className="text-base font-semibold text-ink-900">{t(g.titre[0], g.titre[1])}</h3>
          <LignesEndpoints endpoints={ENDPOINTS.filter((e) => e.groupe === g.cle)} droit />
        </div>
      ))}
    </div>
  );
}

/** « Sur cette page » : les endpoints d'une page de ressource, liens vers leurs ancres, depuis l'index. */
export function SurCettePage({ page }: { page: CleDePage }) {
  const t = useT();
  const ici = ENDPOINTS.filter((e) => e.lien.page === page);
  return (
    <nav aria-label={t('Sur cette page', 'On this page')} className="space-y-2" data-testid="sur-cette-page">
      <p className="text-xs font-semibold text-ink-500">{t('Sur cette page', 'On this page')}</p>
      <LignesEndpoints endpoints={ici} droit={false} />
    </nav>
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

/** Un refus cité dans le texte : son statut, LU dans la table des codes (`statutDe`), puis son code. */
export function Refus({ c }: { c: NomDeCode }) {
  return <span className="whitespace-nowrap">{statutDe(c)} <Code c={c} /></span>;
}

/** Un lien vers une page de la doc, ou vers une de ses ancres DÉCLARÉES (`@/lib/doc-api-pages`). */
export function LienDoc<P extends CleDePage>({ page, ancre, children }: { page: P; ancre?: AncreDe<P>; children: React.ReactNode }) {
  // Le type générique ne se réduit pas à l'union `LienVers` : la paire (page, ancre) est pourtant exactement l'une de ses branches.
  return <Link href={hrefDe({ page, ancre } as LienVers)} className={lienCls}>{children}</Link>;
}

export function Liste({ children }: { children: React.ReactNode }) {
  return <ul className="list-disc space-y-2 pl-5 marker:text-ink-300">{children}</ul>;
}

/**
 * Copier dans le presse-papier. Échec silencieux : sans permission, le texte reste sélectionnable à la main.
 * `quoi` nomme le bloc pour un lecteur d'écran (« Copier : Commande »), et la confirmation passe par une région
 * vivante : le libellé visible, seul, changerait sans que personne ne l'entende.
 */
export function BoutonCopier({ texte, quoi, sombre = false, testid = 'copier' }: {
  texte: string; quoi?: string; sombre?: boolean; testid?: string;
}) {
  const t = useT();
  const [copie, setCopie] = useState(false);
  return (
    <>
    <span className="sr-only" aria-live="polite">{copie ? t('Copié', 'Copied') : ''}</span>
    <button
      type="button"
      data-testid={testid}
      aria-label={quoi ? `${t('Copier', 'Copy')} : ${quoi}` : undefined}
      onClick={() => {
        void navigator.clipboard?.writeText(texte).then(() => { setCopie(true); setTimeout(() => setCopie(false), 2000); }).catch(() => {});
      }}
      className={`shrink-0 rounded-md px-2 py-1 text-xs font-semibold transition ${
        sombre ? 'text-ink-200 hover:bg-white/10 hover:text-white' : 'border border-ink-200 bg-white text-ink-600 hover:bg-ink-50'
      }`}
    >
      {copie ? t('Copié', 'Copied') : t('Copier', 'Copy')}
    </button>
    </>
  );
}

/**
 * Un bloc de code, toujours copiable. `legende` nomme ce qu'il montre (« Commande », « Réponse »…), à l'écran et
 * pour le bouton Copier : elle est donc obligatoire. Seul le bloc défile en largeur, jamais la page.
 */
export function Bloc({ children, legende, testid, testidCopier }: {
  children: string; legende: string; testid?: string; testidCopier?: string;
}) {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg bg-ink-900">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 py-1 pl-4 pr-1.5">
        <span className="text-xs font-medium text-ink-300">{legende}</span>
        <BoutonCopier texte={children} quoi={legende} sombre {...(testidCopier ? { testid: testidCopier } : {})} />
      </div>
      <pre className="overflow-x-auto px-4 py-3 font-mono text-xs leading-relaxed text-ink-50" data-testid={testid}>{children}</pre>
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

/**
 * Le tableau des champs d'un corps (`@/lib/api-champs`, tenu égal au schéma du serveur par la suite racine) : le
 * nom et son type, l'obligation, ce qu'il fait. Suit une ligne sur les clés inconnues, et les clés refusées.
 */
export function Champs({ table }: { table: TableDeChamps }) {
  const t = useT();
  const obligation = (o: ChampDoc['obligatoire']): string => (o === 'oui' ? t('Oui', 'Yes') : o === 'non' ? t('Non', 'No') : t(o[0], o[1]));
  // Sur mobile, l'obligation passe sous le nom du champ : la description garde la largeur.
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-lg border border-ink-200">
        <table className="w-full text-left text-sm">
          <thead className="bg-ink-50">
            <tr className="border-b border-ink-200">
              <th className="px-3 py-2 text-xs font-semibold text-ink-600">{t('Champ', 'Field')}</th>
              <th className="hidden px-3 py-2 text-xs font-semibold text-ink-600 sm:table-cell">{t('Obligatoire', 'Required')}</th>
              <th className="px-3 py-2 text-xs font-semibold text-ink-600">{t('Description', 'Description')}</th>
            </tr>
          </thead>
          <tbody>
            {table.champs.map((c) => (
              <tr key={c.nom} className="border-b border-ink-100 align-top last:border-0">
                <td className="px-3 py-2 text-ink-700">
                  <span className="whitespace-nowrap"><C>{c.nom}</C></span>
                  <span className="mt-1 block font-mono text-xs text-ink-500">{c.type}</span>
                  <span className="mt-0.5 block text-xs text-ink-500 sm:hidden">
                    {c.obligatoire === 'oui' ? t('Obligatoire', 'Required') : c.obligatoire === 'non' ? t('Optionnel', 'Optional') : t(c.obligatoire[0], c.obligatoire[1])}
                  </span>
                </td>
                <td className="hidden px-3 py-2 text-ink-700 sm:table-cell">{obligation(c.obligatoire)}</td>
                <td className="px-3 py-2 text-ink-700">
                  {t(c.quoi[0], c.quoi[1])}
                  {c.valeurs && <> {t('Valeurs :', 'Values:')} {c.valeurs.map((v, i) => <span key={v}>{i > 0 ? ', ' : ''}<C>{v}</C></span>)}.</>}
                  {c.voir && <> <Link href={hrefDe(c.voir.lien)} className={lienCls}>{t(c.voir.libelle[0], c.voir.libelle[1])}</Link></>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-sm text-ink-500">
        {table.inconnues === 'ignorees'
          ? t('Une clé inconnue est ignorée.', 'An unknown key is ignored.')
          : <>{t('Une clé inconnue est refusée :', 'An unknown key is refused:')} <Refus c="invalid_body" />.</>}
        {table.refusees && (
          <>
            {' '}{t('Refusées :', 'Refused:')} {table.refusees.noms.map((n, i) => <span key={n}>{i > 0 ? ', ' : ''}<C>{n}</C></span>)}
            {' '}({t(table.refusees.pourquoi[0], table.refusees.pourquoi[1])}).
          </>
        )}
      </p>
    </div>
  );
}

/**
 * Les erreurs PROPRES à une route : statut, code, cause. Le statut est lu dans la table des codes (`statutDe`),
 * jamais écrit à côté. `clesDeFiche` ajoute la ligne commune aux routes qui désignent une fiche, qui renvoie à
 * la règle au lieu de la répéter. Le catalogue complet vit dans la Référence.
 */
export function Erreurs({ lignes, clesDeFiche = false }: {
  lignes: ReadonlyArray<readonly [NomDeCode, React.ReactNode]>; clesDeFiche?: boolean;
}) {
  const t = useT();
  const cles: NomDeCode[] = ['invalid_recipient', 'invalid_phone', 'identity_conflict'];
  return (
    <Tableau
      entetes={[t('Statut', 'Status'), t('Code', 'Code'), t('Cause', 'Cause')]}
      lignes={[
        ...lignes.map(([code, cause]) => ({ cle: code, cellules: [String(statutDe(code) ?? ''), <Code key="c" c={code} />, cause] })),
        ...(clesDeFiche ? [{
          cle: 'cles',
          cellules: [
            [...new Set(cles.map((c) => statutDe(c)))].join(', '),
            <span key="c" className="flex flex-col items-start gap-1">{cles.map((c) => <Code key={c} c={c} />)}</span>,
            <span key="q">
              {t('Clés de fiche absentes, illisibles ou contradictoires :', 'Record keys missing, unreadable or contradictory:')}{' '}
              <LienDoc page="concepts" ancre="identification">{t('Désigner une personne', 'Identifying a person')}</LienDoc>
            </span>,
          ],
        }] : []),
      ]}
    />
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
