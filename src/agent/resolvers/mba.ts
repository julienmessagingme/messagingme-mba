import type { EntreeResolveur, ResolveurOutil, SortieResolveur } from '../executor';
import type { KnowledgeStore } from '../knowledge';
import { chercherConnaissance, type RechercheSemantique } from './connaissance';
import type { AnalyseEtResume } from '../../crm/contact-store.pg';

/**
 * Le résolveur des outils maison : une table `handler` vers fonction TypeScript, sans réseau.
 *
 * Le `handler` est lu dans `binding`, jamais déduit du nom exposé, que le client peut renommer. Comme tout
 * résolveur, il ne lève pas sur un cas métier : il rend `ok: false` avec une raison que le tronc commun
 * repasse au modèle.
 */

export interface DepsResolveurMba {
  /**
   * Déclenche un bloc du scénario courant (`mba_envoyer_bloc`), par `WorkflowExecutor.envoyerBlocDepuisAgent`
   * (qui porte pourquoi elle ne passe pas par `demarrer`).
   */
  envoyerBloc(input: {
    tenantId: string; waId: string; runId: string; workflowId: string; code: string;
  }): Promise<{ ok: boolean; raison?: string }>;

  /**
   * Escalade vers un humain (`mba_escalader_humain`), par `creerEscaladeVersHumain` qui ordonne les effets.
   * `agentId` : l'agent qui passe la main, nommé dans la cause que la frise et le journal gardent.
   */
  escaladerVersHumain(input: { tenantId: string; waId: string; runId: string; sessionId: string; agentId: string }): Promise<boolean>;

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

type Handler = (entree: EntreeResolveur, deps: DepsResolveurMba) => Promise<SortieResolveur>;

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
  /** Terminer par une sortie prédéfinie. Le tronc commun remonte `sortie`, le tour clôt la session et le
   *  scénario reprend par ce handle. Le code de sortie est une énumération fermée déclarée par le client. */
  terminer: async ({ args }) => {
    const sortie = texte(args, 'sortie');
    if (sortie === '') return echec('parametre « sortie » manquant');
    return { contenu: { sortie }, sortie };
  },

  /**
   * Escalader vers un humain. `rendu` dit au tour de s'arrêter ; `mainPrise` dit si c'est cette escalade qui a
   * basculé le fil (voir `DecisionAgent.mainPriseParCeTour`), sans quoi la dernière phrase serait jetée.
   */
  escalader: async ({ ctx }, deps) => {
    const mainPrise = await deps.escaladerVersHumain({
      tenantId: ctx.tenantId, waId: ctx.waId, runId: ctx.runId, sessionId: ctx.sessionId, agentId: ctx.agentId,
    });
    return { contenu: { escalade: true }, rendu: true, mainPrise };
  },

  poser_tag: async ({ args, ctx }, deps) => {
    const tag = texte(args, 'tag');
    if (tag === '') return echec('parametre « tag » manquant');
    await deps.poserTag(ctx.tenantId, ctx.waId, tag);
    return { contenu: { pose: tag } };
  },

  /** 🔴 La fiche contact telle que le tour l'a déjà lue : aucun moyen de désigner la fiche de quelqu'un
   *  d'autre, puisque le modèle ne fournit pas d'identifiant ici. */
  lire_contact: async ({ ctx }, deps) => (
    ctx.contact === null ? { contenu: { connu: false } } : { contenu: { connu: true, champs: ctx.contact, ...await analyseOuIndisponible(deps, ctx) } }
  ),

  envoyer_bloc: async ({ args, ctx }, deps) => {
    const code = texte(args, 'code');
    if (code === '') return echec('parametre « code » manquant');
    const res = await deps.envoyerBloc({
      tenantId: ctx.tenantId, waId: ctx.waId, runId: ctx.runId, workflowId: ctx.workflowId, code,
    });
    return res.ok ? { contenu: { envoye: code } } : echec(res.raison ?? 'le bloc n a pas pu etre envoye');
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
   * La clé vient du modèle. La portée est bornée (champs libres du contact courant, jamais l'opt-in), mais une
   * injection peut écraser le champ sur lequel une condition du scénario branche : déclarer `cle` en
   * énumération fermée.
   */
  ecrire_variable: async ({ args, ctx }, deps) => {
    const cle = texte(args, 'cle');
    const valeur = texte(args, 'valeur');
    if (cle === '') return echec('parametre « cle » manquant');
    await deps.ecrireChamp(ctx.tenantId, ctx.waId, cle, valeur);
    return { contenu: { ecrit: cle } };
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
