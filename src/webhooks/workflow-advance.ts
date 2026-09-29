import { messageDe, texteDe } from '../lib/erreur';
import type { EntrantRattache } from './rattachement';

/** Fait avancer le run de workflow en attente d'un contact quand il envoie un message entrant. */
export interface WorkflowAdvanceDeps {
  /** Avance le run en attente de ce contact. `buttonPayload` = bouton tapé (branche par bouton). */
  advance(tenantId: string, waId: string, messageId: string, buttonPayload: string | null): Promise<void>;
  /**
   * Consigne un échec d'avance là où quelqu'un le verra : l'isolation par message reste, mais un acquittement
   * silencieux laisserait le contact bloqué sur son bloc sans rejeu ni trace. Optionnelle et best-effort :
   * absente ou en échec, on retombe sur le log.
   */
  journaliserEchec?(e: {
    tenantId: string; waId: string; messageId: string; erreur: string;
    /** Le parcours et le canal, quand l'erreur les portait. Voir `contexteDeLAvance` plus bas. */
    workflowId?: string | null; runId?: string | null; canal?: string | null;
  }): Promise<void>;
}

/**
 * Le contexte que `executor.advance` attache à l'erreur qu'il ré-émet : ce handler ne connaît que le numéro et
 * le message, seul l'exécuteur connaît le parcours et le canal que le journal attend. Lecture défensive : une
 * erreur qui ne le porte pas rend des colonnes nulles, un journal d'échec ne doit pas échouer sur la forme de
 * l'échec.
 */
function contexteDeLAvance(err: unknown): { workflowId?: string; runId?: string; canal?: string } {
  if (err === null || typeof err !== 'object') return {};
  const c = (err as { contexteAvance?: unknown }).contexteAvance;
  if (c === null || typeof c !== 'object') return {};
  const { workflowId, runId, canal } = c as Record<string, unknown>;
  return {
    ...(typeof workflowId === 'string' ? { workflowId } : {}),
    ...(typeof runId === 'string' ? { runId } : {}),
    ...(typeof canal === 'string' ? { canal } : {}),
  };
}

/**
 * Avance les workflows sur les messages entrants (une réponse du contact = un pas dans le graphe). Isolé dans le
 * handler : ne doit jamais faire échouer le job webhook partagé. Le bouton tapé choisit la branche ; une réponse
 * texte suit la 1re arête sortante.
 */
export async function processWorkflowAdvance(entrants: readonly EntrantRattache[], deps: WorkflowAdvanceDeps, consumed?: ReadonlySet<string>): Promise<void> {
  for (const { message: m, tenantId } of entrants) {
    // Message déjà consommé par une étape prioritaire (jeton de test) : ce n'est pas une réponse du contact
    // à son parcours, le traiter comme telle ferait avancer le scénario d'un cran pour rien.
    if (consumed?.has(m.messageId)) continue;
    // Numéro inconnu : aucun parcours à faire avancer.
    if (!tenantId) continue;
    // Pas d'avance sur un `standby` : le contact est sur la liste de l'agent de Meta, qui lui répond, et répondre
    // lui reprendrait implicitement le fil. Le `standby` d'un contact absent de la liste arrive ici déjà réécrit en
    // `messages` (`./standby-hors-liste.ts`) : texte comme bouton, il fait avancer le parcours. L'inbox enregistre
    // bien ce message. `field` null (anciennes fixtures) -> on avance.
    if (m.field && m.field !== 'messages') continue;
    // Isolation par message : une erreur sur un contact ne prive pas les autres du même webhook.
    try {
      await deps.advance(tenantId, m.waId, m.messageId, m.buttonPayload);
    } catch (err) {
      const erreur = texteDe(err);
      // eslint-disable-next-line no-console
      console.error('processWorkflowAdvance: message ignoré:', erreur);
      // Best-effort, et à la fin : un journal d'échec qui ferait échouer le traitement qu'il observe serait
      // une très mauvaise idée.
      if (deps.journaliserEchec) {
        // Le canal est connu ici : ce chemin est le webhook Meta, donc WhatsApp. Repli si l'erreur n'a pas porté le sien.
        const contexte = { canal: 'whatsapp', ...contexteDeLAvance(err) };
        await deps.journaliserEchec({ tenantId, waId: m.waId, messageId: m.messageId, erreur, ...contexte }).catch((e: unknown) => {
          // eslint-disable-next-line no-console
          console.error('processWorkflowAdvance: échec NON journalisé:', messageDe(e));
        });
      }
    }
  }
}
