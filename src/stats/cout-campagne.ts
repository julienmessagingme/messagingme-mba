import { chiffrerVolume, type CategoryRates } from './cost';
import type { NodeEventCount } from '../workflow/node-events.pg';
import type { CompteurClic } from '../links/mesures';

/**
 * Une mesure de bloc, événement ou clic : le même couple de types que `getWorkflowNodeCounts`, `url_click`
 * étant fabriqué à la lecture par `compteursDeClics`. Les deux écrans de mesures par bloc lisent la même forme.
 */
export type MesureBloc = NodeEventCount | CompteurClic;

/**
 * Le détail d'une campagne : ce qu'elle a coûté, et ce que les gens en ont fait. Pur, comme `cost.ts` : c'est
 * ici que se décident les cases vides.
 *
 * Le dénominateur est le lancement seul : compter les templates renvoyés par le scénario gonflerait le coût
 * par interaction à chaque relance. Les relances sont affichées, hors du ratio.
 *
 * Les natures d'interaction ne se fusionnent pas (un bouton tapé n'est pas une réponse écrite). On compte gestes
 * et personnes, le ratio se calcule sur les gestes (la seule unité qui existe partout). Toute la vie de la
 * campagne, pas la période affichée : une fenêtre amputerait les interactions et flatterait le coût.
 */

/** Les envois facturables d'une campagne pour une catégorie, séparés lancement / total. */
export interface EnvoisCampagneRow {
  /** Catégorie Meta de l'envoi (`marketing`, `utility`, ou `null` = non enregistrée). */
  category: string | null;
  /** Tous les envois facturables de cette catégorie, lancement compris. */
  total: number;
  /** ...dont ceux qui sont le premier envoi à leur destinataire. */
  lancement: number;
}

/** Un volume et son coût, quand il est calculable. */
export interface VolumeChiffre {
  envoyes: number;
  /** `null` quand aucun de ces envois n'a pu être chiffré. Jamais zéro : zéro se lirait « gratuit ». */
  cout: number | null;
  /**
   * Envois comptés mais absents du coût, avec ses deux causes : la forme que `web/lib/cout-non-chiffrable.ts`
   * attend (le total seul suffit au repli générique).
   */
  nonChiffrables: number;
  /** ...sans catégorie enregistrée : héritage clos. */
  sansCategorie: number;
  /** ...sans tarif Meta : panne du jour, réparable. */
  sansTarif: number;
}

/** Ce que les gens ont fait à un bloc du scénario. */
export interface EtapeCoutCampagne {
  nodeId: string;
  /** Le bloc a envoyé quelque chose à ce contact : la base de comparaison de la ligne. */
  envoyes: { gestes: number; personnes: number };
  /**
   * Clics sur les liens tracés du template de ce bloc, attribués à cette campagne (le jeton du destinataire dans
   * l'URL dit qui a cliqué). Les clics sans jeton sont comptés à part (`clicsAnonymes`). Pas de `personnes` :
   * l'agrégat compte par code de lien, et inventer un nombre de personnes serait faux.
   */
  liens: { gestes: number };
  /** Boutons tapés (choix d'un scénario). Les deux unités existent : le tap porte un numéro. */
  boutons: { gestes: number; personnes: number };
  /** Réponses écrites en toutes lettres. */
  reponses: { gestes: number; personnes: number };
  /** `liens.gestes + boutons.gestes + reponses.gestes` : le dénominateur du ratio, jamais affiché comme un total. */
  interactions: number;
  /**
   * Coût du lancement rapporté aux interactions de cette étape. `null` dès que le coût manque ou qu'aucune
   * interaction n'a eu lieu : un « ∞ » ou un « 0 € » répondrait à une question qu'on n'a pas pu poser.
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
  /** Le premier envoi par destinataire : la base de tous les ratios de cette fiche. */
  lancement: VolumeChiffre & {
    /**
     * Destinataires en échec, comptés à part et jamais dans le coût (la population du coût est `status =
     * 'sent'` hors livraison `failed`) : le champ existe pour que l'écran le montre.
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
  /** Les envois facturables qui ne sont pas le lancement : les templates que le scénario renvoie ensuite. */
  relances: VolumeChiffre;
  /** Une ligne par bloc mesuré du scénario, dans l'ordre où la base les rend. Vide sans scénario. */
  etapes: EtapeCoutCampagne[];
  /**
   * Clics sur les liens de ce scénario depuis le lancement, sans identifiant (templates dont l'URL figée chez
   * Meta ne porte aucun jeton). Ni tus, ni additionnés aux attribués : rien ne dit qu'ils viennent d'ici.
   */
  clicsAnonymes: number;
}

const round4 = (x: number): number => Math.round(x * 10000) / 10000;

/**
 * Chiffre un volume par la règle de `cost.ts` (`chiffrerVolume`). Les parts nulles ou négatives sont écartées
 * avant : une relance se calcule `total - lancement`.
 */
function chiffrer(parts: Array<{ category: string | null; count: number }>, rates: CategoryRates): VolumeChiffre {
  return chiffrerVolume(parts.filter((p) => p.count > 0), rates);
}

/**
 * Les natures d'événement qui comptent comme une interaction du contact. `sent`, `delivered` et `read` arrivent
 * au contact, il ne les fait pas : les compter ferait passer une campagne que personne n'a lue pour efficace.
 * `url_click` en fait partie : le jeton dans l'URL dit qui a cliqué.
 */
const INTERACTIONS = new Set(['reply_button', 'reply_text', 'url_click']);

/** Assemble la fiche. `mesures` est vide pour une campagne à template direct. */
export function assemblerDetailCampagne(entree: {
  campagne: { id: string; nom: string; template: string | null; workflowId: string | null };
  envois: EnvoisCampagneRow[];
  rates: CategoryRates;
  funnel: { sent: number; failed: number; replied: number; buttonReplies: number; urlClicks: number | null };
  /** Événements de blocs et clics attribués (`kind: 'url_click'`), déjà fusionnés par l'appelant. */
  mesures: MesureBloc[];
  /** Clics sans identifiant survenus depuis le lancement. Voir `DetailCoutCampagne.clicsAnonymes`. */
  clicsAnonymes?: number;
}): DetailCoutCampagne {
  const { campagne, envois, rates, funnel, mesures } = entree;

  const lancementChiffre = chiffrer(envois.map((e) => ({ category: e.category, count: e.lancement })), rates);
  // `total - lancement`, jamais un second comptage : les deux viennent de la même requête, donc de la même
  // population.
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
