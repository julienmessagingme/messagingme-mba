import { prochaineOuverture } from '../lib/heures-ouvrees';
import type { BusinessHours } from '../workflow/conditions';

/**
 * L'équipe est-elle joignable quand l'agent passe la main ? Un bloc statique câblé sur la sortie `humain` ne
 * peut dire ni « c'est fermé » ni « nous reprenons lundi 9 h » : ce module le permet.
 *
 * Les trois valeurs sont celles de `mba_handoff_mode`, pour ne pas avoir deux vocabulaires voisins sur le
 * même écran. Ce module ne décide pas si on transfère : la conversation arrive dans « À traiter » dans tous
 * les cas. Il décide de ce que l'agent a le droit de promettre.
 */
export type ModeTransfert = 'always' | 'business_hours' | 'never';

export const MODES_TRANSFERT: readonly ModeTransfert[] = ['always', 'business_hours', 'never'];

/** Le défaut d'usine, celui d'un espace qui n'a jamais réglé la question. Le même que le MBA. */
export const MODE_TRANSFERT_DEFAUT: ModeTransfert = 'always';

/**
 * Cette valeur lue en base est-elle un mode connu ? Une valeur inconnue vaut `null`, donc le défaut, plutôt
 * qu'un mode inexistant affiché à l'écran.
 */
export function estModeTransfert(v: unknown): v is ModeTransfert {
  return typeof v === 'string' && (MODES_TRANSFERT as readonly string[]).includes(v);
}

/**
 * La disponibilité telle que le tour la transporte, la date déjà écrite en français. Absente = disponible :
 * un câblage qui l'oublie garde le comportement d'origine.
 */
export interface EquipePourPrompt {
  disponible: boolean;
  /** Déjà formatée par `reouvertureEnClair`. `null` = rien à promettre. */
  reouverture: string | null;
}

export interface DisponibiliteEquipe {
  /** `true` = l'agent peut annoncer un conseiller tout de suite. */
  disponible: boolean;
  /**
   * Quand l'équipe reprend, ou `null` quand on ne peut rien promettre (mode `never`, ou semaine entièrement
   * fermée) : l'agent se tait alors sur le délai plutôt que d'en inventer un.
   */
  reouverture: Date | null;
}

/**
 * `hours` absent ou vide fait basculer `business_hours` vers l'indisponibilité, jamais vers la
 * disponibilité : un espace qui a demandé « seulement aux heures ouvrées » sans déclarer ses horaires ne doit
 * pas voir promettre un conseiller à 3 h du matin.
 */
export function disponibiliteEquipe(
  mode: ModeTransfert,
  maintenant: Date,
  timeZone: string,
  hours: BusinessHours | null,
): DisponibiliteEquipe {
  if (mode === 'always') return { disponible: true, reouverture: null };
  if (mode === 'never') return { disponible: false, reouverture: null };

  if (!hours) return { disponible: false, reouverture: null };
  const prochaine = prochaineOuverture(maintenant, timeZone, hours);
  // `prochaineOuverture` rend `depuis` tel quel quand on est déjà ouvert (son contrat) : pas de seconde
  // lecture des horaires qui pourrait diverger d'une minute.
  if (prochaine !== null && prochaine.getTime() === maintenant.getTime()) {
    return { disponible: true, reouverture: null };
  }
  return { disponible: false, reouverture: prochaine };
}

/**
 * La réouverture en français, dans le fuseau de l'espace. C'est nous qui formatons, pas le modèle :
 * `prochaineOuverture` sait franchir un week-end et un changement d'heure, un modèle ferait l'arithmétique
 * et la raterait. Il reçoit un fait écrit (« lundi 22 septembre à 9 h ») et n'a plus qu'à le formuler.
 */
export function reouvertureEnClair(quand: Date, timeZone: string): string {
  const f = new Intl.DateTimeFormat('fr-FR', {
    timeZone, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit',
  });
  // `formatToParts` plutôt que `format` : le format par défaut intercale « à » ou une virgule selon la
  // version d'ICU.
  const p = Object.fromEntries(f.formatToParts(quand).map((x) => [x.type, x.value]));
  const minutes = p.minute === '00' ? '' : ` ${p.minute}`;
  return `${p.weekday} ${p.day} ${p.month} à ${p.hour} h${minutes}`;
}

/**
 * La disponibilité prête pour le prompt, calcul et mise en français en un appel, pour que le tour de
 * production et le bac à sable produisent la même phrase.
 */
export function equipePourPrompt(
  mode: ModeTransfert,
  maintenant: Date,
  timeZone: string,
  hours: BusinessHours | null,
): EquipePourPrompt {
  const d = disponibiliteEquipe(mode, maintenant, timeZone, hours);
  return {
    disponible: d.disponible,
    reouverture: d.reouverture === null ? null : reouvertureEnClair(d.reouverture, timeZone),
  };
}
