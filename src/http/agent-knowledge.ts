import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Guard } from '../auth/middleware';
import type { FicheAEcrire, FicheConnaissance } from '../agent/knowledge';
import { MAX_CORPS, MAX_FICHES_PAR_PAGE, MAX_TITRE, pageEnFiches } from '../agent/scrape';
import { urlRecuperable, type PageDistante } from '../lib/page-distante';
import { PAGES_MAX, dansLaPortee, normaliserUrl, porteeParDefaut, visiter } from '../agent/crawl';
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
  /** Lecture d'une page distante. Injectée pour rester testable sans réseau ; absente, l'import ET
   *  l'aperçu répondent 503. */
  fetchUrl?(url: string): Promise<PageDistante>;
}

/** Titre et corps sont bornés aux MÊMES valeurs que ce qu'un import produit (`src/agent/scrape.ts`) : deux
 *  plafonds différents feraient qu'une fiche importée ne serait plus modifiable telle quelle. */
const TITRE = z.string().trim().min(1).max(MAX_TITRE);
const CORPS = z.string().trim().min(1).max(MAX_CORPS);
const creationSchema = z.object({ titre: TITRE, corps: CORPS });
const patchSchema = z.object({ titre: TITRE.optional(), corps: CORPS.optional() });
const PORTEE = z.enum(['page', 'sous-arbre', 'site']);
const importSchema = z.object({
  url: z.string().trim().min(1).max(2000),
  portee: PORTEE.optional(),
  /**
   * Les pages à importer, telles que l'aperçu les a rendues.
   *
   * ⚠️ Chacune est REVALIDÉE ici (garde SSRF, et même origine que `url`) : une liste vient du client, même
   * quand c'est nous qui la lui avons donnée. Absente, on importe la seule adresse fournie, ce qui est le
   * comportement d'avant le crawl et reste celui d'une adresse précise.
   */
  pages: z.array(z.string().trim().min(1).max(2000)).max(PAGES_MAX).optional(),
});

export function registerAgentKnowledge(app: FastifyInstance, deps: AgentKnowledgeRouteDeps, guard?: Guard): void {
  const opts = guard ? { preHandler: guard } : {};
  const base = '/tenants/:tenantId/agents/:agentId/knowledge';

  /**
   * Lit UNE page, avec toutes ses gardes, et rend soit son HTML soit la raison de l'écart.
   *
   * 🔴 LA GARDE SSRF S'APPLIQUE A CHAQUE ADRESSE, y compris celles DECOUVERTES dans le HTML d'une page. Un
   * lien trouvé sur un site tiers n'est pas plus digne de confiance que ce qu'un client saisit : sans ce
   * contrôle, une page pourrait faire pointer le crawl vers les métadonnées du fournisseur ou le réseau
   * Docker du VPS. C'est la même règle que pour l'adresse de départ, appliquée au même endroit.
   */
  const lireUnePage = async (url: string): Promise<{ html: string } | { erreur: string }> => {
    if (!urlRecuperable(url)) return { erreur: 'adresse non autorisée' };
    let page: PageDistante;
    try {
      page = await deps.fetchUrl!(url);
    } catch (err) {
      return { erreur: `injoignable : ${err instanceof Error ? err.message : 'erreur réseau'}` };
    }
    if (page.status >= 400) return { erreur: `HTTP ${page.status}` };
    const type = page.contentType.toLowerCase();
    if (type !== '' && !type.includes('html') && !type.includes('plain')) return { erreur: 'pas une page web' };
    return { html: page.body };
  };

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
   * L'APERÇU : ce que l'import ramènerait, sans rien écrire.
   *
   * 🔴 IL EXISTE PARCE QU'UN IMPORT EST DIFFICILE À DÉFAIRE. Cinquante pages écrites d'un coup dans une base
   * de connaissance, ce sont cinquante jeux de fiches à relire ou à supprimer un par un si la portée était
   * mauvaise. Voir avant d'écrire coûte un aller-retour et évite ce ménage.
   *
   * 🔴 ET IL DIT CE QU'IL N'A PAS PRIS : les pages écartées avec leur raison, et le plafond quand il a coupé.
   * « 50 pages » n'est pas « tout le site », et un écran qui ne le dirait pas laisserait croire à une base
   * complète alors qu'il en manque la moitié.
   */
  app.post(`${base}/apercu`, opts, async (req, reply) => {
    const ctx = contexte(req);
    if ('code' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    if (!deps.fetchUrl) return reply.code(503).send({ error: 'import depuis une URL indisponible' });
    const parse = importSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'url requise' });
    if (!urlRecuperable(parse.data.url)) {
      return reply.code(400).send({ error: 'adresse invalide ou non autorisée (http(s) et hôte public attendus)' });
    }
    const url = normaliserUrl(parse.data.url.trim());
    // La portée se DÉDUIT de l'adresse quand personne n'en a choisi une : racine -> le site, chemin -> la page.
    const portee = parse.data.portee ?? porteeParDefaut(url);

    const visite = await visiter(url, portee, lireUnePage);
    if (visite.pages.length === 0) {
      const pourquoi = visite.ecartees[0]?.raison ?? 'aucune page lisible';
      return reply.code(422).send({ error: `rien à importer : ${pourquoi}` });
    }
    return reply.code(200).send({
      url,
      portee,
      plafondAtteint: visite.plafondAtteint,
      ecartees: visite.ecartees,
      // On rend le COMPTE de fiches par page, jamais leur contenu : l'aperçu sert à décider d'une portée,
      // pas à relire cinquante pages dans une réponse HTTP.
      pages: visite.pages.map((p) => {
        const fiches = pageEnFiches(p.html, p.url);
        return {
          url: p.url,
          fiches: fiches.length,
          caracteres: fiches.reduce((n, f) => n + f.corps.length, 0),
        };
      }).filter((p) => p.fiches > 0),
    });
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
    // ⚠️ `normaliserUrl` et RIEN D'AUTRE : cette route en portait une seconde version (`new URL().toString()`),
    // qui garde la barre finale là où l'aperçu la retire. Deux canonicalisations dans le même fichier, c'est
    // l'aperçu qui annonce une adresse et l'import qui en écrit une autre. Vérifié avant d'unifier : la seule
    // source existante en production est inchangée par la règle retenue.
    const url = normaliserUrl(parse.data.url.trim());

    /**
     * Les adresses à importer. Sans liste, c'est l'adresse fournie et elle seule : le comportement d'avant le
     * crawl, et celui qu'une adresse précise doit garder.
     *
     * 🔴 CHAQUE ADRESSE EST REVALIDÉE, même venant de notre propre aperçu. Une liste arrive par le réseau :
     * s'y fier parce qu'on l'a produite serait exactement la faute qu'une garde SSRF existe pour empêcher.
     * Et l'origine doit être celle de `url`, sinon un client importerait le site d'un tiers sous son nom.
     */
    const demandees = parse.data.pages ?? [url];
    const aImporter = demandees
      .map((u) => { try { return normaliserUrl(u); } catch { return ''; } })
      .filter((u) => u !== '' && urlRecuperable(u) && dansLaPortee(u, url, 'site'));
    if (aImporter.length === 0) return reply.code(400).send({ error: 'aucune adresse importable dans la demande' });

    let ecrites = 0;
    let retirees = 0;
    const importees: string[] = [];
    const ecartees: Array<{ url: string; raison: string }> = [];
    for (const cible of aImporter) {
      const lu = await lireUnePage(cible);
      if ('erreur' in lu) { ecartees.push({ url: cible, raison: lu.erreur }); continue; }
      const fiches = pageEnFiches(lu.html, cible);
      if (fiches.length === 0) { ecartees.push({ url: cible, raison: 'aucun contenu exploitable' }); continue; }
      const bilan = await deps.remplacerSource(ctx.tenant, ctx.agentId, cible, fiches);
      // `null` = l'agent n'existe pas : inutile de continuer les 49 pages suivantes.
      if (!bilan) return reply.code(404).send({ error: 'agent introuvable' });
      ecrites += bilan.ecrites;
      retirees += bilan.retirees;
      importees.push(cible);
    }
    // ⚠️ Aucune page retenue : c'est un 422, et il PORTE la raison de la première. Un 200 avec zéro fiche
    // laisserait croire à un import réussi sur une base restée vide.
    if (importees.length === 0) {
      return reply.code(422).send({ error: `aucun contenu importé : ${ecartees[0]?.raison ?? 'page vide'}` });
    }
    return reply.code(200).send({
      url, ecrites, retirees, importees, ecartees, plafond: MAX_FICHES_PAR_PAGE,
    });
  });
}
