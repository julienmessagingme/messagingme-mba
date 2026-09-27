import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import type { DashboardStats, TemplateBreakdownRow, CampaignFunnel, ErrorBreakdownRow, VolumesParCanal } from '../stats/store.pg';
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
import { espaceVerifie, estUuid } from './scope';
import type { NodeEventCount } from '../workflow/node-events.pg';
import type { CompteurClic } from '../links/mesures';
import { INTENTS as INTENTS_ANALYSE } from '../analysis/schema';

// Valeurs d'enum admises pour les filtres de la liste quali : on ne passe au store que des valeurs valides (pas
// d'injection de filtre), NULL = « pas de filtre ». Les intentions dérivent du schéma de l'analyse (une copie en
// dur ignorerait des valeurs et rendrait tout sous un filtre affiché) ; sentiments et actions restent des
// miroirs de `src/analysis/schema.ts`.
const SENTIMENTS = new Set(['positif', 'neutre', 'negatif']);
const INTENTS = new Set<string>(INTENTS_ANALYSE);
const ACTIONS = new Set(['creer_devis', 'rappeler', 'relancer', 'escalader', 'aucune']);
const inSet = (s: Set<string>, v: unknown): string | undefined => (typeof v === 'string' && s.has(v) ? v : undefined);

/**
 * Le filtre par sujet, sans énumération : le sujet est écrit par le LLM en texte libre (`topic`, borné à 120
 * caractères par le schéma de sortie). On borne la longueur à cette limite ; `undefined` pour tout le reste, y
 * compris la chaîne vide.
 */
const topicValide = (v: unknown): string | undefined =>
  (typeof v === 'string' && v.trim() !== '' && v.trim().length <= 120 ? v.trim() : undefined);

export interface StatsRouteDeps {
  getDashboard(tenantId: string, range: DateRange): Promise<DashboardStats>;
  /** Volume par template envoyé (dropdown dashboard). */
  getTemplateBreakdown(tenantId: string, range: DateRange): Promise<TemplateBreakdownRow[]>;
  /** Prix Meta (pricing_analytics) par catégorie ; null si indisponible (le front affiche le volume seul). */
  getPricing(tenantId: string, range: DateRange): Promise<PricingSummary | null>;
  /**
   * La marge de l'espace, en pourcent, pour que l'écran puisse nommer la cause de l'écart entre le coût estimé et
   * la facture Meta. Requise : optionnelle, un câblage qui l'oublierait ferait attribuer à un arrondi un écart de
   * 50 %.
   */
  margeTemplate(tenantId: string): Promise<number>;
  /** Funnel d'une campagne : envoyés -> délivrés -> lus -> répondus + échecs. */
  getCampaignFunnel(tenantId: string, campaignId: string): Promise<CampaignFunnel>;
  /** Breakdown des codes d'erreur Meta sur la plage (campagnes du tenant), filtrable par template. */
  getErrorBreakdown(tenantId: string, range: DateRange, templateName?: string): Promise<ErrorBreakdownRow[]>;
  /**
   * Les contacts touchés par un code d'erreur, filtrables par campagnes ou templates. C'est le journal des erreurs
   * de livraison qui répond (`PgErreursLivraisonStore.lister`), pas une requête propre à Analytics : deux requêtes
   * voisines sous le même titre dans deux écrans feraient passer l'une pour fausse.
   */
  getErrorContacts(tenantId: string, range: DateRange, code: number, filter: FiltreCampagneOuTemplate): Promise<ErreurLivraison[]>;
  /** Série de coût estimé/jour, filtrable par campagne ou template. */
  getCostSeries(tenantId: string, range: DateRange, filter: FiltreCampagneOuTemplate): Promise<CostSeries>;
  /**
   * Le tableau « ce que coûte un engagement » : une ligne par campagne ayant envoyé sur la période, son coût
   * estimé et ses clics. `inclureArchivees` : la bascule de la carte (absente = exclues).
   */
  getCoutParCampagne(tenantId: string, range: DateRange, opts: { inclureArchivees: boolean }): Promise<CoutParCampagne>;
  /** Le coût total des messages de la période (ligne 2 de la carte « Coûts »). */
  getCoutMessages(tenantId: string, range: DateRange): Promise<CoutMessages>;
  /**
   * Ce que le client a dépensé en IA sur son crédit (ligne 3 de la carte « Coûts »), et le détail des tours. Un
   * total à zéro est un état normal : l'écran dit « aucune consommation », pas un tiret qui se lirait comme une
   * mesure manquante.
   */
  getCoutIa(tenantId: string, range: DateRange): Promise<CoutIa>;
  /**
   * La fiche d'une campagne : ce qu'elle a coûté et ce que les gens en ont fait. Aucune plage : elle couvre toute
   * la vie de la campagne (un scénario reçoit des réponses pendant des jours), quand le tableau reste sur la
   * période ; la fiche le dit. `null` = inconnue ou d'un autre espace -> 404, jamais une fiche vide.
   */
  getDetailCoutCampagne(tenantId: string, campaignId: string): Promise<DetailCoutCampagne | null>;
  /** Agrégats d'analyse de conversation sur la plage. */
  getConversationSummary(tenantId: string, range: DateRange): Promise<ConversationAnalysisSummary>;
  /** Liste des dernières conversations analysées (quali), filtrable. */
  listAnalyzedConversations(tenantId: string, range: DateRange, filters: AnalyzedConversationsFilter): Promise<AnalyzedConversationRow[]>;
  /**
   * Le damier « satisfaction x urgence » de la page de synthèse. L'écran distingue « vide » de « pas encore de
   * mesures ».
   */
  getNuageQualitatif(tenantId: string, range: DateRange): Promise<NuageQualitatif>;
  /** Une ligne par jour pour l'écran « Analyse des conversations ». */
  getJoursAnalyse(tenantId: string, range: DateRange): Promise<JourAnalyse[]>;
  /** Mesures d'un scénario, bloc par bloc (« Mes tableaux »). */
  getWorkflowNodeCounts(tenantId: string, workflowId: string, range: DateRange): Promise<Array<NodeEventCount | CompteurClic>>;
  /**
   * Les messages envoyés et reçus par canal, pour les cartes « Numéro WhatsApp » et « Canal RCS » de l'Accueil.
   * Ce qui est compté et écarté : `PgStatsStore.volumesParCanal`. Requise ; l'écran tolère l'absence de la route
   * pendant la fenêtre où la console est publiée avant l'API.
   */
  volumesParCanal(tenantId: string, jours: number): Promise<VolumesParCanal>;
}

/**
 * La fenêtre des volumes par canal, la même que la rangée « 30 derniers jours » de l'Accueil, mais glissante
 * (maintenant moins 30 fois 24 h) et non en jours civils de Paris : l'écart tient en quelques heures.
 */
export const JOURS_VOLUMES = 30;

/**
 * Liste CSV d'un query param : découpée, nettoyée, dédupliquée et plafonnée. Ces valeurs partent dans un
 * `= any($n)`, et rien n'empêche un appelant d'en envoyer dix mille.
 */
function csvBorne(v: unknown): string[] {
  if (typeof v !== 'string' || v.trim() === '') return [];
  return [...new Set(v.split(',').map((x) => x.trim()).filter((x) => x !== ''))].slice(0, 200);
}

/**
 * Plafond de la liste des contacts touchés : un code d'erreur peut frapper une campagne entière. On demande une
 * ligne de plus au journal pour savoir qu'on tronque, et le dire.
 * `idsCampagnes`, juste après : un identifiant mal formé rend `null` (donc 400) plutôt que d'être écarté, car une
 * liste vide vaut « tout » ici, et un filtre fautif afficherait plus que ce qui était demandé.
 */
export const PLAFOND_CONTACTS_ERREUR = 200;

function idsCampagnes(v: unknown): string[] | null {
  const ids = csvBorne(v);
  return ids.every(estUuid) ? ids : null;
}

export function registerStats(app: FastifyInstance, deps: StatsRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  app.get('/tenants/:tenantId/stats', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const r = parseRange(req.query as Record<string, unknown>);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    return reply.code(200).send(await deps.getDashboard(tenant, r.range));
  });

  /**
   * Les cartes « Numéro WhatsApp » et « Canal RCS » de l'Accueil : envoyés et reçus par canal, sur 30 jours.
   * Aucune plage en paramètre ; la fenêtre est rendue (`jours`) pour que l'écran ne l'invente pas.
   */
  app.get('/tenants/:tenantId/accueil/volumes', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const volumes = await deps.volumesParCanal(tenant, JOURS_VOLUMES);
    return reply.code(200).send({ jours: JOURS_VOLUMES, whatsapp: volumes.whatsapp, rcs: volumes.rcs });
  });

  // Breakdown par template + prix Meta (pricing_analytics). Séparé de /stats : peut appeler Meta
  // (plus lent) et n'est chargé que par la section « Templates envoyés » du dashboard.
  app.get('/tenants/:tenantId/stats/templates', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const r = parseRange(req.query as Record<string, unknown>);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    const [breakdown, pricing, marge] = await Promise.all([
      deps.getTemplateBreakdown(tenant, r.range),
      deps.getPricing(tenant, r.range),
      // La marge voyage avec ce qu'elle explique : la page pose côte à côte un coût estimé (marge comprise) et le
      // total facturé par Meta, et sans ce chiffre l'écran ne saurait pas nommer la cause dominante de l'écart.
      deps.margeTemplate(tenant),
    ]);
    return reply.code(200).send({ breakdown, pricing, margeTemplate: marge });
  });

  // Funnel d'une campagne (envoyés/délivrés/lus/répondus). ?campaignId=... requis. Pas de plage (le funnel
  // porte sur toute la campagne). Le scope tenant est aussi appliqué en SQL.
  app.get('/tenants/:tenantId/stats/campaign-funnel', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const campaignId = (req.query as Record<string, unknown>).campaignId;
    if (typeof campaignId !== 'string' || campaignId === '') return reply.code(400).send({ error: 'campaignId requis' });
    return reply.code(200).send(await deps.getCampaignFunnel(tenant, campaignId));
  });

  // Breakdown des codes d'erreur Meta sur la plage, filtrable ?templateName=.
  app.get('/tenants/:tenantId/stats/errors', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const q = req.query as Record<string, unknown>;
    const r = parseRange(q);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    const templateName = typeof q.templateName === 'string' && q.templateName !== '' ? q.templateName : undefined;
    return reply.code(200).send({ errors: await deps.getErrorBreakdown(tenant, r.range, templateName) });
  });

  /**
   * Qui a été touché par un code d'erreur, sur la plage, filtrable ?campaignIds= / ?templateNames=. Le code arrive
   * dans le chemin : converti et validé ici (un `NaN` ferait refuser la conversion en `int` par Postgres, donc
   * 500). `tronque` dit que la liste est plafonnée ; la ligne de plus rendue par le store est retirée avant l'envoi.
   */
  app.get('/tenants/:tenantId/stats/errors/:code/contacts', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { code } = req.params as { code: string };
    // `Number.parseInt` s'arrête au premier caractère non chiffre : « 131049abc » passerait. On exige donc
    // que le segment soit entièrement numérique, sinon deux adresses différentes désigneraient la même chose.
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
   * Mesures d'un scénario bloc par bloc, sur une plage : la source des tableaux d'Analytics. Rend les compteurs
   * bruts (par bloc, par nature, par choix) ; l'écran choisit ce qu'il affiche. Une plage antérieure à
   * l'instrumentation rend une liste vide, et c'est juste.
   */
  app.get('/tenants/:tenantId/stats/workflow/:workflowId', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { workflowId } = req.params as { workflowId: string };
    const r = parseRange(req.query as Record<string, unknown>);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    return reply.code(200).send({ counts: await deps.getWorkflowNodeCounts(tenant, workflowId, r.range) });
  });

  // Graphe de coût estimé/jour, filtrable ?campaignId= / ?templateName= (peut appeler Meta pour le tarif).
  app.get('/tenants/:tenantId/stats/cost', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const q = req.query as Record<string, unknown>;
    const r = parseRange(q);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    // Même garde que la liste des contacts touchés : un identifiant mal formé ferait refuser la conversion
    // `::uuid[]` par Postgres (500).
    const idsCout = idsCampagnes(q.campaignIds);
    if (idsCout === null) return reply.code(400).send({ error: 'campaignIds invalide' });
    const filter: FiltreCampagneOuTemplate = {
      ...(idsCout.length > 0 ? { campaignIds: idsCout } : {}),
      ...(csvBorne(q.templateNames).length > 0 ? { templateNames: csvBorne(q.templateNames) } : {}),
    };
    return reply.code(200).send(await deps.getCostSeries(tenant, r.range, filter));
  });

  /**
   * Coût par campagne rapporté aux engagements (page de synthèse), sous `/stats/cost` : mêmes tarifs Meta, même
   * population d'envois facturables que le graphe, pour que les deux totaux viennent du même endroit.
   */
  app.get('/tenants/:tenantId/stats/cost/campaigns', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const r = parseRange(req.query as Record<string, unknown>);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    const inclureArchivees = (req.query as Record<string, unknown>).archivees === '1';
    return reply.code(200).send(await deps.getCoutParCampagne(tenant, r.range, { inclureArchivees }));
  });

  /**
   * Le coût total des messages envoyés sur la période : templates margés, messages de service franchise déduite,
   * RCS à deux tarifs. Route séparée de `/stats/cost` (le graphe dit comment ça s'est réparti, celle-ci ce que la
   * période a coûté) ; elles partagent le calcul (`chiffrer`, marge appliquée en amont par `tarifsFactures`).
   */
  app.get('/tenants/:tenantId/stats/cost/messages', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const r = parseRange(req.query as Record<string, unknown>);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    return reply.code(200).send(await deps.getCoutMessages(tenant, r.range));
  });

  /**
   * Ce que le client a dépensé en IA sur la période, sur son crédit prépayé, et le détail de ses tours. Rien de
   * ce qui est sur notre clé n'apparaît ici (transcription, bot d'aide, assistants) ; le Meta Business Agent non
   * plus : il se facture chez Meta au message de service, donc dans la route au-dessus.
   */
  app.get('/tenants/:tenantId/stats/cost/ia', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const r = parseRange(req.query as Record<string, unknown>);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    return reply.code(200).send(await deps.getCoutIa(tenant, r.range));
  });

  /**
   * Les journées de l'écran « Analyse des conversations » : une ligne par jour, pas par conversation. Route à part
   * de `/stats/conversations` : la réponse est bornée par le nombre de jours de la période, jamais par le trafic.
   */
  app.get('/tenants/:tenantId/stats/conversations/jours', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const r = parseRange(req.query as Record<string, unknown>);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    return reply.code(200).send({ jours: await deps.getJoursAnalyse(tenant, r.range) });
  });

  app.get('/tenants/:tenantId/stats/conversations', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const r = parseRange(req.query as Record<string, unknown>);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    return reply.code(200).send(await deps.getConversationSummary(tenant, r.range));
  });

  /**
   * Le damier « satisfaction x urgence » de la page de synthèse. Route à part de `/stats/conversations` : la page
   * n'a besoin que du damier, pas des compteurs et des sujets du résumé.
   */
  app.get('/tenants/:tenantId/stats/conversations/nuage', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const r = parseRange(req.query as Record<string, unknown>);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    return reply.code(200).send(await deps.getNuageQualitatif(tenant, r.range));
  });

  /**
   * La fiche d'une campagne, ouverte depuis une ligne du tableau du coût. Sans `parseRange`, seule route de ce
   * fichier dans ce cas : elle couvre toute la vie de la campagne. L'identifiant est validé avant la base (400 au
   * lieu d'une levée Postgres sur `uuid`).
   */
  app.get('/tenants/:tenantId/stats/cost/campaigns/:campaignId', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { campaignId } = req.params as { campaignId?: string };
    // `estUuid` du dépôt, pas une expression régulière de plus : elle est déjà importée ici, et une
    // seconde définition de « un identifiant valide » dériverait de la première au premier ajustement.
    if (typeof campaignId !== 'string' || !estUuid(campaignId)) {
      return reply.code(400).send({ error: 'campaignId invalide' });
    }
    const fiche = await deps.getDetailCoutCampagne(tenant, campaignId);
    // 404 et non une fiche à zéro : « cette campagne n'existe pas ici » et « elle n'a rien coûté » sont deux
    // réponses différentes, et la seconde serait une affirmation fausse.
    if (fiche === null) return reply.code(404).send({ error: 'campagne introuvable' });
    return reply.code(200).send(fiche);
  });

  // Liste quali des conversations analysées, filtrable ?sentiment=&intent=&action=&topic=&limit=.
  app.get('/tenants/:tenantId/stats/conversations/list', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const q = req.query as Record<string, unknown>;
    const r = parseRange(q);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    const limit = typeof q.limit === 'string' && /^\d+$/.test(q.limit) ? Number(q.limit) : undefined;
    const filters: AnalyzedConversationsFilter = {
      ...(inSet(SENTIMENTS, q.sentiment) ? { sentiment: inSet(SENTIMENTS, q.sentiment) } : {}),
      ...(inSet(INTENTS, q.intent) ? { intent: inSet(INTENTS, q.intent) } : {}),
      ...(inSet(ACTIONS, q.action) ? { action: inSet(ACTIONS, q.action) } : {}),
      // Le sujet est du texte libre (le LLM l'écrit) : pas d'énumération à valider, on borne la longueur et le
      // paramètre lié fait le reste. Une chaîne vide vaut « pas de filtre » et n'est pas transmise.
      ...(topicValide(q.topic) ? { topic: topicValide(q.topic) } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
    return reply.code(200).send({ conversations: await deps.listAnalyzedConversations(tenant, r.range, filters) });
  });
}
