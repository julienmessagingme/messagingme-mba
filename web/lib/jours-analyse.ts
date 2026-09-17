/**
 * REGROUPER LES JOURNEES D'ANALYSE : par jour, ou par semaine sur une longue periode.
 *
 * 🔴 CE QUE CE MODULE RESOUT, ET LA DEMANDE EXACTE DE JULIEN (2026-09-17). « Si un moment il y a 1000
 * conversations en stock, tu vas pas afficher 1000 conversations dans le tableau. » L'ecran passe donc a une
 * ligne par JOUR. Et quand on lui a demande ce que devenaient les longues periodes, il a repondu « 1 et 2 en
 * meme temps » : les journees vides masquees ET un regroupement hebdomadaire au-dela de 90 jours.
 *
 * ⚠️ LA GRANULARITE QUI CHANGE TOUTE SEULE EST UN PIEGE, ET LA PARADE EST DE LA DIRE. Deux captures de la
 * meme page cessent de se comparer si l'une est en jours et l'autre en semaines sans que rien ne le
 * signale. `granularite()` rend donc le mode courant, l'ecran l'affiche, et un bascule manuel permet de
 * forcer l'autre.
 *
 * Module PUR : aucun appel, aucun etat, aucune date d'aujourd'hui (le jour courant serait une entree
 * cachee, et les tests deviendraient faux le lendemain).
 */

/** Une journee telle que le serveur la rend. */
export interface JourAnalyse {
  /** ISO court 'YYYY-MM-DD'. */
  jour: string;
  conversations: number;
  /** Moyenne des analyses QUI PORTENT la note. `null` si aucune : ce n'est PAS zero. */
  satisfaction: number | null;
  urgence: number | null;
  mesurees: number;
}

/** Une ligne du tableau : une journee, ou une semaine qui en regroupe plusieurs. */
export interface LignePeriode {
  /** La cle d'affichage : le jour, ou le lundi de la semaine. */
  debut: string;
  /** Les jours REELLEMENT couverts, pour que le clic ouvre le bon detail. */
  jours: string[];
  conversations: number;
  satisfaction: number | null;
  urgence: number | null;
  mesurees: number;
}

/**
 * Au-dela de combien de jours de periode on passe a la semaine.
 *
 * ⚠️ 90, ET CE N'EST PAS UN NOMBRE ARBITRAIRE : c'est la retention du contenu decidee le 2026-09-17. Au-dela,
 * l'ecran lit des agregats et non des conversations ; une ligne par jour y serait de toute facon une
 * precision que la donnee sous-jacente n'a plus.
 */
export const SEUIL_SEMAINE_JOURS = 90;

export type Granularite = 'jour' | 'semaine';

/**
 * La granularite que la periode appelle, sauf si on en force une.
 *
 * ⚠️ `force` GAGNE TOUJOURS : le bascule manuel de l'ecran est ce qui rend le changement automatique
 * acceptable. Sans lui, un lecteur qui veut le detail d'une longue periode n'aurait aucun recours.
 */
export function granularite(joursDeLaPeriode: number, force?: Granularite): Granularite {
  if (force) return force;
  return joursDeLaPeriode > SEUIL_SEMAINE_JOURS ? 'semaine' : 'jour';
}

/**
 * Le LUNDI de la semaine d'un jour ISO, en ISO.
 *
 * ⚠️ ARITHMETIQUE UTC PURE, comme `enumerateDays` cote serveur : passer par le fuseau local ferait dependre
 * le regroupement de la machine qui affiche, et deux lecteurs verraient deux decoupages.
 */
export function lundiDe(jour: string): string {
  const [a, m, j] = jour.split('-').map(Number) as [number, number, number];
  const t = Date.UTC(a, m - 1, j);
  const d = new Date(t).getUTCDay();
  // getUTCDay : 0 = dimanche. Le lundi precedent est donc a -6 pour un dimanche, a -(d-1) sinon.
  const recul = d === 0 ? 6 : d - 1;
  return new Date(t - recul * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Regroupe les journees pour l'affichage.
 *
 * 🔴 LES JOURNEES VIDES NE SONT PAS AJOUTEES, et le serveur n'en rend deja aucune : un `group by` ne rend
 * que ce qui existe. Une ligne a zero n'apprend rien et noie les autres. C'est le choix de Julien, et il est
 * repete ici pour que personne ne « repare » en densifiant la serie.
 *
 * 🔴 LES MOYENNES SE REPONDERENT PAR `mesurees`, PAS PAR `conversations`. Une semaine ou un jour a 1 mesure
 * a 9 et un autre 9 mesures a 3 ne fait pas une moyenne de 6 : elle fait 3,6. Ponderer par le nombre de
 * conversations compterait des analyses qui n'ont pas de note, et tirerait la moyenne vers le jour le plus
 * bavard plutot que vers le plus mesure.
 *
 * ⚠️ UNE SEMAINE SANS AUCUNE MESURE REND `null`, jamais zero, exactement comme une journee.
 */
export function regrouper(jours: readonly JourAnalyse[], mode: Granularite): LignePeriode[] {
  if (mode === 'jour') {
    return jours.map((j) => ({
      debut: j.jour,
      jours: [j.jour],
      conversations: j.conversations,
      satisfaction: j.satisfaction,
      urgence: j.urgence,
      mesurees: j.mesurees,
    }));
  }

  const parSemaine = new Map<string, { jours: string[]; conversations: number; sommeSat: number; sommeUrg: number; mesurees: number }>();
  for (const j of jours) {
    const cle = lundiDe(j.jour);
    const acc = parSemaine.get(cle) ?? { jours: [], conversations: 0, sommeSat: 0, sommeUrg: 0, mesurees: 0 };
    acc.jours.push(j.jour);
    acc.conversations += j.conversations;
    // ⚠️ On repondere par `mesurees` : la moyenne d'une journee ne vaut que pour les analyses qui portent
    // la note, et les additionner sans ce poids melangerait des ensembles de tailles differentes.
    if (j.mesurees > 0 && j.satisfaction !== null) acc.sommeSat += j.satisfaction * j.mesurees;
    if (j.mesurees > 0 && j.urgence !== null) acc.sommeUrg += j.urgence * j.mesurees;
    acc.mesurees += j.mesurees;
    parSemaine.set(cle, acc);
  }

  return [...parSemaine.entries()]
    // Le plus recent en tete, comme la liste des journees que le serveur rend.
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([debut, a]) => ({
      debut,
      jours: [...a.jours].sort().reverse(),
      conversations: a.conversations,
      satisfaction: a.mesurees > 0 ? a.sommeSat / a.mesurees : null,
      urgence: a.mesurees > 0 ? a.sommeUrg / a.mesurees : null,
      mesurees: a.mesurees,
    }));
}
