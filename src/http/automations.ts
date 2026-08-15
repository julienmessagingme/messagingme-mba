import type { FastifyInstance } from 'fastify';
import { forbidNonAdmin } from '../auth/middleware';
import type { Guard } from '../auth/middleware';
import { isCreatableTriggerKind, keywordsOf } from '../automation/match';
import type { AutomationRow, AutomationTriggerKind } from '../automation/match';
import type { AutomationInput } from '../automation/store.pg';

export interface AutomationRouteDeps {
  list(tenantId: string): Promise<AutomationRow[]>;
  create(tenantId: string, input: AutomationInput): Promise<{ id: string }>;
  update(id: string, tenantId: string, patch: Partial<AutomationInput>): Promise<boolean>;
  remove(id: string, tenantId: string): Promise<boolean>;
  /** Le scénario ciblé appartient-il bien à ce tenant ? Garde d'appartenance (comme la campagne workflow). */
  workflowBelongsToTenant(workflowId: string, tenantId: string): Promise<boolean>;
  /** UNE automation par id (scopée tenant). Lecture ciblée : `list` est capée, donc aveugle au-delà du plafond. */
  getById(id: string, tenantId: string): Promise<AutomationRow | null>;
}

function scopeTenant(req: { params: unknown; auth?: { tenantId: string } }): string | null {
  const { tenantId } = req.params as { tenantId: string };
  const authTenant = req.auth?.tenantId;
  if (authTenant !== undefined && authTenant !== tenantId) return null;
  return authTenant ?? tenantId;
}
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** Borne haute de l'anti-rebond : 7 jours, comme le gel de contrôle. Au-delà ce n'est plus un anti-rebond. */
const MAX_COOLDOWN = 7 * 24 * 3600;
/** Plancher pour « conversation analysée » : doit rester au-dessus du délai d'inactivité qui déclenche une
 *  analyse (25 min par défaut), sinon le scénario et l'analyse se relancent mutuellement. Voir `refuseIfLoopy`. */
const MIN_ANALYSIS_COOLDOWN = 3600;

/**
 * Refuse une combinaison (type, anti-rebond) qui rouvrirait la boucle analyse <-> scénario.
 *
 * Raisonne sur l'état EFFECTIF, jamais sur le seul corps de la requête : la boucle s'ouvre aussi bien en
 * baissant le délai d'une automation déjà « conversation analysée » qu'en basculant vers ce type une
 * automation dont le délai est déjà trop court. Deux gardes séparées ne voyaient chacune qu'un des deux sens.
 * Renvoie le message d'erreur, ou null.
 */
function refuseIfLoopy(kind: AutomationTriggerKind | undefined, cooldown: number | null | undefined): string | null {
  if (kind !== 'conversation_analyzed') return null;
  if (cooldown === undefined || cooldown === null) return null; // null = défaut du serveur, largement au-dessus
  if (cooldown >= MIN_ANALYSIS_COOLDOWN) return null;
  return `pour « conversation analysée », l'anti-rebond doit valoir au moins ${MIN_ANALYSIS_COOLDOWN} s (ou null pour le défaut) : le scénario rouvre l'analyse en écrivant, un délai plus court boucle`;
}

/** Config du déclencheur, validée SELON son type. Renvoie un message d'erreur, ou null si tout va bien. */
function validateTriggerConfig(kind: AutomationTriggerKind, cfg: Record<string, unknown>): string | null {
  if (kind === 'keyword') {
    if (!Array.isArray(cfg.keywords)) return 'keywords (tableau) requis pour un déclencheur mot-clé';
    if (keywordsOf(cfg).length === 0) return 'au moins un mot-clé non vide est requis';
    if (cfg.mode !== undefined && cfg.mode !== 'contains' && cfg.mode !== 'equals') return "mode invalide ('contains' | 'equals')";
    return null;
  }
  if (kind === 'tag_added') {
    // Sans tag, l'automation partirait sur n'importe quel tag posé : on refuse plutôt que de deviner.
    if (!nonEmpty(cfg.tag)) return 'tag requis pour un déclencheur « tag ajouté »';
    return null;
  }
  if (kind === 'conversation_analyzed') {
    // Les deux filtres sont FACULTATIFS (aucun = déclenche à chaque analyse, choix explicite), mais s'ils
    // sont fournis ils doivent être exploitables : un sentiment hors nomenclature ne matcherait jamais.
    const s = cfg.sentiment;
    if (s !== undefined && s !== null && s !== '' && s !== 'positif' && s !== 'neutre' && s !== 'negatif') {
      return "sentiment invalide ('positif' | 'neutre' | 'negatif')";
    }
    if (cfg.unresolvedOnly !== undefined && typeof cfg.unresolvedOnly !== 'boolean') return 'unresolvedOnly (booléen)';
    return null;
  }
  if (kind === 'hubspot_deal_stage') {
    // Sans étape, l'automation partirait sur TOUT changement d'étape du portail : on refuse plutôt que de
    // deviner. L'identifiant vient de HubSpot et est opaque : on vérifie qu'il est là, pas sa forme.
    if (!nonEmpty(cfg.stageId)) return 'stageId requis pour un déclencheur « étape de deal »';
    if (!nonEmpty(cfg.pipelineId)) return 'pipelineId requis pour un déclencheur « étape de deal »';
    // `stageLabel` est FACULTATIF et purement décoratif : il réaffiche « Devis envoyé » dans la liste sans
    // rappeler HubSpot. Il n'entre JAMAIS dans le matching, sinon un renommage côté HubSpot casserait
    // l'automation en silence, ce qui est précisément ce qu'on cherche à éviter.
    if (cfg.stageLabel !== undefined && typeof cfg.stageLabel !== 'string') return 'stageLabel (texte)';
    return null;
  }
  return null; // new_contact : aucune config
}

/** Corps commun création/modification. Renvoie l'erreur (400) ou l'input normalisé. */
function parseBody(body: unknown, partial: boolean): { error: string } | { input: Partial<AutomationInput> } {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: Partial<AutomationInput> = {};

  if (b.name !== undefined || !partial) {
    if (!nonEmpty(b.name)) return { error: 'name requis' };
    out.name = b.name.trim().slice(0, 120);
  }
  if (b.triggerKind !== undefined || !partial) {
    if (!isCreatableTriggerKind(b.triggerKind)) {
      return { error: "triggerKind invalide ('keyword' | 'new_contact' | 'tag_added' | 'conversation_analyzed')" };
    }
    out.triggerKind = b.triggerKind;
  }
  if (b.triggerConfig !== undefined || !partial) {
    const cfg = b.triggerConfig;
    if (cfg !== undefined && (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg))) return { error: 'triggerConfig invalide (objet)' };
    out.triggerConfig = (cfg as Record<string, unknown>) ?? {};
  }
  if (b.workflowId !== undefined || !partial) {
    if (!nonEmpty(b.workflowId)) return { error: 'workflowId requis' };
    out.workflowId = b.workflowId;
  }
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') return { error: 'enabled (booléen)' };
    out.enabled = b.enabled;
  } else if (!partial) {
    out.enabled = false; // une automation neuve ne part JAMAIS sans activation explicite
  }
  if (b.conditionGroup !== undefined) {
    if (b.conditionGroup !== null && (typeof b.conditionGroup !== 'object' || Array.isArray(b.conditionGroup))) {
      return { error: 'conditionGroup invalide (objet ou null)' };
    }
    out.conditionGroup = b.conditionGroup;
  } else if (!partial) {
    out.conditionGroup = null;
  }
  if (b.startNodeId !== undefined) {
    if (b.startNodeId !== null && !nonEmpty(b.startNodeId)) return { error: 'startNodeId invalide (chaîne ou null)' };
    out.startNodeId = b.startNodeId === null ? null : (b.startNodeId as string);
  } else if (!partial) {
    out.startNodeId = null;
  }
  if (b.cooldownSeconds !== undefined) {
    const c = b.cooldownSeconds;
    if (c !== null && (typeof c !== 'number' || !Number.isInteger(c) || c < 0 || c > MAX_COOLDOWN)) {
      return { error: `cooldownSeconds invalide (entier 0..${MAX_COOLDOWN}, ou null pour le défaut)` };
    }
    out.cooldownSeconds = c as number | null;
  } else if (!partial) {
    out.cooldownSeconds = null;
  }

  // La config n'a de sens que rapportée à son type. Sur un PATCH, modifier l'un sans l'autre laisserait passer
  // une config invalide (ex. `{triggerConfig:{keywords:[]}}` -> automation « active » mais qui ne part jamais) :
  // on exige donc les deux ensemble, plutôt que de valider à moitié.
  const kindGiven = out.triggerKind !== undefined;
  const cfgGiven = out.triggerConfig !== undefined;
  if (kindGiven !== cfgGiven) {
    return { error: 'triggerKind et triggerConfig se modifient ENSEMBLE (la config dépend du type de déclencheur)' };
  }
  if (kindGiven && cfgGiven) {
    const msg = validateTriggerConfig(out.triggerKind!, out.triggerConfig!);
    if (msg) return { error: msg };
  }
  return { input: out };
}

/**
 * Automations (Lot E) : déclencher un scénario sur un événement. Lecture ouverte à tout compte authentifié,
 * ÉCRITURES admin-only (une automation active écrit au client sans qu'un humain relise : c'est un pouvoir
 * d'envoi, au même titre qu'une campagne).
 */
export function registerAutomations(app: FastifyInstance, deps: AutomationRouteDeps, guard?: Guard): void {
  const opts = guard ? { preHandler: guard } : {};

  app.get('/tenants/:tenantId/automations', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    return reply.code(200).send({ automations: await deps.list(tenant) });
  });

  app.post('/tenants/:tenantId/automations', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const parsed = parseBody(req.body, false);
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
    const input = parsed.input as AutomationInput;
    // Le scénario ciblé doit appartenir au tenant : sinon une automation d'un client démarrerait le scénario
    // d'un autre. Même garde que la campagne workflow.
    if (!(await deps.workflowBelongsToTenant(input.workflowId, tenant))) {
      return reply.code(400).send({ error: 'workflowId inconnu pour ce tenant' });
    }
    const boucle = refuseIfLoopy(input.triggerKind, input.cooldownSeconds);
    if (boucle) return reply.code(400).send({ error: boucle });
    const { id } = await deps.create(tenant, input);
    return reply.code(201).send({ id, ...input });
  });

  app.patch('/tenants/:tenantId/automations/:id', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const parsed = parseBody(req.body, true);
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
    if (Object.keys(parsed.input).length === 0) return reply.code(400).send({ error: 'rien à modifier' });
    if (parsed.input.workflowId !== undefined && !(await deps.workflowBelongsToTenant(parsed.input.workflowId, tenant))) {
      return reply.code(400).send({ error: 'workflowId inconnu pour ce tenant' });
    }
    // Garde anti-boucle sur l'état EFFECTIF après ce PATCH. On ne relit l'automation courante que si le corps
    // ne suffit pas à trancher : modifier le type SANS le délai, ou le délai SANS le type, ouvre la boucle
    // aussi sûrement que les deux à la fois.
    if (parsed.input.triggerKind !== undefined || parsed.input.cooldownSeconds !== undefined) {
      const besoinRelecture = parsed.input.triggerKind === undefined || parsed.input.cooldownSeconds === undefined;
      const courant = besoinRelecture ? await deps.getById(id, tenant) : null;
      if (besoinRelecture && !courant) return reply.code(404).send({ error: 'automation inconnue' });
      const kindEffectif = parsed.input.triggerKind ?? courant?.triggerKind;
      const cooldownEffectif = parsed.input.cooldownSeconds !== undefined ? parsed.input.cooldownSeconds : courant?.cooldownSeconds;
      const boucle = refuseIfLoopy(kindEffectif, cooldownEffectif);
      if (boucle) return reply.code(400).send({ error: boucle });
    }
    const ok = await deps.update(id, tenant, parsed.input);
    if (!ok) return reply.code(404).send({ error: 'automation inconnue' });
    return reply.code(200).send({ id, ...parsed.input });
  });

  app.delete('/tenants/:tenantId/automations/:id', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const ok = await deps.remove(id, tenant);
    if (!ok) return reply.code(404).send({ error: 'automation inconnue' });
    return reply.code(204).send();
  });
}
