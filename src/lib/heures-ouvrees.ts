import { addDays } from '../stats/range';
import { parseInstant, weekdayInZone, withinBusinessHours } from '../workflow/conditions';
import type { BusinessHours } from '../workflow/conditions';

/**
 * « Quand est le prochain créneau ouvert ? », en UN seul endroit.
 *
 * 🔴 POURQUOI CETTE BRIQUE EXISTE. Trois chemins la demandent en même temps (2026-09-08, Julien) : un bloc
 * Attente qui patiente jusqu'aux prochaines heures ouvrées, une campagne qui ne doit envoyer que pendant
 * ces heures, et la reprise d'une campagne interrompue par la fermeture. Écrit trois fois, ce calcul aurait
 * divergé sur les deux cas qui font mal : le jour FERMÉ (on saute au suivant) et le changement d'heure (une
 * heure d'ouverture est une heure MURALE, elle ne devient un instant que dans le fuseau de l'espace).
 *
 * ⚠️ Elle ne dit PAS si on est ouvert : ça, c'est `withinBusinessHours`, qui existait déjà et qu'on
 * réutilise ici plutôt que d'en refaire la logique. Cette fonction répond à l'autre question, celle qui
 * n'avait pas de réponse : « et sinon, quand ? ».
 */

/**
 * Combien de jours on regarde devant soi.
 *
 * Huit, pas sept : le jour COURANT compte pour un (on peut être avant son ouverture), il faut donc les sept
 * suivants pour couvrir une semaine entière. Au-delà, il n'y a rien à trouver : une semaine sans un seul
 * jour ouvert est une configuration fermée, pas un créneau lointain.
 */
const JOURS_REGARDES = 8;

/**
 * Le prochain instant où l'espace est ouvert, à partir de `depuis`.
 *
 * - déjà ouvert -> rend `depuis` TEL QUEL. L'appelant n'a rien à attendre, et c'est ce qui lui permet de
 *   traiter les deux cas d'une seule façon : il programme toujours pour l'instant rendu ;
 * - fermé -> l'ouverture du prochain jour ouvert, à la minute près ;
 * - AUCUN jour ouvert de la semaine (ou horaires inexploitables) -> `null`. C'est le cas qu'il ne faut pas
 *   escamoter : rendre `depuis` ferait envoyer tout de suite ce qu'on voulait retenir, et rendre une date
 *   lointaine bloquerait un parcours pour toujours. L'appelant DÉCIDE quoi faire, et il doit le dire à
 *   l'écran.
 */
export function prochaineOuverture(depuis: Date, timeZone: string, hours: BusinessHours): Date | null {
  if (Number.isNaN(depuis.getTime())) return null;
  if (withinBusinessHours(depuis, timeZone, hours)) return depuis;

  // Le jour civil de `depuis` DANS LE FUSEAU, puis les suivants. On itère sur des dates civiles et non sur
  // des « +24 h » : au changement d'heure un jour civil dure 23 ou 25 heures, et l'arithmétique en
  // millisecondes sauterait un jour ou le répéterait, une fois par an, dans un sens seulement.
  let jour = new Intl.DateTimeFormat('en-CA', { timeZone }).format(depuis);
  for (let i = 0; i < JOURS_REGARDES; i += 1) {
    // Le jour de la semaine se lit sur MIDI de ce jour civil, jamais sur minuit : à minuit, un décalage
    // d'offset d'une heure ferait basculer la lecture sur la veille.
    const midi = parseInstant(`${jour}T12:00`, timeZone);
    const h = hours?.[String(weekdayInZone(midi, timeZone))];
    if (h && !h.closed) {
      const ouverture = parseInstant(`${jour}T${h.open}`, timeZone);
      // `>` strict : une ouverture déjà passée aujourd'hui ne sert à rien (on serait déjà « ouvert », or on
      // ne l'est pas, donc on est après la fermeture). On passe au jour suivant.
      if (!Number.isNaN(ouverture.getTime()) && ouverture.getTime() > depuis.getTime()) {
        // Ceinture : un jour dont la plage est inexploitable (`close <= open`) n'est PAS ouvert, même à son
        // heure d'ouverture. Sans cette vérification, on programmerait un envoi dans un créneau vide.
        if (withinBusinessHours(ouverture, timeZone, hours)) return ouverture;
      }
    }
    jour = addDays(jour, 1);
  }
  return null;
}
