import { chiffrerVolume, type CategoryRates } from './cost';
import type { NodeEventCount } from '../workflow/node-events.pg';
import type { CompteurClic } from '../links/mesures';

/**
 * Une mesure de bloc, EVENEMENT ou CLIC.
 *
 * ⚠️ Le meme couple de types que `getWorkflowNodeCounts` (`src/http/stats.ts`), et pas un type de plus :
 * `url_click` n'est pas une nature de `workflow_node_events`, il est fabrique a la lecture par
 * `compteursDeClics`. Les deux ecrans qui affichent des mesures par bloc lisent donc la meme forme.
 */
export type MesureBloc = NodeEventCount | CompteurClic;

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
  /**
   * Clics sur les liens tracés du template de ce bloc, ATTRIBUÉS à cette campagne.
   *
   * 🔴 CETTE COLONNE A FAILLI NE PAS EXISTER, sur une justification fausse : « un clic n'identifie
   * personne ». C'est vrai d'un lien SANS jeton (template approuvé avant le 2026-09-02, dont l'URL est
   * figée chez Meta pour toujours) et faux de tous les autres depuis la migration 0106, qui écrit
   * `tracked_link_clicks.contact_id`. Ce qu'on ne sait pas rattacher est compté à part, au niveau de la
   * fiche (`clicsAnonymes`), au lieu d'être tu ou mélangé ici.
   *
   * ⚠️ `personnes` reste indisponible : le compte se fait par CODE de lien, pas par personne. Un clic
   * attribué sait de qui il vient, mais l'agrégat ne le distingue pas, et inventer un nombre de personnes
   * égal au nombre de clics serait un mensonge dans la colonne d'à côté.
   */
  liens: { gestes: number };
  /** Boutons tapés (choix d'un scénario). Les deux unités existent : le tap porte un numéro. */
  boutons: { gestes: number; personnes: number };
  /** Réponses écrites en toutes lettres. */
  reponses: { gestes: number; personnes: number };
  /**
   * `liens.gestes + boutons.gestes + reponses.gestes` : le dénominateur du ratio, jamais affiché comme un
   * total à part. Trois natures, un seul dénominateur : c'est ce que Julien a demandé (« le coût par clic
   * ou nombre d'interactions »), et les trois colonnes restent lisibles pour elles-mêmes.
   */
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
  /**
   * Clics survenus depuis le lancement sur les liens de ce scénario, mais SANS identifiant.
   *
   * 🔴 Ils ne sont pas « les clics de cette campagne » et l'écran ne le prétend pas : ils viennent de
   * templates approuvés avant le 2026-09-02, dont l'URL figée chez Meta ne porte aucun jeton, et rien ne
   * les rattachera jamais à qui que ce soit. Les taire laisserait croire que la colonne des liens est
   * complète ; les additionner aux attribués affirmerait qu'ils sont d'ici.
   */
  clicsAnonymes: number;
}

const round4 = (x: number): number => Math.round(x * 10000) / 10000;

/**
 * Chiffre un volume par la règle de `cost.ts` (`chiffrerVolume`). Les parts NULLES ou NÉGATIVES sont écartées
 * AVANT : une relance se calcule `total - lancement`, et une part négative ne doit ni compter ni se chiffrer.
 */
function chiffrer(parts: Array<{ category: string | null; count: number }>, rates: CategoryRates): VolumeChiffre {
  return chiffrerVolume(parts.filter((p) => p.count > 0), rates);
}

/**
 * Les natures d'événement qui comptent comme une INTERACTION du contact.
 *
 * 🔴 `sent`, `delivered` et `read` n'en sont PAS : ce sont des choses qui ARRIVENT au contact, pas des
 * choses qu'il FAIT. Les compter ferait tomber le coût par interaction à celui d'un envoi, c'est-à-dire
 * ferait passer une campagne que personne n'a lue pour une campagne parfaitement efficace.
 *
 * ⚠️ `url_click` EN FAIT PARTIE, et il a failli en être exclu sur une justification fausse. Un clic sur un
 * lien dont l'URL porte le jeton du destinataire SAIT qui a cliqué (migration 0106), donc il s'attribue
 * comme le reste. Seuls les clics venus d'un template approuvé avant le 2026-09-02 restent anonymes, et
 * ils sont comptés à part dans `clicsAnonymes`.
 */
const INTERACTIONS = new Set(['reply_button', 'reply_text', 'url_click']);

/** Assemble la fiche. `mesures` est vide pour une campagne à template direct. */
export function assemblerDetailCampagne(entree: {
  campagne: { id: string; nom: string; template: string | null; workflowId: string | null };
  envois: EnvoisCampagneRow[];
  rates: CategoryRates;
  funnel: { sent: number; failed: number; replied: number; buttonReplies: number; urlClicks: number | null };
  /** Événements de blocs ET clics attribués (`kind: 'url_click'`), déjà fusionnés par l'appelant. */
  mesures: MesureBloc[];
  /** Clics sans identifiant survenus depuis le lancement. Voir `DetailCoutCampagne.clicsAnonymes`. */
  clicsAnonymes?: number;
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
      liens: { gestes: 0 },
      boutons: { gestes: 0, personnes: 0 },
      reponses: { gestes: 0, personnes: 0 },
      interactions: 0,
      coutParInteraction: null,
    };
    const personnes = typeof m.contacts === 'number' ? m.contacts : 0;
    if (m.kind === 'sent') { e.envoyes.gestes += m.count; e.envoyes.personnes += personnes; }
    if (m.kind === 'url_click') e.liens.gestes += m.count;
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
    clicsAnonymes: entree.clicsAnonymes ?? 0,
  };
}
