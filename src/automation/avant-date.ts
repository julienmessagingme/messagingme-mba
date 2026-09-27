import { parseInstant } from '../workflow/conditions';
import { normaliserDate } from '../crm/date-iso';

/**
 * Déclencheur « X avant (ou après) la date stockée dans un champ » : la partie pure, qui décide pour un
 * contact s'il est dû maintenant (pas encore, trop tard, déjà tiré se testent sans base).
 *
 * Un moment déjà passé n'envoie rien (un rappel « 48 h avant » qui part 12 h avant dit quelque chose de
 * faux) ; si la date change, le rappel repart sur la nouvelle.
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

/**
 * De quel côté de la date le déclenchement tombe. `avant` est le défaut : les automations sans ce champ dans
 * leur `trigger_config` doivent continuer à faire ce qu'elles faisaient. La clé reste `avant_date` en base :
 * la renommer obligerait à réécrire toutes les lignes et leurs lecteurs.
 */
export type SensDate = 'avant' | 'apres';
export function estSensDate(v: unknown): v is SensDate {
  return v === 'avant' || v === 'apres';
}

/** Config du déclencheur, telle qu'elle vit dans `trigger_config`. */
export interface ConfigAvantDate {
  /** Clé du champ contact qui porte la date. */
  fieldKey: string;
  delai: number;
  unite: UniteDelai;
  /** Absent des configs anciennes : elles valent `avant`. */
  sens: SensDate;
}

/**
 * Coerce le jsonb opaque. null = config inexploitable : l'automation n'attrape rien plutôt que de partir
 * n'importe quand. Un délai de 0 est refusé : issu d'un champ vide, il enverrait au moment du rendez-vous.
 */
export function coerceConfigAvantDate(cfg: Record<string, unknown>): ConfigAvantDate | null {
  const fieldKey = typeof cfg.fieldKey === 'string' ? cfg.fieldKey.trim() : '';
  if (fieldKey === '') return null;
  const delai = typeof cfg.delai === 'number' ? cfg.delai : Number.NaN;
  if (!Number.isInteger(delai) || delai <= 0) return null;
  if (!estUniteDelai(cfg.unite)) return null;
  if (minutesDuDelai(delai, cfg.unite) > DELAI_MAX_MINUTES) return null;
  // Un sens aberrant retombe sur `avant` au lieu de rendre la config inexploitable, ce qui ferait taire une
  // automation qui marchait.
  return { fieldKey, delai, unite: cfg.unite, sens: estSensDate(cfg.sens) ? cfg.sens : 'avant' };
}

/** Pourquoi un contact n'est pas dû. Sert au journal : un déclencheur muet sans trace est indébogable. */
export type RaisonNonDu = 'deja_tire' | 'pas_encore' | 'trop_tard' | 'date_illisible';

export interface EntreeDu {
  /** Valeur brute du champ, telle qu'elle est stockée. */
  valeur: string;
  offsetMinutes: number;
  /** `avant` (défaut historique) recule le moment, `apres` l'avance. */
  sens?: SensDate;
  now: number;
  /** Fenêtre de rattrapage après le moment prévu : pour un redémarrage du worker, pas pour un retard réel. */
  toleranceMinutes: number;
  /** Fuseau de l'espace : une date sans fuseau est une heure murale, elle ne devient un instant qu'ici. */
  timeZone: string;
  /** Valeur pour laquelle ce contact a déjà été déclenché sur cette automation. null = jamais. */
  dejaTirePour: string | null;
}

export type ResultatDu =
  | { du: true; moment: Date }
  | { du: false; raison: RaisonNonDu };

/**
 * Ce contact doit-il partir maintenant ? « Déjà tiré » compare la valeur de la date, pas un booléen : c'est
 * ce qui fait qu'un rendez-vous reporté redonne un rappel.
 */
export function estDu(e: EntreeDu): ResultatDu {
  // Comparaison sur la valeur stockée (canonicalisée à l'écriture) : deux formes de la même date ne font pas
  // deux occurrences.
  if (e.dejaTirePour !== null && e.dejaTirePour === e.valeur) return { du: false, raison: 'deja_tire' };

  // La valeur a pu être écrite avant que la normalisation existe, ou à la main : on ne suppose pas.
  if (!normaliserDate(e.valeur, 'datetime').ok) return { du: false, raison: 'date_illisible' };

  const instant = parseInstant(e.valeur, e.timeZone);
  if (Number.isNaN(instant.getTime())) return { du: false, raison: 'date_illisible' };

  // Le seul endroit où le sens agit : « après » est le même déclencheur avec un signe.
  // 🔴 « Trop tard » vaut aussi pour « après » : activer « 3 jours après la date » ne rattrape rien, sinon
  // l'activation ferait partir d'un coup tous les contacts dont la date est passée (envoi de masse facturé).
  const signe = e.sens === 'apres' ? 1 : -1;
  const moment = new Date(instant.getTime() + signe * e.offsetMinutes * 60_000);
  if (e.now < moment.getTime()) return { du: false, raison: 'pas_encore' };
  if (e.now > moment.getTime() + e.toleranceMinutes * 60_000) return { du: false, raison: 'trop_tard' };
  return { du: true, moment };
}
