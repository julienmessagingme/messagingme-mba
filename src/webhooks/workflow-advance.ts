import { extractInbound } from './inbound';
import { messageDe, texteDe } from '../lib/erreur';

/** Fait avancer le run de workflow en attente d'un contact quand il envoie un message entrant. */
export interface WorkflowAdvanceDeps {
  /** Tenant propriétaire du numéro business (mappe le message à un tenant). null si inconnu. */
  phoneNumberTenant(phoneNumberId: string): Promise<string | null>;
  /** Avance le run en attente de ce contact. `buttonPayload` = bouton tapé (branche par bouton). */
  advance(tenantId: string, waId: string, messageId: string, buttonPayload: string | null): Promise<void>;
  /**
   * Consigne un échec d'avance là où quelqu'un le verra (migration 0108, lot 4 du plan post-audit).
   *
   * 🔴 L'isolation par message est BONNE et ne bouge pas : une erreur sur un contact ne doit pas emporter les
   * autres messages du même webhook. C'était l'acquittement SILENCIEUX qui ne allait pas : le job se terminait
   * en succès, donc aucun rejeu, aucune DLQ, aucune trace consultable, et le contact restait bloqué sur son
   * bloc sans que personne l'apprenne.
   *
   * OPTIONNELLE et best-effort : absente ou en échec -> on retombe sur le message de log, comme avant.
   */
  journaliserEchec?(e: {
    tenantId: string; waId: string; messageId: string; erreur: string;
    /** Le parcours et le canal, quand l'erreur les portait. Voir `contexteDeLAvance` plus bas. */
    workflowId?: string | null; runId?: string | null; canal?: string | null;
  }): Promise<void>;
}

/**
 * Le contexte que `executor.advance` attache à l'erreur qu'il ré-émet (constat B1 de l'audit externe du
 * 2026-09-02).
 *
 * 🔴 Pourquoi il vient de LÀ et pas d'ici. Le journal (migration 0108) porte `workflow_id`, `run_id` et
 * `canal`, trois colonnes que personne ne remplissait : ce point de journalisation est un handler de webhook,
 * il ne connaît que le numéro et le message. Le parcours, lui, n'est connu que dans l'exécuteur. Sans ce
 * relais, la jointure qui cherche le nom du scénario ne rendait JAMAIS rien et l'exploitant lisait « ce
 * contact est bloqué » sans savoir dans quel parcours ni sur quel canal.
 *
 * Lecture DÉFENSIVE : une erreur qui ne le porte pas (panne avant que le run soit trouvé, appelant de test,
 * version d'exécuteur plus ancienne) rend simplement des colonnes nulles, comme avant. Un journal d'échec ne
 * doit jamais échouer à cause de la forme de l'échec qu'il journalise.
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
 * Avance les workflows sur les messages entrants (une réponse du contact = un pas dans le graphe). ISOLÉ
 * dans le handler (ne doit JAMAIS faire échouer le job webhook partagé avec les statuts/inbox/flow). Le
 * bouton tapé (`m.buttonPayload`) sélectionne la branche ; une réponse texte suit la 1re arête sortante.
 */
export async function processWorkflowAdvance(payload: unknown, deps: WorkflowAdvanceDeps, consumed?: ReadonlySet<string>): Promise<void> {
  for (const m of extractInbound(payload)) {
    // Message déjà consommé par une étape prioritaire (jeton de test) : ce n'est pas une réponse du contact
    // à son parcours, le traiter comme telle ferait avancer le scénario d'un cran pour rien.
    if (consumed?.has(m.messageId)) continue;
    // Ne PAS faire avancer le scénario sur un `standby` (le MBA tient le fil) : répondre reprendrait implicitement
    // le contrôle au MBA. L'inbox, elle, enregistre bien ce message (processInbound, non filtré) pour rester visible.
    // field null (anciennes fixtures) -> on avance (rétro-compat).
    if (m.field && m.field !== 'messages') continue;
    // Isolation PAR MESSAGE : une erreur sur un contact ne doit pas empêcher l'avance des autres contacts
    // du même webhook (Meta peut batcher plusieurs messages). Calqué sur processFlowCompletions.
    // Résolu HORS du try : sans tenant, un échec ne peut être rangé nulle part, et c'est justement ce
    // qu'on veut savoir en le journalisant.
    let tenantId: string | null = null;
    try {
      tenantId = await deps.phoneNumberTenant(m.phoneNumberId);
      if (tenantId) await deps.advance(tenantId, m.waId, m.messageId, m.buttonPayload);
    } catch (err) {
      const erreur = texteDe(err);
      // eslint-disable-next-line no-console
      console.error('processWorkflowAdvance: message ignoré:', erreur);
      // Best-effort, et à la fin : un journal d'échec qui ferait échouer le traitement qu'il observe serait
      // une très mauvaise idée. Sans tenant, le log reste le seul canal possible.
      if (tenantId && deps.journaliserEchec) {
        // Le canal est CONNU ici sans rien demander à personne : ce chemin est le webhook Meta, donc WhatsApp.
        // Il ne sert de repli que si l'erreur n'a pas porté le sien.
        const contexte = { canal: 'whatsapp', ...contexteDeLAvance(err) };
        await deps.journaliserEchec({ tenantId, waId: m.waId, messageId: m.messageId, erreur, ...contexte }).catch((e: unknown) => {
          // eslint-disable-next-line no-console
          console.error('processWorkflowAdvance: échec NON journalisé:', messageDe(e));
        });
      }
    }
  }
}
