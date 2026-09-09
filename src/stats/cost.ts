import type { DailyPoint, CostVolumeRow } from './store.pg';

/** Coût estimé par jour et catégorie, sur la plage. `hasRates=false` si Meta n'a fourni aucun tarif. */
export interface CostSeries {
  /** point.count = coût estimé marketing du jour (devise du compte). */
  marketing: DailyPoint[];
  utility: DailyPoint[];
  total: number;
  hasRates: boolean;
  /** Devise du compte (ISO 4217) rendue par Meta ; null = inconnue, l'écran affiche alors le nombre nu. */
  currency: string | null;
  /**
   * Nombre d'envois COMPTÉS dans le volume mais absents du coût. Somme des deux causes ci-dessous.
   *
   * 🔴 Ce champ existe pour que l'écran puisse le DIRE. Sans lui, ces envois disparaissaient du calcul en
   * silence et le client lisait un coût nul là où il avait bien envoyé : c'est ce qui s'est passé pour
   * 22 envois de scénario du tenant Demo, dont la catégorie n'était pas écrite avant le 2026-09-07. Un
   * volume non chiffrable est une information ; l'escamoter en fait un mensonge par omission.
   */
  nonChiffrables: number;
  /**
   * ...dont l'envoi n'a AUCUNE catégorie enregistrée.
   *
   * 🔴 CAUSE FERMÉE ET DATÉE, ET C'EST TOUTE LA DIFFÉRENCE AVEC LA SUIVANTE. Un envoi de scénario
   * antérieur au 2026-09-07 ne porte pas sa catégorie : le code lisait bien la fiche du template chez Meta
   * mais la JETAIT. Mesuré sur la production le 2026-09-09, chemin d'écriture par chemin d'écriture :
   * 15 envois `origin = scenario`, le dernier le 2026-09-07 à 12h36, et zéro depuis ; les chemins
   * `campagne` et `humain` n'ont jamais rien perdu. Ces envois ne redeviendront JAMAIS chiffrables (on ne
   * réécrit pas ce que Meta a déjà facturé), donc l'écran doit dire que c'est de l'HISTORIQUE et non une
   * panne en cours : les deux appellent des gestes opposés.
   */
  sansCategorie: number;
  /**
   * ...dont la catégorie est connue mais dont Meta ne rend AUCUN tarif pour la période.
   *
   * Cause VIVANTE, celle-là : elle peut apparaître demain sur un envoi d'aujourd'hui, et elle se répare en
   * relisant les tarifs. Les confondre avec les précédents ferait lire « panne » là où il n'y a qu'un
   * héritage, et l'inverse.
   */
  sansTarif: number;
}

/** Tarif Meta par message pour chaque catégorie (null = indisponible -> coût non estimable). */
export interface CategoryRates {
  marketing: number | null;
  utility: number | null;
  /** Devise du compte telle que Meta la rend, portée avec les tarifs parce qu'elle vient du même appel. */
  currency?: string | null;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Énumère les jours 'YYYY-MM-DD' de from à to INCLUS (arithmétique UTC pure, borne 366 jours). */
export function enumerateDays(from: string, to: string): string[] {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  const end = Date.UTC(ty, tm - 1, td);
  const days: string[] = [];
  let t = Date.UTC(fy, fm - 1, fd);
  for (let i = 0; t <= end && i <= 366; i++, t += 86_400_000) days.push(new Date(t).toISOString().slice(0, 10));
  return days;
}

/**
 * Combine un volume d'envois par (jour, catégorie) et les tarifs Meta -> série de coût estimé/jour,
 * dense sur [from, to] (0 pour les jours sans envoi). Une catégorie sans tarif connu ne contribue pas
 * au coût (jamais de coût inventé). Pur -> testable sans DB ni réseau.
 */
export function estimateCostSeries(from: string, to: string, rows: CostVolumeRow[], rates: CategoryRates): CostSeries {
  const days = enumerateDays(from, to);
  const mktByDay = new Map<string, number>();
  const utilByDay = new Map<string, number>();
  // 🔴 CE QUI TOMBE DANS LE VIDE, COMPTE PLUTOT QUE JETE EN SILENCE. Une ligne sans catégorie connue (ou
  // dont le tarif Meta manque) ne produit aucun coût, et jusqu'ici elle disparaissait sans laisser de
  // trace : l'écran affichait zéro là où il y avait bien eu des envois. C'est ce qui a fait croire à un
  // coût nul sur 22 envois de scénario du tenant Demo, dont la catégorie n'était pas écrite avant le
  // 2026-09-07. Un volume non chiffrable est une information, pas un néant : l'écran doit le DIRE.
  //
  // ⚠️ ET LES DEUX CAUSES SE COMPTENT À PART, parce qu'elles ne se réparent pas pareil : une catégorie
  // absente est un héritage définitif, un tarif manquant est une panne du jour. Un seul nombre les
  // confondait, et l'écran ne pouvait dire ni l'un ni l'autre sans risquer de mentir.
  let sansCategorie = 0;
  let sansTarif = 0;
  for (const r of rows) {
    const bucket = r.category === 'marketing' ? mktByDay : r.category === 'utility' ? utilByDay : null;
    if (!bucket) { sansCategorie += r.count; continue; }
    const rate = r.category === 'marketing' ? rates.marketing : rates.utility;
    if (rate == null) { sansTarif += r.count; continue; }
    bucket.set(r.date, (bucket.get(r.date) ?? 0) + r.count * rate);
  }
  const marketing = days.map((d) => ({ date: d, count: round2(mktByDay.get(d) ?? 0) }));
  const utility = days.map((d) => ({ date: d, count: round2(utilByDay.get(d) ?? 0) }));
  const total = round2([...mktByDay.values(), ...utilByDay.values()].reduce((a, b) => a + b, 0));
  return {
    marketing, utility, total,
    hasRates: rates.marketing != null || rates.utility != null,
    currency: rates.currency ?? null,
    nonChiffrables: sansCategorie + sansTarif,
    sansCategorie,
    sansTarif,
  };
}

/** Un volume d'envois facturables d'UNE campagne, pour UNE catégorie Meta (marketing / utility / inconnue). */
export interface VolumeCampagneRow {
  campaignId: string;
  nom: string;
  /** Le template de la campagne, `null` pour une campagne à scénario. C'est ce qui décide si un clic existe. */
  template: string | null;
  category: string | null;
  count: number;
}

/**
 * Combien de campagnes le tableau de la synthèse montre au plus.
 *
 * 🔴 UNE LISTE SANS BORNE EST UN DÉFAUT, PAS UN CONFORT. La plage accepte jusqu'à 366 jours : un client qui
 * lance quelques campagnes par semaine en a des centaines sur un an, et l'écran les rendrait toutes, dans une
 * page qu'on ouvre pour se faire une idée. Le dépôt a déjà posé cette règle sur les contacts touchés par une
 * erreur (`PLAFOND_CONTACTS_ERREUR`) et sur la liste quali. Ici, on garde les campagnes qui ont le PLUS
 * ENVOYÉ, et le tableau DIT qu'il tronque : une troncature muette se lit comme un inventaire complet.
 *
 * ⚠️ Le SQL en demande une de plus (`+ 1`) : c'est ainsi qu'on sait qu'on tronque sans compter à part.
 */
export const PLAFOND_CAMPAGNES_SYNTHESE = 50;

/** Une ligne du tableau « ce que coûte un engagement » (page de synthèse). */
export interface LigneCoutCampagne {
  campaignId: string;
  nom: string;
  template: string | null;
  /** Envois facturables de la période, chiffrables ou non. */
  envoyes: number;
  /**
   * Coût ESTIMÉ (envois × tarif Meta de la catégorie). `null` quand AUCUN des envois de la campagne n'a pu
   * être chiffré : la case reste vide et le dit, plutôt que d'afficher un zéro qui se lirait « gratuit ».
   */
  cout: number | null;
  /** Envois comptés dans `envoyes` mais absents du coût. Somme des deux causes qui suivent. */
  nonChiffrables: number;
  /** ...dont ceux sans catégorie enregistrée : héritage définitif, cf. `CostSeries.sansCategorie`. */
  sansCategorie: number;
  /** ...dont ceux dont Meta ne rend pas le tarif : panne du jour, réparable, cf. `CostSeries.sansTarif`. */
  sansTarif: number;
  /**
   * Clics sur les liens tracés, depuis le premier envoi. `null` = rien de mesurable ici, ce qui n'est PAS
   * zéro : campagne à scénario (elle n'a pas de template, donc pas de lien tracé) ou template sans lien.
   */
  clics: number | null;
  /**
   * Coût par clic. `null` dès qu'un des deux termes manque OU que les clics valent zéro : un « ∞ » ou un
   * « 0 € » serait une réponse à une question qu'on n'a pas pu poser.
   */
  coutParClic: number | null;
}

export interface CoutParCampagne {
  lignes: LigneCoutCampagne[];
  /**
   * La période comptait PLUS de campagnes que le plafond, et le tableau n'en montre qu'une partie (les plus
   * grosses). L'écran le dit : sans ça, la liste se lirait comme l'inventaire complet de la période.
   */
  tronque: boolean;
  /** Devise rendue par Meta ; `null` = inconnue, l'écran affiche alors le nombre nu. */
  currency: string | null;
  /** Meta n'a rendu AUCUN tarif : toute la colonne coût est vide, et l'écran doit dire pourquoi. */
  hasRates: boolean;
}

/**
 * Le tableau « coût par engagement », à partir des volumes par campagne, des tarifs Meta et des clics.
 *
 * 🔴 LES MÊMES RÈGLES QUE `estimateCostSeries`, ET POUR LA MÊME RAISON : une catégorie inconnue ou sans
 * tarif ne produit AUCUN coût et se COMPTE à part (`nonChiffrables`). Deux définitions de « chiffrable »
 * donneraient deux totaux sur deux écrans du même onglet, et le client comparerait.
 *
 * Pur (aucune DB, aucun réseau) : c'est ici que se décident les trois cases vides, et elles se testent sans
 * base. Tri par coût décroissant, puis par envois : la question posée est « ce que ça coûte ».
 */
export function estimateCoutParCampagne(
  rows: VolumeCampagneRow[],
  rates: CategoryRates,
  clics: Map<string, number>,
): CoutParCampagne {
  const par = new Map<string, LigneCoutCampagne & { chiffres: number }>();
  for (const r of rows) {
    const ligne = par.get(r.campaignId) ?? {
      campaignId: r.campaignId, nom: r.nom, template: r.template,
      envoyes: 0, cout: 0, nonChiffrables: 0, sansCategorie: 0, sansTarif: 0, clics: null, coutParClic: null, chiffres: 0,
    };
    // ⚠️ MÊME PARTAGE DES DEUX CAUSES QUE `estimateCostSeries`, et pour la même raison qu'elles y sont
    // partagées : les deux écrans du même onglet doivent nommer la même chose de la même façon.
    const connue = r.category === 'marketing' || r.category === 'utility';
    const rate = connue ? (r.category === 'marketing' ? rates.marketing : rates.utility) : null;
    ligne.envoyes += r.count;
    if (!connue) { ligne.sansCategorie += r.count; ligne.nonChiffrables += r.count; }
    else if (rate == null) { ligne.sansTarif += r.count; ligne.nonChiffrables += r.count; }
    else {
      ligne.chiffres += r.count;
      ligne.cout = (ligne.cout ?? 0) + r.count * rate;
    }
    par.set(r.campaignId, ligne);
  }

  const lignes = [...par.values()].map((l) => {
    // Aucun envoi chiffré -> la case COÛT est vide, pas à zéro. Un zéro se lirait « cette campagne n'a rien
    // coûté », alors que la vérité est « on ne sait pas ce qu'elle a coûté ».
    const cout = l.chiffres > 0 ? Math.round((l.cout ?? 0) * 100) / 100 : null;
    const n = clics.get(l.campaignId);
    const nbClics = n === undefined ? null : n;
    // Le ratio n'existe que si ses DEUX termes existent, et si le dénominateur n'est pas nul.
    const coutParClic = cout !== null && nbClics !== null && nbClics > 0 ? Math.round((cout / nbClics) * 10000) / 10000 : null;
    return {
      campaignId: l.campaignId, nom: l.nom, template: l.template, envoyes: l.envoyes, cout,
      nonChiffrables: l.nonChiffrables, sansCategorie: l.sansCategorie, sansTarif: l.sansTarif,
      clics: nbClics, coutParClic,
    };
  });
  /**
   * 🔴 ON TRONQUE SUR LE VOLUME, ON AFFICHE SUR LE COÛT, ET L'ORDRE DES DEUX COMPTE.
   *
   * Le SQL ne connaît pas les tarifs Meta : il garde les N+1 campagnes qui ont le PLUS ENVOYÉ (le `+1` est
   * ce qui permet de savoir qu'on tronque). Si on triait ici au coût avant de couper, la campagne écartée
   * serait la moins chère des survivantes, et l'ensemble affiché ne serait plus « les N qui ont le plus
   * envoyé » : ce serait un mélange des deux critères, que la phrase de l'écran décrirait de travers.
   *
   * On rejoue donc EXACTEMENT le critère du SQL (volume décroissant, identifiant en départage), on coupe,
   * puis on trie au coût pour l'affichage.
   */
  const tronque = lignes.length > PLAFOND_CAMPAGNES_SYNTHESE;
  const gardees = tronque
    ? [...lignes].sort((a, b) => b.envoyes - a.envoyes || a.campaignId.localeCompare(b.campaignId)).slice(0, PLAFOND_CAMPAGNES_SYNTHESE)
    : lignes;
  gardees.sort((a, b) => (b.cout ?? -1) - (a.cout ?? -1) || b.envoyes - a.envoyes || a.nom.localeCompare(b.nom));

  return {
    lignes: gardees,
    tronque,
    currency: rates.currency ?? null,
    hasRates: rates.marketing != null || rates.utility != null,
  };
}
