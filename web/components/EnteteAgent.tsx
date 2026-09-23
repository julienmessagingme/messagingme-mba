'use client';

import type { ReactNode } from 'react';
import { useT } from '@/lib/i18n';

/**
 * L'EN-TÊTE D'UN ÉCRAN D'AGENT : qui est cet agent, ce qui lui manque, ce qu'il a produit.
 *
 * 🔴 PUREMENT PRÉSENTATIONNEL, ET C'EST TOUT L'INTÉRÊT. Il ne lit rien, n'appelle rien, et ne sait ni ce
 * qu'est l'agent de Meta ni ce qu'est un agent IA. Les deux écrans le remplissent depuis des sources
 * différentes (une route de complétion d'un côté, une liste de manques de l'autre) et obtiennent le même
 * dessin. Y mettre un `fetch` ferait deux comportements de chargement à tenir alignés à la main.
 */

export interface EtapeEntete {
  /** Ce qui manque, dans les mots du client. Rendu tel quel. */
  message: string;
  /** L'onglet où ça se corrige. Absent = ça ne se règle pas sur cet écran (le moyen de paiement). */
  onglet?: string;
}

export interface EnteteAgentProps {
  logo: { src: string; alt: string } | null;
  /** Le repli quand `logo` est nul : deux ou trois lettres. */
  pastille: string;
  nom: string;
  /** Sous le nom : le numéro pour l'agent de Meta, le modèle pour un agent IA. */
  precision?: string;
  /** L'état, rendu tel quel : la pastille d'activation d'un agent IA, celle du numéro côté Meta. */
  etat?: ReactNode;
  /**
   * Ce qui reste à faire. Liste VIDE = tout est réglé, et l'en-tête le dit.
   *
   * 🔴 `null` = ON NE SAIT PAS, ET CE N'EST PAS LA MÊME CHOSE QU'UNE LISTE VIDE. La lecture des manques peut
   * n'avoir pas encore abouti, avoir échoué, ou ne pas s'appliquer (l'écran de l'agent de Meta rend son
   * en-tête AVANT de savoir s'il a un numéro). Y passer `[]` dans ces cas afficherait « Tout est réglé » à
   * côté d'un bandeau qui dit « aucun numéro rattaché », c'est-à-dire une affirmation que personne n'a
   * mesurée. Même règle que `messages30j`, et pour la même raison.
   */
  etapes: EtapeEntete[] | null;
  /** Rendu en plus du compte, et SEULEMENT quand il existe un ratio vrai (l'agent de Meta en a un). */
  ratio?: { faites: number; total: number };
  /** `null` = on ne sait pas. On n'affiche alors AUCUN chiffre. Voir le commentaire plus bas. */
  messages30j: number | null;
  onOnglet(cle: string): void;
}

/**
 * 🔴 « n ÉTAPES À FINIR », PAS « n SUR m », ET CE N'EST PAS UN CHOIX DE STYLE.
 *
 * Côté agent IA, le dénominateur n'existe pas : `manquesAvantActivation` (src/agent/setup/lint.ts) applique
 * cinq contrôles inconditionnels et UN SIXIÈME conditionnel (« la base est remplie mais l'outil de recherche
 * est inactif », qui ne s'applique que s'il y a à la fois des fiches et des outils actifs). Le nombre de
 * contrôles qui s'appliquent varie donc d'un agent à l'autre, et la route ne rend que ce qui MANQUE. Figer
 * 5 ou 6 dans l'écran afficherait un dénominateur faux la moitié du temps.
 *
 * L'agent de Meta, lui, a un ratio VRAI (`faites` et `total` calculés au serveur) : il le montre EN PLUS.
 * L'asymétrie est dans la donnée, pas dans le dessin.
 */
export function libelleEtapes(n: number, t: (fr: string, en: string) => string): string {
  if (n === 0) return t('Tout est réglé', 'All set');
  if (n === 1) return t('1 étape à finir', '1 step left');
  return t(`${n} étapes à finir`, `${n} steps left`);
}

export function EnteteAgent({
  logo, pastille, nom, precision, etat, etapes, ratio, messages30j, onOnglet,
}: EnteteAgentProps) {
  const t = useT();
  return (
    <header
      data-testid="entete-agent"
      className="flex flex-col gap-4 rounded-2xl border border-ink-200 bg-white p-4 shadow-sm sm:flex-row sm:items-start sm:gap-5"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- next/image mettrait en cache une URL signée
          qui expire (même contrainte que la photo de profil de l'Accueil), et nos SVG sont servis par nous. */}
      {logo !== null ? (
        <img src={logo.src} alt={logo.alt} data-testid="entete-agent-logo"
          className="h-10 w-10 shrink-0 text-ink-800" />
      ) : (
        <span data-testid="entete-agent-pastille"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-ink-100 text-xs font-semibold text-ink-600">
          {pastille}
        </span>
      )}

      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="truncate text-xl font-semibold tracking-tight text-ink-900">{nom}</h2>
          {etat}
        </div>
        {precision !== undefined && precision !== '' && (
          <p data-testid="entete-agent-precision" className="truncate text-sm text-ink-600">{precision}</p>
        )}

        {etapes !== null && (
          <p data-testid="entete-agent-etapes" className="pt-1 text-sm font-medium text-ink-800">
            {libelleEtapes(etapes.length, t)}
            {ratio !== undefined && (
              <span data-testid="entete-agent-ratio" className="ml-2 font-normal text-ink-500">
                {t(`${ratio.faites} sur ${ratio.total} réglages obligatoires`,
                   `${ratio.faites} of ${ratio.total} required settings`)}
              </span>
            )}
          </p>
        )}

        {etapes !== null && etapes.length > 0 && (
          <ul className="space-y-1 pt-1">
            {etapes.map((e) => (
              <li key={e.message} className="text-sm text-ink-600">
                {/* ⚠️ UNE ÉTAPE SANS ONGLET RESTE AFFICHÉE, en texte simple. C'est le cas du moyen de
                    paiement, qui ne se règle pas dans la console : la masquer ferait disparaître une
                    condition réelle de l'écran qui prétend les lister toutes. */}
                {e.onglet === undefined ? (
                  <span>{e.message}</span>
                ) : (
                  <button
                    type="button"
                    data-testid={`entete-etape-${e.onglet}`}
                    onClick={() => onOnglet(e.onglet as string)}
                    className="text-left underline decoration-dotted hover:decoration-solid"
                  >
                    {e.message}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 🔴 AUCUN CHIFFRE QUAND ON NE SAIT PAS. `null` couvre trois cas réels : la lecture n'a pas encore
          abouti, la route n'est pas encore déployée (Vercel publie l'écran au push, l'API attend son
          déploiement), et le compte n'est pas administrateur (les deux modules sont montés en `g.admin`,
          donc un manager reçoit 403). Un « 0 » se lirait « cet agent n'a parlé à personne ». */}
      {/* 🔴 LE CHIFFRE COMPTE TOUT LE FIL, Y COMPRIS CE QUE L'ÉQUIPE A ÉCRIT APRÈS AVOIR REPRIS LA MAIN, et
          l'écran le DIT (décision du 2026-09-23, à la relecture du lot serveur). La légende courte d'avant,
          « messages échangés sur 30 jours », laissait lire ce nombre comme une mesure du travail de l'agent :
          un client aurait comparé deux agents sur un chiffre qui mesure le VOLUME de la conversation. Le
          « y compris » est le mot qui porte l'aveu, il ne s'abrège pas. */}
      {messages30j !== null && (
        <div data-testid="entete-agent-messages" className="shrink-0 sm:max-w-[15rem] sm:text-right">
          <p className="text-2xl font-semibold tabular-nums text-ink-900">{messages30j.toLocaleString('fr-FR')}</p>
          <p className="text-xs font-medium text-ink-700">
            {t('Messages échangés dans les conversations que cet agent a tenues',
               'Messages exchanged in the conversations this agent handled')}
          </p>
          <p className="pt-0.5 text-xs text-ink-500">
            {t('Tous les messages de ces conversations sur 30 jours, y compris ceux écrits par votre équipe après une reprise.',
               'All messages in those conversations over 30 days, including those written by your team after a takeover.')}
          </p>
        </div>
      )}
    </header>
  );
}
