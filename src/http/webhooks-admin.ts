import type { FastifyInstance } from 'fastify';
import { forbidNonAdmin } from '../auth/middleware';
import type { Guard } from '../auth/middleware';
import { scopeTenant, nonEmpty } from './scope';
import { cheminValide, litChemin, estScalaire } from '../webhook-entrant/chemin';
import { cibleValide, MAX_REGLES } from '../webhook-entrant/mapping';
import type { RegleMapping } from '../webhook-entrant/mapping';
import type { WebhookRow, WebhookInput } from '../webhook-entrant/store.pg';

/**
 * Gestion des webhooks entrants (écran Tools > Webhooks). ADMIN ONLY : une URL de webhook est un pouvoir
 * d'écriture sur le CRM et, quand un scénario y est attaché, un pouvoir d'envoi. Le tenant vient du JWT.
 *
 * La route publique qui REÇOIT les appels vit ailleurs (`http/webhook-entrant.ts`) et n'a aucune
 * authentification : ce sont deux surfaces distinctes, montées séparément.
 */

/** Même borne que l'anti-rebond d'une automation : au-delà de 7 jours, ce n'est plus un anti-rebond. */
const MAX_COOLDOWN = 7 * 24 * 3600;

export interface WebhooksAdminRouteDeps {
  list(tenantId: string): Promise<WebhookRow[]>;
  get(tenantId: string, id: string): Promise<WebhookRow | null>;
  create(tenantId: string, input: WebhookInput): Promise<{ id: string; code: string }>;
  update(tenantId: string, id: string, input: WebhookInput): Promise<boolean>;
  remove(tenantId: string, id: string): Promise<boolean>;
  /** Renvoie le secret EN CLAIR, une seule fois. null = webhook inconnu. */
  rotateSecret(tenantId: string, id: string): Promise<string | null>;
  clearSecret(tenantId: string, id: string): Promise<boolean>;
  forgetPayload(tenantId: string, id: string): Promise<boolean>;
  /** Le scénario ciblé appartient-il bien à ce tenant ? Même garde que la campagne et l'automation. */
  workflowBelongsToTenant(workflowId: string, tenantId: string): Promise<boolean>;
  /** Base publique des URLs (`config.APP_URL`) : l'écran affiche l'URL complète à coller chez le tiers. */
  baseUrl: string;
}

/**
 * Valide le mapping. Le `payload` est le dernier appel reçu, quand il existe : c'est ce qui permet de refuser
 * À LA CONFIGURATION un chemin qui vise un objet ou un tableau.
 *
 * 🔴 Pourquoi ce refus. Les valeurs de champ sont stockées en chaîne, et `contactVars` transforme en `null`
 * toute valeur non primitive : un objet écrit dans un champ rendrait la variable VIDE dans un template, sans
 * la moindre erreur. Le seul moment où l'utilisateur peut comprendre le problème, c'est maintenant.
 *
 * Un chemin qui ne résout PAS est en revanche accepté : un tiers n'envoie pas toujours ses champs
 * facultatifs, et le dernier payload n'est qu'un échantillon.
 */
function validerMapping(brut: unknown, payload: unknown): { error: string } | { mapping: RegleMapping[] } {
  if (brut === undefined) return { mapping: [] };
  if (!Array.isArray(brut)) return { error: 'mapping invalide (tableau)' };
  if (brut.length > MAX_REGLES) return { error: `mapping trop long (${MAX_REGLES} règles au maximum)` };

  const mapping: RegleMapping[] = [];
  for (const item of brut) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { error: 'chaque règle est un objet { chemin, cible }' };
    const r = item as { chemin?: unknown; cible?: unknown };
    if (typeof r.chemin !== 'string' || !cheminValide(r.chemin)) {
      return { error: `chemin invalide : ${typeof r.chemin === 'string' ? r.chemin.slice(0, 80) : 'absent'}` };
    }
    if (!cibleValide(r.cible)) return { error: `destination invalide pour « ${r.chemin.slice(0, 80)} »` };
    const chemin = r.chemin.trim();
    if (payload !== null && payload !== undefined) {
      const valeur = litChemin(payload, chemin);
      if (valeur !== undefined && !estScalaire(valeur)) {
        return { error: `« ${chemin.slice(0, 80)} » désigne un ensemble, pas une valeur : pointez un élément précis (par exemple ${chemin.slice(0, 60)}[0])` };
      }
    }
    mapping.push({ chemin, cible: (r.cible as string).trim() });
  }
  return { mapping };
}

/** Corps commun création/modification, fusionné avec l'existant (le store écrit un état complet). */
function parseBody(body: unknown, actuel: WebhookRow | null, payload: unknown): { error: string } | { input: WebhookInput } {
  const b = (body ?? {}) as Record<string, unknown>;

  let name = actuel?.name ?? '';
  if (b.name !== undefined || actuel === null) {
    if (!nonEmpty(b.name)) return { error: 'name requis' };
    name = b.name.trim().slice(0, 120);
  }

  let enabled = actuel?.enabled ?? true;
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') return { error: 'enabled (booléen)' };
    enabled = b.enabled;
  }

  let createContact = actuel?.createContact ?? true;
  if (b.createContact !== undefined) {
    if (typeof b.createContact !== 'boolean') return { error: 'createContact (booléen)' };
    createContact = b.createContact;
  }

  let mapping = actuel?.mapping ?? [];
  if (b.mapping !== undefined) {
    const m = validerMapping(b.mapping, payload);
    if ('error' in m) return m;
    mapping = m.mapping;
  }

  let workflowId = actuel?.workflowId ?? null;
  if (b.workflowId !== undefined) {
    if (b.workflowId !== null && !nonEmpty(b.workflowId)) return { error: 'workflowId invalide (chaîne ou null)' };
    workflowId = b.workflowId === null ? null : (b.workflowId as string);
  }

  let startNodeId = actuel?.startNodeId ?? null;
  if (b.startNodeId !== undefined) {
    if (b.startNodeId !== null && !nonEmpty(b.startNodeId)) return { error: 'startNodeId invalide (chaîne ou null)' };
    startNodeId = b.startNodeId === null ? null : (b.startNodeId as string);
  }

  let cooldownSeconds = actuel?.cooldownSeconds ?? null;
  if (b.cooldownSeconds !== undefined) {
    const c = b.cooldownSeconds;
    if (c !== null && (typeof c !== 'number' || !Number.isInteger(c) || c < 0 || c > MAX_COOLDOWN)) {
      return { error: `cooldownSeconds invalide (entier 0..${MAX_COOLDOWN}, ou null pour le défaut)` };
    }
    cooldownSeconds = c as number | null;
  }

  // Un bloc de départ sans scénario ne veut rien dire : le laisser passer produirait une configuration qui
  // s'affiche mais ne fait rien.
  if (workflowId === null && startNodeId !== null) {
    return { error: 'startNodeId n’a de sens qu’avec un scénario' };
  }

  return { input: { name, enabled, mapping, createContact, workflowId, startNodeId, cooldownSeconds } };
}

/** URL publique complète à coller chez le tiers. */
function urlPublique(baseUrl: string, code: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/backend/w/${code}`;
}

export function registerWebhooksAdmin(app: FastifyInstance, deps: WebhooksAdminRouteDeps, guard?: Guard): void {
  const opts = guard ? { preHandler: guard } : {};
  const avecUrl = (w: WebhookRow): WebhookRow & { url: string } => ({ ...w, url: urlPublique(deps.baseUrl, w.code) });

  app.get('/tenants/:tenantId/webhooks', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    return reply.code(200).send({ webhooks: (await deps.list(tenant)).map(avecUrl) });
  });

  app.get('/tenants/:tenantId/webhooks/:id', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const w = await deps.get(tenant, id);
    if (!w) return reply.code(404).send({ error: 'webhook inconnu' });
    return reply.code(200).send({ webhook: avecUrl(w) });
  });

  app.post('/tenants/:tenantId/webhooks', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const parsed = parseBody(req.body, null, null);
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
    if (parsed.input.workflowId !== null && !(await deps.workflowBelongsToTenant(parsed.input.workflowId, tenant))) {
      return reply.code(400).send({ error: 'workflowId inconnu pour ce tenant' });
    }
    const { id, code } = await deps.create(tenant, parsed.input);
    return reply.code(201).send({ id, code, url: urlPublique(deps.baseUrl, code), ...parsed.input });
  });

  app.patch('/tenants/:tenantId/webhooks/:id', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    // Relecture systématique : le mapping se valide CONTRE le dernier payload reçu, et le corps est partiel
    // alors que le store écrit un état complet.
    const actuel = await deps.get(tenant, id);
    if (!actuel) return reply.code(404).send({ error: 'webhook inconnu' });
    const parsed = parseBody(req.body, actuel, actuel.lastPayload);
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
    if (parsed.input.workflowId !== null && parsed.input.workflowId !== actuel.workflowId
        && !(await deps.workflowBelongsToTenant(parsed.input.workflowId, tenant))) {
      return reply.code(400).send({ error: 'workflowId inconnu pour ce tenant' });
    }
    const ok = await deps.update(tenant, id, parsed.input);
    if (!ok) return reply.code(404).send({ error: 'webhook inconnu' });
    return reply.code(200).send({ id, ...parsed.input });
  });

  app.delete('/tenants/:tenantId/webhooks/:id', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const ok = await deps.remove(tenant, id);
    if (!ok) return reply.code(404).send({ error: 'webhook inconnu' });
    return reply.code(204).send();
  });

  /** Pose un secret neuf. Le clair n'est rendu QU'ICI, une seule fois, comme une clé d'API. */
  app.post('/tenants/:tenantId/webhooks/:id/secret', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const secret = await deps.rotateSecret(tenant, id);
    if (secret === null) return reply.code(404).send({ error: 'webhook inconnu' });
    return reply.code(201).send({ secret, entete: 'X-Webhook-Secret' });
  });

  app.delete('/tenants/:tenantId/webhooks/:id/secret', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const ok = await deps.clearSecret(tenant, id);
    if (!ok) return reply.code(404).send({ error: 'webhook inconnu' });
    return reply.code(204).send();
  });

  /** « Oublier ce payload » : le JSON d'un tiers peut porter des données personnelles qu'on n'a pas demandées. */
  app.delete('/tenants/:tenantId/webhooks/:id/payload', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const ok = await deps.forgetPayload(tenant, id);
    if (!ok) return reply.code(404).send({ error: 'webhook inconnu' });
    return reply.code(204).send();
  });
}
