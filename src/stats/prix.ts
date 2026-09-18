/**
 * LA GRILLE DE PRIX D'UN ESPACE : ce qu'il FACTURE, la ou l'API de Meta dit ce qu'il COUTE.
 *
 * 🔴 CE SONT DES PRIX DE VENTE (decide avec Julien le 2026-09-17). Le tarif des templates vient de Meta ;
 * le message de service, le RCS simple et le RCS conversationnel ne viennent d'aucune API et se saisissent.
 * Par ESPACE et pas en configuration globale : le tarif smsmode se negocie, et un grand compte ne se
 * facture pas comme un petit. Une constante d'environnement aurait impose le meme prix a tout le monde et
 * demande un deploiement pour en changer un.
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
 * 🔴 `margeTemplate: 100` NE CHANGE RIEN, ET C'EST TOUT SON INTERET. Un espace qui n'a jamais ouvert le
 * reglage facture exactement le tarif Meta, donc lit aujourd'hui le meme chiffre qu'hier. Un defaut qui
 * margerait tout seul ferait bouger un nombre que des clients ont deja lu.
 */
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
 * deux ecritures de la meme regle vivent donc cote a cote, et `tests/prix-grille.test.ts` RELIT le fichier
 * SQL pour verifier qu'elles ne derivent pas.
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
  if (!borne(e.margeTemplate, mt.min, mt.max)) return { ok: false, champ: 'margeTemplate' };
  if (!borne(e.serviceCentimes, c.min, c.max)) return { ok: false, champ: 'serviceCentimes' };
  if (!borne(e.serviceFranchise, f.min, f.max) || !Number.isInteger(e.serviceFranchise)) return { ok: false, champ: 'serviceFranchise' };
  if (typeof e.serviceDepuis !== 'string' || !JOUR_ISO.test(e.serviceDepuis)) return { ok: false, champ: 'serviceDepuis' };
  if (!borne(e.rcsSimpleCentimes, c.min, c.max)) return { ok: false, champ: 'rcsSimpleCentimes' };
  if (!borne(e.rcsConversationnelCentimes, c.min, c.max)) return { ok: false, champ: 'rcsConversationnelCentimes' };

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
