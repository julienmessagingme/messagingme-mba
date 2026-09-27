import type { FastifyInstance } from 'fastify';
import { forbidNonAdmin } from '../auth/middleware';
import type { Guard } from '../auth/middleware';
import { AUTOMATION_TRIGGER_KINDS, isAutomationTriggerKind, keywordsOf } from '../automation/match';
import { coerceConfigAvantDate, UNITES_DELAI, DELAI_MAX_MINUTES } from '../automation/avant-date';
import type { AutomationRow, AutomationTriggerKind } from '../automation/match';
import type { AutomationInput } from '../automation/store.pg';
import { espaceVerifie, nonEmpty } from './scope';

export interface AutomationsDep {
  list(tenantId: string): Promise<AutomationRow[]>;
  /** Une automation par id (scopée tenant). Lecture ciblée : `list` est capée, donc aveugle au-delà du plafond. */
  getById(id: string, tenantId: string): Promise<AutomationRow | null>;
  create(tenantId: string, input: AutomationInput): Promise<{ id: string }>;
  update(id: string, tenantId: string, patch: Partial<AutomationInput>): Promise<boolean>;
  remove(id: string, tenantId: string): Promise<boolean>;
}

export interface AutomationRouteDeps {
  automations: AutomationsDep;
  /** Le scénario ciblé appartient-il bien à ce tenant ? Garde d'appartenance (comme la campagne workflow). */
  workflowBelongsToTenant(workflowId: string, tenantId: string): Promise<boolean>;
}

/**
 * Les types qu'on crée depuis cet écran : ceux du chemin chaud moins `webhook`, que son propre écran possède.
 * Dérivé de `AUTOMATION_TRIGGER_KINDS`, pour que le message d'erreur cite tous les types.
 */
const TYPES_CREABLES_ICI = AUTOMATION_TRIGGER_KINDS.filter((k) => k !== 'webhook');

/**
 * Borne haute de l'anti-rebond réglé : 7 jours, comme le gel de contrôle. Le défaut d'une automation « risque
 * élevé » sans réglage (30 jours, `antiRebondParDefaut`) s'applique au déclenchement, sans passer par cette borne.
 */
const MAX_COOLDOWN = 7 * 24 * 3600;
/** Plancher pour « conversation analysée » : doit rester au-dessus du délai d'inactivité qui déclenche une
 *  analyse (25 min par défaut), sinon le scénario et l'analyse se relancent mutuellement. Voir `refuseIfLoopy`. */
const MIN_ANALYSIS_COOLDOWN = 3600;

/**
 * Refuse une combinaison (type, anti-rebond) qui rouvrirait la boucle analyse <-> scénario. Raisonne sur l'état
 * effectif, jamais sur le seul corps : la boucle s'ouvre en baissant le délai comme en changeant de type.
 * Rend le message d'erreur, ou null.
 */
function refuseIfLoopy(kind: AutomationTriggerKind | undefined, cooldown: number | null | undefined): string | null {
  if (kind !== 'conversation_analyzed') return null;
  if (cooldown === undefined || cooldown === null) return null; // null = défaut du serveur, largement au-dessus
  if (cooldown >= MIN_ANALYSIS_COOLDOWN) return null;
  return `pour « conversation analysée », l'anti-rebond doit valoir au moins ${MIN_ANALYSIS_COOLDOWN} s (ou null pour le défaut) : le scénario rouvre l'analyse en écrivant, un délai plus court boucle`;
}

/** Config du déclencheur, validée selon son type. Renvoie un message d'erreur, ou null si tout va bien. */
function validateTriggerConfig(kind: AutomationTriggerKind, cfg: Record<string, unknown>): string | null {
  if (kind === 'keyword') {
    if (!Array.isArray(cfg.keywords)) return 'keywords (tableau) requis pour un déclencheur mot-clé';
    if (keywordsOf(cfg).length === 0) return 'au moins un mot-clé non vide est requis';
    if (cfg.mode !== undefined && cfg.mode !== 'contains' && cfg.mode !== 'equals') return "mode invalide ('contains' | 'equals')";
    return null;
  }
  if (kind === 'ctwa_ad') {
    // `adId` facultatif, contrairement au tag ou à l'étape de deal : vide veut dire « n'importe quelle pub »,
    // ce qui est le montage le plus courant et reste borné aux messages venus d'une pub. Fourni, il doit
    // être exploitable : un identifiant vide ne matcherait jamais et l'automation paraîtrait active pour rien.
    if (cfg.adId !== undefined && cfg.adId !== null && cfg.adId !== '' && !nonEmpty(cfg.adId)) {
      return 'adId invalide (identifiant de publicité, ou vide pour « n’importe quelle pub »)';
    }
    return null;
  }
  if (kind === 'tag_added') {
    // Sans tag, l'automation partirait sur n'importe quel tag posé : on refuse plutôt que de deviner.
    if (!nonEmpty(cfg.tag)) return 'tag requis pour un déclencheur « tag ajouté »';
    return null;
  }
  if (kind === 'conversation_analyzed') {
    // Les deux filtres sont facultatifs (aucun = déclenche à chaque analyse, choix explicite), mais s'ils
    // sont fournis ils doivent être exploitables : un sentiment hors nomenclature ne matcherait jamais.
    const s = cfg.sentiment;
    if (s !== undefined && s !== null && s !== '' && s !== 'positif' && s !== 'neutre' && s !== 'negatif') {
      return "sentiment invalide ('positif' | 'neutre' | 'negatif')";
    }
    if (cfg.unresolvedOnly !== undefined && typeof cfg.unresolvedOnly !== 'boolean') return 'unresolvedOnly (booléen)';
    return null;
  }
  if (kind === 'hubspot_deal_stage') {
    // Sans étape, l'automation partirait sur tout changement d'étape du portail : on refuse plutôt que de
    // deviner. L'identifiant vient de HubSpot et est opaque : on vérifie qu'il est là, pas sa forme.
    if (!nonEmpty(cfg.stageId)) return 'stageId requis pour un déclencheur « étape de deal »';
    if (!nonEmpty(cfg.pipelineId)) return 'pipelineId requis pour un déclencheur « étape de deal »';
    // `stageLabel` est facultatif et décoratif (réaffiche « Devis envoyé » sans rappeler HubSpot). Il n'entre jamais
    // dans le matching : un renommage côté HubSpot casserait l'automation en silence.
    if (cfg.stageLabel !== undefined && typeof cfg.stageLabel !== 'string') return 'stageLabel (texte)';
    return null;
  }
  if (kind === 'avant_date') {
    // Un champ et un délai, sinon l'automation ne saurait ni quoi regarder ni quand partir. Même coercition que le
    // balayage : une config acceptée ici est exploitable là-bas. `sens` n'a rien à valider : absent ou aberrant, il
    // retombe sur « avant » (le refuser rejetterait des configurations déjà en base).
    if (!nonEmpty(cfg.fieldKey)) return 'fieldKey requis pour un déclencheur « avant ou après une date »';
    if (!coerceConfigAvantDate(cfg)) {
      return `délai invalide : un entier positif et une unité parmi ${UNITES_DELAI.join(' | ')}, sans dépasser ${DELAI_MAX_MINUTES / (24 * 60)} jours`;
    }
    return null;
  }
  if (kind === 'webhook') {
    // Fermé ici : les automations `webhook` sont possédées par un webhook entrant (écran Tools > Webhooks) et
    // exclues de cette liste. En créer une ici ferait une automation active que son écran ne montre pas.
    return 'un déclencheur « webhook » se configure depuis l’écran Tools > Webhooks';
  }
  // new_contact et risque_eleve : aucune config. Un type ajouté à `AUTOMATION_TRIGGER_KINDS` sans branche arrive
  // ici : se demander alors ce qu'il exige.
  return null;
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
    if (!isAutomationTriggerKind(b.triggerKind)) {
      return { error: `triggerKind invalide (${TYPES_CREABLES_ICI.map((k) => `'${k}'`).join(' | ')})` };
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
    out.enabled = false; // une automation neuve ne part jamais sans activation explicite
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
 * Automations : déclencher un scénario sur un événement. Lecture ouverte à tout compte authentifié, écritures
 * admin (une automation active écrit au client sans relecture humaine : c'est un pouvoir d'envoi).
 */
export function registerAutomations(app: FastifyInstance, deps: AutomationRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  app.get('/tenants/:tenantId/automations', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    return reply.code(200).send({ automations: await deps.automations.list(tenant) });
  });

  app.post('/tenants/:tenantId/automations', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;
    const parsed = parseBody(req.body, false);
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
    const input = parsed.input as AutomationInput;
    // 🔴 Le scénario ciblé doit appartenir à l'espace, sinon une automation d'un client démarrerait le scénario
    // d'un autre.
    if (!(await deps.workflowBelongsToTenant(input.workflowId, tenant))) {
      return reply.code(400).send({ error: 'workflowId inconnu pour ce tenant' });
    }
    const boucle = refuseIfLoopy(input.triggerKind, input.cooldownSeconds);
    if (boucle) return reply.code(400).send({ error: boucle });
    const { id } = await deps.automations.create(tenant, input);
    return reply.code(201).send({ id, ...input });
  });

  app.patch('/tenants/:tenantId/automations/:id', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const parsed = parseBody(req.body, true);
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
    if (Object.keys(parsed.input).length === 0) return reply.code(400).send({ error: 'rien à modifier' });
    if (parsed.input.workflowId !== undefined && !(await deps.workflowBelongsToTenant(parsed.input.workflowId, tenant))) {
      return reply.code(400).send({ error: 'workflowId inconnu pour ce tenant' });
    }
    // Garde anti-boucle sur l'état effectif après ce PATCH. On ne relit l'automation courante que si le corps ne
    // suffit pas : modifier le type sans le délai, ou le délai sans le type, ouvre la boucle aussi sûrement.
    if (parsed.input.triggerKind !== undefined || parsed.input.cooldownSeconds !== undefined) {
      const besoinRelecture = parsed.input.triggerKind === undefined || parsed.input.cooldownSeconds === undefined;
      const courant = besoinRelecture ? await deps.automations.getById(id, tenant) : null;
      if (besoinRelecture && !courant) return reply.code(404).send({ error: 'automation inconnue' });
      const kindEffectif = parsed.input.triggerKind ?? courant?.triggerKind;
      const cooldownEffectif = parsed.input.cooldownSeconds !== undefined ? parsed.input.cooldownSeconds : courant?.cooldownSeconds;
      const boucle = refuseIfLoopy(kindEffectif, cooldownEffectif);
      if (boucle) return reply.code(400).send({ error: boucle });
    }
    const ok = await deps.automations.update(id, tenant, parsed.input);
    if (!ok) return reply.code(404).send({ error: 'automation inconnue' });
    return reply.code(200).send({ id, ...parsed.input });
  });

  app.delete('/tenants/:tenantId/automations/:id', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const ok = await deps.automations.remove(id, tenant);
    if (!ok) return reply.code(404).send({ error: 'automation inconnue' });
    return reply.code(204).send();
  });
}
