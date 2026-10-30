import type { FastifyInstance } from 'fastify';
import type { Queue } from '../queue/queue';
import { createCampaignWithRecipients } from '../campaign/create';
import { avertissementPalier } from '../meta/palier';
import type { CampaignRepoLike } from '../campaign/create';
import type { CampaignSummary, CampaignDetail, PhoneNumberRow, RetryReset } from '../campaign/store.pg';
import { expirationDuRun, lancerCampagne } from '../campaign/lancement';
import type { WorkflowGraph } from '../workflow/graph';
import { gardeEtendue } from '../auth/middleware';
import type { Guard, PreHandler } from '../auth/middleware';
import { espaceVerifie, nonEmpty } from './scope';
import { preparerCampagne } from './preparation-campagne';
import type { BulkTarget } from '../crm/contact-store.pg';
import { LimiteOffreError, STATUT_REFUS_OFFRE, corpsRefusLimite } from '../offres/refus';
import type { SourceOffres } from '../offres/offre.pg';
import type { AgentStore } from '../agent/agent-store';

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
  /**
   * 🔴 Les agents IA de l'espace (le magasin entier, `byId` scopée `tenant_id = $1`) : l'agent qu'un étage désigne comme
   * répondeur (migration 0263) doit être un agent ACTIF de CET espace, et la clé étrangère ne scope pas l'espace.
   * Même garde que `rcs.belongsToTenant` et `getWorkflowGraph`, sur la quatrième chose qu'un étage peut nommer.
   */
  agents: Pick<AgentStore, 'byId'>;
  /**
   * L'offre de l'espace (lot 6, B2a) : sans `scenarios`, une campagne (ou un étage) qui démarre un scénario est refusée
   * à la création (402) ; sinon elle partirait, et chaque destinataire finirait « Scénario non démarré ».
   */
  offres: SourceOffres;
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

/** Routes de campagne : lecture (liste/détail/numéros), création et déclenchement du run. */
export function registerCampaigns(app: FastifyInstance, deps: CampaignRouteDeps, garde: Guard, limiteCouteuse?: PreHandler): void {
  const opts = { preHandler: garde };
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

    const prepared = await preparerCampagne(req.body, effectiveTenant, deps);
    if (!prepared.ok) return reply.code(prepared.status).send(prepared.body);

    const result = await createCampaignWithRecipients(prepared.input, deps.repo);
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
    // « Plus tard » : un scheduledAt (ISO absolu UTC) programme au lieu de lancer ; le sweeper enfilera le run à
    // l'échéance. Le corps se lit d'abord : un scheduledAt mal formé est une erreur de l'appelant (400), quelle que soit
    // la campagne visée. Le reste, appartenance comprise, est `lancerCampagne`, que l'assistant appelle aussi.
    const b = (req.body ?? {}) as { scheduledAt?: unknown };
    let quand: Date | null = null;
    if (b.scheduledAt !== undefined && b.scheduledAt !== null) {
      if (typeof b.scheduledAt !== 'string') return reply.code(400).send({ error: 'scheduledAt invalide (ISO)' });
      quand = new Date(b.scheduledAt);
      if (Number.isNaN(quand.getTime())) return reply.code(400).send({ error: 'scheduledAt invalide (date)' });
    }
    const issue = await lancerCampagne(deps, authTenant, campaignId, quand);
    if (issue.ok) {
      return 'programmee' in issue
        ? reply.code(202).send({ scheduled: true, campaignId, scheduledAt: issue.programmee.toISOString() })
        : reply.code(202).send({ enqueued: true, campaignId });
    }
    switch (issue.raison) {
      // 🔴 Scope espace : 404 si la campagne n'appartient pas à l'appelant (pas d'IDOR entre espaces).
      case 'inconnue': return reply.code(404).send({ error: 'campagne inconnue' });
      case 'date_passee': return reply.code(400).send({ error: 'scheduledAt doit être dans le futur' });
      case 'non_programmable': return reply.code(409).send({ error: 'campagne non programmable (déjà en cours/terminée)' });
      case 'limite': {
        const refus = corpsRefusLimite(new LimiteOffreError(authTenant, 'envoisModelesMois', issue.max));
        return reply.code(STATUT_REFUS_OFFRE).send({ ...refus, reste: issue.reste, demandes: issue.demandes });
      }
    }
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
    const expireInSeconds = await expirationDuRun(deps, campaignId);
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
