import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Guard, PreHandler } from '../auth/middleware';
import type { FicheAEcrire, FicheConnaissance, SourceFiche } from '../agent/knowledge';
import { MAX_CORPS, MAX_FICHES_PAR_PAGE, MAX_TITRE, pageEnFiches } from '../agent/scrape';
import { urlRecuperable, type PageDistante } from '../lib/page-distante';
import { PAGES_MAX, dansLaPortee, normaliserUrl, porteeParDefaut, visiter } from '../agent/crawl';
import {
  TAILLE_DOCUMENT_MAX, extraireTexte, reconnaitre, texteEnFiches,
} from '../agent/setup/piece-jointe';
import { octetsDepuisDataUrl } from '../rcs/image';
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
  /**
   * Journalise une fiche EFFACÉE, dans l'historique de l'agent (migration 0146).
   *
   * 🔴 IL N'Y A PAS DE CORBEILLE ICI NON PLUS. Une fiche supprimée disparaît de `agent_knowledge` : cette
   * ligne en est le seul exemplaire, exactement comme pour le Meta Business Agent. C'est aussi le seul
   * endroit qui réponde à « qui a retiré ça de ce que le robot sait dire ? ».
   *
   * ⚠️ OPTIONNEL : une instance sans historique continue de fonctionner. La route ne DOIT pas échouer parce
   * qu'un journal manque.
   */
  journaliserSuppression?(tenantId: string, agentId: string, ligne: {
    cible: string;
    libelle: string;
    avant: unknown;
    acteurId: string | null;
  }): Promise<void>;
  remplacerSource(tenantId: string, agentId: string, source: SourceFiche, fiches: FicheAEcrire[]): Promise<{ retirees: number; ecrites: number } | null>;
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
const documentSchema = z.object({
  nom: z.string().trim().min(1).max(MAX_TITRE),
  /** Le fichier, en data URL base64. Même transport que le téléversement d'image, déjà éprouvé. */
  dataUrl: z.string().min(1),
});

/**
 * Une suppression EN MASSE, bornée.
 *
 * ⚠️ Le plafond n'est pas décoratif : sans lui, une liste arbitraire ferait une requête arbitrairement
 * longue sur le chemin d'administration. 200 couvre très largement « je coche tout et je supprime », et le
 * client peut recommencer.
 */
const suppressionSchema = z.object({ ids: z.array(z.string().trim()).min(1).max(200) });

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

export function registerAgentKnowledge(
  app: FastifyInstance, deps: AgentKnowledgeRouteDeps, guard?: Guard, limiteCouteuse?: PreHandler,
): void {
  const opts = guard ? { preHandler: guard } : {};
  /**
   * 🔴 LE PLAFOND DES OPÉRATIONS LOURDES, sur les QUATRE routes de ce module qui en sont (2026-09-15) : la
   * suppression en masse (jusqu'à 200 fiches, et autant de lignes d'historique depuis ce jour), l'import
   * d'un document (extraction d'un PDF de 8 Mo dans le process) et le crawl d'un site (aperçu et import : des
   * dizaines de requêtes réseau sortantes par appel). Elles étaient sous le seul plafond par UTILISATEUR, soit 300 par
   * minute : de quoi lancer trois cents crawls en une minute sans rien enfreindre.
   *
   * ⚠️ PAS SUR LES LECTURES NI SUR L'ÉDITION D'UNE FICHE : ce plafond est par ESPACE et vaut 10 par minute
   * par défaut, il rendrait l'écran inutilisable si on le posait sur des gestes ordinaires.
   */
  const optsLourds = limiteCouteuse
    ? { preHandler: guard ? [...(Array.isArray(guard) ? guard : [guard]), limiteCouteuse] : [limiteCouteuse] }
    : opts;
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

  /**
   * LE CONTENU EST LU AVANT LA SUPPRESSION, jamais après : c'est le seul exemplaire qui en restera.
   *
   * ⚠️ BEST-EFFORT SUR LA LECTURE, comme côté MBA : si elle échoue, on supprime quand même et on journalise
   * l'identifiant seul. Refuser un geste ordinaire parce qu'une lecture de journal a raté serait pire.
   */
  const ficheAvant = async (ctx: { tenant: string; agentId: string }, ficheId: string): Promise<FicheConnaissance | undefined> => {
    if (!deps.journaliserSuppression) return undefined;
    return (await deps.lister(ctx.tenant, ctx.agentId).catch(() => [])).find((f) => f.id === ficheId);
  };
  const journaliser = async (
    ctx: { tenant: string; agentId: string }, req: FastifyRequest, ficheId: string, avant: FicheConnaissance | undefined,
  ): Promise<void> => {
    await deps.journaliserSuppression?.(ctx.tenant, ctx.agentId, {
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
    const supprime = await deps.supprimer(ctx.tenant, ctx.agentId, ficheId);
    if (!supprime) return reply.code(404).send({ error: 'fiche introuvable' });
    // ⚠️ APRÈS la suppression : journaliser un geste qui n'a pas eu lieu ferait chercher une cause inexistante.
    await journaliser(ctx, req, ficheId, avant);
    return reply.code(204).send();
  });

  /**
   * Supprime PLUSIEURS fiches d'un coup.
   *
   * 🔴 UNE SEULE REQUETE, PAS N. Julien, le 2026-09-08 : « une fois qu'on a selectionne plusieurs fiches, un
   * bouton qui permette de toutes les supprimer ». Boucler cote navigateur ferait cinquante allers-retours,
   * dont certains echoueraient au milieu en laissant une selection a moitie supprimee que personne ne sait
   * plus reconstituer.
   *
   * ⚠️ Les identifiants MAL FORMES sont ecartes ici, pas envoyes en base : un uuid invalide fait LEVER la
   * requete entiere, donc une seule faute de frappe annulerait la suppression des cinquante autres.
   */
  app.post(`${base}/supprimer`, optsLourds, async (req, reply) => {
    const ctx = contexte(req);
    if ('code' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    const parse = suppressionSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'ids requis (1 à 200 identifiants)' });
    const ids = parse.data.ids.filter((id) => estUuid(id));
    if (ids.length === 0) return reply.code(400).send({ error: 'aucun identifiant valide' });

    /**
     * 🔴 LA SUPPRESSION EN MASSE SE JOURNALISE AUSSI, et c'est elle qui compte le plus : c'est le geste qui
     * peut effacer deux cents fiches d'un coup. La journaliser sur un seul des deux chemins, c'est le motif
     * « une capacité câblée sur un consommateur sur deux », déjà payé plusieurs fois dans ce dépôt.
     *
     * ⚠️ UNE SEULE LECTURE pour toute la fournée, pas une par fiche : `ficheAvant` ferait N listes.
     */
    const avantParId = new Map(
      deps.journaliserSuppression
        ? (await deps.lister(ctx.tenant, ctx.agentId).catch(() => [])).map((f) => [f.id, f] as const)
        : [],
    );
    let supprimees = 0;
    for (const id of ids) {
      if (!(await deps.supprimer(ctx.tenant, ctx.agentId, id))) continue;
      supprimees += 1;
      await journaliser(ctx, req, id, avantParId.get(id));
    }
    // ⚠️ On rend le COMPTE REEL, pas la taille de la demande : une fiche deja supprimee par un collegue ne
    // doit pas etre annoncee comme supprimee par ce clic.
    return reply.code(200).send({ supprimees, demandees: ids.length });
  });

  /**
   * Importe un DOCUMENT (texte, CSV, PDF, Word) en fiches de connaissance.
   *
   * 🔴 RIEN N'EST RÉÉCRIT ICI : la reconnaissance, l'extraction et le découpage vivent déjà dans
   * `src/agent/setup/piece-jointe.ts`, écrits pour la conversation de construction. Ils n'étaient
   * simplement joignables que de là. Le même moteur sert donc les deux chemins, et un client qui joint son
   * PDF en parlant au robot obtient EXACTEMENT les mêmes fiches que s'il l'avait déposé ici.
   *
   * 🔴 LE TYPE EST DÉCIDÉ PAR LA SIGNATURE DU FICHIER, jamais par son extension : ce texte finit dans le
   * prompt d'un agent qui parle à de vrais contacts.
   *
   * ⚠️ Les IMAGES ne passent pas par ici. Les lire demande un modèle de vision, que cette route n'a pas :
   * le dire est plus honnête que de traîner un client LLM dans un module d'administration, et la
   * conversation de construction, elle, l'a déjà.
   */
  app.post(`${base}/document`, optsLourds, async (req, reply) => {
    const ctx = contexte(req);
    if ('code' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    const parse = documentSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'nom et dataUrl requis' });

    const bytes = octetsDepuisDataUrl(parse.data.dataUrl);
    if (!bytes) return reply.code(400).send({ error: 'fichier illisible (data URL base64 attendu)' });
    const reconnu = reconnaitre(bytes);
    // 415 et pas 400 : le corps est bien formé, c'est le TYPE du contenu qu'on refuse.
    if (!reconnu) return reply.code(415).send({ error: 'format non accepté (texte, CSV, PDF ou Word)' });
    if (reconnu.nature === 'image') {
      return reply.code(415).send({
        error: 'une image se dépose dans la conversation de construction, qui sait la lire ; ici on attend un document texte, CSV, PDF ou Word',
      });
    }
    if (bytes.length > TAILLE_DOCUMENT_MAX) {
      return reply.code(413).send({ error: `fichier trop lourd (${Math.round(TAILLE_DOCUMENT_MAX / 1024 / 1024)} Mo maximum)` });
    }

    const texte = await extraireTexte(bytes, reconnu.nature);
    // 422 : le type est accepté mais le fichier ne porte aucun texte. Le dire vaut mieux qu'un succès à zéro
    // fiche, que le client lirait comme un import réussi.
    if (texte === null || texte.trim() === '') {
      return reply.code(422).send({ error: 'aucun texte lisible dans ce fichier (un PDF scanné, par exemple, n’en contient pas)' });
    }
    const fiches = texteEnFiches(texte, parse.data.nom);
    if (fiches.length === 0) return reply.code(422).send({ error: 'ce fichier est trop court pour faire une fiche' });

    // 🔴 REMPLACE, comme une page relue (décision de Julien, 2026-09-08) : redéposer le même fichier retire
    // ses fiches d'avant. Sans ça, deux dépôts du même document doubleraient la base, et la recherche
    // remonterait deux fois la même réponse.
    const bilan = await deps.remplacerSource(ctx.tenant, ctx.agentId, { type: 'document', nom: parse.data.nom }, fiches);
    if (!bilan) return reply.code(404).send({ error: 'agent introuvable' });
    return reply.code(200).send({ nom: parse.data.nom, nature: reconnu.nature, ...bilan, plafond: MAX_FICHES_PAR_PAGE });
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
  app.post(`${base}/import`, optsLourds, async (req, reply) => {
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
      const bilan = await deps.remplacerSource(ctx.tenant, ctx.agentId, { type: 'page', url: cible }, fiches);
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
