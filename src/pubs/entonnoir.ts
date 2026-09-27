/**
 * L'entonnoir d'une publicité, module pur. Un client y décide d'arrêter une campagne ou d'y remettre du
 * budget : un coût par prospect faux, ou affiché `0` alors qu'il est inconnu, fait prendre la mauvaise
 * décision sur de l'argent réel. 🔴 « Non disponible » n'est pas « zéro » : `null` traverse tout le module,
 * et l'écran écrit « non disponible ».
 */

import type { IssueRoutage } from './routage';

/** Ce que la base a compté pour une campagne. Tous les nombres sont bruts, aucun n'est déjà dérivé. */
export interface ComptesPub {
  /** La dépense chez Meta, dans la devise du compte. `null` = jamais lue. */
  depense: number | null;
  /** Les clics sur le lien vers WhatsApp, tels que Meta les compte. `null` = jamais lus. */
  clics: number | null;
  /** Contacts distincts arrivés par cette campagne. Pas des arrivées : un contact qui reclique reste un. */
  leads: number;
  /** Contacts distincts dont une arrivée porte `qualifie_le`. */
  qualifies: number;
  /**
   * Les leads non pris en charge (reprise refusée, désabonnés, bloqués, publicité sans scénario branché). Ni
   * retirés des `leads` ni noyés dedans : des clics payés sans conversation, affichés à côté.
   */
  nonPrisEnCharge: number;
}

/** Une étape de l'entonnoir, telle que l'écran l'affiche. */
export interface EtapeEntonnoir {
  /** Le nombre atteint à cette étape. `null` = on ne l'a pas encore lu chez Meta. */
  nombre: number | null;
  /** Ce que coûte une unité de cette étape. `null` = indéterminé (pas de dépense connue, ou zéro unité). */
  cout: number | null;
  /** La part de l'étape précédente qui arrive ici, entre 0 et 1. `null` = indéterminé. */
  passage: number | null;
}

export interface Entonnoir {
  depense: number | null;
  clics: EtapeEntonnoir;
  leads: EtapeEntonnoir;
  qualifies: EtapeEntonnoir;
  nonPrisEnCharge: number;
}

/**
 * Une division qui peut ne pas avoir de réponse. Trois cas rendent `null` : dénominateur nul, numérateur
 * inconnu (Meta pas encore lu), et résultat non fini, pour qu'aucun `Infinity €` n'atteigne un écran.
 */
export function diviserOuRien(numerateur: number | null, denominateur: number | null): number | null {
  if (numerateur === null || denominateur === null) return null;
  if (denominateur === 0) return null;
  const r = numerateur / denominateur;
  return Number.isFinite(r) ? r : null;
}

/**
 * L'entonnoir complet : dépense, clics, prospects, qualifiés, avec le coût de chaque étape et le taux de
 * passage vers la suivante. Le premier taux dit la part des clics payés qui n'écrivent jamais, la perte la
 * plus silencieuse du produit.
 */
export function entonnoir(c: ComptesPub): Entonnoir {
  return {
    depense: c.depense,
    clics: {
      nombre: c.clics,
      cout: diviserOuRien(c.depense, c.clics),
      // Rien ne précède les clics : le taux de passage n'a pas de sens ici, et `null` le dit.
      passage: null,
    },
    leads: {
      nombre: c.leads,
      cout: diviserOuRien(c.depense, c.leads),
      passage: diviserOuRien(c.leads, c.clics),
    },
    qualifies: {
      nombre: c.qualifies,
      cout: diviserOuRien(c.depense, c.qualifies),
      passage: diviserOuRien(c.qualifies, c.leads),
    },
    nonPrisEnCharge: c.nonPrisEnCharge,
  };
}

/**
 * Les issues qui comptent comme « non pris en charge ». Pas `agent_meta` : un lead confié à l'agent de Meta
 * est servi, le compter perdu afficherait « 100 % perdus » sur une pub qui marche. Pas `inchange` (leads
 * hors de cette campagne). `sans_scenario` en fait partie : une pub promet un scénario absent ou non publié,
 * un défaut de configuration qu'il faut voir.
 */
// Le `satisfies` fait refuser une faute de frappe par le compilateur ; l'accord avec le CHECK de la base est
// tenu par `tests/pubs-entonnoir.test.ts`. Il reste sur la même ligne que `as const` : un retour à la ligne
// avant lui ferme l'expression.
export const ISSUES_NON_PRISES_EN_CHARGE = ['reprise_refusee', 'desabonne', 'bloque', 'sans_scenario'] as const satisfies readonly IssueRoutage[];
