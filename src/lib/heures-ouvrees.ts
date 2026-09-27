import { addDays } from '../stats/range';
import { parseInstant, weekdayInZone, withinBusinessHours } from '../workflow/conditions';
import type { BusinessHours } from '../workflow/conditions';

/**
 * « Quand est le prochain créneau ouvert ? », en un seul endroit (« est-on ouvert ? », c'est
 * `withinBusinessHours`). Les deux cas qui feraient diverger des copies : le jour fermé (on saute au suivant)
 * et le changement d'heure (une heure d'ouverture est murale, elle ne devient un instant que dans le fuseau de
 * l'espace).
 */

/**
 * Huit jours regardés, pas sept : le jour courant compte pour un (on peut être avant son ouverture). Une
 * semaine sans jour ouvert est une configuration fermée, pas un créneau lointain.
 */
const JOURS_REGARDES = 8;

/**
 * Le prochain instant où l'espace est ouvert, à partir de `depuis`.
 *
 * - déjà ouvert : rend `depuis` tel quel, l'appelant programme toujours pour l'instant rendu ;
 * - fermé : l'ouverture du prochain jour ouvert ;
 * - aucun jour ouvert (ou horaires inexploitables) : `null`. Rendre `depuis` enverrait tout de suite ce qu'on
 *   voulait retenir, une date lointaine bloquerait un parcours pour toujours : l'appelant décide, et le dit à
 *   l'écran.
 */
export function prochaineOuverture(depuis: Date, timeZone: string, hours: BusinessHours): Date | null {
  if (Number.isNaN(depuis.getTime())) return null;
  if (withinBusinessHours(depuis, timeZone, hours)) return depuis;

  // On itère sur des jours civils dans le fuseau, pas sur des « +24 h » : au changement d'heure un jour dure 23
  // ou 25 heures, et l'arithmétique en millisecondes sauterait ou répéterait un jour.
  let jour = new Intl.DateTimeFormat('en-CA', { timeZone }).format(depuis);
  for (let i = 0; i < JOURS_REGARDES; i += 1) {
    // Le jour de la semaine se lit sur midi, jamais sur minuit : un décalage d'une heure ferait lire la veille.
    const midi = parseInstant(`${jour}T12:00`, timeZone);
    const h = hours?.[String(weekdayInZone(midi, timeZone))];
    if (h && !h.closed) {
      const ouverture = parseInstant(`${jour}T${h.open}`, timeZone);
      // `>` strict : une ouverture déjà passée aujourd'hui veut dire qu'on est après la fermeture, on passe au jour
      // suivant.
      if (!Number.isNaN(ouverture.getTime()) && ouverture.getTime() > depuis.getTime()) {
        // Une plage inexploitable (`close <= open`) n'est pas ouverte, même à son heure d'ouverture : sinon on
        // programmerait un envoi dans un créneau vide.
        if (withinBusinessHours(ouverture, timeZone, hours)) return ouverture;
      }
    }
    jour = addDays(jour, 1);
  }
  return null;
}

/**
 * « A-t-on le droit de rattraper maintenant ? », pour un réessai ou un repli d'étage.
 *
 * Question distincte de `business_hours_only`, qui gouverne l'envoi initial, le moment que l'opérateur
 * choisit ; celle-ci gouverne le moment que personne ne choisit (un échec à 3 h du matin, un repli après la fin
 * de la campagne). Le drapeau `rattrapage_hors_horaires` la court-circuite en amont.
 *
 * Une semaine sans aucun jour ouvert rend `true` : y attendre l'ouverture reviendrait à ne jamais rattraper, en
 * silence. `prochaineOuverture` rend déjà `null` dans ce cas, on lui redemande.
 */
export function fenetreDeRattrapageOuverte(maintenant: Date, timeZone: string, hours: BusinessHours): boolean {
  if (withinBusinessHours(maintenant, timeZone, hours)) return true;
  return prochaineOuverture(maintenant, timeZone, hours) === null;
}
