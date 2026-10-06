import type { EntreeResolveur, ResolveurOutil, SortieResolveur } from '../executor';
import type { KnowledgeStore } from '../knowledge';
import { chercherConnaissance, type RechercheSemantique } from './connaissance';
import type { AnalyseEtResume } from '../../crm/contact-store.pg';
import { lireCibleOutilAgent, type CibleOutilAgent, type HandlerACible } from '../outils-maison';

/**
 * Le résolveur des outils maison : une table `handler` vers fonction TypeScript, sans réseau.
 *
 * Le `handler` est lu dans `binding`, jamais déduit du nom exposé, que le client peut renommer. Comme tout
 * résolveur, il ne lève pas sur un cas métier : il rend `ok: false` avec une raison que le tronc commun
 * repasse au modèle.
 *
 * 🔴 LA CIBLE AUSSI EST LUE DANS `binding`, JAMAIS DANS LES ARGUMENTS DU MODÈLE (RC4) : le tag, le champ, le bloc et
 * le scénario sont fixés par l'administrateur. Un modèle qui passe `tag: "autre"` pose quand même le tag fixé (la
 * validation retire d'ailleurs l'argument, que l'outil ne déclare pas). Une cible illisible refuse l'appel au lieu
 * d'agir, et le refus est journalisé par le tronc commun (`agent_tool_calls`).
 */

export interface DepsResolveurMba {
  /**
   * Envoie SEUL le bloc fixé d'un scénario publié de l'espace (`mba_envoyer_bloc`), sans faire bouger le parcours de
   * l'agent : `creerGestesEnvoiAgent` (`src/agent/gestes-envoi.ts`), puis `WorkflowExecutor.envoyerBlocDepuisAgent`.
   */
  envoyerBloc(input: {
    tenantId: string; waId: string; runId: string; workflowId: string; code: string;
  }): Promise<{ ok: boolean; raison?: string }>;

  /**
   * Lance le scénario fixé (`mba_lancer_scenario`, RC4), qui prend la conversation, puis clôt la session de l'agent et
   * son parcours (`creerGestesEnvoiAgent`). `ok: false` = rien n'est parti, la session continue, et la raison va au
   * modèle. Requise : un câblage qui l'oublierait ne compile pas.
   */
  lancerScenario(input: {
    tenantId: string; waId: string; runId: string; sessionId: string; workflowId: string;
  }): Promise<{ ok: boolean; raison?: string }>;

  /**
   * Escalade vers un humain (`mba_escalader_humain`), par `creerEscaladeVersHumain` qui ordonne les effets.
   * `agentId` : l'agent qui passe la main, nommé dans la cause que la frise et le journal gardent.
   */
  escaladerVersHumain(input: { tenantId: string; waId: string; runId: string; sessionId: string; agentId: string }): Promise<boolean>;

  /**
   * Marque urgente la conversation du TOUR (`mba_marquer_urgent`, migration 0216), par `PgInboxStore.marquerUrgenteParWaId`.
   * `agentId` : l'agent qui la pose, nommé dans la cause que la frise garde (il n'est pas un collaborateur). `false` =
   * aucune conversation pour ce contact. Requise : un câblage qui l'oublierait ne compile pas.
   */
  marquerUrgente(input: { tenantId: string; waId: string; agentId: string }): Promise<boolean>;

  /** Pose un tag sur le contact (`mba_poser_tag`). */
  poserTag(tenantId: string, waId: string, tag: string): Promise<void>;

  /** Écrit une valeur dans les champs du contact (`mba_ecrire_variable`), pour qu'un bloc plus loin la relise. */
  ecrireChamp(tenantId: string, waId: string, cle: string, valeur: string): Promise<void>;

  /**
   * La dernière analyse du contact et le résumé de la même analyse (`mba_lire_contact`), lus seulement à l'appel de
   * l'outil et toujours pour le contact du TOUR (`ctx.waId`), jamais pour un numéro venu du modèle. Requise : un
   * câblage qui l'oublierait ne compile pas, au lieu de rendre une fiche sans analyse sans rien dire.
   * La projection du contact n'en porte rien : les connecteurs, qui la reçoivent aussi, n'ont pas à voir l'analyse.
   */
  lireAnalyse(tenantId: string, waId: string): Promise<AnalyseEtResume | null>;

  /** La base de connaissance de l'agent (`mba_chercher_connaissance`). */
  connaissance: KnowledgeStore;
  /**
   * Le rappel vectoriel et le verdict du reranker. Optionnelle : absente, la recherche retombe sur le plein
   * texte et la règle lexicale.
   */
  recherche?: RechercheSemantique;
}

/** Lit un argument textuel non vide. Les arguments sont validés contre une déclaration qui vient du client :
 *  un handler ne suppose jamais qu'elle est bien faite. */
function texte(args: Record<string, unknown>, cle: string): string {
  const v = args[cle];
  return typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v).trim();
}

function echec(raison: string): SortieResolveur {
  return { ok: false, contenu: { erreur: raison }, erreur: raison };
}

/** Ce que le modèle lit d'un outil dont la cible ne se lit pas : il ne peut rien y corriger, l'administrateur si. */
export const CIBLE_ILLISIBLE = 'outil mal configuré : sa cible ne se lit pas, il faut le refaire dans l’onglet Outils de l’agent';

/**
 * Le refus d'un outil dont la cible ne se lit pas pour son handler, journalisé : un outil posé avant RC4, ou un
 * `binding` réécrit à la main, refuse chaque appel, et l'exploitation doit pouvoir le voir. Partagé avec le bac à
 * sable, qui juge la cible de la même façon.
 */
export function refusCible(entree: Pick<EntreeResolveur, 'outil'>, handler: HandlerACible): SortieResolveur {
  // eslint-disable-next-line no-console
  console.warn(`agent: outil ${entree.outil.id} (${handler}) sans cible lisible, appel refusé`);
  return echec(CIBLE_ILLISIBLE);
}

/** La cible fixée de l'outil (`binding`), lue contre le schéma du catalogue. Le handler se compare chez l'appelant. */
export function cibleLue(entree: Pick<EntreeResolveur, 'outil'>): CibleOutilAgent | null {
  return lireCibleOutilAgent(entree.outil.binding);
}

type Handler = (entree: EntreeResolveur, deps: DepsResolveurMba) => Promise<SortieResolveur>;

/**
 * Terminer par une sortie prédéfinie : le tronc commun remonte `sortie`, le tour clôt la session et le scénario
 * reprend par ce handle. Le code est une énumération fermée déclarée par le client. Le `message` (imposé par le
 * catalogue) remonte en `dernierMessage`, absent s'il est vide. Sans effet de bord : le bac à sable l'exécute
 * tel quel (`resolvers/simulation.ts`), un terminer simulé qui jugerait autrement ne prouverait rien.
 */
export function terminerAvec(args: Record<string, unknown>): SortieResolveur {
  const sortie = texte(args, 'sortie');
  if (sortie === '') return echec('parametre « sortie » manquant');
  const dernierMessage = texte(args, 'message');
  return { contenu: { sortie }, sortie, ...(dernierMessage !== '' ? { dernierMessage } : {}) };
}

/**
 * La dernière analyse et son résumé, tels que le modèle les lit (`derniere_analyse`, `resume`). Les codes restent ceux
 * de l'analyse ; une note `null` dit « pas de mesure ». Rien à rendre sans copie : l'agent ne déduit rien d'un vide.
 */
function analysePourLeModele(ar: AnalyseEtResume | null): Record<string, unknown> {
  const a = ar?.analyse ?? null;
  return {
    derniere_analyse: a === null ? null : {
      intention: a.intention, sentiment: a.sentiment, satisfaction: a.satisfaction, urgence: a.urgence, resolue: a.resolue,
      sujet: a.sujet, traitee_par: a.traiteePar, action_suggeree: a.action, analysee_le: a.analyseLe.toISOString(),
    },
    resume: ar?.resume ?? null,
  };
}

/**
 * Une lecture ratée rend `analyse_indisponible`, jamais `derniere_analyse: null` (qui dirait « jamais analysé »),
 * et ne fait pas perdre la fiche déjà en mémoire au modèle.
 */
async function analyseOuIndisponible(deps: DepsResolveurMba, ctx: { tenantId: string; waId: string }): Promise<Record<string, unknown>> {
  try {
    return analysePourLeModele(await deps.lireAnalyse(ctx.tenantId, ctx.waId));
  } catch (e) {
    console.warn('mba_lire_contact: dernière analyse illisible, fiche rendue sans elle:', e instanceof Error ? e.message : e);
    return { analyse_indisponible: true };
  }
}

const HANDLERS: Record<string, Handler> = {
  terminer: async ({ args }) => terminerAvec(args),

  /**
   * Escalader vers un humain. `rendu` dit au tour de s'arrêter ; `mainPrise` dit si c'est cette escalade qui a
   * basculé le fil (voir `DecisionAgent.mainPriseParCeTour`), sans quoi la dernière phrase serait jetée.
   */
  escalader: async ({ args, ctx }, deps) => {
    const mainPrise = await deps.escaladerVersHumain({
      tenantId: ctx.tenantId, waId: ctx.waId, runId: ctx.runId, sessionId: ctx.sessionId, agentId: ctx.agentId,
    });
    // Le `message` imposé par le catalogue, comme celui de `terminer` : le tour l'envoie quand le modèle n'a rien écrit.
    const dernierMessage = texte(args, 'message');
    return { contenu: { escalade: true }, rendu: true, mainPrise, ...(dernierMessage !== '' ? { dernierMessage } : {}) };
  },

  /**
   * Marquer la conversation urgente. 🔴 Toujours celle du contact du TOUR (`ctx.waId`) : l'outil n'a aucun paramètre,
   * le modèle ne peut désigner aucune autre conversation. Ni `rendu` ni `sortie` : urgent n'est pas un transfert, la
   * session continue et l'agent répond au contact dans le même tour.
   */
  marquer_urgent: async ({ ctx }, deps) => {
    const marquee = await deps.marquerUrgente({ tenantId: ctx.tenantId, waId: ctx.waId, agentId: ctx.agentId });
    return marquee ? { contenu: { urgente: true } } : echec('aucune conversation a marquer pour ce contact');
  },

  /**
   * Le tag FIXÉ par l'administrateur (RC4), jamais un argument du modèle. Le modèle ne lit pas son nom en retour :
   * un nom interne, qu'il répéterait au contact (même règle que l'agent de Meta, `REPONSE_MAISON`).
   */
  poser_tag: async (entree, deps) => {
    const cible = cibleLue(entree);
    if (cible?.handler !== 'poser_tag') return refusCible(entree, 'poser_tag');
    await deps.poserTag(entree.ctx.tenantId, entree.ctx.waId, cible.tag);
    return { contenu: { pose: true } };
  },

  /** 🔴 La fiche contact telle que le tour l'a déjà lue : aucun moyen de désigner la fiche de quelqu'un
   *  d'autre, puisque le modèle ne fournit pas d'identifiant ici. */
  lire_contact: async ({ ctx }, deps) => (
    ctx.contact === null ? { contenu: { connu: false } } : { contenu: { connu: true, champs: ctx.contact, ...await analyseOuIndisponible(deps, ctx) } }
  ),

  /** Le bloc FIXÉ (RC4) : son scénario et son code viennent de la cible, jamais du modèle ni du parcours en cours. */
  envoyer_bloc: async (entree, deps) => {
    const cible = cibleLue(entree);
    if (cible?.handler !== 'envoyer_bloc') return refusCible(entree, 'envoyer_bloc');
    const { ctx } = entree;
    const res = await deps.envoyerBloc({
      tenantId: ctx.tenantId, waId: ctx.waId, runId: ctx.runId, workflowId: cible.workflowId, code: cible.code,
    });
    return res.ok ? { contenu: { envoye: true } } : echec(res.raison ?? 'le bloc n a pas pu etre envoye');
  },

  /**
   * 🔴 LANCER LE SCÉNARIO FIXÉ (RC4), et se retirer. TERMINAL sur un succès : `scenarioLance` arrête le tour sans
   * rappeler le modèle (`brain.gateway.ts`), la dépendance a déjà clos la session et le parcours de l'agent. Un refus
   * (scénario dépublié ou supprimé, contact désabonné, fil tenu) laisse la session vivante : le modèle lit la raison.
   * Relancer le scénario où l'agent parle est refusé : il retomberait sur l'agent, qui pourrait le relancer encore.
   */
  lancer_scenario: async (entree, deps) => {
    const cible = cibleLue(entree);
    if (cible?.handler !== 'lancer_scenario') return refusCible(entree, 'lancer_scenario');
    const { ctx } = entree;
    if (cible.workflowId === ctx.workflowId) {
      return echec('ce scénario est celui où tu parles déjà : le relancer recommencerait la conversation, continue sans cet outil');
    }
    const res = await deps.lancerScenario({
      tenantId: ctx.tenantId, waId: ctx.waId, runId: ctx.runId, sessionId: ctx.sessionId, workflowId: cible.workflowId,
    });
    return res.ok
      ? { contenu: { lance: true }, scenarioLance: true }
      : echec(res.raison ?? 'le scénario n’a pas pu être lancé');
  },

  /**
   * Cherche dans la base de connaissance. Seul handler qui peut demander une sortie sans que le modèle l'ait
   * décidé : aucune fiche pertinente rend `{ aucune_source: true }` et `sortie: sans_source`. La règle
   * (`ficheEstPertinente`) s'applique ici, et le modèle ne voit aucun score : ce serait lui rendre la décision.
   */
  chercher_connaissance: async ({ args, ctx }, deps) => {
    const requete = texte(args, 'requete');
    if (requete === '') return echec('parametre « requete » manquant');
    return chercherConnaissance(deps.connaissance, ctx, requete, deps.recherche);
  },

  /**
   * 🔴 Le champ est FIXÉ par l'administrateur (RC4) : une injection ne peut plus viser le champ sur lequel une
   * condition du scénario branche. La valeur vient du modèle, bornée à la liste permise quand il y en a une : la
   * validation l'applique déjà (`paramsEffectifs`), la revérifier ici ne coûte rien et ne dépend d'aucun câblage.
   */
  ecrire_variable: async (entree, deps) => {
    const cible = cibleLue(entree);
    if (cible?.handler !== 'ecrire_variable') return refusCible(entree, 'ecrire_variable');
    const valeur = texte(entree.args, 'valeur');
    if (valeur === '') return echec('parametre « valeur » manquant');
    if (cible.valeurs.length > 0 && !cible.valeurs.includes(valeur)) {
      return echec(`valeur refusée : choisir parmi ${cible.valeurs.join(', ')}`);
    }
    await deps.ecrireChamp(entree.ctx.tenantId, entree.ctx.waId, cible.champ, valeur);
    return { contenu: { ecrit: true } };
  },
};

/** Les handlers qui existent vraiment, exportés pour que `tests/agent-outils-maison.test.ts` vérifie la
 *  correspondance avec le catalogue de la console (`src/agent/outils-maison.ts`). */
export const HANDLERS_MAISON: readonly string[] = Object.keys(HANDLERS);

export function creerResolveurMba(deps: DepsResolveurMba): ResolveurOutil {
  return async (entree) => {
    const nom = String(entree.outil.binding.handler ?? '').trim();
    // `hasOwn` et non un accès direct : un `handler` « valueOf » ou « toString » (jsonb de la console)
    // retrouverait une méthode du prototype.
    const handler = Object.hasOwn(HANDLERS, nom) ? HANDLERS[nom] : undefined;
    // Handler inconnu : une erreur de configuration, dite au modèle plutôt que levée, pour que le tour se
    // termine proprement.
    if (!handler) return echec(`outil maison inconnu : ${nom || '(handler absent)'}`);
    return handler(entree, deps);
  };
}
