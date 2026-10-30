import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { espaceVerifie } from './scope';
import { preparerConfigurationWebhook } from '../webhook-entrant/configuration';
import type {
  IssueCreationWebhook, IssueModificationWebhook, IssueSuppressionWebhook, WebhookInput, WebhookRow,
} from '../webhook-entrant/modele';
import { makeJournal, type AuditSink } from '../audit/journal';

/**
 * Gestion des webhooks entrants (écran Tools > Webhooks), admin : une URL de webhook est un pouvoir d'écriture
 * sur le CRM et, avec un scénario attaché, un pouvoir d'envoi. La route publique qui reçoit les appels vit dans
 * `webhook-entrant.ts`, montée séparément.
 */

export interface WebhooksDep {
  list(tenantId: string): Promise<WebhookRow[]>;
  get(tenantId: string, id: string): Promise<WebhookRow | null>;
  create(tenantId: string, input: WebhookInput): Promise<IssueCreationWebhook>;
  update(tenantId: string, id: string, input: WebhookInput): Promise<IssueModificationWebhook>;
  remove(tenantId: string, id: string): Promise<IssueSuppressionWebhook>;
  /** Renvoie le secret en clair, une seule fois. null = webhook inconnu. */
  rotateSecret(tenantId: string, id: string): Promise<string | null>;
  clearSecret(tenantId: string, id: string): Promise<boolean>;
  forgetPayload(tenantId: string, id: string): Promise<boolean>;
}

export interface WebhooksAdminRouteDeps {
  /**
   * Journal d'audit (les fixtures qui ne l'observent pas passent `journalMuet`). Un webhook est une porte d'entrée :
   * ce qu'un tiers y envoie devient des contacts, et savoir qui l'a ouverte répond aux contacts inattendus.
   * 🔴 Le `detail` ne porte ni le code de l'adresse (ce qui la rend devinable) ni le secret (ce qui l'authentifie).
   */
  audit: AuditSink;
  webhooks: WebhooksDep;
  /** Base publique des URLs (`config.APP_URL`) : l'écran affiche l'URL complète à coller chez le tiers. */
  baseUrl: string;
}

/**
 * L'URL publique complète à donner au tiers. `baseUrl` porte la base entière, préfixe du proxy compris quand il y
 * en a un (`adressesPubliques`) : l'écrire ici donnerait une adresse morte le jour où l'API répond sous son nom.
 */
function urlPublique(baseUrl: string, code: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/w/${code}`;
}

export function registerWebhooksAdmin(app: FastifyInstance, deps: WebhooksAdminRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };
  const journal = makeJournal(deps.audit);
  const avecUrl = (w: WebhookRow): WebhookRow & { url: string } => ({ ...w, url: urlPublique(deps.baseUrl, w.code) });

  app.get('/tenants/:tenantId/webhooks', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    return reply.code(200).send({ webhooks: (await deps.webhooks.list(tenant)).map(avecUrl) });
  });

  app.get('/tenants/:tenantId/webhooks/:id', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { id } = req.params as { id: string };
    const w = await deps.webhooks.get(tenant, id);
    if (!w) return reply.code(404).send({ error: 'webhook inconnu' });
    return reply.code(200).send({ webhook: avecUrl(w) });
  });

  app.post('/tenants/:tenantId/webhooks', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const parsed = preparerConfigurationWebhook({ saisie: req.body, actuel: null });
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const issue = await deps.webhooks.create(tenant, parsed.input);
    if (issue.kind === 'scenario_inconnu') return reply.code(400).send({ error: 'workflowId inconnu pour ce tenant' });
    const { id, code } = issue;
    // Ni `code` ni l'URL : le code est le secret de cette adresse. L'identifiant interne suffit à la retrouver.
    await journal(tenant, req, 'webhook.cree', { kind: 'webhook', id }, { workflowId: parsed.input.workflowId });
    return reply.code(201).send({ id, code, url: urlPublique(deps.baseUrl, code), ...parsed.input });
  });

  app.patch('/tenants/:tenantId/webhooks/:id', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { id } = req.params as { id: string };
    // Relecture systématique : le mapping se valide contre le dernier payload reçu, et le corps est partiel
    // alors que le store écrit un état complet.
    const actuel = await deps.webhooks.get(tenant, id);
    if (!actuel) return reply.code(404).send({ error: 'webhook inconnu' });
    const parsed = preparerConfigurationWebhook({ saisie: req.body, actuel });
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const issue = await deps.webhooks.update(tenant, id, parsed.input);
    if (issue.kind === 'introuvable') return reply.code(404).send({ error: 'webhook inconnu' });
    if (issue.kind === 'scenario_inconnu') return reply.code(400).send({ error: 'workflowId inconnu pour ce tenant' });
    await journal(tenant, req, 'webhook.modifie', { kind: 'webhook', id }, { workflowId: parsed.input.workflowId });
    return reply.code(200).send({ id, ...parsed.input });
  });

  app.delete('/tenants/:tenantId/webhooks/:id', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { id } = req.params as { id: string };
    const issue = await deps.webhooks.remove(tenant, id);
    if (issue.kind === 'introuvable') return reply.code(404).send({ error: 'webhook inconnu' });
    if (issue.kind === 'campagne_vivante') {
      return reply.code(409).send({ error: `La campagne « ${issue.campagne} » se nourrit de ce webhook. Arrête-la avant de supprimer l'adresse.` });
    }
    await journal(tenant, req, 'webhook.supprime', { kind: 'webhook', id });
    return reply.code(204).send();
  });

  /** Pose un secret neuf. Le clair n'est rendu qu'ici, une seule fois, comme une clé d'API. */
  app.post('/tenants/:tenantId/webhooks/:id/secret', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { id } = req.params as { id: string };
    const secret = await deps.webhooks.rotateSecret(tenant, id);
    if (secret === null) return reply.code(404).send({ error: 'webhook inconnu' });
    // `pose` distingue la pose du retrait sans inventer deux actions.
    await journal(tenant, req, 'webhook.secret_change', { kind: 'webhook', id }, { pose: true });
    return reply.code(201).send({ secret, entete: 'X-Webhook-Secret' });
  });

  app.delete('/tenants/:tenantId/webhooks/:id/secret', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { id } = req.params as { id: string };
    const ok = await deps.webhooks.clearSecret(tenant, id);
    if (!ok) return reply.code(404).send({ error: 'webhook inconnu' });
    await journal(tenant, req, 'webhook.secret_change', { kind: 'webhook', id }, { pose: false });
    return reply.code(204).send();
  });

  /** « Oublier ce payload » : le JSON d'un tiers peut porter des données personnelles qu'on n'a pas demandées. */
  app.delete('/tenants/:tenantId/webhooks/:id/payload', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { id } = req.params as { id: string };
    const ok = await deps.webhooks.forgetPayload(tenant, id);
    if (!ok) return reply.code(404).send({ error: 'webhook inconnu' });
    return reply.code(204).send();
  });
}
