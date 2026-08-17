import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Queue } from '../queue/queue';
import { createCampaignWithRecipients } from '../campaign/create';
import type { CampaignRepoLike } from '../campaign/create';
import type { CreateCampaignInput, CampaignSummary, CampaignDetail, PhoneNumberRow, RetryReset } from '../campaign/store.pg';
import type { CampaignCategory } from '../campaign/types';
import { validateParamMapping } from '../crm/template';
import { campaignJobExpireSeconds, resolveRatePerMinute } from '../campaign/pacing';
import { scanOpening } from '../workflow/engine';
import type { WorkflowGraph } from '../workflow/graph';
import { forbidNonAdmin } from '../auth/middleware';
import type { Guard } from '../auth/middleware';

/**
 * Message RCS accepté à la création d'une campagne. Union FERMÉE : un `kind` inconnu est refusé en 400, il ne
 * traverse jamais jusqu'au provider. Validé en `safeParse` (jamais `parse`), comme toute entrée non fiable.
 */
const rcsSuggestionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reply'), text: z.string().min(1).max(25), postbackData: z.string().min(1) }),
  z.object({ kind: z.literal('openUrl'), text: z.string().min(1).max(25), url: z.string().url(), postbackData: z.string().min(1) }),
  z.object({ kind: z.literal('dial'), text: z.string().min(1).max(25), phoneNumber: z.string().min(1), postbackData: z.string().min(1) }),
]);
const rcsCardSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  mediaUrl: z.string().url().optional(),
  suggestions: z.array(rcsSuggestionSchema).max(4).optional(),
});
const rcsOutboundSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(3072), suggestions: z.array(rcsSuggestionSchema).max(11).optional() }),
  z.object({ kind: z.literal('card'), card: rcsCardSchema }),
  z.object({ kind: z.literal('carousel'), cards: z.array(rcsCardSchema).min(2).max(10) }),
]);

export interface CampaignRouteDeps {
  repo: CampaignRepoLike;
  queue: Queue;
  /** Le numéro appartient-il au tenant ? (empêche d'envoyer depuis le numéro d'autrui.) */
  phoneNumberBelongsToTenant(phoneNumberId: string, tenantId: string): Promise<boolean>;
  /** L'agent RCS appartient-il au tenant ? Même garde que pour le numéro : sans elle, un tenant enverrait
   *  sous la marque d'un autre. Absente du câblage -> aucune campagne RCS ne peut être créée. */
  rcsAgentBelongsToTenant?(agentId: string, tenantId: string): Promise<boolean>;
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
  /** Renvoi d'un destinataire en échec de variable de template (F7) : re-résout sur le contact à jour + remet en
   *  pending. Résultat discriminé (queued/not_found/not_retryable/missing_var/conflict). */
  resetRecipientForRetry(tenantId: string, campaignId: string, recipientId: string): Promise<RetryReset>;
  listPhoneNumbers(tenantId: string): Promise<PhoneNumberRow[]>;
  /** Débit par défaut (msg/min, 0 = opt-out) des campagnes sans ratePerMinute. Doit être le MÊME que celui
   *  injecté au worker (config.CAMPAIGN_DEFAULT_RATE_PER_MINUTE), pour que l'estimation d'expiration et le
   *  throttle réel voient le même débit. Absent (tests) -> 0 = opt-out, comme avant ce défaut. */
  defaultRatePerMinute?: number;
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
      channel: string;
      rcsAgentId: string;
      rcsMessage: unknown;
    }>;

    if (!isCategory(b.category)) return reply.code(400).send({ error: 'category invalide (marketing|utility)' });

    // Canal. Absent = 'whatsapp' : un client qui ignore le canal garde le comportement historique. Un canal
    // INCONNU est refusé, jamais silencieusement ramené à WhatsApp (une campagne partie sur le mauvais canal
    // est irrattrapable).
    const channel = b.channel ?? 'whatsapp';
    if (channel !== 'whatsapp' && channel !== 'rcs') {
      return reply.code(400).send({ error: 'channel invalide (whatsapp|rcs)' });
    }
    const isRcs = channel === 'rcs';
    let rcsMessage: unknown;
    if (isRcs) {
      if (!nonEmpty(b.rcsAgentId)) return reply.code(400).send({ error: 'rcsAgentId requis pour une campagne RCS' });
      if (!deps.rcsAgentBelongsToTenant || !(await deps.rcsAgentBelongsToTenant(b.rcsAgentId as string, effectiveTenant))) {
        return reply.code(400).send({ error: 'rcsAgentId inconnu pour ce tenant' });
      }
      const parsed = rcsOutboundSchema.safeParse(b.rcsMessage);
      if (!parsed.success) return reply.code(400).send({ error: 'rcsMessage invalide' });
      rcsMessage = parsed.data;
      if (nonEmpty(b.workflowId)) {
        return reply.code(400).send({ error: "Une campagne RCS envoie un message direct. Le declenchement d'un scenario par campagne n'est pas disponible sur ce canal." });
      }
    }
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
    // Numéro Meta : exigé sur WhatsApp uniquement. Une campagne RCS part d'un agent, pas d'un numéro.
    if (!isRcs && !nonEmpty(b.phoneNumberId)) return reply.code(400).send({ error: 'phoneNumberId requis' });
    if (!nonEmpty(b.name)) return reply.code(400).send({ error: 'name requis' });
    // Une campagne envoie SOIT un template SOIT un workflow (exactement un des deux). Sur RCS, ni l'un ni
    // l'autre : le message est porté par la campagne elle-même.
    const isWorkflow = nonEmpty(b.workflowId);
    if (isWorkflow) {
      const graph = await deps.getWorkflowGraph(b.workflowId as string, effectiveTenant);
      if (!graph) {
        return reply.code(400).send({ error: 'workflowId inconnu pour ce tenant' });
      }
      // Une campagne part sur une audience FROIDE : le 1er message doit être un template. Ce n'est PAS la même
      // chose qu'« exiger un bloc template en entrée » : un tag, une action ou une condition avant le template
      // n'envoient rien et ne changent donc rien. On juge sur ce qui OUVRE réellement, pas sur le type du 1er bloc.
      const scan = scanOpening(graph);
      if (scan.sessionOpen) {
        return reply.code(400).send({ error: "Ce scénario ouvre par un message rapide ou un formulaire, qui exige que le contact ait écrit dans les 24 h. Une campagne part sur une audience froide : il lui faut un envoi de template en ouverture." });
      }
      if (scan.waitBeforeTemplate) {
        return reply.code(400).send({ error: "Ce scénario attend avant son premier envoi : rien ne partirait au lancement. Pour différer une campagne, utilise « Plus tard » au moment de la lancer." });
      }
      if (!scan.firstTemplate) {
        return reply.code(400).send({ error: 'Le scénario doit envoyer un template en ouverture.' });
      }
      if (scan.ambiguousTemplate) {
        return reply.code(400).send({ error: "Ce scénario peut ouvrir sur plusieurs templates différents : impossible de savoir lequel paramétrer pour la campagne." });
      }
      // `unnamedOpeningTemplate` couvre AUSSI les branches : une condition dont une sortie mène à un template
      // sans nom laisserait ces destinataires sans message, tout en les comptant « envoyés ».
      if (scan.unnamedOpeningTemplate || String(scan.firstTemplate.data.templateName ?? '').trim() === '') {
        return reply.code(400).send({ error: "Un template d'ouverture du scénario n'est pas encore choisi." });
      }
    } else if (!isRcs) {
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

    // Le numéro doit appartenir au tenant (sinon envoi depuis le numéro d'un autre client). Sur RCS, c'est
    // l'agent qui a été contrôlé plus haut, il n'y a pas de numéro à vérifier.
    if (!isRcs && !(await deps.phoneNumberBelongsToTenant(b.phoneNumberId as string, effectiveTenant))) {
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
    const expireInSeconds = sizing
      ? campaignJobExpireSeconds(sizing.pendingCount, resolveRatePerMinute(sizing.ratePerMinute, deps.defaultRatePerMinute ?? 0))
      : undefined;
    // singletonKey = campaignId : deux POST /run concurrents n'empilent pas deux jobs pour
    // la même campagne (le claim par destinataire est le garde-fou primaire, ceci le double).
    await deps.queue.enqueue('campaign-run', { campaignId }, { singletonKey: campaignId, ...(expireInSeconds ? { expireInSeconds } : {}) });
    return reply.code(202).send({ enqueued: true, campaignId });
  });

  /**
   * Renvoi d'UN destinataire en échec de variable de template (F7). Après que l'admin a corrigé la donnée du contact,
   * on re-résout le paramMapping sur le contact À JOUR et on remet le destinataire à `pending` (réutilise runCampaign,
   * pas de nouveau chemin d'envoi). Gardes : famille de codes variables, statut `failed`, appartenance tenant. 422 si la
   * variable est TOUJOURS manquante (on ne renvoie pas le même échec). Admin-only, tenant du JWT.
   */
  app.post('/campaigns/:campaignId/recipients/:recipientId/retry', guard, async (req, reply) => {
    if (forbidNonAdmin(req, reply)) return;
    const authTenant = req.auth?.tenantId ?? '';
    const { campaignId, recipientId } = req.params as { campaignId: string; recipientId: string };
    const r = await deps.resetRecipientForRetry(authTenant, campaignId, recipientId);
    if (r.result === 'not_found') return reply.code(404).send({ error: 'destinataire inconnu' });
    if (r.result === 'not_retryable') return reply.code(409).send({ error: 'destinataire non renvoyable (pas un échec de variable de template)' });
    if (r.result === 'missing_var') return reply.code(422).send({ error: 'variable de template toujours manquante', missing: r.missing });
    if (r.result === 'conflict') return reply.code(409).send({ error: 'destinataire déjà repris' });
    // queued : enfile un run (le destinataire redevenu pending est renvoyé par runCampaign avec les valeurs corrigées).
    const sizing = await deps.getRunSizing(campaignId);
    const expireInSeconds = sizing
      ? campaignJobExpireSeconds(sizing.pendingCount, resolveRatePerMinute(sizing.ratePerMinute, deps.defaultRatePerMinute ?? 0))
      : undefined;
    await deps.queue.enqueue('campaign-run', { campaignId }, { singletonKey: campaignId, ...(expireInSeconds ? { expireInSeconds } : {}) });
    return reply.code(202).send({ enqueued: true, recipientId });
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
