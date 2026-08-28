import type { EntreeResolveur, ResolveurOutil, SortieResolveur } from '../executor';
import { ficheEstPertinente, type KnowledgeStore } from '../knowledge';
import { SORTIE_SANS_SOURCE } from '../sorties';

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
  escaladerVersHumain(input: { tenantId: string; waId: string; runId: string; sessionId: string }): Promise<void>;

  /** Pose un tag sur le contact (`mba_poser_tag`). */
  poserTag(tenantId: string, waId: string, tag: string): Promise<void>;

  /** Écrit une valeur dans les champs du contact (`mba_ecrire_variable`), pour qu'un bloc plus loin la relise. */
  ecrireChamp(tenantId: string, waId: string, cle: string, valeur: string): Promise<void>;

  /** La base de connaissance de l'agent (`mba_chercher_connaissance`). */
  connaissance: KnowledgeStore;
}

/** Nombre de fiches rendues au modèle. Au-delà, on paie du contexte à chaque tour pour des sources que le
 *  modèle n'utilisera pas. */
const FICHES_RENDUES = 3;

/**
 * Bornes de ce qui repart au modèle. Le tronc commun borne DÉJÀ la réponse entière à `max_bytes`, mais sa
 * troncature remplace toute la structure par un aperçu : trois fiches entières la déclencheraient, et le
 * modèle recevrait une source mutilée au lieu de sources listées. Le pire des deux mondes pour un mécanisme
 * anti-hallucination, donc on borne fiche par fiche, en le disant.
 */
const CORPS_MAX = 2_000;

/** La requête vient du modèle, qui peut recopier un message que le contact contrôle. `similarity()` génère
 *  les trigrammes de cette chaîne pour chaque ligne candidate : une requête de plusieurs kilo-octets se
 *  paierait en base. */
const REQUETE_MAX = 512;

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

  /** Escalader vers un humain. `rendu` dit au tour de s'arrêter : la main n'est plus à nous. */
  escalader: async ({ ctx }, deps) => {
    await deps.escaladerVersHumain({
      tenantId: ctx.tenantId, waId: ctx.waId, runId: ctx.runId, sessionId: ctx.sessionId,
    });
    return { contenu: { escalade: true }, rendu: true };
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
    const requete = texte(args, 'requete').slice(0, REQUETE_MAX);
    if (requete === '') return echec('parametre « requete » manquant');
    const fiches = await deps.connaissance.chercher(ctx.tenantId, ctx.agentId, requete, FICHES_RENDUES);
    const retenues = fiches.filter(ficheEstPertinente);
    if (retenues.length === 0) {
      return { contenu: { aucune_source: true }, sortie: SORTIE_SANS_SOURCE };
    }
    return {
      contenu: {
        sources: retenues.map((f) => ({
          titre: f.titre,
          contenu: f.corps.length > CORPS_MAX ? `${f.corps.slice(0, CORPS_MAX)}...` : f.corps,
          url: f.sourceUrl,
        })),
      },
    };
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
