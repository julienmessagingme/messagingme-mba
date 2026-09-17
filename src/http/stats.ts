import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import type { DashboardStats, TemplateBreakdownRow, CampaignFunnel, ErrorBreakdownRow, CostFilter } from '../stats/store.pg';
import type { ErreurLivraison } from '../ops/erreurs-livraison.pg';
import type { FiltreCampagneOuTemplate } from '../stats/store.pg';
import type { CostSeries, CoutParCampagne } from '../stats/cost';
import type { DetailCoutCampagne } from '../stats/cout-campagne';
import type { CoutMessages } from '../stats/cout-messages';
import type { CoutIa } from '../stats/cout-ia';
import type { PricingSummary } from '../meta/pricing';
import { parseRange } from '../stats/range';
import type { DateRange } from '../stats/range';
import type { ConversationAnalysisSummary, AnalyzedConversationRow, AnalyzedConversationsFilter, NuageQualitatif, JourAnalyse } from '../stats/conversation-stats.pg';
import { scopeTenant, estUuid } from './scope';
import type { NodeEventCount } from '../workflow/node-events.pg';
import type { CompteurClic } from '../links/mesures';

// Valeurs d'enum admises pour les filtres de la liste quali (miroir de src/analysis/schema.ts). On ne passe au
// store QUE des valeurs valides -> pas d'injection de filtre arbitraire, et le NULL = « pas de filtre ».
const SENTIMENTS = new Set(['positif', 'neutre', 'negatif']);
const INTENTS = new Set(['demande_devis', 'sav', 'reclamation', 'information', 'prise_rdv', 'autre']);
const ACTIONS = new Set(['creer_devis', 'rappeler', 'relancer', 'escalader', 'aucune']);
const inSet = (s: Set<string>, v: unknown): string | undefined => (typeof v === 'string' && s.has(v) ? v : undefined);

/**
 * Le filtre par SUJET. Contrairement aux trois autres, il n'a pas d'énumération : le sujet est écrit par le
 * LLM en texte libre (`topic` est un `text` en base, borné à 120 caractères par le schéma de sortie).
 *
 * On borne donc la longueur à cette même limite, plutôt que de laisser passer une chaîne de n'importe quelle
 * taille jusqu'à la base : un filtre plus long que ce qu'une colonne peut contenir ne peut de toute façon
 * rien ramener. `undefined` (pas de filtre) pour tout le reste, y compris la chaîne vide.
 */
const topicValide = (v: unknown): string | undefined =>
  (typeof v === 'string' && v.trim() !== '' && v.trim().length <= 120 ? v.trim() : undefined);

export interface StatsRouteDeps {
  getDashboard(tenantId: string, range: DateRange): Promise<DashboardStats>;
  /** Volume par template envoyé (dropdown dashboard). */
  getTemplateBreakdown(tenantId: string, range: DateRange): Promise<TemplateBreakdownRow[]>;
  /** Prix Meta (pricing_analytics) par catégorie ; null si indisponible (le front affiche le volume seul). */
  getPricing(tenantId: string, range: DateRange): Promise<PricingSummary | null>;
  /** Funnel d'UNE campagne : envoyés -> délivrés -> lus -> répondus + échecs. */
  getCampaignFunnel(tenantId: string, campaignId: string): Promise<CampaignFunnel>;
  /** Breakdown des codes d'erreur Meta sur la plage (campagnes du tenant), filtrable par template. */
  getErrorBreakdown(tenantId: string, range: DateRange, templateName?: string): Promise<ErrorBreakdownRow[]>;
  /**
   * Les contacts touchés par UN code d'erreur, filtrables par campagnes OU templates.
   *
   * 🔴 C'EST LE JOURNAL DES ERREURS DE LIVRAISON QUI RÉPOND (`PgErreursLivraisonStore.lister`), pas une
   * requête propre à Analytics. Une seconde requête a été écrite puis SUPPRIMÉE le 2026-09-07 : elle
   * comptait une population voisine mais différente, et les deux écrans (Analytics et Paramètres) portent
   * le même titre. Un client aurait comparé, et l'un des deux serait passé pour faux.
   *
   * OPTIONNELLE : un câblage qui ne la fournit pas rend 503, pas une liste vide. Une liste vide se lirait
   * « personne n'a été touché », qui est une affirmation, alors que la vérité serait « rien n'est branché ».
   * Même choix que `getWorkflowNodeCounts` juste en dessous.
   */
  getErrorContacts?(tenantId: string, range: DateRange, code: number, filter: FiltreCampagneOuTemplate): Promise<ErreurLivraison[]>;
  /** Série de coût estimé/jour, filtrable par campagne ou template. */
  getCostSeries(tenantId: string, range: DateRange, filter: CostFilter): Promise<CostSeries>;
  /**
   * Le tableau « ce que coûte un engagement » de la page de synthèse (lot E) : une ligne par campagne
   * ayant envoyé sur la période, son coût ESTIMÉ et ses clics.
   *
   * OPTIONNELLE -> 503 quand elle manque, comme ses voisines : un tableau vide se lirait « aucune campagne
   * n'a envoyé sur la période », qui est une affirmation, alors que la vérité serait « rien n'est branché ».
   */
  getCoutParCampagne?(tenantId: string, range: DateRange): Promise<CoutParCampagne>;
  /**
   * Le COUT TOTAL DES MESSAGES de la période (ligne 2 de la carte « Coûts »).
   *
   * OPTIONNELLE -> 503 quand elle manque, comme ses voisines. Un total à zéro se lirait « vous n'avez rien
   * envoyé », qui est une affirmation, alors que la vérité serait « rien n'est branché ».
   */
  getCoutMessages?(tenantId: string, range: DateRange): Promise<CoutMessages>;
  /**
   * Ce que le client a dépensé en IA sur SON crédit (ligne 3 de la carte « Coûts »), et le détail des tours.
   *
   * OPTIONNELLE, même raison. ⚠️ Un total à zéro est ici un état NORMAL et non une panne : aucun tour
   * d'agent n'a jamais tourné en production (mesuré le 2026-09-17). L'écran doit dire « aucune
   * consommation », pas afficher un tiret qui se lirait comme une mesure manquante.
   */
  getCoutIa?(tenantId: string, range: DateRange): Promise<CoutIa>;
  /**
   * La fiche d'UNE campagne : ce qu'elle a coûté et ce que les gens en ont fait (demande de Julien du
   * 2026-09-09, ouverte en cliquant une ligne du tableau ci-dessus).
   *
   * ⚠️ AUCUNE PLAGE, et c'est la décision de Julien : la fiche couvre toute la VIE de la campagne. Un
   * scénario reçoit des réponses pendant des jours ; bornée à la fenêtre du tableau, elle montrerait le
   * coût d'un lancement sans les interactions qu'il a produites ensuite. Le tableau, lui, reste sur la
   * période : ce n'est pas une incohérence, ce sont deux questions différentes, et la fiche le DIT.
   *
   * `null` quand la campagne n'existe pas ou n'appartient pas à cet espace -> 404, jamais une fiche vide.
   */
  getDetailCoutCampagne?(tenantId: string, campaignId: string): Promise<DetailCoutCampagne | null>;
  /** Agrégats d'analyse de conversation (Pièce 1) sur la plage. */
  getConversationSummary(tenantId: string, range: DateRange): Promise<ConversationAnalysisSummary>;
  /** Liste des dernières conversations analysées (quali), filtrable. */
  listAnalyzedConversations(tenantId: string, range: DateRange, filters: AnalyzedConversationsFilter): Promise<AnalyzedConversationRow[]>;
  /**
   * Le damier « satisfaction x urgence » de la page de synthèse (lot F).
   *
   * OPTIONNELLE, et 503 quand elle manque, comme `getWorkflowNodeCounts` juste en dessous : un nuage vide
   * se lirait « aucune conversation mesurée sur la période », qui est une affirmation, alors que la vérité
   * serait « rien n'est branché ». L'écran, lui, distingue déjà « vide » de « pas encore de mesures ».
   */
  getNuageQualitatif?(tenantId: string, range: DateRange): Promise<NuageQualitatif>;
  /**
   * Une ligne par JOUR pour l ecran « Analyse des conversations » (2026-09-17).
   *
   * OPTIONNELLE -> 503 quand elle manque, comme ses voisines : une liste vide se lirait « aucune
   * conversation analysee sur la periode », qui est une affirmation, alors que la verite serait
   * « rien n est branche ».
   */
  getJoursAnalyse?(tenantId: string, range: DateRange): Promise<JourAnalyse[]>;
  /**
   * Mesures d'un SCÉNARIO, bloc par bloc (« Mes tableaux »). Optionnelle : absente -> 503 plutôt qu'une liste
   * vide, qui se lirait « ce scénario n'a rien produit » alors que rien n'est branché.
   */
  getWorkflowNodeCounts?(tenantId: string, workflowId: string, range: DateRange): Promise<Array<NodeEventCount | CompteurClic>>;
}

/** Stats du dashboard (séries 1 pt/jour). Groupe admin-only (garde passé par server.ts). Plage de dates
 *  via ?from&?to (YYYY-MM-DD, Europe/Paris) ou repli ?days= ; invalide/futur/span>366 -> 400. */
/**
 * Liste CSV d'un query param : découpée, nettoyée, dédupliquée et PLAFONNÉE. Le plafond n'est pas décoratif :
 * ces valeurs partent dans un `= any($n)`, et rien n'empêche un appelant d'en envoyer dix mille.
 */
function csvBorne(v: unknown): string[] {
  if (typeof v !== 'string' || v.trim() === '') return [];
  return [...new Set(v.split(',').map((x) => x.trim()).filter((x) => x !== ''))].slice(0, 200);
}

/**
 * Les identifiants de campagne d'un filtre, ou `null` si l'un d'eux n'en est pas un.
 *
 * 🔴 CES VALEURS PARTENT DANS UN `$n::uuid[]`, et Postgres refuse la conversion À L'EXÉCUTION : un
 * identifiant mal formé sortait donc en 500, dont Cloudflare remplace le corps par sa propre page. Le client
 * ne voyait même pas ce qu'on lui reprochait. On répond 400.
 *
 * ⚠️ Et on REFUSE plutôt que de filtrer les mauvaises valeurs : les jeter rendrait la liste vide, or une
 * liste vide vaut « tout » ici. Un filtre fautif afficherait alors PLUS que ce qui était demandé, en
 * silence, ce qui est pire qu'une erreur.
 */
/**
 * Plafond de la liste des contacts touches. Un code d'erreur peut frapper une campagne entiere (5 000
 * destinataires) : sans borne, un clic sur une ligne ramenerait tout, et l'ecran ne sait de toute facon pas
 * afficher utilement davantage. On demande UNE LIGNE DE PLUS au journal pour savoir qu'on tronque, et le dire.
 */
export const PLAFOND_CONTACTS_ERREUR = 200;

function idsCampagnes(v: unknown): string[] | null {
  const ids = csvBorne(v);
  return ids.every(estUuid) ? ids : null;
}

export function registerStats(app: FastifyInstance, deps: StatsRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  app.get('/tenants/:tenantId/stats', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const r = parseRange(req.query as Record<string, unknown>);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    return reply.code(200).send(await deps.getDashboard(tenant, r.range));
  });

  // Breakdown par template + prix Meta (pricing_analytics). Séparé de /stats : peut appeler Meta
  // (plus lent) et n'est chargé que par la section « Templates envoyés » du dashboard.
  app.get('/tenants/:tenantId/stats/templates', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const r = parseRange(req.query as Record<string, unknown>);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    const [breakdown, pricing] = await Promise.all([deps.getTemplateBreakdown(tenant, r.range), deps.getPricing(tenant, r.range)]);
    return reply.code(200).send({ breakdown, pricing });
  });

  // Funnel d'UNE campagne (envoyés/délivrés/lus/répondus). ?campaignId=... requis. Pas de plage
  // (le funnel porte sur toute la campagne). Le scope tenant est aussi appliqué en SQL (pas de fuite).
  app.get('/tenants/:tenantId/stats/campaign-funnel', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const campaignId = (req.query as Record<string, unknown>).campaignId;
    if (typeof campaignId !== 'string' || campaignId === '') return reply.code(400).send({ error: 'campaignId requis' });
    return reply.code(200).send(await deps.getCampaignFunnel(tenant, campaignId));
  });

  // Breakdown des codes d'erreur Meta sur la plage, filtrable ?templateName=.
  app.get('/tenants/:tenantId/stats/errors', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const q = req.query as Record<string, unknown>;
    const r = parseRange(q);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    const templateName = typeof q.templateName === 'string' && q.templateName !== '' ? q.templateName : undefined;
    return reply.code(200).send({ errors: await deps.getErrorBreakdown(tenant, r.range, templateName) });
  });

  /**
   * QUI a été touché par un code d'erreur, sur la plage, filtrable ?campaignIds= / ?templateNames=.
   *
   * ⚠️ Le code arrive dans le CHEMIN, donc en texte : il est converti et VALIDÉ ici. Sans ça, un `NaN`
   * partirait en paramètre de requête et Postgres refuserait la conversion en `int` au moment de
   * l'exécution, c'est-à-dire en 500 plutôt qu'en 400. Cloudflare remplace le corps d'un 5xx par sa propre
   * page : l'appelant n'aurait même pas vu le message.
   *
   * `tronque` dit que la liste est plafonnée. Le store rend une ligne de plus que le plafond pour qu'on
   * puisse le savoir ; on la retire avant d'envoyer, sans quoi l'écran afficherait 201 lignes en annonçant
   * un plafond de 200.
   */
  app.get('/tenants/:tenantId/stats/errors/:code/contacts', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!deps.getErrorContacts) return reply.code(503).send({ error: 'contacts touches non configures' });
    const { code } = req.params as { code: string };
    // `Number.parseInt` s'arrete au premier caractere non chiffre : « 131049abc » passerait. On exige donc
    // que le segment soit ENTIEREMENT numerique, sinon deux adresses differentes designeraient la meme chose.
    if (!/^\d{1,9}$/.test(code)) return reply.code(400).send({ error: 'code invalide' });
    const codeNum = Number.parseInt(code, 10);
    const q = req.query as Record<string, unknown>;
    const r = parseRange(q);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    const campaignIds = idsCampagnes(q.campaignIds);
    if (campaignIds === null) return reply.code(400).send({ error: 'campaignIds invalide' });
    const templateNames = csvBorne(q.templateNames);
    const filter: FiltreCampagneOuTemplate = {
      ...(campaignIds.length ? { campaignIds } : {}),
      ...(templateNames.length ? { templateNames } : {}),
    };
    const rows = await deps.getErrorContacts(tenant, r.range, codeNum, filter);
    const tronque = rows.length > PLAFOND_CONTACTS_ERREUR;
    return reply.code(200).send({
      contacts: tronque ? rows.slice(0, PLAFOND_CONTACTS_ERREUR) : rows,
      tronque,
      plafond: PLAFOND_CONTACTS_ERREUR,
    });
  });

  /**
   * Mesures d'un scénario BLOC PAR BLOC, sur une plage. C'est la source des tableaux d'Analytics.
   *
   * Rend les compteurs BRUTS (par bloc, par nature, par choix), pas un tableau tout fait : c'est l'écran qui
   * décide lesquels il affiche, et deux tableaux différents lisent les mêmes lignes. Agréger côté serveur
   * obligerait à rejouer la requête à chaque changement de sélection.
   *
   * ⚠️ Ces mesures n'existent QUE depuis la mise en place de l'instrumentation : une plage antérieure rend
   * une liste vide, et c'est le comportement juste, pas un bug.
   */
  app.get('/tenants/:tenantId/stats/workflow/:workflowId', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!deps.getWorkflowNodeCounts) return reply.code(503).send({ error: 'mesures de scénario non configurées' });
    const { workflowId } = req.params as { workflowId: string };
    const r = parseRange(req.query as Record<string, unknown>);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    return reply.code(200).send({ counts: await deps.getWorkflowNodeCounts(tenant, workflowId, r.range) });
  });

  // Graphe de coût estimé/jour, filtrable ?campaignId= / ?templateName= (peut appeler Meta pour le tarif).
  app.get('/tenants/:tenantId/stats/cost', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const q = req.query as Record<string, unknown>;
    const r = parseRange(q);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    // Même garde que la liste des contacts touchés : un identifiant mal formé sortait en 500 (refus de
    // conversion `::uuid[]` chez Postgres), donc en page d'erreur Cloudflare côté client.
    const idsCout = idsCampagnes(q.campaignIds);
    if (idsCout === null) return reply.code(400).send({ error: 'campaignIds invalide' });
    const filter: CostFilter = {
      ...(idsCout.length > 0 ? { campaignIds: idsCout } : {}),
      ...(csvBorne(q.templateNames).length > 0 ? { templateNames: csvBorne(q.templateNames) } : {}),
    };
    return reply.code(200).send(await deps.getCostSeries(tenant, r.range, filter));
  });

  // Analyse de conversation (Pièce 1) : agrégats quanti sur la plage. Scope tenant AUSSI en SQL (pas de fuite).
  /**
   * Coût par campagne rapporté aux engagements (page de synthèse).
   *
   * ⚠️ Adresse SOUS `/stats/cost`, parce que c'est la même matière que le graphe : mêmes tarifs Meta, même
   * population d'envois facturables. Un client qui compare les deux totaux doit pouvoir se dire qu'ils
   * viennent du même endroit, et ils en viennent.
   */
  app.get('/tenants/:tenantId/stats/cost/campaigns', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!deps.getCoutParCampagne) return reply.code(503).send({ error: 'cout par campagne non configure' });
    const r = parseRange(req.query as Record<string, unknown>);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    return reply.code(200).send(await deps.getCoutParCampagne(tenant, r.range));
  });

  /**
   * Le COUT TOTAL DES MESSAGES ENVOYES sur la période : templates margés, messages de service franchise
   * déduite, RCS à deux tarifs.
   *
   * ⚠️ Route SÉPARÉE de `/stats/cost`, alors qu'elle lit la même matière pour les templates, et ce n'est
   * pas un doublon : le graphe répond « comment ça s'est réparti dans le temps », celle-ci « ce que la
   * période a coûté, tous canaux ». Elles partagent le calcul (`chiffrer`, `prixTemplate`), pas la forme.
   */
  app.get('/tenants/:tenantId/stats/cost/messages', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!deps.getCoutMessages) return reply.code(503).send({ error: 'cout des messages non configure' });
    const r = parseRange(req.query as Record<string, unknown>);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    return reply.code(200).send(await deps.getCoutMessages(tenant, r.range));
  });

  /**
   * CE QUE LE CLIENT A DEPENSE EN IA sur la période, sur SON crédit prépayé, et le détail de ses tours.
   *
   * ⚠️ Rien de ce qui est sur NOTRE clé n'apparaît ici (transcription, bot d'aide, assistants de
   * configuration) : montrer une dépense qu'on ne facture pas ouvrirait une discussion sur un coût interne.
   * Et le Meta Business Agent n'y est pas non plus, parce qu'il tourne CHEZ Meta et se facture au message
   * de service : son coût est dans la route au-dessus, pas dans celle-ci.
   */
  app.get('/tenants/:tenantId/stats/cost/ia', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!deps.getCoutIa) return reply.code(503).send({ error: 'cout ia non configure' });
    const r = parseRange(req.query as Record<string, unknown>);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    return reply.code(200).send(await deps.getCoutIa(tenant, r.range));
  });

  /**
   * LES JOURNEES de l'écran « Analyse des conversations » : une ligne par jour, pas par conversation.
   *
   * 🔴 ROUTE A PART DE `/stats/conversations`, ET C'EST CE QUI REND L'ECRAN TENABLE. Julien, le
   * 2026-09-17 : « si un moment il y a 1000 conversations en stock, tu vas pas afficher 1000
   * conversations dans le tableau ». La réponse est bornée par le nombre de JOURS de la période, jamais
   * par le trafic du client.
   */
  app.get('/tenants/:tenantId/stats/conversations/jours', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!deps.getJoursAnalyse) return reply.code(503).send({ error: 'jours d analyse non configure' });
    const r = parseRange(req.query as Record<string, unknown>);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    return reply.code(200).send({ jours: await deps.getJoursAnalyse(tenant, r.range) });
  });

  app.get('/tenants/:tenantId/stats/conversations', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const r = parseRange(req.query as Record<string, unknown>);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    return reply.code(200).send(await deps.getConversationSummary(tenant, r.range));
  });

  /**
   * Le damier « satisfaction x urgence » de la page de synthèse (lot F).
   *
   * ⚠️ Route À PART de `/stats/conversations`, alors qu'elle lit la même table sur la même plage : la page
   * de synthèse n'a besoin QUE de ce damier, et le résumé quali transporte une vingtaine de compteurs plus
   * les dix sujets fréquents. Les fondre ferait payer à chaque écran ce dont l'autre a besoin.
   */
  app.get('/tenants/:tenantId/stats/conversations/nuage', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!deps.getNuageQualitatif) return reply.code(503).send({ error: 'nuage qualitatif non configure' });
    const r = parseRange(req.query as Record<string, unknown>);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    return reply.code(200).send(await deps.getNuageQualitatif(tenant, r.range));
  });

  /**
   * La fiche d'une campagne, ouverte depuis une ligne du tableau du coût.
   *
   * ⚠️ SANS `parseRange`, seule route de ce fichier dans ce cas : elle couvre toute la vie de la campagne.
   * Accepter une plage ici laisserait croire qu'elle en tient compte.
   *
   * 🔴 L'identifiant est VALIDÉ avant d'atteindre la base : `campaignId` vient de l'URL, il part en
   * paramètre lié dans une requête `uuid`, et un texte quelconque y ferait lever Postgres (donc un 500 dont
   * Cloudflare mangerait le corps) au lieu du 400 que mérite une adresse mal formée.
   */
  app.get('/tenants/:tenantId/stats/cost/campaigns/:campaignId', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!deps.getDetailCoutCampagne) return reply.code(503).send({ error: 'detail de campagne non configure' });
    const { campaignId } = req.params as { campaignId?: string };
    // `estUuid` du dépôt, pas une expression régulière de plus : elle est déjà importée ici, et une
    // seconde définition de « un identifiant valide » dériverait de la première au premier ajustement.
    if (typeof campaignId !== 'string' || !estUuid(campaignId)) {
      return reply.code(400).send({ error: 'campaignId invalide' });
    }
    const fiche = await deps.getDetailCoutCampagne(tenant, campaignId);
    // 404 et non une fiche a zero : « cette campagne n'existe pas ici » et « elle n'a rien coute » sont
    // deux reponses differentes, et la seconde serait une affirmation fausse.
    if (fiche === null) return reply.code(404).send({ error: 'campagne introuvable' });
    return reply.code(200).send(fiche);
  });

  // Liste quali des conversations analysées, filtrable ?sentiment=&intent=&action=&topic=&limit=.
  app.get('/tenants/:tenantId/stats/conversations/list', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const q = req.query as Record<string, unknown>;
    const r = parseRange(q);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    const limit = typeof q.limit === 'string' && /^\d+$/.test(q.limit) ? Number(q.limit) : undefined;
    const filters: AnalyzedConversationsFilter = {
      ...(inSet(SENTIMENTS, q.sentiment) ? { sentiment: inSet(SENTIMENTS, q.sentiment) } : {}),
      ...(inSet(INTENTS, q.intent) ? { intent: inSet(INTENTS, q.intent) } : {}),
      ...(inSet(ACTIONS, q.action) ? { action: inSet(ACTIONS, q.action) } : {}),
      // Le sujet est du TEXTE LIBRE (le LLM l'écrit) : il n'y a pas d'énumération à valider, donc on borne
      // ce qu'on peut borner, la longueur, et on laisse le paramètre lié faire le reste. Une chaîne vide
      // vaut « pas de filtre » et n'est pas transmise, sinon elle ne ramènerait jamais rien.
      ...(topicValide(q.topic) ? { topic: topicValide(q.topic) } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
    return reply.code(200).send({ conversations: await deps.listAnalyzedConversations(tenant, r.range, filters) });
  });
}
