import type { AutomationEvent } from './match';

/**
 * File `automation-event` : le pont entre les processus (E.2).
 *
 * Pourquoi une file. Un tag peut être posé depuis l'API (édition d'une fiche) alors que SEUL le worker sait
 * démarrer un scénario (c'est lui qui tient l'exécuteur, les clients Meta, les stores de runs). L'API publie
 * donc un événement, le worker le consomme. Bénéfice second : durable et rejouable, donc un tag posé pendant
 * un redémarrage du worker n'est pas perdu.
 *
 * ⚠️ Émission volontairement limitée aux chemins UNITAIRES (bloc Action d'un scénario, édition d'une fiche).
 * Un import CSV ou une action en masse n'émettent PAS : poser un tag sur 5 000 contacts déclencherait 5 000
 * scénarios, donc 5 000 messages facturés, sans que personne l'ait demandé. Pour toucher une liste, l'outil
 * prévu est la campagne, qui a ses propres garde-fous (cadence, fenêtre, quality gate).
 *
 * 🔴 UNE EXCEPTION, DÉCIDÉE : le balayage du risque de désengagement (`src/engagement/balayage.ts`) publie
 * `risque_eleve`, seulement sur un PASSAGE en élevé et au plus 200 par nuit et par espace. Ses bornes sont
 * écrites au point d'émission.
 */

/** Ce qui transite dans la file. `tenantId` porté explicitement : le worker ne le déduit de rien d'autre. */
export interface AutomationEventJob {
  tenantId: string;
  event: AutomationEvent;
}

export const AUTOMATION_EVENT_QUEUE = 'automation-event';

/**
 * LE SEUL CHEMIN D'ENFILEMENT DE CETTE FILE (lot 6 du plan post-audit, 2026-09-02).
 *
 * 🔴 Pourquoi une fonction plutôt que six `queue.enqueue` recopiés. La clé de groupe est ce qui empêche un
 * client bavard d'occuper toutes les places de la file : un enfilement qui l'oublie produit un job SANS
 * groupe, donc un job qui échappe au plafond par espace, et rien ne le signale. Six recopies, c'est six
 * occasions d'oublier, et le dépôt a déjà payé ce prix-là (le 131008 du 2026-09-02 venait d'une dépendance
 * câblée d'un côté et oubliée de l'autre).
 *
 * Le groupe est le TENANT, et il se déduit du job lui-même : il n'y a donc rien à passer, donc rien à oublier.
 *
 * ⚠️ Le paramètre est le PLUS PETIT type qui convient, et pas `Queue`. Un appelant (le câblage de scénario)
 * ne reçoit qu'une file réduite à `enqueue` ; exiger la file complète l'aurait obligé à s'élargir pour rien.
 * Ce type-là, lui, DÉCLARE les options : la version étroite d'origine ne les nommait pas, si bien qu'un
 * appelant qui aurait passé un groupe l'aurait vu disparaître sans un mot.
 */
export interface FileDEvenements {
  enqueue(name: string, data: unknown, opts?: { groupId?: string; startAfter?: Date }): Promise<void>;
}

/**
 * `depart` (2026-09-25) : l'événement n'est pas traité avant cet instant. Un seul appelant le pose, le balayage
 * du risque, pour que le scénario parte à l'ouverture de l'espace et non à 3 h du matin. Absent = tout de suite.
 */
export async function enfilerEvenementAutomation(queue: FileDEvenements, job: AutomationEventJob, depart?: Date): Promise<void> {
  await queue.enqueue(AUTOMATION_EVENT_QUEUE, job, { groupId: job.tenantId, ...(depart !== undefined ? { startAfter: depart } : {}) });
}

/**
 * Coerce un payload de file (JSON opaque, potentiellement d'une version antérieure du code) en job valide.
 * null = payload inexploitable -> le worker l'ignore proprement au lieu de planter la file.
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
    // SEULE l'étape est exigée : sans elle, aucune automation ne peut correspondre. Le pipeline est
    // FACULTATIF, exactement comme dans `matchesTrigger` où un pipeline non configuré ne restreint rien.
    //
    // ⚠️ Il était exigé ici, et ça rendait la chaîne MORTE : le webhook HubSpot ne porte PAS le pipeline, donc
    // le connecteur publiait une chaîne vide, donc cet analyseur écartait tout. En silence, avec des 200
    // partout. Producteur écrit sans relire son propre consommateur (trouvé en revue le 2026-08-16).
    const stageId = typeof e.stageId === 'string' ? e.stageId.trim() : '';
    const pipelineId = typeof e.pipelineId === 'string' ? e.pipelineId.trim() : '';
    if (stageId === '') return null;
    return { tenantId: j.tenantId, event: { kind: 'hubspot_deal_stage', waId, pipelineId, stageId } };
  }
  if (e.kind === 'webhook') {
    // L'identifiant du webhook est le SEUL discriminant : sans lui, aucune automation ne peut correspondre,
    // et un événement anonyme risquerait de déclencher les automations d'un AUTRE webhook.
    const webhookId = typeof e.webhookId === 'string' ? e.webhookId.trim() : '';
    if (webhookId === '') return null;
    return { tenantId: j.tenantId, event: { kind: 'webhook', waId, webhookId } };
  }
  if (e.kind === 'avant_date') {
    // L'identifiant de l'automation ET la valeur sont exiges : sans le premier l'evenement partirait sur
    // toutes les automations de date de l'espace, sans la seconde on ne saurait pas pour quelle occurrence
    // on a tire, et un rendez-vous reporte ne redonnerait rien.
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
    // 🔴 `message` transitait AUTREFOIS uniquement en direct dans le webhook Meta, et cet analyseur le
    // refusait. Le RCS a changé la donne : ses messages entrants arrivent dans le processus API, qui n'a pas
    // les dépendances du runner. La file est exactement faite pour ça.
    //
    // Le CANAL est exigé et n'a PAS de valeur par défaut : le supposer WhatsApp ferait croire au runner que
    // la fenêtre de service est ouverte sur un message RCS, et le scénario déclenché partirait en 131047.
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
