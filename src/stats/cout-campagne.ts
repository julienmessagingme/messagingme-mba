import type { CategoryRates } from './cost';
import type { NodeEventCount } from '../workflow/node-events.pg';

/**
 * LE DÉTAIL D'UNE CAMPAGNE : ce qu'elle a coûté, et ce que les gens en ont fait.
 *
 * Demandé par Julien le 2026-09-09 : « quand on clique sur une des lignes de ce tableau, on voit en détail
 * ce qui s'est passé pour cette campagne : coût de lancement (tu enlèves bien les failed j'espère), les
 * coûts du clic sur le template initial, et s'il y a eu un lancement de scénario, le nombre de clics par
 * étape, et calculer, toujours par rapport à la base de départ qui est le coût de lancement, le coût par
 * clic ou nombre d'interactions ».
 *
 * Quatre décisions ont été tranchées avec lui avant d'écrire une ligne, et elles gouvernent tout ce fichier :
 *
 * 🔴 1. LE DÉNOMINATEUR EST LE LANCEMENT SEUL. Un scénario qui renvoie un template trois jours plus tard
 * est facturé pour ce second envoi ; le compter dans la base ferait GONFLER le coût par interaction à
 * chaque relance, sans qu'aucune interaction nouvelle ne soit survenue. Les relances sont donc comptées et
 * affichées, hors du ratio.
 *
 * 🔴 2. LES NATURES D'INTERACTION NE SE FUSIONNENT PAS. Un bouton tapé et une réponse écrite ne valent pas
 * la même chose ; un nombre unique ne se réinterprète plus. Elles restent en colonnes.
 *
 * 🔴 3. ON COMPTE LES DEUX, gestes ET personnes. Une personne qui tape deux fois le même bouton fait deux
 * gestes et une personne, et les deux répondent à des questions différentes (« combien d'activité » contre
 * « combien de gens »). Le RATIO, lui, se calcule sur les GESTES : c'est la seule des deux unités qui
 * existe partout.
 *
 * 🔴 4. TOUTE LA VIE DE LA CAMPAGNE, pas la période affichée en haut de l'écran. Un scénario reçoit des
 * réponses pendant des jours : bornée à sept jours, la fiche montrerait le coût d'un lancement amputé des
 * interactions qu'il a produites ensuite, donc un coût par interaction faux dans le sens qui flatte.
 *
 * ⚠️ PUR (aucune DB, aucun réseau), comme `cost.ts` à côté : c'est ici que se décident les cases vides, et
 * elles se testent sans base.
 */

/** Les envois facturables d'une campagne pour UNE catégorie, séparés lancement / total. */
export interface EnvoisCampagneRow {
  /** Catégorie Meta de l'envoi (`marketing`, `utility`, ou `null` = non enregistrée). */
  category: string | null;
  /** Tous les envois facturables de cette catégorie, lancement compris. */
  total: number;
  /** ...dont ceux qui sont le PREMIER envoi à leur destinataire. */
  lancement: number;
}

/** Un volume et son coût, quand il est calculable. */
export interface VolumeChiffre {
  envoyes: number;
  /** `null` quand AUCUN de ces envois n'a pu être chiffré. Jamais zéro : zéro se lirait « gratuit ». */
  cout: number | null;
  /**
   * Envois comptés mais absents du coût, et le TOTAL vient avec les deux causes.
   *
   * ⚠️ Les trois voyagent ensemble parce que c'est ce que `web/lib/cout-non-chiffrable.ts` attend : le
   * total est le seul champ garanti côté front (il retombe sur la phrase générique quand le détail manque),
   * et le lui faire recalculer ici aurait été une quatrième addition du même nombre.
   */
  nonChiffrables: number;
  /** ...sans catégorie enregistrée : héritage clos. */
  sansCategorie: number;
  /** ...sans tarif Meta : panne du jour, réparable. */
  sansTarif: number;
}

/** Ce que les gens ont fait à UN bloc du scénario. */
export interface EtapeCoutCampagne {
  nodeId: string;
  /** Le bloc a envoyé quelque chose à ce contact : la base de comparaison de la ligne. */
  envoyes: { gestes: number; personnes: number };
  /** Boutons tapés (choix d'un scénario). Les deux unités existent : le tap porte un numéro. */
  boutons: { gestes: number; personnes: number };
  /** Réponses écrites en toutes lettres. */
  reponses: { gestes: number; personnes: number };
  /** `boutons.gestes + reponses.gestes` : le dénominateur du ratio, jamais affiché comme un total à part. */
  interactions: number;
  /**
   * Coût du LANCEMENT rapporté aux interactions de CETTE étape.
   *
   * `null` dès que le coût du lancement manque ou qu'aucune interaction n'a eu lieu : un « ∞ » ou un
   * « 0 € » répondrait à une question qu'on n'a pas pu poser. Même règle que le coût par clic du tableau.
   */
  coutParInteraction: number | null;
}

export interface DetailCoutCampagne {
  campaignId: string;
  nom: string;
  /** Template de lancement, `null` pour une campagne à scénario (c'est le parcours qui envoie). */
  template: string | null;
  /** Le scénario, s'il y en a un. `null` = campagne à template direct, donc aucune étape. */
  workflowId: string | null;
  /** Devise rendue par Meta ; `null` = inconnue, l'écran affiche alors le nombre nu. */
  devise: string | null;
  /** Le premier envoi par destinataire : la BASE de tous les ratios de cette fiche. */
  lancement: VolumeChiffre & {
    /**
     * Destinataires en échec, comptés à part et JAMAIS dans le coût.
     *
     * 🔴 C'est la question que Julien a posée entre parenthèses (« tu enlèves bien les failed j'espère »).
     * Ils l'étaient déjà, par la population elle-même (`status = 'sent'` et livraison non `failed`) ; ce
     * champ existe pour que l'écran puisse le MONTRER au lieu de le laisser croire.
     */
    echecs: number;
    /** Clics sur les liens tracés du template de lancement. `null` = rien à mesurer, ce qui n'est pas zéro. */
    clics: number | null;
    /** Coût du lancement par clic sur son template. `null` si un terme manque ou si les clics sont nuls. */
    coutParClic: number | null;
    /** Réponses attribuées à la campagne, tous types confondus, et parmi elles les taps de bouton. */
    reponses: number;
    boutons: number;
  };
  /** Les envois facturables qui ne sont PAS le lancement : les templates que le scénario renvoie ensuite. */
  relances: VolumeChiffre;
  /** Une ligne par bloc mesuré du scénario, dans l'ordre où la base les rend. Vide sans scénario. */
  etapes: EtapeCoutCampagne[];
}

const round2 = (x: number): number => Math.round(x * 100) / 100;
const round4 = (x: number): number => Math.round(x * 10000) / 10000;

/** Le tarif Meta d'une catégorie, ou `null` (catégorie inconnue, ou tarif absent). Même règle que `cost.ts`. */
function tarifDe(category: string | null, rates: CategoryRates): number | null {
  if (category === 'marketing') return rates.marketing;
  if (category === 'utility') return rates.utility;
  return null;
}

/** Chiffre un volume en séparant les deux causes de non-chiffrabilité, exactement comme `cost.ts`. */
function chiffrer(parts: Array<{ category: string | null; count: number }>, rates: CategoryRates): VolumeChiffre {
  let envoyes = 0;
  let cout = 0;
  let chiffres = 0;
  let sansCategorie = 0;
  let sansTarif = 0;
  for (const p of parts) {
    if (p.count <= 0) continue;
    envoyes += p.count;
    const connue = p.category === 'marketing' || p.category === 'utility';
    const tarif = connue ? tarifDe(p.category, rates) : null;
    if (!connue) { sansCategorie += p.count; continue; }
    if (tarif == null) { sansTarif += p.count; continue; }
    chiffres += p.count;
    cout += p.count * tarif;
  }
  return {
    envoyes, cout: chiffres > 0 ? round2(cout) : null,
    nonChiffrables: sansCategorie + sansTarif, sansCategorie, sansTarif,
  };
}

/**
 * Les natures d'événement qui comptent comme une INTERACTION du contact.
 *
 * 🔴 `sent`, `delivered` et `read` n'en sont PAS : ce sont des choses qui ARRIVENT au contact, pas des
 * choses qu'il FAIT. Les compter ferait tomber le coût par interaction à celui d'un envoi, c'est-à-dire
 * ferait passer une campagne que personne n'a lue pour une campagne parfaitement efficace.
 *
 * ⚠️ `url_click` n'y figure pas non plus, et pour une raison toute différente : il n'existe pas ici. Un
 * clic sur un lien tracé ne porte AUCUN numéro (une adresse ouverte n'identifie personne), donc il ne peut
 * pas être rattaché à une campagne parmi celles qui partagent un scénario. Les clics du template de
 * LANCEMENT, eux, le sont, par la borne du premier envoi : ils vivent dans `lancement.clics`.
 */
const INTERACTIONS = new Set(['reply_button', 'reply_text']);

/** Assemble la fiche. `mesures` est vide pour une campagne à template direct. */
export function assemblerDetailCampagne(entree: {
  campagne: { id: string; nom: string; template: string | null; workflowId: string | null };
  envois: EnvoisCampagneRow[];
  rates: CategoryRates;
  funnel: { sent: number; failed: number; replied: number; buttonReplies: number; urlClicks: number | null };
  mesures: NodeEventCount[];
}): DetailCoutCampagne {
  const { campagne, envois, rates, funnel, mesures } = entree;

  const lancementChiffre = chiffrer(envois.map((e) => ({ category: e.category, count: e.lancement })), rates);
  // ⚠️ `total - lancement`, jamais un second comptage : les deux viennent de la MÊME requête, donc de la
  // même population. Les recompter ailleurs ferait diverger la somme du tout et de ses parties.
  const relances = chiffrer(envois.map((e) => ({ category: e.category, count: e.total - e.lancement })), rates);

  const clics = funnel.urlClicks;
  const coutParClic = lancementChiffre.cout !== null && clics !== null && clics > 0
    ? round4(lancementChiffre.cout / clics)
    : null;

  const parNode = new Map<string, EtapeCoutCampagne>();
  for (const m of mesures) {
    const e = parNode.get(m.nodeId) ?? {
      nodeId: m.nodeId,
      envoyes: { gestes: 0, personnes: 0 },
      boutons: { gestes: 0, personnes: 0 },
      reponses: { gestes: 0, personnes: 0 },
      interactions: 0,
      coutParInteraction: null,
    };
    const personnes = typeof m.contacts === 'number' ? m.contacts : 0;
    if (m.kind === 'sent') { e.envoyes.gestes += m.count; e.envoyes.personnes += personnes; }
    if (m.kind === 'reply_button') { e.boutons.gestes += m.count; e.boutons.personnes += personnes; }
    if (m.kind === 'reply_text') { e.reponses.gestes += m.count; e.reponses.personnes += personnes; }
    if (INTERACTIONS.has(m.kind)) e.interactions += m.count;
    parNode.set(m.nodeId, e);
  }

  const etapes = [...parNode.values()].map((e) => ({
    ...e,
    coutParInteraction: lancementChiffre.cout !== null && e.interactions > 0
      ? round4(lancementChiffre.cout / e.interactions)
      : null,
  }));

  return {
    campaignId: campagne.id,
    nom: campagne.nom,
    template: campagne.template,
    workflowId: campagne.workflowId,
    devise: rates.currency ?? null,
    lancement: {
      ...lancementChiffre,
      echecs: funnel.failed,
      clics,
      coutParClic,
      reponses: funnel.replied,
      boutons: funnel.buttonReplies,
    },
    relances,
    etapes,
  };
}
