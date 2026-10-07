import type { FastifyInstance } from 'fastify';
import { rcsOutboundSchema } from '../rcs/schema';
import type { Queue } from '../queue/queue';
import { createCampaignWithRecipients } from '../campaign/create';
import { avertissementPalier } from '../meta/palier';
import type { CampaignRepoLike } from '../campaign/create';
import type { CreateCampaignInput, CampaignSummary, CampaignDetail, PhoneNumberRow, RetryReset } from '../campaign/store.pg';
import type { CampaignCategory } from '../campaign/types';
import { validateParamMapping } from '../crm/template';
import { campaignJobExpireSeconds, resolveRatePerMinute } from '../campaign/pacing';
import { refusDePlafond } from '../campaign/plafond';
import { scanOpening } from '../workflow/engine';
import type { WorkflowGraph } from '../workflow/graph';
import { gardeEtendue } from '../auth/middleware';
import type { Guard, PreHandler } from '../auth/middleware';
import { espaceVerifie, nonEmpty, estUuid } from './scope';
import { normaliserChaine, problemeDeChaine, RANG_INITIAL, type DevenirEtage, type EtageEntrant } from '../campaign/etages';
// Le même analyseur de cible que le mini-CRM : les destinataires d'une campagne se désignent exactement
// comme une action en masse, et deux analyseurs finiraient par ne plus viser la même chose.
import { parseBulkTarget } from './contacts';
import type { BulkTarget } from '../crm/contact-store.pg';
import { LimiteOffreError, STATUT_REFUS_OFFRE, corpsRefusLimite } from '../offres/refus';

/**
 * Ce que les routes lisent et écrivent des campagnes, en plus de ce que la création en a besoin
 * (`CampaignRepoLike`). Toutes ces lectures et écritures sont scopées tenant.
 */
export interface CampagnesDep extends CampaignRepoLike {
  /** 🔴 Le numéro appartient-il à l'espace ? (empêche d'envoyer depuis le numéro d'autrui.) */
  phoneNumberBelongsToTenant(phoneNumberId: string, tenantId: string): Promise<boolean>;
  /** La campagne appartient-elle au tenant ? (scope le run, 404 sinon.) */
  campaignBelongsTo(campaignId: string, tenantId: string): Promise<boolean>;
  /** Arrête une campagne au fil de l'eau (scopée tenant) : elle cesse de prendre les arrivants. */
  stopWebhookCampaign(campaignId: string, tenantId: string): Promise<boolean>;
  /** Suspend une campagne en cours d'envoi (scopée tenant, `running` uniquement). false = elle n'envoyait pas. */
  pauseCampaign(campaignId: string, tenantId: string): Promise<boolean>;
  /** Lève la pause avant d'enfiler le run de reprise (`paused` uniquement, no-op ailleurs). */
  resumeCampaign(campaignId: string, tenantId: string): Promise<boolean>;
  /** Dimensionnement du job de run : débit choisi + nb de destinataires en attente. null si campagne absente.
   *  Sert à calculer l'expireInSeconds du job (éviter qu'un run throttlé long expire et soit rejoué en parallèle). */
  getRunSizing(campaignId: string): Promise<{ ratePerMinute: number | null; pendingCount: number } | null>;
  /** Programme une campagne (draft/paused) pour un lancement futur (scopé tenant). true si programmée. */
  scheduleCampaign(campaignId: string, tenantId: string, scheduledAt: Date): Promise<boolean>;
  /** Annule une programmation (scopé tenant) : la campagne repasse en brouillon. true si annulée. */
  cancelSchedule(campaignId: string, tenantId: string): Promise<boolean>;
  listCampaignSummaries(tenantId: string, opts?: { archived?: boolean }): Promise<CampaignSummary[]>;
  /** Archive une campagne (scopée tenant) : masquée de la liste, conservée en base. true si elle était active. */
  archiveCampaign(campaignId: string, tenantId: string): Promise<boolean>;
  /** Sort une campagne de l'archive (scopée tenant). true si elle y était. */
  unarchiveCampaign(campaignId: string, tenantId: string): Promise<boolean>;
  /** Supprime pour de bon une campagne jamais lancée (scopée tenant). false si la garde métier refuse. */
  deleteDraftCampaign(campaignId: string, tenantId: string): Promise<boolean>;
  getCampaignDetail(campaignId: string, tenantId: string): Promise<CampaignDetail | null>;
  /** Renvoi d'un destinataire en échec de variable de template : re-résout sur le contact à jour + remet en
  *  pending. Résultat discriminé (queued/not_found/not_retryable/missing_var/conflict). */
  resetRecipientForRetry(tenantId: string, campaignId: string, recipientId: string): Promise<RetryReset>;
  listPhoneNumbers(tenantId: string): Promise<PhoneNumberRow[]>;
}

export interface CampaignRouteDeps {
  repo: CampagnesDep;
  queue: Queue;
  /**
   * Palier d'envoi du numéro de l'espace (`messaging_limit_tier`), pour avertir avant un lancement trop gros.
   * Une panne de lecture ne doit jamais empêcher de créer une campagne, d'où le repli silencieux côté appelant.
   */
  getMessagingLimitTier(tenantId: string): Promise<string | null>;
  /**
   * Brouillons de composition (une campagne qu'on est en train d'écrire), sans rapport avec
   * `campaigns.status = 'draft'`, qui est une campagne complète et non lancée.
   */
  drafts: {
    list(tenantId: string): Promise<Array<{ id: string; name: string; state: Record<string, unknown>; updatedAt: Date }>>;
    create(tenantId: string, name: string, state: Record<string, unknown>): Promise<{ id: string; name: string; state: Record<string, unknown>; updatedAt: Date }>;
    update(tenantId: string, id: string, name: string, state: Record<string, unknown>): Promise<boolean>;
    remove(tenantId: string, id: string): Promise<boolean>;
  };
  contacts: {
    /**
     * Résout une cible (filtres + exclusions, ou identifiants) en liste d'identifiants, dans la base : le
     * navigateur n'a pas à rapatrier puis renvoyer des dizaines de milliers d'identifiants dans un corps plafonné
     * à 1 Mo.
     */
    contactIdsForTarget(tenantId: string, target: BulkTarget, limite?: number): Promise<string[]>;
  };
  /**
   * Les identifiants de tous les contacts de l'espace, bornés à `plafond + 1`. On résout une fois, et ce sont
   * exactement ceux-là que la campagne emporte : compter puis charger plus tard laisserait un import concurrent
   * faire partir la campagne au-dessus du plafond validé. Le `+ 1` distingue « pile au plafond » de « au-dessus ».
   * Cela borne aussi la mémoire.
   */
  identifiantsDeTousLesContacts(tenantId: string, limite: number): Promise<string[]>;
  /** Plafond de destinataires (le câblage passe la configuration, défaut de `src/campaign/plafond.ts`). */
  plafondDestinataires: number;
  rcs: {
    /**
     * 🔴 L'agent RCS appartient-il au tenant ? Même garde que pour le numéro : le partenaire RBM est global,
     * donc sans elle un tenant enverrait sous la marque d'un autre.
     */
    belongsToTenant(agentId: string, tenantId: string): Promise<boolean>;
    /** Agents RCS du tenant (sélecteur de l'assistant). */
    listForTenant(tenantId: string): Promise<Array<{ agentId: string; brandName: string; status: string }>>;
  };
  /**
   * Le modèle de mail appartient-il à l'espace (et n'est-il pas supprimé) ? Garde d'un étage e-mail, comme
   * `rcs.belongsToTenant` : sans elle, un identifiant inconnu lèverait 23503 sur la clé étrangère (500).
   */
  emailTemplateBelongsToTenant(templateId: string, tenantId: string): Promise<boolean>;
  /**
   * Le webhook entrant appartient-il à l'espace, et est-il actif ? Garde d'une campagne au fil de l'eau : sans
   * elle on brancherait une campagne sur l'adresse d'un autre espace.
   */
  webhookUsableByTenant(webhookId: string, tenantId: string): Promise<boolean>;
  /**
   * Graphe du workflow du tenant (campagne workflow). null si inconnu/autre tenant (le scope tenant vaut le
   * contrôle de propriété : un workflow d'un autre tenant renvoie null -> 400). Sert aussi à vérifier que le
   * bloc d'entrée est bien un envoi de template.
   */
  getWorkflowGraph(workflowId: string, tenantId: string): Promise<WorkflowGraph | null>;
  /** Débit par défaut (msg/min, 0 = opt-out) des campagnes sans ratePerMinute. Doit être le même que celui
  *  injecté au worker (config.CAMPAIGN_DEFAULT_RATE_PER_MINUTE), pour que l'estimation d'expiration et le
  *  throttle réel voient le même débit. */
  defaultRatePerMinute: number;
  /** Le plus bas des plafonds de canal, pour estimer une durée sans connaître le canal (`plafondLePlusBas`).
  *  Le frein réel est posé par `run-job`, qui lit le canal. */
  plafondLePlusBas: number;
  /**
   * Les modèles du mois au lancement (lot 6) : la limite de l'offre, ce qu'il en reste, et combien de modèles la campagne
   * enverrait (ses destinataires en attente sur un étage WhatsApp à modèle, hors scénario). `null` = sans limite. Une
   * ESTIMATION pour refuser tôt : la décision qui fait foi reste à l'envoi (`src/meta/factory.ts`). Requise : les
   * fixtures disent leur hypothèse (`campagnesInertes` : sans limite).
   */
  modelesDuLancement(tenantId: string, campaignId: string): Promise<{ max: number; reste: number; demandes: number } | null>;
}

const CATEGORIES = new Set<CampaignCategory>(['marketing', 'utility']);

function isCategory(v: unknown): v is CampaignCategory {
  return typeof v === 'string' && CATEGORIES.has(v as CampaignCategory);
}

/** Routes de campagne : lecture (liste/détail/numéros), création et déclenchement du run. */
export function registerCampaigns(app: FastifyInstance, deps: CampaignRouteDeps, garde: Guard, limiteCouteuse?: PreHandler): void {
  const opts = { preHandler: garde };
  /**
   * L'expiration du job d'un run, dimensionnée sur le travail réel (destinataires en attente / débit résolu) :
   * un run throttlé long ne doit pas expirer et être rejoué en parallèle. `undefined` (campagne introuvable) =
   * le défaut de la file.
   */
  const expirationDuRun = async (campaignId: string): Promise<number | undefined> => {
    const sizing = await deps.repo.getRunSizing(campaignId);
    return sizing
      ? campaignJobExpireSeconds(sizing.pendingCount, resolveRatePerMinute(sizing.ratePerMinute, deps.defaultRatePerMinute, deps.plafondLePlusBas))
      : undefined;
  };
  // Garde des routes coûteuses : la garde habituelle plus le plafond par espace (chaîne aplatie).
  const couteux = gardeEtendue(garde, limiteCouteuse);

  /**
   * Brouillons de composition : aucun effet d'envoi (un nom et l'état d'un écran), mais admin comme tout ce
   * groupe, un brouillon étant une campagne en devenir.
   */
  const drafts = deps.drafts;
  /** Nom d'un brouillon : non vide et borné. Le nom sert d'étiquette, il n'est jamais interprété. */
  const lireNom = (body: unknown): string | null => {
    const n = (body as { name?: unknown } | null)?.name;
    if (!nonEmpty(n)) return null;
    const nom = (n as string).trim();
    return nom.length <= 200 ? nom : null;
  };
  /** État de l'écran : un objet, jamais un tableau ni un scalaire. Absent -> objet vide. */
  const lireEtat = (body: unknown): Record<string, unknown> | null => {
    const s = (body as { state?: unknown } | null)?.state;
    if (s === undefined || s === null) return {};
    if (typeof s !== 'object' || Array.isArray(s)) return null;
    return s as Record<string, unknown>;
  };

  app.get('/tenants/:tenantId/campaign-drafts', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    return reply.code(200).send({ drafts: await drafts.list(tenant) });
  });

  app.post('/tenants/:tenantId/campaign-drafts', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const nom = lireNom(req.body);
    if (nom === null) return reply.code(400).send({ error: 'name requis (texte non vide, 200 caractères max)' });
    const etat = lireEtat(req.body);
    if (etat === null) return reply.code(400).send({ error: 'state invalide (objet)' });
    return reply.code(201).send({ draft: await drafts.create(tenant, nom, etat) });
  });

  app.put('/tenants/:tenantId/campaign-drafts/:draftId', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const nom = lireNom(req.body);
    if (nom === null) return reply.code(400).send({ error: 'name requis (texte non vide, 200 caractères max)' });
    const etat = lireEtat(req.body);
    if (etat === null) return reply.code(400).send({ error: 'state invalide (objet)' });
    const { draftId } = req.params as { draftId: string };
    // 🔴 404 et non création : un identifiant inconnu vient d'un brouillon supprimé ou d'un autre espace. Créer à
    // la volée sèmerait des brouillons chez autrui en devinant des identifiants.
    const maj = await drafts.update(tenant, draftId, nom, etat);
    if (!maj) return reply.code(404).send({ error: 'brouillon inconnu' });
    return reply.code(200).send({ updated: true, draftId });
  });

  app.delete('/tenants/:tenantId/campaign-drafts/:draftId', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { draftId } = req.params as { draftId: string };
    const supprime = await drafts.remove(tenant, draftId);
    if (!supprime) return reply.code(404).send({ error: 'brouillon inconnu' });
    return reply.code(200).send({ deleted: true, draftId });
  });

  app.get('/tenants/:tenantId/campaigns', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    // `?archived=1` bascule sur la corbeille. Valeur venue de la query string, donc `unknown` : on n'accepte que
    // les deux formes explicites, tout le reste (y compris 'false', '0', 'oui') vaut « campagnes actives ».
    const q = (req.query ?? {}) as { archived?: unknown };
    const archived = q.archived === '1' || q.archived === 'true';
    return reply.code(200).send({ campaigns: await deps.repo.listCampaignSummaries(tenant, { archived }) });
  });

  app.get('/tenants/:tenantId/campaigns/:campaignId', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { campaignId } = req.params as { campaignId: string };
    const detail = await deps.repo.getCampaignDetail(campaignId, tenant);
    if (!detail) return reply.code(404).send({ error: 'campagne inconnue' });
    return reply.code(200).send(detail);
  });

  app.get('/tenants/:tenantId/phone-numbers', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    return reply.code(200).send({ phoneNumbers: await deps.repo.listPhoneNumbers(tenant) });
  });

  // Agents RCS de l'espace, pour le sélecteur de l'assistant de campagne, à côté du listage des numéros Meta :
  // même besoin (« depuis quoi j'envoie ? »), même garde. Un espace sans agent RCS rend une liste vide.
  app.get('/tenants/:tenantId/rcs-agents', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    return reply.code(200).send({ agents: await deps.rcs.listForTenant(tenant) });
  });

  app.post('/tenants/:tenantId/campaigns', opts, async (req, reply) => {
    const effectiveTenant = espaceVerifie(req);

    const b = (req.body ?? {}) as Partial<{
      phoneNumberId: string;
      name: string;
      category: CampaignCategory;
      templateName: string;
      templateLanguage: string;
      paramMapping: unknown;
      contactIds: unknown;
      contactTarget: unknown;
      workflowId: string;
      ratePerMinute: unknown;
      channel: string;
      rcsAgentId: string;
      rcsMessage: unknown;
      webhookId: string;
      businessHoursOnly: unknown;
      chaine: unknown;
      reessayer: unknown;
      rattrapageHorsHoraires: unknown;
      assignation: unknown;
      assignationUserId: unknown;
      devenir: unknown;
    }>;

    if (!isCategory(b.category)) return reply.code(400).send({ error: 'category invalide (marketing|utility)' });

    // Canal. Absent = 'whatsapp'. Un canal inconnu est refusé, jamais ramené à WhatsApp en silence (une campagne
    // partie sur le mauvais canal est irrattrapable).
    const channel = b.channel ?? 'whatsapp';
    if (channel !== 'whatsapp' && channel !== 'rcs') {
      return reply.code(400).send({ error: 'channel invalide (whatsapp|rcs)' });
    }
    const isRcs = channel === 'rcs';
    let rcsMessage: unknown;
    if (isRcs) {
      if (!nonEmpty(b.rcsAgentId)) return reply.code(400).send({ error: 'rcsAgentId requis pour une campagne RCS' });
      if (!(await deps.rcs.belongsToTenant(b.rcsAgentId as string, effectiveTenant))) {
        return reply.code(400).send({ error: 'rcsAgentId inconnu pour ce tenant' });
      }
      const parsed = rcsOutboundSchema.safeParse(b.rcsMessage);
      if (!parsed.success) return reply.code(400).send({ error: 'rcsMessage invalide' });
      rcsMessage = parsed.data;
      if (nonEmpty(b.workflowId)) {
        return reply.code(400).send({ error: "Une campagne RCS envoie un message direct. Le declenchement d'un scenario par campagne n'est pas disponible sur ce canal." });
      }
    }
    // Débit optionnel : entier 1..80 messages/min (le client ne peut que baisser sous le plafond métier). Absent ou
    // null = aucun throttle ; 0, 81, décimal ou négatif -> 400. 80 est la borne de saisie, pas le plafond appliqué :
    // il dépend du canal (`plafondDuCanal`), et une campagne RCS qui demande 80 est ramenée au plafond RCS.
    let ratePerMinute: number | null | undefined;
    if (b.ratePerMinute !== undefined && b.ratePerMinute !== null) {
      const r = b.ratePerMinute;
      if (typeof r !== 'number' || !Number.isInteger(r) || r < 1 || r > 80) {
        return reply.code(400).send({ error: 'ratePerMinute invalide (entier 1..80 ou null)' });
      }
      ratePerMinute = r;
    }
    // Numéro Meta : exigé sur WhatsApp uniquement. Une campagne RCS part d'un agent, pas d'un numéro.
    if (!isRcs && !nonEmpty(b.phoneNumberId)) return reply.code(400).send({ error: 'phoneNumberId requis' });
    if (!nonEmpty(b.name)) return reply.code(400).send({ error: 'name requis' });
    // Une campagne envoie soit un template soit un workflow (exactement un des deux). Sur RCS, ni l'un ni
    // l'autre : le message est porté par la campagne elle-même.
    const isWorkflow = nonEmpty(b.workflowId);
    if (isWorkflow) {
      const graph = await deps.getWorkflowGraph(b.workflowId as string, effectiveTenant);
      if (!graph) {
        return reply.code(400).send({ error: 'workflowId inconnu pour ce tenant' });
      }
      // Une campagne part sur une audience froide : le premier message doit être un template. On juge sur ce qui
      // ouvre réellement (un tag, une action ou une condition avant n'envoient rien), pas sur le type du 1er bloc.
      const scan = scanOpening(graph);
      if (scan.sessionOpen) {
        return reply.code(400).send({ error: "Ce scénario ouvre par un message rapide, une question ou un formulaire, qui exigent que le contact ait écrit dans les 24 h. Une campagne part sur une audience froide : il lui faut un envoi de template en ouverture." });
      }
      if (scan.waitBeforeTemplate) {
        return reply.code(400).send({ error: "Ce scénario attend avant son premier envoi : rien ne partirait au lancement. Pour différer une campagne, utilise « Plus tard » au moment de la lancer." });
      }
      // Un « Aller à » vers un autre scénario avant tout envoi (RC5) : l'ouverture se joue dans un graphe que cette
      // garde ne lit pas, et la campagne ne saurait ni quel template paramétrer, ni si un message de session part.
      if (scan.sautsHorsScenario.length > 0) {
        return reply.code(400).send({ error: "Ce scénario saute vers un autre scénario (« Aller à ») avant son premier envoi : une campagne doit ouvrir sur un envoi de ce scénario. Choisis directement le scénario d'arrivée." });
      }
      // Un bloc RCS configuré ouvre à froid : il ne passe pas par WhatsApp, donc aucune fenêtre de 24 h ne
      // s'y applique. Exiger un template en ouverture fermait la porte à toute campagne RCS par scénario.
      if (!scan.firstTemplate && !scan.rcsOpen) {
        return reply.code(400).send({ error: 'Le scénario doit ouvrir par un envoi : un template WhatsApp, ou un message RCS.' });
      }
      // Les trois contrôles suivants portent sur le template d'ouverture, s'il y en a un (un scénario qui ouvre en
      // RCS n'en a pas). Pas de `return` nu ici : sortir d'un handler Fastify sans répondre laisserait la requête
      // pendante.
      if (scan.firstTemplate) {
        if (scan.ambiguousTemplate) {
          return reply.code(400).send({ error: "Ce scénario peut ouvrir sur plusieurs templates différents : impossible de savoir lequel paramétrer pour la campagne." });
        }
        // `unnamedOpeningTemplate` couvre aussi les branches : une condition dont une sortie mène à un template
        // sans nom laisserait ces destinataires sans message, tout en les comptant « envoyés ».
        if (scan.unnamedOpeningTemplate || String(scan.firstTemplate.data.templateName ?? '').trim() === '') {
          return reply.code(400).send({ error: "Un template d'ouverture du scénario n'est pas encore choisi." });
        }
      }
    } else if (!isRcs) {
      if (!nonEmpty(b.templateName)) return reply.code(400).send({ error: 'templateName ou workflowId requis' });
      if (!nonEmpty(b.templateLanguage)) return reply.code(400).send({ error: 'templateLanguage requis' });
    }

    // Campagne au fil de l'eau : les destinataires n'existent pas encore, ils arriveront un par un par ce
    // webhook entrant. Trois refus explicites plutôt qu'une campagne qui a l'air créée et n'attrape rien.
    let webhookId: string | undefined;
    if (nonEmpty(b.webhookId)) {
      if (!(await deps.webhookUsableByTenant(b.webhookId as string, effectiveTenant))) {
        return reply.code(400).send({ error: 'webhookId inconnu (ou désactivé) pour ce tenant' });
      }
      // Une liste figée ET un flux d'arrivants sont deux façons contradictoires de désigner les destinataires.
      // Accepter les deux en n'en honorant qu'une laisserait l'appelant croire que sa liste va partir.
      if (Array.isArray(b.contactIds) && b.contactIds.length > 0) {
        return reply.code(400).send({ error: "Une campagne alimentée par un webhook ne prend pas de liste de contacts : ses destinataires arrivent au fil de l'eau." });
      }
      webhookId = b.webhookId as string;
    }

    // Sélection de contacts optionnelle : tableau de chaînes non vides. Absent -> tous les contacts.
    let contactIds: string[] | undefined;
    // Le plafond est lu ici, avant toute résolution de cible : il sert de borne aux requêtes de sélection, pas
    // seulement de verdict après coup. Une garde qui arrive après le chargement ne protège que la suite.
    const plafond = deps.plafondDestinataires;
    if (b.contactIds !== undefined) {
      if (!Array.isArray(b.contactIds) || !b.contactIds.every((x) => nonEmpty(x))) {
        return reply.code(400).send({ error: 'contactIds invalide (tableau d\'ids)' });
      }
      /**
       * 🔴 Une liste vide n'est pas « tout le monde » : sans ce refus, une sélection explicitement vide retombait sur
       * « tous les contacts de l'espace ». `contactIds` absent veut toujours dire « tous les contacts » ; ce qu'on
       * refuse, c'est de désigner une liste et de n'y mettre personne.
       */
      if (b.contactIds.length === 0) {
        return reply.code(422).send({ error: 'Aucun contact ne correspond à cette sélection.' });
      }
      contactIds = b.contactIds as string[];
    }

    /**
     * Cible par intention (filtres + exclusions) plutôt que par liste d'identifiants. Deux façons de désigner les
     * mêmes destinataires ne coexistent pas dans une requête : on n'en honorerait qu'une.
     */
    if (b.contactTarget !== undefined) {
      if (contactIds !== undefined) {
        return reply.code(400).send({ error: 'contactIds et contactTarget désignent tous les deux les destinataires : n’en envoyer qu’un.' });
      }
      if (webhookId) {
        return reply.code(400).send({ error: "Une campagne alimentée par un webhook ne prend pas de cible de contacts : ses destinataires arrivent au fil de l'eau." });
      }
      const target = parseBulkTarget(b.contactTarget);
      // `null` = aucune cible exploitable. On refuse plutôt que de retomber sur « tous les contacts » : une cible
      // mal formée qui viserait tout l'espace est exactement l'accident qu'on ne veut jamais.
      if (target === null) return reply.code(400).send({ error: 'contactTarget invalide (ids non vides, ou filters)' });
      // Borné à `plafond + 1` : inutile de matérialiser au-delà de ce que le plafond refusera.
      contactIds = await deps.contacts.contactIdsForTarget(effectiveTenant, target, plafond + 1);
      // Une cible qui ne résout personne est une erreur de l'appelant, pas une campagne à tout le monde :
      // sans ce refus, `contactIds` vide retomberait sur « tous les contacts » un peu plus bas.
      if (contactIds.length === 0) {
        return reply.code(422).send({ error: 'Aucun contact ne correspond à cette sélection.' });
      }
    }

    /**
     * 🔴 Le plafond de taille, ici parce que c'est le seul point où se rejoignent les trois façons de désigner des
     * destinataires (liste, cible par filtres, « tous les contacts »). Une campagne au fil de l'eau en est exclue :
     * elle naît vide, ses destinataires arrivent un par un.
     */
    if (!webhookId) {
      /**
       * « Tous les contacts » résout ses identifiants ici, il ne les compte pas : la garde juge exactement ce que la
       * campagne emportera. Un contact créé après la validation n'entre pas dans la campagne : l'opérateur a confirmé
       * un nombre, il obtient ce nombre.
       */
      if (contactIds === undefined) {
        contactIds = await deps.identifiantsDeTousLesContacts(effectiveTenant, plafond + 1);
      }
      const vises = contactIds ? contactIds.length : 0;
      const refus = refusDePlafond(vises, plafond);
      if (refus) return reply.code(422).send({ error: refus });
    }

    // Le numéro doit appartenir à l'espace (sinon envoi depuis le numéro d'un autre client). Sur RCS, c'est
    // l'agent qui a été contrôlé plus haut, il n'y a pas de numéro à vérifier.
    if (!isRcs && !(await deps.repo.phoneNumberBelongsToTenant(b.phoneNumberId as string, effectiveTenant))) {
      return reply.code(400).send({ error: 'phoneNumberId inconnu pour ce tenant' });
    }

    // Valider paramMapping avant toute écriture, pour un workflow aussi : le mapping cible les variables du 1er
    // template du workflow (résolues par contact, contacts sans la valeur sautés). Invalide -> 400 déterministe.
    const paramMapping = validateParamMapping(b.paramMapping ?? []);
    if (paramMapping === null) {
      return reply.code(400).send({ error: 'paramMapping invalide (positions 1..N contiguës, sources valides)' });
    }

    /**
     * La chaîne d'étages, quand l'assistant en envoie une. Refusée en 422, jamais en 5xx : la table porte ses CHECK
     * (rang 1 à 3, canal) et sa clé primaire `(campaign_id, rang)`, et un corps brut ferait trancher Postgres.
     * Absente = une campagne à un seul étage (API publique, clients existants).
     */
    let chaine: EtageEntrant[] | undefined;
    if (b.chaine !== undefined) {
      if (!Array.isArray(b.chaine)) {
        return reply.code(400).send({ error: 'chaine invalide (tableau d\'étages)' });
      }
      const probleme = problemeDeChaine(b.chaine as EtageEntrant[], channel);
      if (probleme) return reply.code(422).send({ error: probleme });
      const normalisee = normaliserChaine(b.chaine as EtageEntrant[]);
      /**
       * Le contenu des étages au-delà du premier, et seulement lui : le rang 1 est la campagne elle-même, déjà
       * contrôlée plus haut, et `insertCampaignRow` le réécrit depuis `campaigns` (une seule source par étage).
       */
      for (const e of normalisee) {
        if (e.rang === RANG_INITIAL) continue;
        if (e.canal === 'rcs') {
          const parsed = rcsOutboundSchema.safeParse(e.rcsMessage);
          if (!parsed.success) {
            return reply.code(422).send({ error: `L'étage ${e.rang} part en RCS : son message n'est pas valide.` });
          }
          e.rcsMessage = parsed.data;
        }
        if (e.canal === 'email') {
          if (!estUuid(e.emailTemplateId ?? '')) {
            return reply.code(422).send({ error: `L'étage ${e.rang} part en e-mail : il lui faut un modèle de mail.` });
          }
          /**
           * Sans la clé du champ, l'étage est mort-né : `contacts` n'a pas de colonne `email`, l'adresse vit dans le
           * jsonb `fields` sous un nom que le client choisit. Sans cette clé, l'étage serait sauté à chaque bascule
           * (`prochainEtageServable`) sans explication.
           */
          if (typeof e.emailChamp !== 'string' || e.emailChamp.trim() === '') {
            return reply.code(422).send({ error: `L'étage ${e.rang} part en e-mail : il faut dire quel champ de la fiche porte l'adresse.` });
          }
          e.emailChamp = e.emailChamp.trim();
          if (!(await deps.emailTemplateBelongsToTenant(e.emailTemplateId as string, effectiveTenant))) {
            return reply.code(422).send({ error: `L'étage ${e.rang} vise un modèle de mail inconnu de cet espace.` });
          }
        }
        // 🔴 Même garde que `workflowId` sur la campagne : sans elle, un identifiant recopié démarrerait le scénario
        // d'un autre espace. `getWorkflowGraph` est scopée, elle rend null hors espace.
        if (e.workflowId !== undefined) {
          if (!estUuid(e.workflowId) || !(await deps.getWorkflowGraph(e.workflowId, effectiveTenant))) {
            return reply.code(422).send({ error: `L'étage ${e.rang} vise un scénario inconnu de cet espace.` });
          }
        }
      }
      /**
       * Un étage RCS exige un agent, même sur une campagne WhatsApp : sans lui, `senderForCampaign` rend `null` et le
       * run se met en pause. Poser `rcs_agent_id` sur une campagne WhatsApp est inerte : c'est `campaign.channel` qui
       * gouverne le sender (`src/campaign/run-job.ts`).
       */
      if (!isRcs && normalisee.some((e) => e.canal === 'rcs')) {
        if (!nonEmpty(b.rcsAgentId)) {
          return reply.code(422).send({ error: "Cette chaîne comporte un étage RCS : il lui faut un agent RCS." });
        }
        if (!(await deps.rcs.belongsToTenant(b.rcsAgentId as string, effectiveTenant))) {
          return reply.code(422).send({ error: 'rcsAgentId inconnu pour ce tenant' });
        }
      }
      chaine = normalisee;
    }

    /**
     * L'assignation des réponses ; `null` ou absente = aucune. `personne` sans personne est refusé : sinon les
     * réponses tomberaient dans « À traiter » alors que l'opérateur croit les avoir routées.
     */
    let assignation: 'personne' | 'tour_de_role' | null | undefined;
    if (b.assignation !== undefined && b.assignation !== null) {
      if (b.assignation !== 'personne' && b.assignation !== 'tour_de_role') {
        return reply.code(400).send({ error: 'assignation invalide (personne|tour_de_role)' });
      }
      assignation = b.assignation;
      if (assignation === 'personne' && !estUuid(typeof b.assignationUserId === 'string' ? b.assignationUserId : '')) {
        return reply.code(422).send({ error: "Cette campagne confie ses réponses à une personne : il faut la choisir." });
      }
    }

    /**
     * Ce qui se passe quand le contact répond au premier étage. Refusé ici plutôt qu'en base (le CHECK lèverait,
     * donc 500). Les étages suivants portent le leur dans `chaine[].devenir`, validé par `problemeDeChaine`.
     */
    let devenir: DevenirEtage | undefined;
    if (b.devenir !== undefined && b.devenir !== null) {
      if (b.devenir !== 'mba' && b.devenir !== 'inbox') {
        return reply.code(400).send({ error: 'devenir invalide (mba|inbox)' });
      }
      devenir = b.devenir;
    }

    const input: CreateCampaignInput = {
      tenantId: effectiveTenant,
      ...(devenir ? { devenir } : {}),
      phoneNumberId: isRcs ? '' : (b.phoneNumberId as string),
      name: b.name,
      category: b.category,
      templateName: isWorkflow || isRcs ? '' : (b.templateName as string),
      templateLanguage: isWorkflow || isRcs ? '' : (b.templateLanguage as string),
      paramMapping,
      channel,
      ...(contactIds ? { contactIds } : {}),
      ...(isWorkflow ? { workflowId: b.workflowId as string } : {}),
      ...(ratePerMinute !== undefined ? { ratePerMinute } : {}),
      ...(isRcs ? { rcsAgentId: b.rcsAgentId as string, rcsMessage } : {}),
      ...(b.businessHoursOnly === true ? { businessHoursOnly: true } : {}),
      ...(webhookId ? { webhookId } : {}),
      ...(chaine ? { chaine } : {}),
      // Un étage RCS de repli sur une campagne WhatsApp : l'agent voyage avec la campagne, contrôlé juste
      // au-dessus. Inerte tant que `channel` n'est pas `rcs`.
      ...(!isRcs && chaine?.some((e) => e.canal === 'rcs') ? { rcsAgentId: b.rcsAgentId as string } : {}),
      ...(b.reessayer !== undefined ? { reessayer: b.reessayer === true } : {}),
      ...(b.rattrapageHorsHoraires !== undefined ? { rattrapageHorsHoraires: b.rattrapageHorsHoraires === true } : {}),
      ...(assignation !== undefined ? { assignation } : {}),
      ...(assignation === 'personne' ? { assignationUserId: b.assignationUserId as string } : {}),
    };
    const result = await createCampaignWithRecipients(input, deps.repo);
    // Avertissement de palier : dit avant ce que le moteur gère après (pause sur un code de plafond). Au mieux :
    // une lecture en échec n'empêche pas de créer la campagne, elle n'ajoute qu'un message.
    let avertissement: string | undefined;
    try {
      avertissement = avertissementPalier(await deps.getMessagingLimitTier(effectiveTenant), result.recipientCount);
    } catch { /* le palier est un confort, pas une condition */ }
    return reply.code(201).send({ ...result, ...(avertissement ? { avertissement } : {}) });
  });

  app.post('/campaigns/:campaignId/run', couteux, async (req, reply) => {
    const { campaignId } = req.params as { campaignId: string };
    const authTenant = req.auth?.tenantId ?? '';
    // 🔴 Scope espace : 404 si la campagne n'appartient pas à l'appelant (pas d'IDOR entre espaces).
    if (!(await deps.repo.campaignBelongsTo(campaignId, authTenant))) {
      return reply.code(404).send({ error: 'campagne inconnue' });
    }

    // « Plus tard » : un scheduledAt (ISO absolu UTC) programme au lieu de lancer ; le sweeper enfilera le run à
    // l'échéance. Date future obligatoire (une date passée = 400, pas un lancement immédiat déguisé). Statut
    // 'scheduled', annulable via /cancel-schedule.
    const b = (req.body ?? {}) as { scheduledAt?: unknown };
    if (b.scheduledAt !== undefined && b.scheduledAt !== null) {
      if (typeof b.scheduledAt !== 'string') return reply.code(400).send({ error: 'scheduledAt invalide (ISO)' });
      const when = new Date(b.scheduledAt);
      if (Number.isNaN(when.getTime())) return reply.code(400).send({ error: 'scheduledAt invalide (date)' });
      if (when.getTime() <= Date.now()) return reply.code(400).send({ error: 'scheduledAt doit être dans le futur' });
      const ok = await deps.repo.scheduleCampaign(campaignId, authTenant, when);
      if (!ok) return reply.code(409).send({ error: 'campagne non programmable (déjà en cours/terminée)' });
      return reply.code(202).send({ scheduled: true, campaignId, scheduledAt: when.toISOString() });
    }

    // Les modèles du mois (lot 6) : une campagne qui ne tient pas dans ce qu'il reste est refusée d'emblée, avant toute
    // levée de pause, plutôt que de s'arrêter au milieu. Seul le lancement immédiat : une campagne programmée part un
    // autre jour, peut-être un autre mois, et la fabrique décide alors.
    const modeles = await deps.modelesDuLancement(authTenant, campaignId);
    if (modeles !== null && modeles.demandes > modeles.reste) {
      const refus = corpsRefusLimite(new LimiteOffreError(authTenant, 'envoisModelesMois', modeles.max));
      return reply.code(STATUT_REFUS_OFFRE).send({ ...refus, reste: modeles.reste, demandes: modeles.demandes });
    }

    // Lancement immédiat, l'expiration dimensionnée sur le travail réel (`expirationDuRun`).
    const expireInSeconds = await expirationDuRun(campaignId);
    // Reprise d'une campagne en pause : la pause est levée avant l'enfilement, parce que le job refuse de
    // démarrer une campagne en pause (garde de `campaignRunJob`, qui empêche un job enfilé avant la pause de la
    // ressusciter). No-op sur un brouillon, donc l'appel est inconditionnel.
    await deps.repo.resumeCampaign(campaignId, authTenant);
    // Deux POST /run concurrents empilent deux jobs, et les deux tournent : rien ne déduplique la file. 🔴 Le claim
    // atomique par destinataire est le seul garde-fou contre le double envoi (pas contre le débit).
    try {
      // `groupId` = l'espace : le plafond de concurrence par espace de la file s'applique aussi au lancement
      // manuel, sinon un client qui clique quatre fois occupe les quatre places.
      await deps.queue.enqueue('campaign-run', { campaignId }, { ...(expireInSeconds ? { expireInSeconds } : {}), groupId: authTenant });
    } catch (err) {
      // L'enfilement a échoué après la levée de pause : on la rétablit, sinon la campagne resterait « en cours »
      // sans job, et « Reprendre » ne s'afficherait pas. `pauseCampaign` est bornée à `running` (pas un brouillon).
      await deps.repo.pauseCampaign(campaignId, authTenant);
      throw err;
    }
    return reply.code(202).send({ enqueued: true, campaignId });
  });

  /**
   * Renvoi d'un destinataire en échec de variable de template, après correction du contact : on re-résout le
   * paramMapping sur le contact à jour et on remet le destinataire à `pending` (même chemin d'envoi). Gardes :
   * famille de codes variables, statut `failed`, appartenance à l'espace. 422 si la variable manque toujours.
   */
  app.post('/campaigns/:campaignId/recipients/:recipientId/retry', opts, async (req, reply) => {
    const authTenant = req.auth?.tenantId ?? '';
    const { campaignId, recipientId } = req.params as { campaignId: string; recipientId: string };
    const r = await deps.repo.resetRecipientForRetry(authTenant, campaignId, recipientId);
    if (r.result === 'not_found') return reply.code(404).send({ error: 'destinataire inconnu' });
    if (r.result === 'not_retryable') return reply.code(409).send({ error: 'destinataire non renvoyable (pas un échec de variable de template)' });
    if (r.result === 'missing_var') return reply.code(422).send({ error: 'variable de template toujours manquante', missing: r.missing });
    if (r.result === 'conflict') return reply.code(409).send({ error: 'destinataire déjà repris' });
    // queued : enfile un run (le destinataire redevenu pending est renvoyé par runCampaign avec les valeurs corrigées).
    const expireInSeconds = await expirationDuRun(campaignId);
    // Même groupe que partout ailleurs : un renvoi de destinataire ne doit pas échapper au plafond par espace.
    await deps.queue.enqueue('campaign-run', { campaignId }, { ...(expireInSeconds ? { expireInSeconds } : {}), groupId: authTenant });
    return reply.code(202).send({ enqueued: true, recipientId });
  });

  /**
   * Suspend une campagne en cours d'envoi : l'arrêt d'urgence d'un mauvais ciblage. Ce qui est parti reste parti ;
   * le run en vol sort à sa prochaine relecture de statut, et les destinataires non traités restent `pending` pour
   * « Reprendre ». 404 « inconnue » et 409 « n'envoie pas » sont distincts : l'appartenance est contrôlée d'abord.
   */
  app.post('/tenants/:tenantId/campaigns/:campaignId/pause', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { campaignId } = req.params as { campaignId: string };
    if (!(await deps.repo.campaignBelongsTo(campaignId, tenant))) {
      return reply.code(404).send({ error: 'campagne inconnue' });
    }
    const ok = await deps.repo.pauseCampaign(campaignId, tenant);
    // 409 et pas 5xx : c'est un message destiné à l'opérateur (Cloudflare remplacerait le corps d'une 5xx).
    if (!ok) return reply.code(409).send({ error: "campagne non suspendable (elle n'est pas en cours d'envoi)" });
    return reply.code(200).send({ paused: true, campaignId });
  });

  // Annule une campagne programmée : elle repasse en brouillon (le job différé n'a jamais été enfilé, rien à tuer).
  app.post('/campaigns/:campaignId/cancel-schedule', opts, async (req, reply) => {
    const { campaignId } = req.params as { campaignId: string };
    const authTenant = req.auth?.tenantId ?? '';
    const ok = await deps.repo.cancelSchedule(campaignId, authTenant);
    if (!ok) return reply.code(404).send({ error: 'campagne non programmée' });
    return reply.code(200).send({ cancelled: true, campaignId });
  });

  /**
   * Arrêt d'une campagne au fil de l'eau, son seul point final : elle passe en `completed`, plus rien ne
   * l'alimente, son historique reste. 404 sur une campagne ordinaire ou déjà arrêtée.
   */
  app.post('/tenants/:tenantId/campaigns/:campaignId/stop', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { campaignId } = req.params as { campaignId: string };
    const ok = await deps.repo.stopWebhookCampaign(campaignId, tenant);
    if (!ok) return reply.code(404).send({ error: 'campagne non arrêtable' });
    return reply.code(200).send({ stopped: true, campaignId });
  });

  // Archivage : masque la campagne de la liste sans rien effacer. Les trois routes ci-dessous contrôlent
  // l'appartenance avant d'agir : seule façon de distinguer « pas à toi » (404) de « pas dans le bon état ».
  app.post('/tenants/:tenantId/campaigns/:campaignId/archive', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { campaignId } = req.params as { campaignId: string };
    if (!(await deps.repo.campaignBelongsTo(campaignId, tenant))) {
      return reply.code(404).send({ error: 'campagne inconnue' });
    }
    // Archiver une campagne déjà archivée n'est pas une erreur : l'état visé est atteint, on répond 200 sans
    // réécrire l'horodatage (la garde `archived_at is null` du store s'en charge).
    await deps.repo.archiveCampaign(campaignId, tenant);
    return reply.code(200).send({ archived: true, campaignId });
  });

  app.post('/tenants/:tenantId/campaigns/:campaignId/unarchive', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { campaignId } = req.params as { campaignId: string };
    if (!(await deps.repo.campaignBelongsTo(campaignId, tenant))) {
      return reply.code(404).send({ error: 'campagne inconnue' });
    }
    await deps.repo.unarchiveCampaign(campaignId, tenant);
    return reply.code(200).send({ archived: false, campaignId });
  });

  // 🔴 Suppression définitive, réservée aux campagnes qui n'ont jamais rien envoyé : une campagne partie porte
  // l'historique des analytics, elle s'archive. 409 quand la garde refuse, pour proposer l'archivage à la place.
  app.delete('/tenants/:tenantId/campaigns/:campaignId', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { campaignId } = req.params as { campaignId: string };
    if (!(await deps.repo.campaignBelongsTo(campaignId, tenant))) {
      return reply.code(404).send({ error: 'campagne inconnue' });
    }
    const deleted = await deps.repo.deleteDraftCampaign(campaignId, tenant);
    if (!deleted) {
      return reply.code(409).send({ error: 'campagne déjà lancée : elle ne peut être qu\'archivée' });
    }
    return reply.code(200).send({ deleted: true, campaignId });
  });
}
