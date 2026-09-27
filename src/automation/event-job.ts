import type { AutomationEvent } from './match';

/**
 * File `automation-event` : le pont entre les processus. L'API peut poser un tag, mais seul le worker sait
 * démarrer un scénario ; la file est aussi durable, un tag posé pendant un redémarrage n'est pas perdu.
 *
 * 🔴 Émission limitée aux chemins unitaires (bloc Action, édition d'une fiche) : un import CSV ou une action
 * en masse n'émettent pas, sinon un tag sur 5 000 contacts déclencherait 5 000 messages facturés. Pour une
 * liste, c'est la campagne. Seule exception : le balayage du risque de désengagement publie `risque_eleve`,
 * sur un passage en élevé seulement et au plus 200 par nuit et par espace.
 */

/** Ce qui transite dans la file. `tenantId` porté explicitement : le worker ne le déduit de rien d'autre. */
export interface AutomationEventJob {
  tenantId: string;
  event: AutomationEvent;
}

export const AUTOMATION_EVENT_QUEUE = 'automation-event';

/**
 * Le seul chemin d'enfilement de cette file. La clé de groupe (le tenant, déduit du job) empêche un client
 * bavard d'occuper toutes les places : un enfilement qui l'oublierait échapperait au plafond par espace, sans
 * que rien le signale.
 *
 * Le paramètre est le plus petit type qui convient (un appelant ne reçoit qu'une file réduite à `enqueue`),
 * et il déclare les options, pour qu'un groupe passé ne disparaisse pas en silence.
 */
export interface FileDEvenements {
  enqueue(name: string, data: unknown, opts?: { groupId?: string; startAfter?: Date }): Promise<void>;
}

/**
 * `depart` : l'événement n'est pas traité avant cet instant (le balayage du risque, pour partir à l'ouverture
 * de l'espace et non à 3 h du matin). Absent = tout de suite.
 */
export async function enfilerEvenementAutomation(queue: FileDEvenements, job: AutomationEventJob, depart?: Date): Promise<void> {
  await queue.enqueue(AUTOMATION_EVENT_QUEUE, job, { groupId: job.tenantId, ...(depart !== undefined ? { startAfter: depart } : {}) });
}

/**
 * Coerce un payload de file (JSON opaque, potentiellement d'une version antérieure du code) en job valide.
 * null = payload inexploitable : le worker l'ignore au lieu de planter la file.
 */
export function parseAutomationEventJob(raw: unknown): AutomationEventJob | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const j = raw as { tenantId?: unknown; event?: unknown };
  if (typeof j.tenantId !== 'string' || j.tenantId === '') return null;
  if (!j.event || typeof j.event !== 'object') return null;
  const e = j.event as Record<string, unknown>;
  const waId = typeof e.waId === 'string' ? e.waId : '';
  if (waId === '') return null;
  if (e.kind === 'tag_added') {
    const tag = typeof e.tag === 'string' ? e.tag : '';
    return tag === '' ? null : { tenantId: j.tenantId, event: { kind: 'tag_added', waId, tag } };
  }
  if (e.kind === 'analysis') {
    return {
      tenantId: j.tenantId,
      event: { kind: 'analysis', waId, sentiment: typeof e.sentiment === 'string' ? e.sentiment : '', resolved: e.resolved === true },
    };
  }
  if (e.kind === 'hubspot_deal_stage') {
    // Seule l'étape est exigée : le webhook HubSpot ne porte pas le pipeline, qui reste facultatif comme dans
    // `matchesTrigger`. L'exiger rendrait la chaîne muette.
    const stageId = typeof e.stageId === 'string' ? e.stageId.trim() : '';
    const pipelineId = typeof e.pipelineId === 'string' ? e.pipelineId.trim() : '';
    if (stageId === '') return null;
    return { tenantId: j.tenantId, event: { kind: 'hubspot_deal_stage', waId, pipelineId, stageId } };
  }
  if (e.kind === 'webhook') {
    // L'identifiant du webhook est le seul discriminant : un événement anonyme pourrait déclencher les
    // automations d'un autre webhook.
    const webhookId = typeof e.webhookId === 'string' ? e.webhookId.trim() : '';
    if (webhookId === '') return null;
    return { tenantId: j.tenantId, event: { kind: 'webhook', waId, webhookId } };
  }
  if (e.kind === 'avant_date') {
    // Automation et valeur exigées : sans la première, l'événement partirait sur toutes les automations de date
    // de l'espace ; sans la seconde, un rendez-vous reporté ne redonnerait rien.
    const automationId = typeof e.automationId === 'string' ? e.automationId.trim() : '';
    const valeur = typeof e.valeur === 'string' ? e.valeur.trim() : '';
    if (automationId === '' || valeur === '') return null;
    return { tenantId: j.tenantId, event: { kind: 'avant_date', waId, automationId, valeur } };
  }
  if (e.kind === 'risque_eleve') {
    // Le contact suffit : le passage a déjà été constaté (et plafonné) par le balayage qui publie.
    return { tenantId: j.tenantId, event: { kind: 'risque_eleve', waId } };
  }
  if (e.kind === 'message') {
    // `message` passe par la file pour le RCS, dont les entrants arrivent dans le processus API. Le canal est
    // exigé, sans défaut : supposer WhatsApp ferait croire la fenêtre de service ouverte sur un message RCS
    // (131047).
    const channel = e.channel === 'rcs' || e.channel === 'whatsapp' ? e.channel : null;
    if (channel === null) return null;
    return {
      tenantId: j.tenantId,
      event: {
        kind: 'message', waId, body: typeof e.body === 'string' ? e.body : null,
        isNewContact: e.isNewContact === true, channel,
        ...(typeof e.adId === 'string' && e.adId.trim() !== '' ? { adId: e.adId.trim() } : {}),
      },
    };
  }
  return null; // genre inconnu : la file l ignore proprement plutot que de planter
}
