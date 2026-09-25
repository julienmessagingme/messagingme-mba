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

/** Arrondi au centime, le seul du dépôt pour un montant affiché (coûts, séries, bilans). */
export const round2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * Ce qu'on peut faire d'une catégorie d'envoi : la chiffrer, ou dire POURQUOI on ne peut pas.
 *
 * 🔴 UNE SEULE DÉFINITION DE « CHIFFRABLE », pour les TROIS écrans qui l'affichent (la série de coût, le
 * tableau par campagne, et le bilan d'un contact). Deux définitions donneraient deux totaux sur deux écrans
 * du même produit, et le client les comparerait. La règle était déjà écrite deux fois à l'identique quand le
 * troisième écran est arrivé : c'est le moment où recopier devient une dette, pas avant.
 *
 * ⚠️ LES DEUX CAUSES RESTENT DISTINCTES, parce qu'elles ne se réparent pas pareil : une catégorie absente est
 * un héritage définitif (rien ne la retrouvera), un tarif manquant est une panne du jour (Meta le rendra
 * demain). Un seul nombre les confondait, et l'écran ne pouvait dire ni l'un ni l'autre sans risquer de mentir.
 */
export type Chiffrage = { tarif: number } | { refus: 'sansCategorie' | 'sansTarif' };

export function chiffrer(category: string | null, rates: CategoryRates): Chiffrage {
  if (category !== 'marketing' && category !== 'utility') return { refus: 'sansCategorie' };
  const tarif = category === 'marketing' ? rates.marketing : rates.utility;
  return tarif == null ? { refus: 'sansTarif' } : { tarif };
}

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

/** Un volume d'envois facturables d'UNE campagne, pour UNE catégorie Meta (marketing / utility / inconnue). */
export interface VolumeCampagneRow {
  campaignId: string;
  nom: string;
  /** Le template de la campagne, `null` pour une campagne à scénario. C'est ce qui décide si un clic existe. */
  template: string | null;
  /**
   * Le canal de la campagne.
   *
   * ⚠️ IL NE DECIDE PLUS D'UNE CASE VIDE, IL DECIDE DE LA SOURCE DU PRIX (2026-09-23). Ce tableau a longtemps
   * dit « je ne connais que les tarifs Meta, donc une campagne RCS garde sa case vide » ; c'etait faux depuis
   * la migration 0154, qui porte les deux prix RCS de l'espace. Le canal sert maintenant a savoir quoi faire
   * quand RIEN n'a ete chiffre : une campagne WhatsApp sans envoi facturable a coute ce que coutent ses
   * messages de service, une campagne RCS dont aucun envoi n'a pu etre rattache reste inconnue.
   */
  canal: string;
  category: string | null;
  /**
   * Envois FACTURABLES de cette catégorie. ⚠️ `0` (et `category` à `null`) sur la ligne unique d'une campagne qui
   * a touché quelqu'un sans rien de facturable : elle a sa ligne quand même (lot 4 de la liste du 2026-09-23).
   */
  count: number;
  /** Personnes TOUCHÉES par la campagne sur la période, facturable ou non. Même valeur sur chaque ligne d'une campagne. */
  envois: number;
  /**
   * Les envois de cette campagne ont-ils PU être purgés ?
   *
   * 🔴 CE QUI SÉPARE « ÇA N'A RIEN COÛTÉ » DE « ON NE PEUT PLUS LE SAVOIR ». Les envois d'un SCÉNARIO ne
   * vivent pas dans `campaign_recipients` mais dans les conversations, et la purge de rétention les
   * supprime. Une campagne ancienne rendait donc « zéro envoi facturable », exactement comme une campagne
   * qui n'a vraiment rien facturé, et la case affichait 0,00 €. Sur un écran de coût, un zéro est une
   * affirmation : il se lit « gratuit ».
   *
   * ⚠️ OPTIONNEL, et absent vaut `false` : une instance qui ne calcule pas encore ce drapeau garde le
   * comportement d'avant plutôt que de vider des cases au déploiement.
   */
  horsRetention?: boolean;
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
   * Ce que la colonne « Envoyés » affiche : les personnes TOUCHÉES sur la période, facturable ou non. Une
   * campagne à scénario ou RCS n'a souvent aucun envoi facturable, et « 0 envoyé » se lirait « rien n'est parti ».
   *
   * 🔴 JAMAIS MOINS QUE `envoyes` (revue finale du 2026-09-23). Les envois facturables peuvent venir de
   * l'ATTRIBUTION, qui n'a aucune borne basse : une campagne partie il y a trois semaines dont les modèles
   * partent cette semaine a des envois facturables et AUCUN destinataire daté de la période. Elle affichait
   * alors « 0 envoyés » en face d'un coût, c'est-à-dire l'inverse de ce que ce lot cherche.
   */
  envois: number;
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
  /**
   * LES PERSONNES QUI SE SONT ENGAGÉES : celles qui ont cliqué, ET celles qui ont RÉPONDU.
   *
   * 🔴 UNE RÉPONSE EST UN ENGAGEMENT DE PREMIER NIVEAU (décision de Julien du 2026-09-13, sur un cas
   * réel : « le destinataire n'a pas cliqué mais en revanche il a répondu, c'est comme un clic »).
   * Quelqu'un qui prend la peine d'écrire s'est engagé plus fort que quelqu'un qui clique ; ne pas le
   * compter sous-estimait exactement ce que cette colonne prétend mesurer.
   *
   * 🔴 ON COMPTE DES PERSONNES, PAS DES GESTES, et c'est un écart ASSUMÉ avec `EtapeCoutCampagne`
   * (qui additionne liens + boutons + réponses). Tranché par Julien le 2026-09-13 : diviser un coût
   * par des PERSONNES donne ce que coûte une personne engagée, ce qui se compare d'une campagne à
   * l'autre ; le diviser par des gestes flatte mécaniquement les campagnes dont les gens réagissent
   * plusieurs fois. Quelqu'un qui clique PUIS répond compte donc une fois.
   *
   * ⚠️ LES CLICS ANONYMES N'Y SONT PAS, ET C'EST INÉVITABLE : un lien d'un template approuvé avant le
   * 2026-09-02 n'a pas de jeton, donc son clic n'est rattaché à personne (cf. `clicsAnonymes`). On ne
   * peut pas compter une personne qu'on ne sait pas nommer. `clics` continue de les compter, lui.
   *
   * ⚠️ OPTIONNEL, comme `sansCategorie` et `sansTarif`, et pour la même raison de RÉSEAU : la console
   * part sur Vercel à chaque push, l'API se déploie à la main sur le VPS. Entre les deux, la réponse
   * ne porte pas ce champ, et l'écran doit retomber sur les clics sans rien casser.
   */
  engagements?: number | null;
  /** Coût par personne engagée. `null` aux mêmes conditions que `coutParClic`. */
  coutParEngagement?: number | null;
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
  /**
   * Les PERSONNES engagées par campagne (cliqueurs identifiés et répondeurs, dédoublonnés).
   *
   * ⚠️ ABSENTE = on ne sait pas, et l'écran retombe sur les clics. Ce n'est pas zéro : une campagne
   * sans engagement mesurable et une campagne dont on n'a pas mesuré l'engagement ne se disent pas
   * de la même façon, et c'est la règle que tout ce fichier applique déjà aux trois autres cases.
   */
  engagements?: Map<string, number>,
  /**
   * LES MESSAGES DE SERVICE IMPUTES A CHAQUE CAMPAGNE, et le prix effectif de l'un d'eux.
   *
   * 🔴 LE NUMERATEUR INCLUT LES MESSAGES DE SERVICE, PAS SEULEMENT LES TEMPLATES (décision du cadrage).
   * Une campagne qui ouvre une conversation et fait échanger dix messages de service ne coûte pas son seul
   * template de départ.
   *
   * 🔴 LA FRANCHISE MENSUELLE SE REPARTIT AU PRORATA, ET C'EST LE SEUL PARTAGE QUI NE PRIVILEGIE PERSONNE.
   * Elle appartient à l'ESPACE et au MOIS, pas à une campagne : lui en donner mille gratuits chacune
   * multiplierait la franchise par le nombre de campagnes, et la donner à la première du mois ferait
   * apparaître une campagne gratuite à côté d'une campagne chère pour le même geste. Le prix effectif
   * (`coût total du service / messages de service de la période`) porte donc la franchise déjà déduite, et
   * chaque campagne le paie sur SA part.
   *
   * ⚠️ LA SOMME DES CAMPAGNES RESTE INFERIEURE OU EGALE AU TOTAL DE LA LIGNE « MESSAGES », et c'est
   * correct : les messages de service d'une conversation qu'aucune campagne n'a ouverte n'appartiennent à
   * aucune campagne. Ils sont dans le total de l'espace, pas dans le coût d'un envoi.
   *
   * ⚠️ ABSENTS = on n'impute rien, et le coût reste celui des templates. Ce n'est pas zéro service : c'est
   * une instance qui ne sait pas encore les compter, et la carte doit alors le DIRE.
   */
  service?: { parCampagne: Map<string, number>; prixUnitaire: number },
  /**
   * LES ENVOIS RCS IMPUTES A CHAQUE CAMPAGNE, et la grille qui les tarife.
   *
   * 🔴 LE RCS A UN PRIX, ET CE DEPOT LE CONNAIT (Julien, 2026-09-23 : « on a justement defini un cout, 6 cts
   * si pas conversationnel et 8 si conversationnel »). Il est saisi par espace depuis la migration 0154, et
   * la ligne « cout des messages envoyes » le compte deja. Ne pas le compter ICI laissait une campagne RCS
   * avec une case vide, c'est-a-dire « on ne sait pas » la ou on savait.
   *
   * 🔴 LA BASCULE CONVERSATIONNELLE EST DEJA TRANCHEE PAR L'APPELANT (`basculesRcs`), et ce n'est pas un
   * detail de cablage : la regle porte sur l'ECHANGE entier sur sept jours, donc elle a besoin d'envois que
   * cette campagne n'a pas faits. La recalculer ici avec les seules donnees d'une campagne donnerait un
   * SECOND verdict, plus faible, sur la meme question.
   *
   * ⚠️ ABSENT = on n'impute aucun RCS. Ce n'est pas « zero RCS » : c'est une instance qui ne sait pas encore
   * les rattacher, et la case doit alors rester vide plutot que d'afficher un zero.
   */
  rcs?: { parCampagne: Map<string, { simple: number; conversationnel: number }>; grille: GrillePrix },
  /**
   * ⚠️ IL N Y A PLUS DE PARAMETRE DE MARGE ICI, ET C EST VOLONTAIRE. Elle a vecu a cette place quelques
   * heures, le temps qu une revue montre que deux AUTRES consommateurs des memes tarifs l ignoraient. Elle
   * est desormais posee UNE SEULE FOIS, a la source (`tarifsFactures`), donc `rates` porte deja le prix de
   * VENTE quand il arrive ici. Le parametre a ete laisse en place une heure de plus, mort, avec dix lignes
   * de documentation affirmant qu il s appliquait : un appelant qui l aurait cru et aurait passe 150 aurait
   * vu sa marge avalee en silence, sans erreur du compilateur (il etait optionnel) ni d aucun test.
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
    // ⚠️ UNE SEULE LIGNE SUFFIT A LE POSER : le drapeau porte sur la CAMPAGNE, pas sur une categorie, et le
    // SQL le rend identique sur chacune de ses lignes. `||` plutot qu'une affectation, pour que l'ordre des
    // lignes ne decide de rien.
    ligne.horsRetention = ligne.horsRetention || r.horsRetention === true;
    // ⚠️ UNE CAMPAGNE SANS RIEN DE FACTURABLE A SA LIGNE (lot 4) : `count` à 0, aucune catégorie à juger. La
    // garde ÉVITE UN APPEL INUTILE à `chiffrer`, rien de plus : tous les compteurs ci-dessous s'incrémenteraient
    // de zéro sans elle. Ne pas lui prêter un effet qu'elle n'a pas (relevé en revue le 2026-09-23).
    if (r.count > 0) {
      // ⚠️ MÊME PARTAGE DES DEUX CAUSES QUE `estimateCostSeries`, et pour la même raison qu'elles y sont
      // partagées : les deux écrans du même onglet doivent nommer la même chose de la même façon.
      const verdict = chiffrer(r.category, rates);
      ligne.envoyes += r.count;
      if ('refus' in verdict) {
        if (verdict.refus === 'sansCategorie') ligne.sansCategorie += r.count; else ligne.sansTarif += r.count;
        ligne.nonChiffrables += r.count;
      } else {
        ligne.chiffres += r.count;
        // `rates` porte DEJA le prix de vente : la marge est posee une fois pour toutes par `prixFactures`.
        ligne.cout = (ligne.cout ?? 0) + r.count * verdict.tarif;
      }
    }
    par.set(r.campaignId, ligne);
  }

  const lignes = [...par.values()].map((l) => {
    /**
     * LE SERVICE S'AJOUTE AU TEMPLATE, et l'ordre des deux gardes compte.
     *
     * 🔴 IL NE CREE PAS DE COUT LA OU IL N'Y EN AVAIT PAS. Une campagne dont AUCUN envoi n'est chiffrable
     * (catégorie inconnue, tarif absent) garde sa case VIDE : afficher le seul coût de ses messages de
     * service se lirait « voilà ce qu'elle a coûté », alors que la vérité reste « on ne sait pas ». La
     * règle des trois cases vides de ce fichier ne se contourne pas par une addition.
     */
    const services = service?.parCampagne.get(l.campaignId) ?? 0;
    // Le RCS de cette campagne, deja separe en simple et conversationnel par l'appelant.
    const envoisRcs = rcs?.parCampagne.get(l.campaignId) ?? { simple: 0, conversationnel: 0 };
    const nbRcs = envoisRcs.simple + envoisRcs.conversationnel;
    const prixRcs = rcs ? coutRcsEuros(envoisRcs.simple, envoisRcs.conversationnel, rcs.grille) : 0;
    const brut = (l.cout ?? 0) + (service ? services * service.prixUnitaire : 0) + prixRcs;
    // Aucun envoi chiffré -> la case COÛT est vide, pas à zéro. Un zéro se lirait « cette campagne n'a rien
    // coûté », alors que la vérité est « on ne sait pas ce qu'elle a coûté ».
    // 🔴 SAUF QUAND IL N'Y AVAIT RIEN À CHIFFRER (lot 4) : une campagne WhatsApp sans aucun envoi facturable a
    // un coût CONNU, celui de ses messages de service (souvent nul). Une campagne RCS, elle, garde sa case
    // vide : ce tableau ne connaît que les tarifs Meta, et « 0 » y serait faux.
    // 🔴 ET LE RCS COMPTE COMME UN ENVOI CHIFFRE : son prix vient de la grille de l'espace, pas de Meta.
    // Une campagne RCS qui a touche quelqu'un a donc un cout, la ou elle affichait « — » (2026-09-23).
    // ⚠️ MAIS UNE CAMPAGNE RCS SANS AUCUN ENVOI RATTACHE GARDE SA CASE VIDE : ecrire 0 la dirait gratuite,
    // alors qu'elle a envoye et que c'est le rattachement qui manque (une campagne anterieure a la
    // migration 0134, un envoi sans identifiant). La doctrine des cases vides de ce fichier tient : zero se
    // lit « rien coute », vide se lit « on ne sait pas ».
    //
    // 🔴 ET UNE CAMPAGNE DONT LES ENVOIS ONT PU ETRE PURGES N'A PLUS DE COUT CONNU (jaune de la revue du
    // 2026-09-23). Les envois d'un scenario vivent dans les conversations, que la retention supprime : passe
    // cette borne, « zero envoi facturable » ne veut plus dire « rien n a ete facture ». Sans ce terme, une
    // campagne de plus de 90 jours serait passee de son vrai cout a 0,00 €, toute seule, un matin.
    const rienAChiffrer = l.chiffres === 0 && l.nonChiffrables === 0 && nbRcs === 0
      && l.canal === 'whatsapp' && l.horsRetention !== true;
    const cout = l.chiffres > 0 || nbRcs > 0 || rienAChiffrer ? Math.round(brut * 100) / 100 : null;
    const n = clics.get(l.campaignId);
    const nbClics = n === undefined ? null : n;
    // Le ratio n'existe que si ses DEUX termes existent, et si le dénominateur n'est pas nul.
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
  // 🔴 ET LE CRITÈRE EST CELUI QUE LA COLONNE MONTRE (`envois`, revue finale du 2026-09-23). Trié sur les seuls
  // envois FACTURABLES, tout ce qui n'a rien de facturable se retrouvait à égalité (0), départagé par
  // l'identifiant : au-delà de 50 campagnes, une campagne à scénario de 5 000 personnes sortait pendant qu'une
  // campagne à un seul envoi restait, sous une phrase qui dit « celles qui ont le plus envoyé ».
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

/** Un volume d'envois facturables vers UN contact, pour UNE catégorie Meta. */
export interface VolumeContactRow {
  category: string | null;
  count: number;
}

/** Ce qu'un contact a coûté, et ce qu'on n'a pas su chiffrer. */
export interface CoutContact {
  /** Envois facturables, chiffrables ou non. */
  envoyes: number;
  /**
   * Coût ESTIMÉ. `null` quand AUCUN envoi n'a pu être chiffré : la case reste vide et le dit, plutôt qu'un
   * zéro qui se lirait « ce contact ne nous a rien coûté ».
   */
  cout: number | null;
  nonChiffrables: number;
  sansCategorie: number;
  sansTarif: number;
  currency: string | null;
}

/**
 * Ce qu'un contact a coûté, à partir de ses envois par catégorie et des tarifs Meta.
 *
 * 🔴 LES MÊMES RÈGLES QUE LES DEUX AUTRES ÉCRANS, par le MÊME `chiffrer` : un client qui compare le coût
 * d'un contact au coût de la campagne qui le lui a envoyé doit retrouver la même arithmétique.
 *
 * ⚠️ IL NE COMPTE QUE LES ENVOIS DE CAMPAGNE, et c'est une limite à dire plutôt qu'à taire : un message de
 * scénario ou une réponse d'opérateur dans la fenêtre de service ne passe pas par `campaign_recipients`,
 * donc n'entre pas ici. Meta les facture souvent à zéro (`FREE_CUSTOMER_SERVICE`, mesuré sur notre WABA),
 * mais pas toujours. Le chiffre est donc un PLANCHER, jamais une facture.
 */
export function estimerCoutContact(rows: VolumeContactRow[], rates: CategoryRates): CoutContact {
  return { ...chiffrerVolume(rows, rates), currency: rates.currency ?? null };
}

/**
 * Chiffre un VOLUME d'envois (le bilan d'un contact, le lancement et les relances d'une campagne) : combien
 * sont partis, combien sont chiffrés, et POURQUOI les autres ne le sont pas, par la règle unique `chiffrer`.
 * `cout` vaut `null` quand AUCUN n'a pu l'être : zéro se lirait « gratuit ».
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
 * Combien de niveaux l'entonnoir d'un contact montre au plus.
 *
 * 🔴 UNE BORNE, PAS UN CONFORT. Mesuré sur les données réelles le 2026-09-11 : sans borne de temps ni de
 * profondeur, un contact bavard produisait des « niveaux » 27 et 35, c'est-à-dire une conversation racontée
 * comme un entonnoir. Au-delà du cinquième échange, ce n'est plus une progression dans un scénario, c'est un
 * dialogue, et il se lit dans l'Inbox.
 */
export const NIVEAUX_MONTRES = 5;

/** Un niveau de l'entonnoir : combien de parcours l'ont atteint, AU MOINS. */
export interface NiveauEngagement {
  niveau: number;
  parcours: number;
}

/**
 * L'entonnoir CUMULÉ, à partir des profondeurs atteintes parcours par parcours.
 *
 * 🔴 « AU MOINS N », PAS « EXACTEMENT N », et c'est ce qui en fait un entonnoir. Quelqu'un qui est allé
 * jusqu'au troisième message a forcément réagi au premier et au deuxième : un scénario n'avance QUE sur une
 * réaction. Compter « exactement » rendrait une suite non décroissante, illisible comme entonnoir, et ferait
 * disparaître du niveau 1 les contacts les plus engagés.
 *
 * ⚠️ LE DERNIER NIVEAU MONTRÉ RAMASSE CE QUI EST PLUS PROFOND, au lieu de le tronquer : sinon un parcours
 * allé au septième échange sortirait de l'entonnoir, et le total du niveau 5 serait faux vers le bas.
 */
export function entonnoirEngagement(profondeurs: readonly number[]): NiveauEngagement[] {
  const out: NiveauEngagement[] = [];
  for (let n = 1; n <= NIVEAUX_MONTRES; n += 1) {
    out.push({ niveau: n, parcours: profondeurs.filter((p) => p >= n).length });
  }
  // Un entonnoir qui ne commence par rien n'a rien à dire : l'écran préfère ne pas l'afficher du tout.
  return out[0]!.parcours === 0 ? [] : out;
}
