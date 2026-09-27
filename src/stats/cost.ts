import type { DailyPoint, CostVolumeRow } from './store.pg';
import { coutRcsEuros, type GrillePrix } from './prix';

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
   * Nombre d'envois comptés dans le volume mais absents du coût (somme des deux causes ci-dessous). Il existe
   * pour que l'écran le dise : sinon le client lirait un coût nul là où il a bien envoyé.
   */
  nonChiffrables: number;
  /**
   * ...dont l'envoi n'a aucune catégorie enregistrée : cause fermée, de l'historique (d'anciens envois de
   * scénario ne portent pas leur catégorie). Ils ne redeviendront jamais chiffrables, et l'écran doit le dire
   * comme un héritage, pas comme une panne.
   */
  sansCategorie: number;
  /**
   * ...dont la catégorie est connue mais dont Meta ne rend aucun tarif pour la période : cause vivante, qui se
   * répare en relisant les tarifs.
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

/** Arrondi au centime, le seul du dépôt pour un montant affiché (coûts, séries, bilans). */
export const round2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * Ce qu'on peut faire d'une catégorie d'envoi : la chiffrer, ou dire pourquoi on ne peut pas. 🔴 Une seule
 * définition de « chiffrable » pour tous les écrans qui affichent un coût, sinon deux totaux pour les mêmes
 * envois. Les deux causes restent distinctes : une catégorie absente est un héritage définitif, un tarif
 * manquant une panne du jour.
 */
export type Chiffrage = { tarif: number } | { refus: 'sansCategorie' | 'sansTarif' };

export function chiffrer(category: string | null, rates: CategoryRates): Chiffrage {
  if (category !== 'marketing' && category !== 'utility') return { refus: 'sansCategorie' };
  const tarif = category === 'marketing' ? rates.marketing : rates.utility;
  return tarif == null ? { refus: 'sansTarif' } : { tarif };
}

/** Énumère les jours 'YYYY-MM-DD' de from à to inclus (arithmétique UTC pure, borne 366 jours). */
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
  // Ce qui ne se chiffre pas est compté, par cause, plutôt que jeté en silence : l'écran doit le dire.
  let sansCategorie = 0;
  let sansTarif = 0;
  for (const r of rows) {
    const verdict = chiffrer(r.category, rates);
    if ('refus' in verdict) {
      if (verdict.refus === 'sansCategorie') sansCategorie += r.count; else sansTarif += r.count;
      continue;
    }
    const bucket = r.category === 'marketing' ? mktByDay : utilByDay;
    bucket.set(r.date, (bucket.get(r.date) ?? 0) + r.count * verdict.tarif);
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

/** Un volume d'envois facturables d'une campagne, pour une catégorie Meta (marketing / utility / inconnue). */
export interface VolumeCampagneRow {
  campaignId: string;
  nom: string;
  /** Le template de la campagne, `null` pour une campagne à scénario. C'est ce qui décide si un clic existe. */
  template: string | null;
  /**
   * Le canal de la campagne : il décide de la source du prix quand rien n'a été chiffré. Une campagne WhatsApp
   * sans envoi facturable a coûté ses messages de service ; une campagne RCS dont aucun envoi n'a pu être
   * rattaché reste inconnue.
   */
  canal: string;
  category: string | null;
  /**
   * Envois facturables de cette catégorie. `0` (et `category` à `null`) sur la ligne unique d'une campagne qui
   * a touché quelqu'un sans rien de facturable : elle a sa ligne quand même.
   */
  count: number;
  /** Personnes touchées par la campagne sur la période, facturable ou non. Même valeur sur chaque ligne d'une campagne. */
  envois: number;
  /**
   * Les envois de cette campagne ont-ils pu être purgés ? Les envois d'un scénario vivent dans les
   * conversations, que la rétention supprime : sans ce drapeau, une campagne ancienne afficherait 0,00 €, lu
   * « gratuit », au lieu de « on ne sait plus ». Absent vaut `false`.
   */
  horsRetention?: boolean;
}

/**
 * Combien de campagnes le tableau de la synthèse montre au plus (la plage va jusqu'à 366 jours). On garde celles
 * qui ont le plus envoyé, et le tableau dit qu'il tronque. Le SQL en demande une de plus pour le savoir.
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
   * Ce que la colonne « Envoyés » affiche : les personnes touchées sur la période, facturable ou non (« 0 envoyé »
   * se lirait « rien n'est parti » pour une campagne à scénario ou RCS). Jamais moins que `envoyes` : les envois
   * facturables peuvent venir d'une attribution sans borne basse.
   */
  envois: number;
  /**
   * Coût estimé (envois × tarif). `null` quand aucun des envois n'a pu être chiffré : la case reste vide plutôt
   * que d'afficher un zéro qui se lirait « gratuit ».
   */
  cout: number | null;
  /** Envois comptés dans `envoyes` mais absents du coût. Somme des deux causes qui suivent. */
  nonChiffrables: number;
  /** ...dont ceux sans catégorie enregistrée : héritage définitif, cf. `CostSeries.sansCategorie`. */
  sansCategorie: number;
  /** ...dont ceux dont Meta ne rend pas le tarif : panne du jour, réparable, cf. `CostSeries.sansTarif`. */
  sansTarif: number;
  /**
   * Clics sur les liens tracés, depuis le premier envoi. `null` = rien de mesurable (campagne à scénario, ou
   * template sans lien), ce qui n'est pas zéro.
   */
  clics: number | null;
  /**
   * Coût par clic. `null` dès qu'un des deux termes manque ou que les clics valent zéro : un « ∞ » ou un « 0 € »
   * répondrait à une question qu'on n'a pas pu poser.
   */
  coutParClic: number | null;
  /**
   * Les personnes qui se sont engagées : celles qui ont cliqué et celles qui ont répondu (une réponse est un
   * engagement de premier niveau).
   *
   * On compte des personnes, pas des gestes, contrairement à `EtapeCoutCampagne` : le coût par personne engagée
   * se compare d'une campagne à l'autre, alors qu'un coût par geste flatte les campagnes où l'on réagit
   * plusieurs fois. Les clics anonymes n'y sont pas (personne à nommer), `clics` les compte. Optionnel : entre
   * deux déploiements, l'écran retombe sur les clics.
   */
  engagements?: number | null;
  /** Coût par personne engagée. `null` aux mêmes conditions que `coutParClic`. */
  coutParEngagement?: number | null;
}

export interface CoutParCampagne {
  lignes: LigneCoutCampagne[];
  /**
   * La période comptait plus de campagnes que le plafond, et le tableau n'en montre qu'une partie (les plus
   * grosses). L'écran le dit.
   */
  tronque: boolean;
  /** Devise rendue par Meta ; `null` = inconnue, l'écran affiche alors le nombre nu. */
  currency: string | null;
  /** Meta n'a rendu aucun tarif : toute la colonne coût est vide, et l'écran doit dire pourquoi. */
  hasRates: boolean;
}

/**
 * Le tableau « coût par engagement », à partir des volumes par campagne, des tarifs et des clics. Mêmes règles
 * que `estimateCostSeries` : une catégorie inconnue ou sans tarif ne produit aucun coût et se compte à part.
 * Pur ; tri par coût décroissant, puis par envois.
 */
export function estimateCoutParCampagne(
  rows: VolumeCampagneRow[],
  rates: CategoryRates,
  clics: Map<string, number>,
  /**
   * Les personnes engagées par campagne (cliqueurs identifiés et répondeurs, dédoublonnés). Absente = on ne
   * sait pas, l'écran retombe sur les clics : ce n'est pas zéro.
   */
  engagements?: Map<string, number>,
  /**
   * Les messages de service imputés à chaque campagne, et le prix effectif de l'un d'eux : une campagne qui
   * ouvre une conversation ne coûte pas son seul template.
   *
   * 🔴 La franchise mensuelle appartient à l'espace et au mois : elle se répartit au prorata, via le prix
   * effectif (coût total du service / messages de service), sinon on la multiplierait par le nombre de
   * campagnes. La somme des campagnes reste inférieure ou égale au total « messages » (le service hors campagne
   * n'est à personne). Absents = rien d'imputé, pas zéro service.
   */
  service?: { parCampagne: Map<string, number>; prixUnitaire: number },
  /**
   * Les envois RCS imputés à chaque campagne, et la grille qui les tarife. La bascule conversationnelle est
   * déjà tranchée par l'appelant (`basculesRcs`) : elle porte sur l'échange entier sur sept jours, la recalculer
   * ici donnerait un second verdict. Absent = aucun RCS imputé, la case reste vide plutôt qu'à zéro.
   */
  rcs?: { parCampagne: Map<string, { simple: number; conversationnel: number }>; grille: GrillePrix },
  /**
   * Pas de paramètre de marge : elle est posée une seule fois, à la source (`tarifsFactures`), et `rates` porte
   * déjà le prix de vente.
   */
): CoutParCampagne {
  const par = new Map<string, LigneCoutCampagne & { chiffres: number; canal: string; horsRetention: boolean }>();
  for (const r of rows) {
    const ligne = par.get(r.campaignId) ?? {
      campaignId: r.campaignId, nom: r.nom, template: r.template, canal: r.canal,
      envoyes: 0, envois: 0, cout: 0, nonChiffrables: 0, sansCategorie: 0, sansTarif: 0, clics: null, coutParClic: null, chiffres: 0,
      horsRetention: false,
    };
    ligne.envois = Math.max(ligne.envois, r.envois);
    // Le drapeau porte sur la campagne et le SQL le rend identique sur chaque ligne : `||` pour que l'ordre des
    // lignes ne décide de rien.
    ligne.horsRetention = ligne.horsRetention || r.horsRetention === true;
    // Une campagne sans rien de facturable a sa ligne (`count` à 0) : la garde évite seulement un appel inutile.
    if (r.count > 0) {
      // Même partage des deux causes que `estimateCostSeries` : les deux écrans nomment la même chose pareil.
      const verdict = chiffrer(r.category, rates);
      ligne.envoyes += r.count;
      if ('refus' in verdict) {
        if (verdict.refus === 'sansCategorie') ligne.sansCategorie += r.count; else ligne.sansTarif += r.count;
        ligne.nonChiffrables += r.count;
      } else {
        ligne.chiffres += r.count;
        // `rates` porte déjà le prix de vente : la marge est posée une fois par `prixFactures`.
        ligne.cout = (ligne.cout ?? 0) + r.count * verdict.tarif;
      }
    }
    par.set(r.campaignId, ligne);
  }

  const lignes = [...par.values()].map((l) => {
    /**
     * Le service et le RCS s'ajoutent au template, sans créer de coût là où il n'y en avait pas : une campagne
     * dont aucun envoi n'est chiffrable garde sa case vide.
     */
    const services = service?.parCampagne.get(l.campaignId) ?? 0;
    // Le RCS de cette campagne, déjà séparé en simple et conversationnel par l'appelant.
    const envoisRcs = rcs?.parCampagne.get(l.campaignId) ?? { simple: 0, conversationnel: 0 };
    const nbRcs = envoisRcs.simple + envoisRcs.conversationnel;
    const prixRcs = rcs ? coutRcsEuros(envoisRcs.simple, envoisRcs.conversationnel, rcs.grille) : 0;
    const brut = (l.cout ?? 0) + (service ? services * service.prixUnitaire : 0) + prixRcs;
    // Aucun envoi chiffré : case vide, pas zéro. Sauf le RCS (prix de la grille) et une campagne WhatsApp sans
    // rien de facturable (coût connu, son service), si ses envois n'ont pas pu être purgés par la rétention.
    const rienAChiffrer = l.chiffres === 0 && l.nonChiffrables === 0 && nbRcs === 0
      && l.canal === 'whatsapp' && l.horsRetention !== true;
    const cout = l.chiffres > 0 || nbRcs > 0 || rienAChiffrer ? round2(brut) : null;
    const n = clics.get(l.campaignId);
    const nbClics = n === undefined ? null : n;
    // Le ratio n'existe que si ses deux termes existent, et si le dénominateur n'est pas nul.
    const coutParClic = cout !== null && nbClics !== null && nbClics > 0 ? Math.round((cout / nbClics) * 10000) / 10000 : null;
    // Même règle que le coût par clic, sur l'autre dénominateur : les deux termes, et un dénominateur non nul.
    const e = engagements?.get(l.campaignId);
    const nbEngagements = e === undefined ? null : e;
    const coutParEngagement = cout !== null && nbEngagements !== null && nbEngagements > 0
      ? Math.round((cout / nbEngagements) * 10000) / 10000
      : null;
    return {
      // `envois` ne descend jamais sous les envois facturables : voir sa documentation, et le cas de l'attribution.
      campaignId: l.campaignId, nom: l.nom, template: l.template, envoyes: l.envoyes, envois: Math.max(l.envois, l.envoyes), cout,
      nonChiffrables: l.nonChiffrables, sansCategorie: l.sansCategorie, sansTarif: l.sansTarif,
      clics: nbClics, coutParClic, engagements: nbEngagements, coutParEngagement,
    };
  });
  /**
   * On tronque sur le volume, on affiche sur le coût : le SQL, qui ne connaît pas les tarifs, garde les N+1
   * campagnes qui ont le plus envoyé. On rejoue exactement ce critère (`envois`, la colonne affichée, puis
   * l'identifiant), on coupe, puis on trie au coût. Trier au coût avant de couper mélangerait les deux critères.
   */
  const tronque = lignes.length > PLAFOND_CAMPAGNES_SYNTHESE;
  const gardees = tronque
    ? [...lignes].sort((a, b) => b.envois - a.envois || a.campaignId.localeCompare(b.campaignId)).slice(0, PLAFOND_CAMPAGNES_SYNTHESE)
    : lignes;
  gardees.sort((a, b) => (b.cout ?? -1) - (a.cout ?? -1) || b.envois - a.envois || a.nom.localeCompare(b.nom));

  return {
    lignes: gardees,
    tronque,
    currency: rates.currency ?? null,
    hasRates: rates.marketing != null || rates.utility != null,
  };
}

/** Un volume d'envois facturables vers un contact, pour une catégorie Meta. */
export interface VolumeContactRow {
  category: string | null;
  count: number;
}

/** Ce qu'un contact a coûté, et ce qu'on n'a pas su chiffrer. */
export interface CoutContact {
  /** Envois facturables, chiffrables ou non. */
  envoyes: number;
  /**
   * Coût estimé. `null` quand aucun envoi n'a pu être chiffré : pas de zéro qui se lirait « ce contact ne nous
   * a rien coûté ».
   */
  cout: number | null;
  nonChiffrables: number;
  sansCategorie: number;
  sansTarif: number;
  currency: string | null;
}

/**
 * Ce qu'un contact a coûté, à partir de ses envois par catégorie et des tarifs, par le même `chiffrer` que les
 * autres écrans. Ne compte que les envois de campagne : un message de scénario ou une réponse dans la fenêtre de
 * service n'y entre pas (Meta les facture souvent à zéro, pas toujours). Le chiffre est un plancher, pas une
 * facture.
 */
export function estimerCoutContact(rows: VolumeContactRow[], rates: CategoryRates): CoutContact {
  return { ...chiffrerVolume(rows, rates), currency: rates.currency ?? null };
}

/**
 * Chiffre un volume d'envois : combien sont partis, combien sont chiffrés, et pourquoi les autres ne le sont
 * pas, par la règle unique `chiffrer`. `cout` vaut `null` quand aucun n'a pu l'être : zéro se lirait « gratuit ».
 */
export function chiffrerVolume(
  rows: ReadonlyArray<{ category: string | null; count: number }>,
  rates: CategoryRates,
): Omit<CoutContact, 'currency'> {
  let envoyes = 0, chiffres = 0, cout = 0, sansCategorie = 0, sansTarif = 0;
  for (const r of rows) {
    envoyes += r.count;
    const verdict = chiffrer(r.category, rates);
    if ('refus' in verdict) {
      if (verdict.refus === 'sansCategorie') sansCategorie += r.count; else sansTarif += r.count;
      continue;
    }
    chiffres += r.count;
    cout += r.count * verdict.tarif;
  }
  return {
    envoyes,
    cout: chiffres > 0 ? round2(cout) : null,
    nonChiffrables: sansCategorie + sansTarif,
    sansCategorie,
    sansTarif,
  };
}

/**
 * Combien de niveaux l'entonnoir d'un contact montre au plus : au-delà du cinquième échange, ce n'est plus une
 * progression dans un scénario mais un dialogue, qui se lit dans l'Inbox.
 */
export const NIVEAUX_MONTRES = 5;

/** Un niveau de l'entonnoir : combien de parcours l'ont atteint, au moins. */
export interface NiveauEngagement {
  niveau: number;
  parcours: number;
}

/**
 * L'entonnoir cumulé, à partir des profondeurs atteintes parcours par parcours. « Au moins N », pas
 * « exactement N » : un scénario n'avance que sur une réaction, donc atteindre le niveau 3 implique les deux
 * premiers. Le dernier niveau montré ramasse ce qui est plus profond, au lieu de le tronquer.
 */
export function entonnoirEngagement(profondeurs: readonly number[]): NiveauEngagement[] {
  const out: NiveauEngagement[] = [];
  for (let n = 1; n <= NIVEAUX_MONTRES; n += 1) {
    out.push({ niveau: n, parcours: profondeurs.filter((p) => p >= n).length });
  }
  // Un entonnoir qui ne commence par rien n'a rien à dire : l'écran préfère ne pas l'afficher du tout.
  return out[0]!.parcours === 0 ? [] : out;
}
