import { prochaineOuverture } from '../lib/heures-ouvrees';
import type { BusinessHours } from '../workflow/conditions';

/**
 * L'ÉQUIPE EST-ELLE JOIGNABLE QUAND L'AGENT PASSE LA MAIN ? (lot 1 du plan du 2026-09-18)
 *
 * 🔴 CE QUE ÇA RÉPARE. Un agent IA qui transfère à 3 h du matin laisse le contact devant ce que le client a
 * câblé sur la sortie `humain` de son bloc, c'est-à-dire un BLOC STATIQUE. Un bloc statique ne peut dire ni
 * « c'est fermé », ni « nous reprenons lundi 9 h » : il dit la même chose à toute heure. Demande de Julien,
 * 2026-09-18 : « il faut que le user setup si il veut qu'on transfère à toute heure ou jamais en dehors des
 * heures ouvrées, ou encore nous sommes fermés mais nous reviendrons vers vous dès demain 9h ».
 *
 * 🔴 LES TROIS VALEURS SONT CELLES DU MBA, PAS DES NOUVELLES. `mba_handoff_mode` (migration 0067) pose déjà
 * exactement cette question pour l'agent de Meta. En inventer un quatrième vocabulaire aurait donné deux
 * réglages voisins que personne ne saurait rapprocher, sur un écran où les deux agents cohabitent.
 *
 * ⚠️ CE MODULE NE DÉCIDE PAS SI ON TRANSFÈRE. La conversation arrive dans « À traiter » dans TOUS les cas,
 * c'est l'arbitrage de Julien : une phrase « on revient vers vous » sans ligne de travail derrière est un
 * mensonge poli. Ce qui change, c'est ce que l'agent a le droit de PROMETTRE.
 */
export type ModeTransfert = 'always' | 'business_hours' | 'never';

export const MODES_TRANSFERT: readonly ModeTransfert[] = ['always', 'business_hours', 'never'];

/** Le défaut d'usine, celui d'un espace qui n'a jamais réglé la question. Le même que le MBA. */
export const MODE_TRANSFERT_DEFAUT: ModeTransfert = 'always';

/**
 * Cette valeur lue en base est-elle un mode connu ?
 *
 * ⚠️ ELLE VIT ICI, avec le vocabulaire, et pas dans le store : une valeur inconnue doit valoir `null`, donc
 * « rien n'a été réglé », donc le défaut. Sans cette garde, une base en retard sur la migration ferait
 * remonter `undefined` dans un champ typé et l'écran afficherait un mode qui n'existe pas.
 */
export function estModeTransfert(v: unknown): v is ModeTransfert {
  return typeof v === 'string' && (MODES_TRANSFERT as readonly string[]).includes(v);
}

/**
 * La disponibilité telle que le TOUR la transporte : la date est déjà écrite en français.
 *
 * ⚠️ ABSENTE = DISPONIBLE, et ce défaut n'est pas une commodité : il garantit qu'un câblage qui ne la
 * fournit pas se comporte exactement comme avant le 2026-09-18. Un agent qui se tairait sur un délai parce
 * qu'une dépendance a été oubliée serait pire que le défaut qu'on corrige.
 */
export interface EquipePourPrompt {
  disponible: boolean;
  /** Déjà formatée par `reouvertureEnClair`. `null` = rien à promettre. */
  reouverture: string | null;
}

export interface DisponibiliteEquipe {
  /** `true` = l'agent peut annoncer un conseiller tout de suite, comme il le fait depuis toujours. */
  disponible: boolean;
  /**
   * Quand l'équipe reprend, ou `null` quand on ne peut RIEN promettre.
   *
   * ⚠️ `null` alors qu'on est indisponible n'est pas une erreur : c'est le mode `never`, et c'est aussi une
   * semaine entièrement fermée. Dans les deux cas l'agent doit se taire sur le délai plutôt que d'en
   * inventer un.
   */
  reouverture: Date | null;
}

/**
 * ⚠️ `hours` ABSENT OU VIDE FAIT BASCULER `business_hours` VERS L'INDISPONIBILITÉ, jamais vers la
 * disponibilité, et le choix se pèse dans les deux sens. Un espace qui a demandé « seulement aux heures
 * ouvrées » sans jamais déclarer ses horaires ne nous a pas dit quand il répond : traiter ce cas comme
 * `always` ferait promettre un conseiller à 3 h du matin, ce que le réglage existait justement pour
 * empêcher. Le traiter comme une indisponibilité sans date coûte, elle, une phrase moins précise, sur une
 * conversation qui arrive de toute façon dans « À traiter ».
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
  // 🔴 `prochaineOuverture` rend `depuis` TEL QUEL quand on est déjà ouvert : c'est son contrat, et c'est ce
  // qui permet de ne pas redemander `withinBusinessHours` ici, donc de ne pas avoir deux lectures des
  // horaires qui pourraient diverger d'une minute.
  if (prochaine !== null && prochaine.getTime() === maintenant.getTime()) {
    return { disponible: true, reouverture: null };
  }
  return { disponible: false, reouverture: prochaine };
}

/**
 * La réouverture en FRANÇAIS, dans le fuseau de l'espace, prête à être lue par un humain.
 *
 * 🔴 C'EST NOUS QUI FORMATONS, PAS LE MODÈLE, et c'est le point entier. Julien, 2026-09-18 : « un client qui
 * nous contacte un samedi alors que c'est fermé tout le week-end, faut pas lui dire on vous contacte demain
 * à 9h mais on vous contacte lundi à 9h ». `prochaineOuverture` sait déjà franchir un week-end et les
 * changements d'heure ; un modèle à qui l'on donnerait le calendrier brut ferait l'arithmétique lui-même, et
 * c'est exactement le genre de calcul qu'il rate, sur la phrase que le contact va croire.
 *
 * ⚠️ Le modèle reçoit donc un FAIT déjà écrit (« lundi 22 septembre à 9 h ») et n'a plus qu'à le formuler
 * dans son ton. Il garde la voix, il perd le calcul.
 */
export function reouvertureEnClair(quand: Date, timeZone: string): string {
  const f = new Intl.DateTimeFormat('fr-FR', {
    timeZone, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit',
  });
  // ⚠️ `formatToParts` plutôt que `format` : le format français par défaut intercale « à » ou une virgule
  // selon la version d'ICU, et on ne veut pas que la phrase change de forme au gré du runtime.
  const p = Object.fromEntries(f.formatToParts(quand).map((x) => [x.type, x.value]));
  const minutes = p.minute === '00' ? '' : ` ${p.minute}`;
  return `${p.weekday} ${p.day} ${p.month} à ${p.hour} h${minutes}`;
}

/**
 * La disponibilité prête pour le prompt : le calcul ET la mise en français, en un seul appel.
 *
 * 🔴 IL EXISTE POUR QUE LES DEUX CÂBLAGES NE LE REFASSENT PAS CHACUN. Le tour de production et le bac à
 * sable construisent le contexte de l'agent par le même point de passage (`lireContexteAgent`), et c'est
 * précisément ce que ce module protège : un espace fermé doit produire la même phrase des deux côtés, sans
 * quoi le bac à sable cesserait de montrer ce que la production fera.
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
