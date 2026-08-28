import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Guard } from '../auth/middleware';
import type { FicheAEcrire, FicheConnaissance } from '../agent/knowledge';
import { MAX_CORPS, MAX_FICHES_PAR_PAGE, MAX_TITRE, pageEnFiches } from '../agent/scrape';
import { urlRecuperable, type PageDistante } from '../lib/page-distante';
import { scopeTenant, estUuid } from './scope';

/**
 * La base de connaissance d'un agent IA : la voir, la corriger, et la fabriquer depuis une page du site du
 * client.
 *
 * 🔴 CE QUE CET ÉCRAN REND POSSIBLE, ET CE QU'IL REND DANGEREUX. Ce que le client écrit ici finit dans le
 * contexte du modèle à chaque réponse : c'est la seule source que l'agent a le droit d'utiliser (tâche 16bis,
 * `sortie:sans_source`). Deux conséquences. D'abord une base vide n'est pas un agent silencieux mais un agent
 * qui sort du parcours à la première question, ce que l'écran doit dire. Ensuite l'import va chercher une
 * adresse fournie par un client DEPUIS le serveur, qui vit dans le réseau Docker du VPS : la garde SSRF de
 * `src/lib/page-distante.ts` est obligatoire, et elle est appliquée à l'adresse saisie ET à chaque
 * redirection.
 *
 * Réservée aux ADMINISTRATEURS, comme les routes d'agents qu'elle prolonge.
 */

export interface AgentKnowledgeRouteDeps {
  lister(tenantId: string, agentId: string): Promise<FicheConnaissance[]>;
  creer(tenantId: string, agentId: string, fiche: FicheAEcrire): Promise<FicheConnaissance | null>;
  modifier(tenantId: string, agentId: string, ficheId: string, patch: { titre?: string; corps?: string }): Promise<FicheConnaissance | null>;
  supprimer(tenantId: string, agentId: string, ficheId: string): Promise<boolean>;
  remplacerSource(tenantId: string, agentId: string, sourceUrl: string, fiches: FicheAEcrire[]): Promise<{ retirees: number; ecrites: number } | null>;
  /** Lecture d'une page distante. Injectée pour rester testable sans réseau ; absente, l'import répond 503. */
  fetchUrl?(url: string): Promise<PageDistante>;
}

/** Titre et corps sont bornés aux MÊMES valeurs que ce qu'un import produit (`src/agent/scrape.ts`) : deux
 *  plafonds différents feraient qu'une fiche importée ne serait plus modifiable telle quelle. */
const TITRE = z.string().trim().min(1).max(MAX_TITRE);
const CORPS = z.string().trim().min(1).max(MAX_CORPS);
const creationSchema = z.object({ titre: TITRE, corps: CORPS });
const patchSchema = z.object({ titre: TITRE.optional(), corps: CORPS.optional() });
const importSchema = z.object({ url: z.string().trim().min(1).max(2000) });

export function registerAgentKnowledge(app: FastifyInstance, deps: AgentKnowledgeRouteDeps, guard?: Guard): void {
  const opts = guard ? { preHandler: guard } : {};
  const base = '/tenants/:tenantId/agents/:agentId/knowledge';

  /** Tenant du jeton et identifiants bien formés, ou la réponse d'erreur déjà décidée. */
  function contexte(req: { params: unknown; auth?: { tenantId: string } }): { tenant: string; agentId: string } | { code: 403 | 404; error: string } {
    const tenant = scopeTenant(req);
    if (tenant === null) return { code: 403, error: 'tenant interdit' };
    const { agentId } = req.params as { agentId: string };
    // Un identifiant mal formé part sinon tel quel dans un `where` sur une colonne `uuid` et fait LEVER
    // Postgres, donc un 500 dont Cloudflare remplace le corps. Une adresse tapée de travers rend 404.
    if (!estUuid(agentId)) return { code: 404, error: 'agent introuvable' };
    return { tenant, agentId };
  }

  app.get(base, opts, async (req, reply) => {
    const ctx = contexte(req);
    if ('code' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    return reply.code(200).send({ fiches: await deps.lister(ctx.tenant, ctx.agentId) });
  });

  app.post(base, opts, async (req, reply) => {
    const ctx = contexte(req);
    if ('code' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    const parse = creationSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: `titre et corps requis (corps : ${MAX_CORPS} caractères au plus)` });
    const fiche = await deps.creer(ctx.tenant, ctx.agentId, parse.data);
    // `null` : l'agent n'existe pas, ou appartient à un autre tenant. Les deux se répondent pareil, sinon la
    // route dirait à qui la sonde quels identifiants existent ailleurs.
    if (!fiche) return reply.code(404).send({ error: 'agent introuvable' });
    return reply.code(201).send({ fiche });
  });

  app.patch(`${base}/:ficheId`, opts, async (req, reply) => {
    const ctx = contexte(req);
    if ('code' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    const { ficheId } = req.params as { ficheId: string };
    if (!estUuid(ficheId)) return reply.code(404).send({ error: 'fiche introuvable' });
    const parse = patchSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: `titre ou corps invalide (corps : ${MAX_CORPS} caractères au plus)` });
    if (parse.data.titre === undefined && parse.data.corps === undefined) {
      return reply.code(400).send({ error: 'aucun champ à modifier' });
    }
    const fiche = await deps.modifier(ctx.tenant, ctx.agentId, ficheId, parse.data);
    if (!fiche) return reply.code(404).send({ error: 'fiche introuvable' });
    return reply.code(200).send({ fiche });
  });

  app.delete(`${base}/:ficheId`, opts, async (req, reply) => {
    const ctx = contexte(req);
    if ('code' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    const { ficheId } = req.params as { ficheId: string };
    if (!estUuid(ficheId)) return reply.code(404).send({ error: 'fiche introuvable' });
    const supprime = await deps.supprimer(ctx.tenant, ctx.agentId, ficheId);
    if (!supprime) return reply.code(404).send({ error: 'fiche introuvable' });
    return reply.code(204).send();
  });

  /**
   * Lit une page et en fait des fiches, en REMPLAÇANT celles que la même adresse avait déjà produites.
   *
   * Toutes les issues d'échec sont en 4xx, jamais en 5xx : un site injoignable, une page vide ou un PDF ne
   * sont pas des incidents de la console, ce sont des choses que le client doit lire et corriger lui-même.
   */
  app.post(`${base}/import`, opts, async (req, reply) => {
    const ctx = contexte(req);
    if ('code' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    if (!deps.fetchUrl) return reply.code(503).send({ error: 'import depuis une URL indisponible' });
    const parse = importSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'url requise' });
    if (!urlRecuperable(parse.data.url)) {
      return reply.code(400).send({ error: 'adresse invalide ou non autorisée (http(s) et hôte public attendus)' });
    }
    // Forme canonique : sans elle, la même page importée avec et sans barre finale ferait deux sources, donc
    // deux jeux de fiches jumelles qu'aucune relecture ne remplacerait jamais ensemble.
    const url = new URL(parse.data.url.trim()).toString();

    let page: PageDistante;
    try {
      page = await deps.fetchUrl(url);
    } catch (err) {
      return reply.code(422).send({ error: `page injoignable : ${err instanceof Error ? err.message : 'erreur réseau'}` });
    }
    if (page.status >= 400) return reply.code(422).send({ error: `la page a répondu HTTP ${page.status}` });
    const type = page.contentType.toLowerCase();
    // Un PDF ou une image passeraient dans l'extracteur et rendraient des fiches de charabia, qui deviendraient
    // ensuite des sources acceptables pour la recherche. Mieux vaut refuser en le disant.
    if (type !== '' && !type.includes('html') && !type.includes('plain')) {
      return reply.code(422).send({ error: 'cette adresse ne rend pas une page web (HTML attendu)' });
    }

    const fiches = pageEnFiches(page.body, url);
    if (fiches.length === 0) return reply.code(422).send({ error: 'aucun contenu exploitable sur cette page' });
    const bilan = await deps.remplacerSource(ctx.tenant, ctx.agentId, url, fiches);
    if (!bilan) return reply.code(404).send({ error: 'agent introuvable' });
    return reply.code(200).send({ url, ...bilan, plafond: MAX_FICHES_PAR_PAGE });
  });
}
