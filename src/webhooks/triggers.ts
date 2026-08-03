import { extractInbound } from './inbound';
import type { AutomationEvent } from '../automation/match';

/**
 * Déclenche les automations sur les messages entrants (mot-clé, 1er message d'un nouveau contact). ISOLÉ dans
 * le handler (ne doit JAMAIS faire échouer le job webhook partagé avec les statuts/inbox/flow/avance).
 *
 * ⚠️ Même règle que l'avance de scénario : on ignore un `standby` (le MBA tient le fil), sinon déclencher un
 * scénario lui reprendrait implicitement le contrôle. L'inbox, elle, enregistre bien ce message.
 */
export interface TriggerDeps {
  /** Tenant propriétaire du numéro business. null si inconnu. */
  phoneNumberTenant(phoneNumberId: string): Promise<string | null>;
  /**
   * Ce message est-il le PREMIER d'un contact inconnu ? Le signal est calculé à l'upsert d'inbound
   * (`created`), il est juste relu ici. false si l'information n'est pas disponible.
   */
  isNewContact(tenantId: string, waId: string): Promise<boolean>;
  /** Évalue et démarre les automations correspondantes. Renvoie le nombre de scénarios démarrés. */
  run(tenantId: string, ev: AutomationEvent): Promise<number>;
}

export async function processTriggers(payload: unknown, deps: TriggerDeps, consumed?: ReadonlySet<string>): Promise<void> {
  for (const m of extractInbound(payload)) {
    if (m.field && m.field !== 'messages') continue; // standby : le MBA tient le fil
    // Message déjà consommé par une étape prioritaire (jeton de test) : il a déjà démarré un scénario, une
    // automation par mot-clé ne doit pas en démarrer un second par-dessus.
    if (consumed?.has(m.messageId)) continue;
    // Isolation PAR MESSAGE : une erreur sur un contact ne doit pas priver les autres de leur déclenchement.
    try {
      const tenantId = await deps.phoneNumberTenant(m.phoneNumberId);
      if (!tenantId) continue;
      const isNewContact = await deps.isNewContact(tenantId, m.waId);
      await deps.run(tenantId, { kind: 'message', waId: m.waId, body: m.body, isNewContact });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('processTriggers: message ignoré:', err instanceof Error ? err.message : err);
    }
  }
}
