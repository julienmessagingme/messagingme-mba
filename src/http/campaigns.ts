import type { FastifyInstance } from 'fastify';
import type { Queue } from '../queue/queue';
import { createCampaignWithRecipients } from '../campaign/create';
import type { CampaignRepoLike } from '../campaign/create';
import type { CreateCampaignInput, CampaignSummary, CampaignDetail, PhoneNumberRow } from '../campaign/store.pg';
import type { CampaignCategory } from '../campaign/types';
import { validateParamMapping } from '../crm/template';
import { campaignJobExpireSeconds } from '../campaign/pacing';
import { entryNode } from '../workflow/engine';
import type { WorkflowGraph } from '../workflow/graph';
import { forbidNonAdmin } from '../auth/middleware';
import type { Guard } from '../auth/middleware';

export interface CampaignRouteDeps {
  repo: CampaignRepoLike;
  queue: Queue;
  /** Le numéro appartient-il au tenant ? (empêche d'envoyer depuis le numéro d'autrui.) */
  phoneNumberBelongsToTenant(phoneNumberId: string, tenantId: string): Promise<boolean>;
  /** La campagne appartient-elle au tenant ? (scope le run, 404 sinon.) */
  campaignBelongsTo(campaignId: string, tenantId: string): Promise<boolean>;
  /** Dimensionnement du job de run : débit choisi + nb de destinataires en attente. null si campagne absente.
   *  Sert à calculer l'expireInSeconds du job (éviter qu'un run throttlé long expire et soit rejoué en parallèle). */
  getRunSizing(campaignId: string): Promise<{ ratePerMinute: number | null; pendingCount: number } | null>;
  /** Programme une campagne (draft/paused) pour un lancement futur (scopé tenant). true si programmée. */
  scheduleCampaign(campaignId: string, tenantId: string, scheduledAt: Date): Promise<boolean>;
  /** Annule une programmation (scopé tenant) : la campagne repasse en brouillon. true si annulée. */
  cancelSchedule(campaignId: string, tenantId: string): Promise<boolean>;
  /**
   * Graphe du workflow du tenant (campagne workflow). null si inconnu/autre tenant (le scope tenant vaut le
   * contrôle de propriété : un workflow d'un autre tenant renvoie null -> 400). Sert aussi à vérifier que le
   * bloc d'entrée est bien un envoi de template.
   */
  getWorkflowGraph(workflowId: string, tenantId: string): Promise<WorkflowGraph | null>;
  listCampaigns(tenantId: string, opts?: { archived?: boolean }): Promise<CampaignSummary[]>;
  /** Archive une campagne (scopée tenant) : masquée de la liste, conservée en base. true si elle était active. */
  archiveCampaign(campaignId: string, tenantId: string): Promise<boolean>;
  /** Sort une campagne de l'archive (scopée tenant). true si elle y était. */
  unarchiveCampaign(campaignId: string, tenantId: string): Promise<boolean>;
  /** Supprime pour de bon une campagne JAMAIS lancée (scopée tenant). false si la garde métier refuse. */
  deleteDraftCampaign(campaignId: string, tenantId: string): Promise<boolean>;
  getCampaignDetail(campaignId: string, tenantId: string): Promise<CampaignDetail | null>;
  listPhoneNumbers(tenantId: string): Promise<PhoneNumberRow[]>;
}

const CATEGORIES = new Set<CampaignCategory>(['marketing', 'utility']);

function isCategory(v: unknown): v is CampaignCategory {
  return typeof v === 'string' && CATEGORIES.has(v as CampaignCategory);
}
function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/** Tenant effectif = celui du JWT ; l'URL doit correspondre. null si interdit. */
function scopeTenant(req: { params: unknown; auth?: { tenantId: string } }): string | null {
  const { tenantId } = req.params as { tenantId: string };
  const authTenant = req.auth?.tenantId;
  if (authTenant !== undefined && authTenant !== tenantId) return null;
  return authTenant ?? tenantId;
}

/** Routes de campagne : lecture (liste/détail/numéros), création et déclenchement du run. */
export function registerCampaigns(app: FastifyInstance, deps: CampaignRouteDeps, requireAuth?: Guard): void {
  const guard = requireAuth ? { preHandler: requireAuth } : {};

  app.get('/tenants/:tenantId/campaigns', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    // `?archived=1` bascule sur la corbeille. Valeur venue de la query string, donc `unknown` : on n'accepte
    // QUE les deux formes explicites, tout le reste (y compris 'false', '0', 'oui') vaut « campagnes actives ».
    const q = (req.query ?? {}) as { archived?: unknown };
    const archived = q.archived === '1' || q.archived === 'true';
    return reply.code(200).send({ campaigns: await deps.listCampaigns(tenant, { archived }) });
  });

  app.get('/tenants/:tenantId/campaigns/:campaignId', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { campaignId } = req.params as { campaignId: string };
    const detail = await deps.getCampaignDetail(campaignId, tenant);
    if (!detail) return reply.code(404).send({ error: 'campagne inconnue' });
    return reply.code(200).send(detail);
  });

  app.get('/tenants/:tenantId/phone-numbers', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    return reply.code(200).send({ phoneNumbers: await deps.listPhoneNumbers(tenant) });
  });

  app.post('/tenants/:tenantId/campaigns', guard, async (req, reply) => {
    const effectiveTenant = scopeTenant(req);
    if (effectiveTenant === null) {
      return reply.code(403).send({ error: 'tenant interdit' });
    }
    if (forbidNonAdmin(req, reply)) return;

    const b = (req.body ?? {}) as Partial<{
      phoneNumberId: string;
      name: string;
      category: CampaignCategory;
      templateName: string;
      templateLanguage: string;
      paramMapping: unknown;
      contactIds: unknown;
      workflowId: string;
      ratePerMinute: unknown;
    }>;

    if (!isCategory(b.category)) return reply.code(400).send({ error: 'category invalide (marketing|utility)' });
    // Débit optionnel : entier 1..80 messages/min (le client ne peut que BAISSER sous le plafond métier).
    // Absent/null = aucun throttle. Rejette 0, 81, décimal, négatif -> 400 déterministe.
    let ratePerMinute: number | null | undefined;
    if (b.ratePerMinute !== undefined && b.ratePerMinute !== null) {
      const r = b.ratePerMinute;
      if (typeof r !== 'number' || !Number.isInteger(r) || r < 1 || r > 80) {
        return reply.code(400).send({ error: 'ratePerMinute invalide (entier 1..80 ou null)' });
      }
      ratePerMinute = r;
    }
    if (!nonEmpty(b.phoneNumberId)) return reply.code(400).send({ error: 'phoneNumberId requis' });
    if (!nonEmpty(b.name)) return reply.code(400).send({ error: 'name requis' });
    // Une campagne envoie SOIT un template SOIT un workflow (exactement un des deux).
    const isWorkflow = nonEmpty(b.workflowId);
    if (isWorkflow) {
      const graph = await deps.getWorkflowGraph(b.workflowId as string, effectiveTenant);
      if (!graph) {
        return reply.code(400).send({ error: 'workflowId inconnu pour ce tenant' });
      }
      // Le 1er bloc (entrée) DOIT être un envoi de template : c'est lui qui porte les variables mappées à la
      // campagne. Sinon le mapping n'a pas de cible et l'envoi partirait sans être personnalisé -> on bloque.
      const entryId = entryNode(graph);
      const entry = entryId ? graph.nodes.find((n) => n.id === entryId) : undefined;
      if (!entry || entry.type !== 'template') {
        return reply.code(400).send({ error: 'Le workflow doit commencer par un envoi de template.' });
      }
    } else {
      if (!nonEmpty(b.templateName)) return reply.code(400).send({ error: 'templateName ou workflowId requis' });
      if (!nonEmpty(b.templateLanguage)) return reply.code(400).send({ error: 'templateLanguage requis' });
    }

    // Sélection de contacts optionnelle : tableau de chaînes non vides. Absent -> tous les contacts.
    let contactIds: string[] | undefined;
    if (b.contactIds !== undefined) {
      if (!Array.isArray(b.contactIds) || !b.contactIds.every((x) => nonEmpty(x))) {
        return reply.code(400).send({ error: 'contactIds invalide (tableau d\'ids)' });
      }
      contactIds = b.contactIds as string[];
    }

    // Le numéro doit appartenir au tenant (sinon envoi depuis le numéro d'un autre client).
    if (!(await deps.phoneNumberBelongsToTenant(b.phoneNumberId, effectiveTenant))) {
      return reply.code(400).send({ error: 'phoneNumberId inconnu pour ce tenant' });
    }

    // Valider paramMapping AVANT toute écriture. Pour un workflow AUSSI : le mapping cible les variables du 1er
    // template du workflow (résolues par contact -> pré-validation via buildRecipients, contacts sans la valeur
    // sautés). Invalide -> 400 déterministe (indépendant du nb de contacts), pas un 500.
    const paramMapping = validateParamMapping(b.paramMapping ?? []);
    if (paramMapping === null) {
      return reply.code(400).send({ error: 'paramMapping invalide (positions 1..N contiguës, sources valides)' });
    }

    const input: CreateCampaignInput = {
      tenantId: effectiveTenant,
      phoneNumberId: b.phoneNumberId,
      name: b.name,
      category: b.category,
      templateName: isWorkflow ? '' : (b.templateName as string),
      templateLanguage: isWorkflow ? '' : (b.templateLanguage as string),
      paramMapping,
      ...(contactIds ? { contactIds } : {}),
      ...(isWorkflow ? { workflowId: b.workflowId as string } : {}),
      ...(ratePerMinute !== undefined ? { ratePerMinute } : {}),
    };
    const result = await createCampaignWithRecipients(input, deps.repo);
    return reply.code(201).send(result);
  });

  app.post('/campaigns/:campaignId/run', guard, async (req, reply) => {
    if (forbidNonAdmin(req, reply)) return;
    const { campaignId } = req.params as { campaignId: string };
    const authTenant = req.auth?.tenantId ?? '';
    // Scope tenant : 404 si la campagne n'appartient pas à l'appelant (pas d'IDOR cross-tenant).
    if (!(await deps.campaignBelongsTo(campaignId, authTenant))) {
      return reply.code(404).send({ error: 'campagne inconnue' });
    }

    // ÉTAPE 2 « plus tard » : un scheduledAt (ISO absolu UTC) programme au lieu de lancer tout de suite. Le
    // sweeper enfilera le run à l'échéance. Doit être une date FUTURE (une date passée = 400, pas un lancement
    // immédiat déguisé). La campagne passe en statut 'scheduled' (annulable via /cancel-schedule).
    const b = (req.body ?? {}) as { scheduledAt?: unknown };
    if (b.scheduledAt !== undefined && b.scheduledAt !== null) {
      if (typeof b.scheduledAt !== 'string') return reply.code(400).send({ error: 'scheduledAt invalide (ISO)' });
      const when = new Date(b.scheduledAt);
      if (Number.isNaN(when.getTime())) return reply.code(400).send({ error: 'scheduledAt invalide (date)' });
      if (when.getTime() <= Date.now()) return reply.code(400).send({ error: 'scheduledAt doit être dans le futur' });
      const ok = await deps.scheduleCampaign(campaignId, authTenant, when);
      if (!ok) return reply.code(409).send({ error: 'campagne non programmable (déjà en cours/terminée)' });
      return reply.code(202).send({ scheduled: true, campaignId, scheduledAt: when.toISOString() });
    }

    // Lancement IMMÉDIAT. Dimensionne l'expiration du job sur le travail réel (nb destinataires en attente /
    // débit choisi) : un run throttlé long ne doit pas expirer et être rejoué en parallèle. Absent -> défaut file.
    const sizing = await deps.getRunSizing(campaignId);
    const expireInSeconds = sizing ? campaignJobExpireSeconds(sizing.pendingCount, sizing.ratePerMinute) : undefined;
    // singletonKey = campaignId : deux POST /run concurrents n'empilent pas deux jobs pour
    // la même campagne (le claim par destinataire est le garde-fou primaire, ceci le double).
    await deps.queue.enqueue('campaign-run', { campaignId }, { singletonKey: campaignId, ...(expireInSeconds ? { expireInSeconds } : {}) });
    return reply.code(202).send({ enqueued: true, campaignId });
  });

  // Annule une campagne programmée : elle repasse en brouillon (le job différé n'a jamais été enfilé, rien à tuer).
  app.post('/campaigns/:campaignId/cancel-schedule', guard, async (req, reply) => {
    if (forbidNonAdmin(req, reply)) return;
    const { campaignId } = req.params as { campaignId: string };
    const authTenant = req.auth?.tenantId ?? '';
    const ok = await deps.cancelSchedule(campaignId, authTenant);
    if (!ok) return reply.code(404).send({ error: 'campagne non programmée' });
    return reply.code(200).send({ cancelled: true, campaignId });
  });

  // Archivage : masque la campagne de la liste sans rien effacer. Les trois routes ci-dessous contrôlent
  // l'appartenance AVANT d'agir, ce qui est la seule façon de distinguer honnêtement « pas à toi » (404) de
  // « pas dans le bon état » (200 idempotent pour l'archive, 409 pour la suppression).
  app.post('/tenants/:tenantId/campaigns/:campaignId/archive', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const { campaignId } = req.params as { campaignId: string };
    if (!(await deps.campaignBelongsTo(campaignId, tenant))) {
      return reply.code(404).send({ error: 'campagne inconnue' });
    }
    // Archiver une campagne déjà archivée n'est pas une erreur : l'état visé est atteint, on répond 200 sans
    // réécrire l'horodatage (la garde `archived_at is null` du store s'en charge).
    await deps.archiveCampaign(campaignId, tenant);
    return reply.code(200).send({ archived: true, campaignId });
  });

  app.post('/tenants/:tenantId/campaigns/:campaignId/unarchive', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const { campaignId } = req.params as { campaignId: string };
    if (!(await deps.campaignBelongsTo(campaignId, tenant))) {
      return reply.code(404).send({ error: 'campagne inconnue' });
    }
    await deps.unarchiveCampaign(campaignId, tenant);
    return reply.code(200).send({ archived: false, campaignId });
  });

  // Suppression DÉFINITIVE, réservée aux campagnes qui n'ont jamais rien envoyé. Une campagne partie porte
  // l'historique qui alimente les analytics : elle s'archive, elle ne s'efface pas. 409 (et non 404) quand la
  // garde refuse, pour que l'interface puisse proposer l'archivage à la place.
  app.delete('/tenants/:tenantId/campaigns/:campaignId', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const { campaignId } = req.params as { campaignId: string };
    if (!(await deps.campaignBelongsTo(campaignId, tenant))) {
      return reply.code(404).send({ error: 'campagne inconnue' });
    }
    const deleted = await deps.deleteDraftCampaign(campaignId, tenant);
    if (!deleted) {
      return reply.code(409).send({ error: 'campagne déjà lancée : elle ne peut être qu\'archivée' });
    }
    return reply.code(200).send({ deleted: true, campaignId });
  });
}
