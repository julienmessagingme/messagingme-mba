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
function jour(v: unknown, defaut: string): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
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
