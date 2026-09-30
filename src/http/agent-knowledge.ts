import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { gardeEtendue, type Guard, type PreHandler } from '../auth/middleware';
import type { FicheAEcrire, FicheConnaissance, SourceFiche } from '../agent/knowledge';
import { MAX_CORPS, MAX_FICHES_PAR_PAGE, MAX_TITRE, pageEnFiches } from '../agent/scrape';
import { urlRecuperable, type PageDistante } from '../lib/page-distante';
import { PAGES_MAX, dansLaPortee, normaliserUrl, porteeParDefaut, visiter } from '../agent/crawl';
import {
  TAILLE_DOCUMENT_MAX, lireDocumentHorsBoucle,
} from '../agent/setup/piece-jointe';
import { octetsDepuisDataUrl } from '../rcs/image';
import { espaceVerifie, estUuid } from './scope';

/**
 * La base de connaissance d'un agent IA : la voir, la corriger, la fabriquer depuis le site du client. Réservée
 * aux administrateurs. Ce qui s'écrit ici entre dans le contexte du modèle à chaque réponse, seule source que
 * l'agent a le droit d'utiliser : une base vide fait sortir l'agent du parcours à la première question.
 * 🔴 L'import va chercher une adresse fournie par un client depuis le serveur (réseau Docker du VPS) : la garde
 * SSRF de `src/lib/page-distante.ts` s'applique à l'adresse saisie et à chaque redirection.
 */

/** Ce que les routes lisent et écrivent de la connaissance d'un agent. */
export interface ConnaissanceDep {
  lister(tenantId: string, agentId: string): Promise<FicheConnaissance[]>;
  creer(tenantId: string, agentId: string, fiche: FicheAEcrire): Promise<FicheConnaissance | null>;
  modifier(tenantId: string, agentId: string, ficheId: string, patch: { titre?: string; corps?: string }): Promise<FicheConnaissance | null>;
  supprimer(tenantId: string, agentId: string, ficheId: string): Promise<boolean>;
  remplacerSource(tenantId: string, agentId: string, source: SourceFiche, fiches: FicheAEcrire[]): Promise<{ retirees: number; ecrites: number } | null>;
}

export interface AgentKnowledgeRouteDeps {
  connaissance: ConnaissanceDep;
  /**
   * Journalise une fiche effacée dans l'historique de l'agent. 🔴 Pas de corbeille : cette ligne est le seul
   * exemplaire d'une fiche supprimée. La route ne doit pas échouer parce qu'une écriture de journal échoue.
   */
  journaliserSuppression(tenantId: string, agentId: string, ligne: {
    cible: string;
    libelle: string;
    avant: unknown;
    acteurId: string | null;
  }): Promise<void>;
  /** Lecture d'une page distante. Injectée pour rester testable sans réseau ; absente, l'import et
  *  l'aperçu répondent 503. */
  fetchUrl?(url: string): Promise<PageDistante>;
}

/** Titre et corps sont bornés aux mêmes valeurs que ce qu'un import produit (`src/agent/scrape.ts`) : deux
*  plafonds différents feraient qu'une fiche importée ne serait plus modifiable telle quelle. */
const TITRE = z.string().trim().min(1).max(MAX_TITRE);
const CORPS = z.string().trim().min(1).max(MAX_CORPS);
const creationSchema = z.object({ titre: TITRE, corps: CORPS });
const patchSchema = z.object({ titre: TITRE.optional(), corps: CORPS.optional() });
const documentSchema = z.object({
  nom: z.string().trim().min(1).max(MAX_TITRE),
  /** Le fichier, en data URL base64. Même transport que le téléversement d'image, déjà éprouvé. */
  dataUrl: z.string().min(1),
});

/**
 * Une suppression en masse, bornée : sans plafond, une liste arbitraire ferait une requête arbitrairement longue.
 * 200 couvre « je coche tout et je supprime », et le client peut recommencer.
 */
const suppressionSchema = z.object({ ids: z.array(z.string().trim()).min(1).max(200) });

const PORTEE = z.enum(['page', 'sous-arbre', 'site']);
const importSchema = z.object({
  url: z.string().trim().min(1).max(2000),
  portee: PORTEE.optional(),
  /**
   * Les pages à importer, telles que l'aperçu les a rendues. Chacune est revalidée ici (garde SSRF, même origine
   * que `url`) : la liste vient du client. Absente, on importe la seule adresse fournie.
   */
  pages: z.array(z.string().trim().min(1).max(2000)).max(PAGES_MAX).optional(),
});

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

  /**
   * Lit une page avec toutes ses gardes, et rend son HTML ou la raison de l'écart.
   * 🔴 La garde SSRF s'applique à chaque adresse, y compris celles découvertes dans le HTML : un lien trouvé sur un
   * site tiers ne vaut pas mieux qu'une saisie, et pourrait viser les métadonnées du fournisseur ou le réseau Docker.
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

  /** Tenant vérifié par l'étape d'espace et identifiants bien formés, ou la réponse d'erreur déjà décidée. */
  function contexte(req: { params: unknown }): { tenant: string; agentId: string } | { code: 404; error: string } {
    const tenant = espaceVerifie(req);
    const { agentId } = req.params as { agentId: string };
    // Identifiant mal formé : 404, sinon Postgres lèverait sur la colonne `uuid` (donc un 500).
    if (!estUuid(agentId)) return { code: 404, error: 'agent introuvable' };
    return { tenant, agentId };
  }

  app.get(base, opts, async (req, reply) => {
    const ctx = contexte(req);
    if ('code' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    return reply.code(200).send({ fiches: await deps.connaissance.lister(ctx.tenant, ctx.agentId) });
  });

  app.post(base, opts, async (req, reply) => {
    const ctx = contexte(req);
    if ('code' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    const parse = creationSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: `titre et corps requis (corps : ${MAX_CORPS} caractères au plus)` });
    const fiche = await deps.connaissance.creer(ctx.tenant, ctx.agentId, parse.data);
    // 🔴 `null` : l'agent n'existe pas ou appartient à un autre espace. Même réponse, sinon la route dirait quels
    // identifiants existent ailleurs.
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
  const journaliser = async (
    ctx: { tenant: string; agentId: string }, req: FastifyRequest, ficheId: string, avant: FicheConnaissance | undefined,
  ): Promise<void> => {
    await deps.journaliserSuppression(ctx.tenant, ctx.agentId, {
      cible: ficheId,
      libelle: `Fiche de connaissance : ${avant?.titre ?? ficheId}`,
      avant: avant ?? { id: ficheId },
      acteurId: req.auth?.userId ?? null,
    });
  };

  app.delete(`${base}/:ficheId`, opts, async (req, reply) => {
    const ctx = contexte(req);
    if ('code' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    const { ficheId } = req.params as { ficheId: string };
    if (!estUuid(ficheId)) return reply.code(404).send({ error: 'fiche introuvable' });
    const avant = await ficheAvant(ctx, ficheId);
    const supprime = await deps.connaissance.supprimer(ctx.tenant, ctx.agentId, ficheId);
    if (!supprime) return reply.code(404).send({ error: 'fiche introuvable' });
    // Après la suppression : journaliser un geste qui n'a pas eu lieu ferait chercher une cause inexistante.
    await journaliser(ctx, req, ficheId, avant);
    return reply.code(204).send();
  });

  /**
   * Supprime plusieurs fiches en une seule requête : boucler côté navigateur laisserait, au premier échec, une
   * sélection à moitié supprimée. Les identifiants mal formés sont écartés ici : un uuid invalide ferait lever la
   * requête entière.
   */
  app.post(`${base}/supprimer`, optsLourds, async (req, reply) => {
    const ctx = contexte(req);
    if ('code' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    const parse = suppressionSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'ids requis (1 à 200 identifiants)' });
    const ids = parse.data.ids.filter((id) => estUuid(id));
    if (ids.length === 0) return reply.code(400).send({ error: 'aucun identifiant valide' });

    /**
     * La suppression en masse se journalise aussi (c'est elle qui peut effacer deux cents fiches), avec une seule
     * lecture pour toute la fournée.
     */
    const avantParId = new Map(
      (await deps.connaissance.lister(ctx.tenant, ctx.agentId).catch(() => [])).map((f) => [f.id, f] as const),
    );
    let supprimees = 0;
    for (const id of ids) {
      if (!(await deps.connaissance.supprimer(ctx.tenant, ctx.agentId, id))) continue;
      supprimees += 1;
      await journaliser(ctx, req, id, avantParId.get(id));
    }
    // On rend le compte réel, pas la taille de la demande : une fiche déjà supprimée par un collègue ne doit pas
    // être annoncée comme supprimée par ce clic.
    return reply.code(200).send({ supprimees, demandees: ids.length });
  });

  /**
   * Importe un document (texte, CSV, PDF, Word) en fiches, avec le moteur de `src/agent/setup/piece-jointe.ts` :
   * un PDF joint en conversation donne exactement les mêmes fiches. 🔴 Le type est décidé par la signature du
   * fichier, jamais par son extension : ce texte finit dans le prompt d'un agent qui parle à de vrais contacts.
   * Les images ne passent pas ici : il faudrait un modèle de vision.
   */
  // Son propre plafond de corps, comme la pièce jointe de la conversation : le plafond global (un million d'octets)
  // refusait en 413 tout fichier de plus de 750 Ko environ, les octets transitant en base64 (+33 %).
  app.post(`${base}/document`, { ...optsLourds, bodyLimit: Math.ceil(TAILLE_DOCUMENT_MAX * 1.4) }, async (req, reply) => {
    const ctx = contexte(req);
    if ('code' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    const parse = documentSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'nom et dataUrl requis' });

    const bytes = octetsDepuisDataUrl(parse.data.dataUrl);
    if (!bytes) return reply.code(400).send({ error: 'fichier illisible (data URL base64 attendu)' });
    // Nature, texte et fiches en UN seul worker : seules les fiches reviennent, jamais le texte.
    const lu = await lireDocumentHorsBoucle(bytes, parse.data.nom, TAILLE_DOCUMENT_MAX);
    const reconnu = lu.reconnu;
    // 415 et pas 400 : le corps est bien formé, c'est le type du contenu qu'on refuse.
    if (!reconnu) return reply.code(415).send({ error: 'format non accepté (texte en UTF-8, CSV, PDF ou Word)' });
    if (reconnu.nature === 'image') {
      return reply.code(415).send({
        error: 'une image se dépose dans la conversation de construction, qui sait la lire ; ici on attend un document texte, CSV, PDF ou Word',
      });
    }
    if (bytes.length > TAILLE_DOCUMENT_MAX) {
      return reply.code(413).send({ error: `fichier trop lourd (${Math.round(TAILLE_DOCUMENT_MAX / 1024 / 1024)} Mo maximum)` });
    }

    // 422 : le type est accepté mais le fichier ne porte aucun texte. Le dire vaut mieux qu'un succès à zéro
    // fiche, que le client lirait comme un import réussi.
    if (!lu.fiches) {
      return reply.code(422).send({ error: 'aucun texte lisible dans ce fichier (un PDF scanné, par exemple, n’en contient pas)' });
    }
    const fiches = lu.fiches;
    if (fiches.length === 0) return reply.code(422).send({ error: 'ce fichier est trop court pour faire une fiche' });

    // Remplace, comme une page relue : redéposer le même fichier retire ses fiches d'avant (sinon deux dépôts
    // doubleraient la base, et la recherche remonterait deux fois la même réponse).
    const bilan = await deps.connaissance.remplacerSource(ctx.tenant, ctx.agentId, { type: 'document', nom: parse.data.nom }, fiches);
    if (!bilan) return reply.code(404).send({ error: 'agent introuvable' });
    return reply.code(200).send({ nom: parse.data.nom, nature: reconnu.nature, ...bilan, plafond: MAX_FICHES_PAR_PAGE });
  });

  /**
   * L'aperçu : ce que l'import ramènerait, sans rien écrire (un import de cinquante pages est difficile à défaire).
   * Il dit aussi ce qu'il n'a pas pris : les pages écartées avec leur raison, et le plafond quand il a coupé.
   */
  app.post(`${base}/apercu`, optsLourds, async (req, reply) => {
    const ctx = contexte(req);
    if ('code' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    if (!deps.fetchUrl) return reply.code(503).send({ error: 'import depuis une URL indisponible' });
    const parse = importSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'url requise' });
    if (!urlRecuperable(parse.data.url)) {
      return reply.code(400).send({ error: 'adresse invalide ou non autorisée (http(s) et hôte public attendus)' });
    }
    const url = normaliserUrl(parse.data.url.trim());
    // La portée se déduit de l'adresse quand personne n'en a choisi une : racine -> le site, chemin -> la page.
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
      // On rend le compte de fiches par page, jamais leur contenu : l'aperçu sert à décider d'une portée,
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
   * Lit une page et en fait des fiches, en remplaçant celles que la même adresse avait produites. Toutes les
   * issues d'échec sont en 4xx : un site injoignable ou une page vide sont à lire et corriger par le client.
   */
  app.post(`${base}/import`, optsLourds, async (req, reply) => {
    const ctx = contexte(req);
    if ('code' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    if (!deps.fetchUrl) return reply.code(503).send({ error: 'import depuis une URL indisponible' });
    const parse = importSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'url requise' });
    if (!urlRecuperable(parse.data.url)) {
      return reply.code(400).send({ error: 'adresse invalide ou non autorisée (http(s) et hôte public attendus)' });
    }
    // Forme canonique, par `normaliserUrl` et rien d'autre (l'aperçu l'emploie aussi) : sans elle, la même page
    // avec et sans barre finale ferait deux sources, donc deux jeux de fiches jumelles.
    const url = normaliserUrl(parse.data.url.trim());

    /**
     * Les adresses à importer ; sans liste, l'adresse fournie seule.
     * 🔴 Chaque adresse est revalidée, même venant de notre aperçu (la liste arrive par le réseau), et son origine
     * doit être celle de `url` : sinon un client importerait le site d'un tiers sous son nom.
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
      const bilan = await deps.connaissance.remplacerSource(ctx.tenant, ctx.agentId, { type: 'page', url: cible }, fiches);
      // `null` = l'agent n'existe pas : inutile de continuer les 49 pages suivantes.
      if (!bilan) return reply.code(404).send({ error: 'agent introuvable' });
      ecrites += bilan.ecrites;
      retirees += bilan.retirees;
      importees.push(cible);
    }
    // Aucune page retenue : 422 portant la raison de la première (un 200 à zéro fiche se lirait comme un succès).
    if (importees.length === 0) {
      return reply.code(422).send({ error: `aucun contenu importé : ${ecartees[0]?.raison ?? 'page vide'}` });
    }
    return reply.code(200).send({
      url, ecrites, retirees, importees, ecartees, plafond: MAX_FICHES_PAR_PAGE,
    });
  });
}
