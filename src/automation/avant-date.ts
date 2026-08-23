import { parseInstant } from '../workflow/conditions';
import { normaliserDate } from '../crm/date-iso';

/**
 * Déclencheur « X avant la date stockée dans un champ » : la partie PURE.
 *
 * Aucune IO. C'est ici que se décide, pour UN contact, s'il est dû maintenant. Le balayage qui va chercher
 * les contacts vit ailleurs ; le séparer permet de tester les trois cas qui comptent (pas encore, trop tard,
 * déjà tiré) sans base.
 *
 * Décisions de Julien du 2026-08-23 :
 *  - un moment DÉJÀ PASSÉ n'envoie RIEN (un rappel « 48 h avant » qui part 12 h avant dit quelque chose de
 *    faux au client) ;
 *  - si la date CHANGE, le rappel repart sur la nouvelle (un rendez-vous reporté doit redonner un rappel) ;
 *  - le délai se règle par un nombre et une unité.
 */

export type UniteDelai = 'minutes' | 'heures' | 'jours';
export const UNITES_DELAI: readonly UniteDelai[] = ['minutes', 'heures', 'jours'];
export function estUniteDelai(v: unknown): v is UniteDelai {
  return typeof v === 'string' && (UNITES_DELAI as readonly string[]).includes(v);
}

/** 90 jours : au-delà, ce n'est plus un rappel, c'est une erreur de saisie. */
export const DELAI_MAX_MINUTES = 90 * 24 * 60;

export function minutesDuDelai(delai: number, unite: UniteDelai): number {
  if (unite === 'jours') return delai * 24 * 60;
  if (unite === 'heures') return delai * 60;
  return delai;
}

/** Config du déclencheur, telle qu'elle vit dans `trigger_config`. */
export interface ConfigAvantDate {
  /** Clé du champ contact qui porte la date. */
  fieldKey: string;
  delai: number;
  unite: UniteDelai;
}

/**
 * Coerce le jsonb opaque. null = config inexploitable -> l'automation n'attrape RIEN, même doctrine que le
 * mot-clé vide : une automation inerte plutôt qu'une automation qui part n'importe quand.
 *
 * ⚠️ Un délai de 0 est REFUSÉ, pas traité comme « à l'heure pile ». « 0 minute avant » ne veut rien dire pour
 * un rappel, et laisser passer un 0 issu d'un champ vide de formulaire enverrait au moment du rendez-vous.
 */
export function coerceConfigAvantDate(cfg: Record<string, unknown>): ConfigAvantDate | null {
  const fieldKey = typeof cfg.fieldKey === 'string' ? cfg.fieldKey.trim() : '';
  if (fieldKey === '') return null;
  const delai = typeof cfg.delai === 'number' ? cfg.delai : Number.NaN;
  if (!Number.isInteger(delai) || delai <= 0) return null;
  if (!estUniteDelai(cfg.unite)) return null;
  if (minutesDuDelai(delai, cfg.unite) > DELAI_MAX_MINUTES) return null;
  return { fieldKey, delai, unite: cfg.unite };
}

/** Pourquoi un contact n'est pas dû. Sert au journal : un déclencheur muet sans trace est indébogable. */
export type RaisonNonDu = 'deja_tire' | 'pas_encore' | 'trop_tard' | 'date_illisible';

export interface EntreeDu {
  /** Valeur BRUTE du champ, telle qu'elle est stockée. */
  valeur: string;
  offsetMinutes: number;
  now: number;
  /**
   * Fenêtre de rattrapage après le moment prévu. Elle existe pour qu'un redémarrage du worker ne fasse pas
   * perdre les déclenchements de la minute d'avant, PAS pour rattraper un retard réel : au-delà, on
   * n'envoie rien (décision de Julien).
   */
  toleranceMinutes: number;
  /** Fuseau de l'espace : une date sans fuseau est une heure MURALE, elle ne devient un instant qu'ici. */
  timeZone: string;
  /** Valeur pour laquelle ce contact a DÉJÀ été déclenché sur cette automation. null = jamais. */
  dejaTirePour: string | null;
}

export type ResultatDu =
  | { du: true; moment: Date }
  | { du: false; raison: RaisonNonDu };

/**
 * Ce contact doit-il partir MAINTENANT ?
 *
 * 🔴 La comparaison de « déjà tiré » porte sur la VALEUR de la date, pas sur le simple fait d'avoir tiré.
 * C'est ce qui fait qu'un rendez-vous reporté redonne un rappel : la valeur a changé, donc l'occurrence est
 * neuve. Se contenter d'un booléen laisserait le client sans rappel après un report, en silence.
 */
export function estDu(e: EntreeDu): ResultatDu {
  // Comparaison sur la valeur STOCKÉE (déjà canonicalisée à l'écriture), donc deux écritures de la même date
  // sous deux formes différentes ne comptent pas pour deux occurrences.
  if (e.dejaTirePour !== null && e.dejaTirePour === e.valeur) return { du: false, raison: 'deja_tire' };

  // La valeur a pu être écrite avant que la normalisation existe, ou à la main : on ne suppose pas.
  if (!normaliserDate(e.valeur, 'datetime').ok) return { du: false, raison: 'date_illisible' };

  const instant = parseInstant(e.valeur, e.timeZone);
  if (Number.isNaN(instant.getTime())) return { du: false, raison: 'date_illisible' };

  const moment = new Date(instant.getTime() - e.offsetMinutes * 60_000);
  if (e.now < moment.getTime()) return { du: false, raison: 'pas_encore' };
  if (e.now > moment.getTime() + e.toleranceMinutes * 60_000) return { du: false, raison: 'trop_tard' };
  return { du: true, moment };
}
