import { validerMapping } from './mapping';
import type { WebhookInput, WebhookRow } from './modele';

/** Même borne que l'anti-rebond d'une automation : au-delà de 7 jours, ce n'est plus un anti-rebond. */
const MAX_COOLDOWN = 7 * 24 * 3600;

export type PreparationConfigurationWebhook =
  | { ok: true; input: WebhookInput }
  | { ok: false; error: string };

function texteNonVide(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}
/**
 * Prépare l'état complet qu'écrit le store. Une création part des défauts du domaine ; une modification fusionne le
 * corps partiel avec l'état relu. Le transport n'a donc pas à connaître les champs qui doivent survivre à un PATCH.
 */
export function preparerConfigurationWebhook(args: {
  saisie: unknown;
  actuel: WebhookRow | null;
}): PreparationConfigurationWebhook {
  const { actuel } = args;
  const b = (args.saisie ?? {}) as Record<string, unknown>;

  let name = actuel?.name ?? '';
  if (b.name !== undefined || actuel === null) {
    if (!texteNonVide(b.name)) return { ok: false, error: 'name requis' };
    name = b.name.trim().slice(0, 120);
  }

  let enabled = actuel?.enabled ?? true;
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') return { ok: false, error: 'enabled (booléen)' };
    enabled = b.enabled;
  }

  let createContact = actuel?.createContact ?? true;
  if (b.createContact !== undefined) {
    if (typeof b.createContact !== 'boolean') return { ok: false, error: 'createContact (booléen)' };
    createContact = b.createContact;
  }

  // L'opérateur affirme que sa source recueille le consentement, comme pour l'import CSV.
  let optIn = actuel?.optIn ?? true;
  if (b.optIn !== undefined) {
    if (typeof b.optIn !== 'boolean') return { ok: false, error: 'optIn (booléen)' };
    optIn = b.optIn;
  }

  let mapping = actuel?.mapping ?? [];
  if (b.mapping !== undefined) {
    const issue = validerMapping(b.mapping, actuel?.lastPayload ?? null);
    if (!issue.ok) return issue;
    mapping = issue.mapping;
  }

  let workflowId = actuel?.workflowId ?? null;
  if (b.workflowId !== undefined) {
    if (b.workflowId !== null && !texteNonVide(b.workflowId)) {
      return { ok: false, error: 'workflowId invalide (chaîne ou null)' };
    }
    workflowId = b.workflowId === null ? null : (b.workflowId as string);
  }

  let startNodeId = actuel?.startNodeId ?? null;
  if (b.startNodeId !== undefined) {
    if (b.startNodeId !== null && !texteNonVide(b.startNodeId)) {
      return { ok: false, error: 'startNodeId invalide (chaîne ou null)' };
    }
    startNodeId = b.startNodeId === null ? null : (b.startNodeId as string);
  }

  let cooldownSeconds = actuel?.cooldownSeconds ?? null;
  if (b.cooldownSeconds !== undefined) {
    const c = b.cooldownSeconds;
    if (c !== null && (typeof c !== 'number' || !Number.isInteger(c) || c < 0 || c > MAX_COOLDOWN)) {
      return { ok: false, error: `cooldownSeconds invalide (entier 0..${MAX_COOLDOWN}, ou null pour le défaut)` };
    }
    cooldownSeconds = c as number | null;
  }

  if (workflowId === null && startNodeId !== null) {
    return { ok: false, error: 'startNodeId n’a de sens qu’avec un scénario' };
  }

  return {
    ok: true,
    input: { name, enabled, mapping, createContact, optIn, workflowId, startNodeId, cooldownSeconds },
  };
}
