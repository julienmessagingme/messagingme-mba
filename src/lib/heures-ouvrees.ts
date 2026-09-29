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
 * Un instant quelconque, fixe, d'où chercher un créneau : `prochaineOuverture` regarde huit jours, donc chaque jour
 * de la semaine au moins une fois, et sa réponse (« il existe un créneau ») ne dépend pas du point de départ.
 */
const REFERENCE = new Date(Date.UTC(2026, 0, 5, 12));

/**
 * L'espace a-t-il au moins un créneau d'ouverture exploitable dans la semaine ? Non (horaires absents, tous les
 * jours fermés, plages mal saisies) : le temps ouvré n'a pas de sens, `tempsOuvre` compte en temps brut, et
 * l'écran qui l'affiche doit le dire. Même critère que `prochaineOuverture`, à qui on le demande.
 */
export function horairesExploitables(timeZone: string, hours: BusinessHours | null): boolean {
  return hours !== null && prochaineOuverture(REFERENCE, timeZone, hours) !== null;
}

/**
 * Le temps OUVRÉ entre deux instants, en millisecondes : la part de `[debut, fin]` qui tombe dans les heures
 * d'ouverture de l'espace, dans son fuseau. C'est ce que mesure le Quantitatif > Performance : une demande arrivée
 * vendredi à 17 h et répondue lundi à 9 h 30 a attendu une heure et demie d'équipe, pas soixante-quatre heures.
 *
 * - `fin` antérieure à `debut` (ou instant invalide) : 0, jamais une durée négative ;
 * - horaires absents ou sans créneau exploitable (`horairesExploitables`) : le temps BRUT, que l'appelant annonce ;
 * - le changement d'heure : on itère sur des jours CIVILS du fuseau, et chaque ouverture ou fermeture murale
 *   devient un instant par `parseInstant`. Un jour de 23 ou 25 heures garde donc ses vraies heures d'ouverture,
 *   là où une arithmétique en « + 24 h » sauterait ou répéterait un jour, comme dans `prochaineOuverture`.
 */
export function tempsOuvre(debut: Date, fin: Date, timeZone: string, hours: BusinessHours | null): number {
  return mesureurDeTempsOuvre(timeZone, hours)(debut, fin);
}

/**
 * `tempsOuvre` pour un même espace, avec la plage de chaque jour civil calculée une seule fois : une période de
 * statistiques mesure des centaines de demandes qui partagent leurs jours, et chaque plage coûte plusieurs
 * formatages `Intl`. Même résultat que `tempsOuvre`, qui l'appelle.
 */
export function mesureurDeTempsOuvre(timeZone: string, hours: BusinessHours | null): (debut: Date, fin: Date) => number {
  const brut = (debut: Date, fin: Date): number => {
    const d = fin.getTime() - debut.getTime();
    return d > 0 ? d : 0;
  };
  if (hours === null || !horairesExploitables(timeZone, hours)) return brut;

  const jourCivil = new Intl.DateTimeFormat('en-CA', { timeZone });
  const plages = new Map<string, readonly [number, number] | null>();
  /** L'ouverture et la fermeture du jour civil `jour`, en instants ; `null` = fermé ou plage inexploitable. */
  const plageDu = (jour: string): readonly [number, number] | null => {
    const connue = plages.get(jour);
    if (connue !== undefined) return connue;
    let plage: readonly [number, number] | null = null;
    // Le jour de la semaine se lit sur midi, jamais sur minuit : un décalage d'une heure ferait lire la veille.
    const h = hours[String(weekdayInZone(parseInstant(`${jour}T12:00`, timeZone), timeZone))];
    if (h && !h.closed) {
      const ouverture = parseInstant(`${jour}T${h.open}`, timeZone).getTime();
      const fermeture = parseInstant(`${jour}T${h.close}`, timeZone).getTime();
      // Une plage mal saisie (`close <= open`) n'est pas ouverte : même règle que `withinBusinessHours`.
      if (fermeture > ouverture && withinBusinessHours(new Date(ouverture), timeZone, hours)) plage = [ouverture, fermeture];
    }
    plages.set(jour, plage);
    return plage;
  };

  return (debut, fin) => {
    const a = debut.getTime();
    const b = fin.getTime();
    // `!(b > a)` et pas `b <= a` : un instant invalide (NaN) rend 0 au lieu d'une boucle sans fin.
    if (!(b > a)) return 0;
    const dernier = jourCivil.format(fin);
    let total = 0;
    // Les dates `YYYY-MM-DD` se comparent comme des chaînes.
    for (let jour = jourCivil.format(debut); jour <= dernier; jour = addDays(jour, 1)) {
      const p = plageDu(jour);
      if (p) total += Math.max(0, Math.min(b, p[1]) - Math.max(a, p[0]));
    }
    return total;
  };
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
