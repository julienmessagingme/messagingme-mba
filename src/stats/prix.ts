/**
 * LA GRILLE DE PRIX D'UN ESPACE : ce qu'il FACTURE, la ou l'API de Meta dit ce qu'il COUTE.
 *
 * 🔴 CE SONT DES PRIX DE VENTE (decide avec Julien le 2026-09-17). Le tarif des templates vient de Meta ;
 * le message de service, le RCS simple et le RCS conversationnel ne viennent d'aucune API et se saisissent.
 *
 * 🔴 UNE SEULE GRILLE POUR TOUS LES ESPACES, DANS `/ops` (arbitrage de Julien du 2026-09-23, migration
 * 0168). Ce paragraphe disait l'inverse et il faut dire ce qui a change, pas l'effacer : « par ESPACE et
 * pas en configuration globale, le tarif smsmode se negocie, et un grand compte ne se facture pas comme un
 * petit ». Cette raison-la n'a pas disparu, elle a ete PESEE contre une autre et elle a perdu : un client
 * n'a pas a fixer, ni meme a voir, ce qu'on lui facture, et l'ecran « Vos prix » de ses Parametres le lui
 * laissait faire. Le jour ou un grand compte demandera son prix, ce sera une SURCHARGE par espace a
 * rouvrir, pas un oubli a reparer.
 *
 * ⚠️ ET CE N'EST PAS UNE CONSTANTE D'ENVIRONNEMENT, ce qui etait le vrai grief du paragraphe d'origine :
 * la grille vit en base, donc elle se change sans deploiement, depuis `/ops`.
 *
 * 🔴 UNE MARGE SUR LE TARIF META, PAS UNE GRILLE DE PRIX DE TEMPLATE. Meta change ses tarifs par pays et
 * par periode : une grille saisie a la main aurait derive en silence, en restant plausible. Or un prix
 * plausible et faux est le pire mode de panne ici, parce qu'un client en tire un budget et que rien a
 * l'ecran ne le contredit. La marge garde Meta comme source unique.
 *
 * Module PUR : aucune base, aucun reseau. C'est ici que se decident les prix, donc ici qu'ils se testent.
 */

/** Ce qu'un espace FACTURE. Voyage en objet IMBRIQUE, jamais en six champs a plat : cf. `grilleDepuisLigne`. */
export interface GrillePrix {
  /** En POURCENT du tarif Meta. 100 = on facture le tarif Meta, et c'est le defaut. */
  margeTemplate: number;
  /** Prix d'UN message de service, en centimes. */
  serviceCentimes: number;
  /** Messages de service offerts par mois. ⚠️ Par ESPACE ici, par NUMERO chez Meta : cf. migration 0154. */
  serviceFranchise: number;
  /** Date d'effet de la facturation des messages de service, en ISO court 'YYYY-MM-DD'. */
  serviceDepuis: string;
  rcsSimpleCentimes: number;
  rcsConversationnelCentimes: number;
}

/**
 * Les defauts, qui sont des DECISIONS et pas des constantes techniques (Julien, 2026-09-17).
 *
 * 🔴 `margeTemplate: 100` NE CHANGE RIEN, ET C'EST TOUT SON INTERET. Une instance qui n'a jamais ouvert le
 * reglage facture exactement le tarif Meta, donc lit aujourd'hui le meme chiffre qu'hier. Un defaut qui
 * margerait tout seul ferait bouger un nombre que des clients ont deja lu.
 *
 * ⚠️ ILS SERVENT ENCORE, ET PAS SEULEMENT AU PREMIER JOUR : `grilleDepuisLigne` retombe dessus quand la
 * ligne est absente, ce qui arrive entre le deploiement de la console et celui de l'API (la table
 * `grille_prix` n'existe pas encore). Un zero y ferait lire « gratuit » sur tous les ecrans de cout.
 */
/**
 * CE QUE COUTE UN LOT DE RCS, en euros. Deux tarifs, aucune franchise, aucun message de service.
 *
 * 🔴 UNE SEULE FORMULE POUR LES DEUX ECRANS QUI L'AFFICHENT (le total des messages envoyes, et le cout par
 * engagement campagne par campagne). Elle tenait en une ligne, ce qui est exactement la raison pour laquelle
 * elle allait etre recopiee : deux ecrans du meme onglet, deux additions, et le jour ou un tarif change de
 * place l'une des deux reste plausible. Le depot applique deja cette regle a `chiffrer`.
 *
 * ⚠️ LES PRIX SONT EN CENTIMES DANS LA GRILLE, le resultat est en EUROS : c'est la conversion qu'on oublie
 * en recopiant, et elle rend un chiffre cent fois trop grand sans qu'aucun type ne bronche.
 */
export function coutRcsEuros(simple: number, conversationnel: number, g: GrillePrix): number {
  return Math.round((simple * g.rcsSimpleCentimes + conversationnel * g.rcsConversationnelCentimes)) / 100;
}

export const GRILLE_DEFAUT: GrillePrix = {
  margeTemplate: 100,
  serviceCentimes: 2.48,
  serviceFranchise: 1000,
  serviceDepuis: '2026-10-01',
  rcsSimpleCentimes: 6,
  rcsConversationnelCentimes: 8,
};

/**
 * Le prix FACTURE d'un template, a partir du tarif rendu par Meta.
 *
 * ⚠️ ARRONDI A 1e-4, LE MEME QUE LES RATIOS DE `cost.ts`. Deux arrondis differents feraient diverger le
 * total de la carte de celui du graphe des que le volume monte, et l'ecart serait attribue a n'importe
 * quoi sauf a un arrondi.
 */
export function prixTemplate(tarifMeta: number, g: GrillePrix): number {
  return Math.round(tarifMeta * (g.margeTemplate / 100) * 10000) / 10000;
}

/** Un `numeric` Postgres arrive en CHAINE (le pilote ne le convertit pas : il ne rentre pas dans un `number`
 *  sans perte). Sans cette conversion, une addition de prix concatenerait des chaines au lieu de sommer. */
function nombre(v: unknown, defaut: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return defaut;
}

/** Une `date` Postgres arrive en objet `Date`. Elle se COMPARE a un mois ('2026-09'), donc elle doit
 *  voyager en texte : un `Date` traverserait JSON en ISO complet avec un fuseau, et la comparaison de mois
 *  deviendrait fausse d'un jour pres aux frontieres de mois. */
/**
 * Un JOUR CIVIL, lu depuis une colonne `date`.
 *
 * 🔴 EN COMPOSANTES LOCALES, ET `toISOString()` EST LE PIEGE. node-postgres rend une colonne `date` en
 * `Date` positionnee a MINUIT LOCAL : minuit du 1er novembre a Paris vaut `2026-10-31T23:00Z`, donc
 * `toISOString().slice(0, 10)` rend **la veille**. La premiere version faisait exactement ca : la date
 * d'effet de la facturation du service reculait d'un jour pour tout le monde, defaut compris, et les
 * messages du 30 septembre se seraient factures. Personne ne l'aurait vu a l'ecran, puisque la date
 * affichee aurait ete celle enregistree, fausse des les deux cotes.
 *
 * ⚠️ TROUVE PAR UNE SONDE, PAS PAR UN TEST, et c'est ce qui compte ici : un aller-retour reel en base
 * (2026-11-01 ecrit, 2026-10-31 relu) dans une session isolee. Un test unitaire qui tourne en UTC ne peut
 * PAS distinguer les deux ecritures, l'ecart etant nul a decalage zero ; celui qui suit ne discrimine donc
 * que sur une machine a decalage non nul, et il le dit.
 */
function jour(v: unknown, defaut: string): string {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return defaut;
    const mm = String(v.getMonth() + 1).padStart(2, '0');
    const jj = String(v.getDate()).padStart(2, '0');
    return `${v.getFullYear()}-${mm}-${jj}`;
  }
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  return defaut;
}

/**
 * La grille d'un espace, lue depuis sa ligne de reglages.
 *
 * 🔴 CHAQUE CHAMP RETOMBE SUR LE DEFAUT, ET CE N'EST PAS DE LA PRUDENCE DECORATIVE. La console part sur
 * Vercel a chaque push quand l'API se deploie a la main sur le VPS, et la migration 0154 s'applique entre
 * les deux : une ligne lue avant qu'elle passe ne porte AUCUNE de ces colonnes. Sans repli, `margeTemplate`
 * vaudrait `undefined`, `tarif * (undefined / 100)` rendrait `NaN`, et l'ecran afficherait un prix vide
 * sans rien expliquer a personne.
 *
 * ⚠️ UN OBJET IMBRIQUE, ET PAS SIX CHAMPS A PLAT dans les reglages. C'est la regle du `Pick` recopie du
 * `CLAUDE.md` : une liste de champs retransmise a la main derive, et le controle des proprietes en trop ne
 * traverse pas un spread. Un objet se transmet d'un seul tenant, donc il ne peut pas perdre un membre en
 * chemin.
 */
export function grilleDepuisLigne(ligne: Record<string, unknown> | null | undefined): GrillePrix {
  const l = ligne ?? {};
  return {
    margeTemplate: nombre(l.prix_marge_template, GRILLE_DEFAUT.margeTemplate),
    serviceCentimes: nombre(l.prix_service_centimes, GRILLE_DEFAUT.serviceCentimes),
    serviceFranchise: nombre(l.prix_service_franchise, GRILLE_DEFAUT.serviceFranchise),
    serviceDepuis: jour(l.prix_service_depuis, GRILLE_DEFAUT.serviceDepuis),
    rcsSimpleCentimes: nombre(l.prix_rcs_centimes, GRILLE_DEFAUT.rcsSimpleCentimes),
    rcsConversationnelCentimes: nombre(l.prix_rcs_conv_centimes, GRILLE_DEFAUT.rcsConversationnelCentimes),
  };
}

/**
 * LES BORNES DE SAISIE D'UNE GRILLE, ET ELLES SONT CELLES DE LA MIGRATION 0154, PAS D'AUTRES.
 *
 * 🔴 DEUX JEUX DE BORNES POUR UNE MEME VALEUR, C'EST UN 500 AU LIEU D'UN MESSAGE. Si l'ecriture acceptait
 * plus large que le CHECK, Postgres refuserait la ligne et le client verrait une page d'erreur sur un geste
 * ordinaire ; si elle acceptait plus etroit, un reglage legitime serait refuse sans raison lisible. Les
 * deux ecritures de la meme regle vivent donc cote a cote, et `tests/prix-bornes.test.ts` RELIT le fichier
 * SQL pour verifier qu'elles ne derivent pas (et pas `prix-grille.test.ts`, que cette phrase a nomme a tort).
 *
 * ⚠️ Les plafonds ne sont pas de la prudence, ils attrapent une FAUTE DE FRAPPE : 248 au lieu de 2,48, ou
 * 10000 au lieu de 100. Une valeur plausible et fausse est le pire mode de panne ici, parce qu'un client en
 * tire un budget et que rien a l'ecran ne le contredit.
 */
export const BORNES_GRILLE = {
  margeTemplate: { min: 1, max: 1000 },
  centimes: { min: 0, max: 100 },
  franchise: { min: 0, max: 1_000_000 },
} as const;

/** `YYYY-MM-DD` et rien d'autre : la date d'effet se compare a des mois, elle doit etre un jour civil. */
const JOUR_ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Le format NE SUFFIT PAS : la date doit EXISTER.
 *
 * 🔴 `2026-02-31` PASSE LE FORMAT ET FAIT UN 500. Le `$5::date` de l'ecriture leve alors
 * `date/time field value out of range`, non attrape, donc une page d'erreur sur un geste ordinaire :
 * c'est tres exactement le mode de panne que les bornes de ce fichier disent avoir ferme (« un 500 au lieu
 * d'un message »). L'`input type="date"` protege le navigateur, jamais la route. Releve en revue finale le
 * 2026-09-18.
 *
 * ⚠️ ON RECONSTRUIT LA DATE ET ON COMPARE : `new Date('2026-02-31')` ne leve pas, il DECALE au 3 mars.
 * C'est le decalage qu'on detecte, pas une exception.
 */
function jourExiste(iso: string): boolean {
  const [a, m, j] = iso.split('-').map(Number) as [number, number, number];
  const d = new Date(Date.UTC(a, m - 1, j));
  return d.getUTCFullYear() === a && d.getUTCMonth() === m - 1 && d.getUTCDate() === j;
}

/**
 * Valide une grille SAISIE et la rend normalisee, ou nomme le champ fautif.
 *
 * 🔴 ELLE REFUSE, ELLE NE CORRIGE PAS. Ramener une valeur hors bornes dans les bornes (« 248 -> 100 »)
 * enregistrerait un prix que personne n'a choisi, et le client lirait ensuite une facture batie dessus sans
 * jamais savoir que sa saisie avait ete reecrite. Le seul geste sur : dire lequel des six champs ne va pas.
 *
 * ⚠️ TOUS LES CHAMPS SONT REQUIS, il n'y a pas de grille partielle. Un `patch` a un champ obligerait a
 * fusionner avec l'existant a l'ecriture, et c'est exactement la ou le depot s'est deja fait avoir : une
 * liste REMPLACEE au lieu d'etre fusionnee. L'ecran envoie les six, toujours.
 */
export function valideGrille(entree: unknown): { ok: true; grille: GrillePrix } | { ok: false; champ: string } {
  const e = (entree ?? {}) as Record<string, unknown>;
  const borne = (v: unknown, min: number, max: number): boolean =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

  const { margeTemplate: mt, centimes: c, franchise: f } = BORNES_GRILLE;
  /**
   * 🔴 LA COMPARAISON SE FAIT A EPSILON, ET L EGALITE STRICTE REFUSAIT UN PRIX SUR NEUF. `2.47 * 100` vaut
   * `247.00000000000003` en virgule flottante : `Math.round(v * 100) === v * 100` rendait donc FAUX, et un
   * client qui tapait 2,47 lisait « champ invalide » sans la moindre explication. Mesure : 1146 refus sur
   * les 10001 valeurs a deux decimales entre 0 et 100, dont 1,15, 9,95, 8,2, 0,07 et 2,03. Mes propres
   * tests ne le voyaient pas parce que les quatre defauts (2,48, 100, 6, 8) tombent tous du bon cote du
   * flottant. Releve en revue le 2026-09-18, une heure apres l avoir ecrit.
   */
  const deuxDecimalesMax = (v: unknown): boolean =>
    typeof v === 'number' && Number.isFinite(v) && Math.abs(v * 100 - Math.round(v * 100)) < 1e-9;

  /**
   * 🔴 DEUX DECIMALES, COMME SA COLONNE, ET CETTE REGLE A CHANGE DEUX FOIS EN UNE HEURE. Elle a d abord
   * accepte n importe quel decimal sur la foi d un commentaire qui annoncait `numeric(6,2)` alors que la
   * colonne etait un `smallint` : Postgres rejetait, donc 500 sur un geste ordinaire. Puis elle a exige un
   * ENTIER, ce qui tenait le type mais RETRECISSAIT le produit : une marge de 120,5 %, soit +20,5 %, est
   * banale, et l ecran la refusait sans pouvoir dire pourquoi puisqu elle est dans les bornes annoncees.
   * La migration n etant pas encore appliquee, c est la COLONNE qui a ete elargie. Un type choisi sans y
   * penser ne doit pas decider de ce qu un client a le droit de facturer.
   */
  if (!borne(e.margeTemplate, mt.min, mt.max) || !deuxDecimalesMax(e.margeTemplate)) return { ok: false, champ: 'margeTemplate' };
  if (!borne(e.serviceCentimes, c.min, c.max) || !deuxDecimalesMax(e.serviceCentimes)) return { ok: false, champ: 'serviceCentimes' };
  if (!borne(e.serviceFranchise, f.min, f.max) || !Number.isInteger(e.serviceFranchise)) return { ok: false, champ: 'serviceFranchise' };
  if (typeof e.serviceDepuis !== 'string' || !JOUR_ISO.test(e.serviceDepuis) || !jourExiste(e.serviceDepuis)) return { ok: false, champ: 'serviceDepuis' };
  if (!borne(e.rcsSimpleCentimes, c.min, c.max) || !deuxDecimalesMax(e.rcsSimpleCentimes)) return { ok: false, champ: 'rcsSimpleCentimes' };
  if (!borne(e.rcsConversationnelCentimes, c.min, c.max) || !deuxDecimalesMax(e.rcsConversationnelCentimes)) return { ok: false, champ: 'rcsConversationnelCentimes' };

  return {
    ok: true,
    grille: {
      margeTemplate: e.margeTemplate as number,
      serviceCentimes: e.serviceCentimes as number,
      serviceFranchise: e.serviceFranchise as number,
      serviceDepuis: e.serviceDepuis,
      rcsSimpleCentimes: e.rcsSimpleCentimes as number,
      rcsConversationnelCentimes: e.rcsConversationnelCentimes as number,
    },
  };
}

/**
 * LES TARIFS DE META, TRANSFORMES EN PRIX DE VENTE. C'EST LE POINT DE PASSAGE UNIQUE DE LA MARGE.
 *
 * 🔴 UN SEUL ENDROIT, ET C'EST TOUT L'INTERET. La marge a d'abord ete posee dans les deux fonctions qui
 * calculaient un total (le cout des messages, le tableau des campagnes). Deux AUTRES consommateurs des
 * memes tarifs l'ignoraient donc : le graphe de cout du Quantitatif et le bilan d'un contact affichaient le
 * tarif Meta BRUT. Des qu'un client posait une marge de 150, la Synthese annoncait 1,50 € la ou le graphe
 * du meme produit annoncait 1,00 € pour exactement les memes envois. Releve en revue finale le 2026-09-18.
 * En margeant a la SOURCE, les cinq consommateurs sont justes, et le sixieme qu'on ajoutera demain aussi.
 *
 * 🔴 UN TARIF ABSENT LE RESTE. Marger `null` en ferait un prix, et `chiffrer` ne pourrait plus compter ces
 * envois comme « sans tarif » : ils passeraient de « on ne sait pas ce que ca coute » a « ca coute zero »,
 * ce qui est precisement l'inversion que tout ce module s'interdit.
 */
export function tarifsFactures(
  brut: { marketing?: number | null; utility?: number | null; currency?: string | null },
  g: GrillePrix,
): { marketing: number | null; utility: number | null; currency: string | null } {
  const marge = (tarif: number | null | undefined): number | null => (tarif == null ? null : prixTemplate(tarif, g));
  return { marketing: marge(brut.marketing), utility: marge(brut.utility), currency: brut.currency ?? null };
}

/**
 * UN RESUME DE TARIFS DE META, TRANSFORME EN PRIX DE VENTE, CATEGORIE PAR CATEGORIE.
 *
 * 🔴 IL EXISTE PARCE QUE `tarifsFactures` NE COUVRAIT PAS TOUT LE MONDE. Le resume brut de Meta part aussi
 * vers la carte « Detail par template » du Quantitatif et vers l ecran Campagnes (total, ligne, tiroir de
 * detail), par un AUTRE chemin que les cinq consommateurs deja marges. Sans ce passage, la MEME campagne
 * valait 1,00 € sur l ecran Campagnes et 1,50 € sur sa fiche Performance Lab, et deux cartes de la MEME
 * page annoncaient deux totaux. Trouve a la troisieme revue : l inventaire avait ete fait sur la fonction
 * qui lit les tarifs, alors que la bonne question etait « qui affiche un prix de template a un client ».
 *
 * 🔴 SEUL `ratePerMessage` DEVIENT UN PRIX. `cost` et `totalCost` sont les charges REELLES que Meta a
 * facturees sur la periode : les marger en ferait une projection de vente melangee a une depense constatee,
 * donc un total qui n est ni l un ni l autre. Cette asymetrie est le coeur de la fonction, pas un oubli.
 *
 * ⚠️ TYPE STRUCTUREL, PAS LE TYPE DE META. Ce module est PUR et ne connait pas `src/meta/` : accepter la
 * forme plutot que la classe evite de coupler la grille de prix au client de l API.
 */
/** Les seules categories dont le prix se DERIVE du tarif Meta. Les autres se saisissent, ou ne se vendent pas. */
const CATEGORIES_MARGEES = new Set(['marketing', 'utility']);

export function pricingFacture<C extends { ratePerMessage: number }, T extends { byCategory: Record<string, C> }>(
  brut: T,
  g: GrillePrix,
): T {
  const byCategory: Record<string, C> = {};
  for (const [cle, c] of Object.entries(brut.byCategory)) {
    // 🔴 SEULES LES CATEGORIES DE TEMPLATE SONT MARGEES. Meta rend aussi `service` et `authentication` sur
    // le meme appel, et la marge de ce module porte sur le TARIF DE TEMPLATE, pas sur eux : le prix d un
    // message de service se SAISIT (`serviceCentimes`), il ne se derive d aucun tarif Meta. Les marger
    // rendrait un prix faux, et sans erreur, au premier ecran qui les lirait. Aucun n'en lit aujourd'hui ;
    // la doc de cette fonction invite pourtant a la reutiliser, donc la borne se pose maintenant.
    byCategory[cle] = CATEGORIES_MARGEES.has(cle) ? { ...c, ratePerMessage: prixTemplate(c.ratePerMessage, g) } : c;
  }
  return { ...brut, byCategory };
}
