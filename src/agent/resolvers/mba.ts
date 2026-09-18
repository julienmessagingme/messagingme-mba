import type { EntreeResolveur, ResolveurOutil, SortieResolveur } from '../executor';
import type { KnowledgeStore } from '../knowledge';
import { chercherConnaissance, type RechercheSemantique } from './connaissance';

/**
 * Le résolveur des outils MAISON : une table de correspondance `handler` vers fonction TypeScript, en dur, et
 * aucun réseau. Ce sont les seuls outils dont nous écrivons nous-mêmes le comportement, et donc les seuls sur
 * lesquels on peut promettre quoi que ce soit.
 *
 * Le `handler` est lu dans `binding`, jamais déduit du nom exposé : le client peut renommer un outil dans sa
 * console (c'est même souhaitable, un nom parlant fait un meilleur agent), et le comportement ne doit pas
 * suivre le nom.
 *
 * Comme tout résolveur, il ne lève pas sur un cas métier : il rend `ok: false` avec une raison lisible, que le
 * tronc commun repasse au modèle.
 */

export interface DepsResolveurMba {
  /**
   * Déclenche un bloc du scénario COURANT (`mba_envoyer_bloc`). Implémentée par
   * `WorkflowExecutor.envoyerBlocDepuisAgent`, dont le commentaire porte les raisons (elle ne doit surtout
   * pas passer par `startFromNode`).
   */
  envoyerBloc(input: {
    tenantId: string; waId: string; runId: string; workflowId: string; code: string;
  }): Promise<{ ok: boolean; raison?: string }>;

  /**
   * Escalade vers un humain (`mba_escalader_humain`). Implémentée par `creerEscaladeVersHumain`
   * (`src/agent/escalade.ts`), qui ordonne les trois effets et explique pourquoi cet ordre.
   */
  escaladerVersHumain(input: { tenantId: string; waId: string; runId: string; sessionId: string }): Promise<boolean>;

  /** Pose un tag sur le contact (`mba_poser_tag`). */
  poserTag(tenantId: string, waId: string, tag: string): Promise<void>;

  /** Écrit une valeur dans les champs du contact (`mba_ecrire_variable`), pour qu'un bloc plus loin la relise. */
  ecrireChamp(tenantId: string, waId: string, cle: string, valeur: string): Promise<void>;

  /** La base de connaissance de l'agent (`mba_chercher_connaissance`). */
  connaissance: KnowledgeStore;
  /**
   * Le RAPPEL vectoriel et le VERDICT du reranker (migration 0110). OPTIONNELLE : absente, la recherche
   * retombe sur le plein texte et la regle lexicale, c'est-a-dire le comportement d'avant. C'est ce qui rend
   * la migration non bloquante et le Gateway non indispensable a la lecture d'une base.
   */
  recherche?: RechercheSemantique;
}

/** Lit un argument textuel non vide. Les arguments sont déjà validés par le tronc commun, mais contre une
 *  DÉCLARATION qui vient du client : un handler ne suppose jamais que sa déclaration est bien faite. */
function texte(args: Record<string, unknown>, cle: string): string {
  const v = args[cle];
  return typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v).trim();
}

function echec(raison: string): SortieResolveur {
  return { ok: false, contenu: { erreur: raison }, erreur: raison };
}

type Handler = (entree: EntreeResolveur, deps: DepsResolveurMba) => Promise<SortieResolveur>;

const HANDLERS: Record<string, Handler> = {
  /** Terminer par une sortie prédéfinie. Le tronc commun remonte `sortie`, le tour clôt la session et le
   *  scénario reprend par ce handle. Le code de sortie est une énumération fermée déclarée par le client. */
  terminer: async ({ args }) => {
    const sortie = texte(args, 'sortie');
    if (sortie === '') return echec('parametre « sortie » manquant');
    return { contenu: { sortie }, sortie };
  },

  /**
   * Escalader vers un humain. `rendu` dit au tour de s'arrêter : la main n'est plus à nous.
   *
   * 🔴 `mainPrise` DIT QUI L'A PRISE, et sans lui le tour ne peut plus écrire un mot (revue du 2026-09-18).
   * `run-turn` refuse d'envoyer dès que le fil n'est plus `app_workflow` : c'est une garde juste, mais
   * l'escalade vient elle-même de le basculer, donc elle l'armait contre nous et la dernière phrase de
   * l'agent était jetée en silence. Ce booléen sépare les deux cas, et il vient de l'écriture, pas d'une
   * relecture du détenteur qui rouvrirait la course.
   */
  escalader: async ({ ctx }, deps) => {
    const mainPrise = await deps.escaladerVersHumain({
      tenantId: ctx.tenantId, waId: ctx.waId, runId: ctx.runId, sessionId: ctx.sessionId,
    });
    return { contenu: { escalade: true }, rendu: true, mainPrise };
  },

  poser_tag: async ({ args, ctx }, deps) => {
    const tag = texte(args, 'tag');
    if (tag === '') return echec('parametre « tag » manquant');
    await deps.poserTag(ctx.tenantId, ctx.waId, tag);
    return { contenu: { pose: tag } };
  },

  /** La fiche contact telle que le tour l'a déjà lue : aucune requête de plus, et surtout aucune façon de
   *  désigner la fiche de QUELQU'UN D'AUTRE, puisque le modèle ne fournit pas d'identifiant ici. */
  lire_contact: async ({ ctx }) => (
    ctx.contact === null ? { contenu: { connu: false } } : { contenu: { connu: true, champs: ctx.contact } }
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
   * Cherche dans la base de connaissance. C'est le seul handler qui peut demander une SORTIE sans que le
   * modèle l'ait décidé, et c'est le sujet : aucune fiche pertinente -> `{ aucune_source: true }` et
   * `sortie: sans_source`, jamais une fiche, jamais une réponse inventée.
   *
   * Les MESURES viennent de la base, la RÈGLE est appliquée ici (`ficheEstPertinente`), et le modèle ne voit
   * ni l'une ni les autres : lui montrer un score reviendrait à lui rendre la décision qu'on lui retire.
   */
  chercher_connaissance: async ({ args, ctx }, deps) => {
    const requete = texte(args, 'requete');
    if (requete === '') return echec('parametre « requete » manquant');
    return chercherConnaissance(deps.connaissance, ctx, requete, deps.recherche);
  },

  /**
   * ⚠️ La CLÉ vient du modèle. La portée est bornée (`ecrireChamp` n'écrit que les champs libres du contact
   * courant, jamais l'opt-in ni un autre contact), mais une injection peut écraser le champ sur lequel une
   * condition du scénario branche. La parade est de déclarer `cle` avec une énumération fermée : à proposer
   * par défaut dans la console qui configure cet outil.
   */
  ecrire_variable: async ({ args, ctx }, deps) => {
    const cle = texte(args, 'cle');
    const valeur = texte(args, 'valeur');
    if (cle === '') return echec('parametre « cle » manquant');
    await deps.ecrireChamp(ctx.tenantId, ctx.waId, cle, valeur);
    return { contenu: { ecrit: cle } };
  },
};

/** Les handlers qui existent VRAIMENT. Exporté pour que `tests/agent-outils-maison.test.ts` casse dès que le
 *  catalogue de la console (`src/agent/outils-maison.ts`) et cette table cessent de se correspondre : un
 *  handler sans entrée au catalogue est inatteignable, une entrée sans handler est un outil mort-né. */
export const HANDLERS_MAISON: readonly string[] = Object.keys(HANDLERS);

export function creerResolveurMba(deps: DepsResolveurMba): ResolveurOutil {
  return async (entree) => {
    const nom = String(entree.outil.binding.handler ?? '').trim();
    // `hasOwn` et non un accès direct : `binding` est du jsonb écrit par la console, et un `handler` valant
    // « valueOf » ou « toString » retrouverait une méthode du prototype, appelée sans `this` donc en
    // exception, là où on veut un refus propre.
    const handler = Object.hasOwn(HANDLERS, nom) ? HANDLERS[nom] : undefined;
    // Un handler inconnu est une erreur de CONFIGURATION, pas une erreur du modèle : il n'y a rien qu'il
    // puisse corriger. On le lui dit quand même plutôt que de lever, pour que le tour se termine proprement.
    if (!handler) return echec(`outil maison inconnu : ${nom || '(handler absent)'}`);
    return handler(entree, deps);
  };
}
