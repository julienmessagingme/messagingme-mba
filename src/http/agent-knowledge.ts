import type { FastifyInstance, FastifyRequest } from 'fastify';
import { gardeEtendue, type Guard, type PreHandler } from '../auth/middleware';
import type { FicheConnaissance } from '../agent/knowledge';
import { MAX_CORPS } from '../agent/scrape';
import { TAILLE_DOCUMENT_MAX } from '../agent/setup/piece-jointe';
import {
  ajouterFiches, apercuSite, importerDocument, importerSite, journaliserFicheSupprimee, saisieDePatchDeFiche,
  supprimerFiches, type DepsConnaissance,
} from '../agent/connaissance';
import { corpsDuRefus, type Issue } from '../lib/issue';
import { espaceVerifie, estUuid } from './scope';

/**
 * La base de connaissance d'un agent IA : la voir, la corriger, la fabriquer depuis le site du client. Réservée
 * aux administrateurs. Les écritures passent par `src/agent/connaissance.ts`, que les outils MCP de l'agent appellent
 * aussi : gardes d'adresse, découpage, remplacement et journal y vivent ; la route n'ajoute que la garde, le plafond
 * des opérations lourdes et la traduction des refus en statuts.
 */

/** Les dépendances des routes : celles de la gestion, les MÊMES objets que le MCP reçoit. */
export type AgentKnowledgeRouteDeps = DepsConnaissance;
export type { ConnaissanceDep } from '../agent/connaissance';
// Les deux échéances d'un parcours de site, dont la somme est tenue par `tests/http-agent-knowledge.test.ts`.
export { ECHEANCE_PARCOURS_MS, LECTURE_PAGES } from '../agent/connaissance';

export function registerAgentKnowledge(
  app: FastifyInstance, deps: AgentKnowledgeRouteDeps, garde: Guard, limiteCouteuse?: PreHandler,
): void {
  const opts = { preHandler: garde };
  /**
   * Le plafond des opérations lourdes, par espace, sur les quatre routes qui en sont : suppression en masse, import
   * d'un document (extraction d'un PDF de 8 Mo dans le process), aperçu et import d'un site (des dizaines de
   * requêtes sortantes). Pas sur les lectures ni l'édition d'une fiche : à 10 par minute, l'écran serait inutilisable.
   */
  const optsLourds = gardeEtendue(garde, limiteCouteuse);
  const base = '/tenants/:tenantId/agents/:agentId/knowledge';

  /** Tenant vérifié par l'étape d'espace et identifiants bien formés, ou la réponse d'erreur déjà décidée. */
  function contexte(req: { params: unknown }): { tenant: string; agentId: string } | { code: 404; error: string } {
    const tenant = espaceVerifie(req);
    const { agentId } = req.params as { agentId: string };
    // Identifiant mal formé : 404, sinon Postgres lèverait sur la colonne `uuid` (donc un 500).
    if (!estUuid(agentId)) return { code: 404, error: 'agent introuvable' };
    return { tenant, agentId };
  }

  /** L'espace de la session et l'agent de l'adresse : la gestion contrôle la forme de l'identifiant. */
  function cible(req: { params: unknown }): { tenant: string; agentId: string } {
    return { tenant: espaceVerifie(req), agentId: (req.params as { agentId: string }).agentId };
  }

  /** Une issue de la gestion, en réponse : le refus avec sa phrase, ou la valeur sous le statut de la route. */
  function repondre<T>(reply: { code(n: number): { send(b: unknown): unknown } }, r: Issue<T>, statut: number, corps: (v: T) => unknown) {
    return r.ok ? reply.code(statut).send(corps(r.valeur)) : reply.code(r.statut).send(corpsDuRefus(r));
  }

  app.get(base, opts, async (req, reply) => {
    const ctx = contexte(req);
    if ('code' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    return reply.code(200).send({ fiches: await deps.connaissance.lister(ctx.tenant, ctx.agentId) });
  });

  // Une fiche depuis l'onglet : la gestion en accepte plusieurs (le MCP), la route lui en passe une seule.
  app.post(base, opts, async (req, reply) => {
    const { tenant, agentId } = cible(req);
    return repondre(reply, await ajouterFiches(deps, tenant, agentId, [req.body ?? {}]), 201, (fiches) => ({ fiche: fiches[0] }));
  });

  app.patch(`${base}/:ficheId`, opts, async (req, reply) => {
    const ctx = contexte(req);
    if ('code' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    const { ficheId } = req.params as { ficheId: string };
    if (!estUuid(ficheId)) return reply.code(404).send({ error: 'fiche introuvable' });
    const parse = saisieDePatchDeFiche.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: `titre ou corps invalide (corps : ${MAX_CORPS} caractères au plus)` });
    if (parse.data.titre === undefined && parse.data.corps === undefined) {
      return reply.code(400).send({ error: 'aucun champ à modifier' });
    }
    const fiche = await deps.connaissance.modifier(ctx.tenant, ctx.agentId, ficheId, parse.data);
    if (!fiche) return reply.code(404).send({ error: 'fiche introuvable' });
    return reply.code(200).send({ fiche });
  });

  /**
   * Le contenu est lu avant la suppression, jamais après : c'est le seul exemplaire qui en restera. Au mieux : si
   * la lecture échoue, on supprime quand même et on journalise l'identifiant seul.
   */
  const ficheAvant = async (ctx: { tenant: string; agentId: string }, ficheId: string): Promise<FicheConnaissance | undefined> => {
    return (await deps.connaissance.lister(ctx.tenant, ctx.agentId).catch(() => [])).find((f) => f.id === ficheId);
  };
  const acteur = (req: FastifyRequest): string | null => req.auth?.userId ?? null;

  app.delete(`${base}/:ficheId`, opts, async (req, reply) => {
    const ctx = contexte(req);
    if ('code' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    const { ficheId } = req.params as { ficheId: string };
    if (!estUuid(ficheId)) return reply.code(404).send({ error: 'fiche introuvable' });
    const avant = await ficheAvant(ctx, ficheId);
    const supprime = await deps.connaissance.supprimer(ctx.tenant, ctx.agentId, ficheId);
    if (!supprime) return reply.code(404).send({ error: 'fiche introuvable' });
    // Après la suppression : journaliser un geste qui n'a pas eu lieu ferait chercher une cause inexistante.
    await journaliserFicheSupprimee(deps, ctx.tenant, ctx.agentId, ficheId, avant, acteur(req));
    return reply.code(204).send();
  });

  /** Plusieurs fiches en une requête, journalisées une à une (`supprimerFiches`). */
  app.post(`${base}/supprimer`, optsLourds, async (req, reply) => {
    const { tenant, agentId } = cible(req);
    return repondre(reply, await supprimerFiches(deps, tenant, agentId, req.body, acteur(req)), 200, (v) => v);
  });

  // Son propre plafond de corps, comme la pièce jointe de la conversation : le plafond global (un million d'octets)
  // refusait en 413 tout fichier de plus de 750 Ko environ, les octets transitant en base64 (+33 %).
  app.post(`${base}/document`, { ...optsLourds, bodyLimit: Math.ceil(TAILLE_DOCUMENT_MAX * 1.4) }, async (req, reply) => {
    const { tenant, agentId } = cible(req);
    return repondre(reply, await importerDocument(deps, tenant, agentId, req.body), 200, (v) => v);
  });

  app.post(`${base}/apercu`, optsLourds, async (req, reply) => {
    const { tenant, agentId } = cible(req);
    return repondre(reply, await apercuSite(deps, tenant, agentId, req.body), 200, (v) => v);
  });

  app.post(`${base}/import`, optsLourds, async (req, reply) => {
    const { tenant, agentId } = cible(req);
    return repondre(reply, await importerSite(deps, tenant, agentId, req.body), 200, (v) => v);
  });
}
