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

/**
 * Rend les `messageId` qui ont RÉELLEMENT démarré un scénario.
 *
 * 🔴 POURQUOI CETTE SORTIE EXISTE, et pourquoi cette étape passe désormais AVANT l'avance de parcours.
 * Julien, le 2026-09-07 : quand un message est à la fois une réponse attendue par le parcours en cours ET
 * le déclencheur d'un autre scénario, « le déclencheur gagne, toujours ». Sans consommation, l'ancien
 * parcours avançait ET envoyait son bloc suivant, puis le nouveau scénario démarrait par-dessus : le client
 * recevait DEUX messages, dont un hors sujet, et l'ancien parcours était tué juste après l'avoir fait
 * parler. Fermer le parcours ne suffisait donc pas, il fallait aussi lui retirer le message.
 *
 * C'est le motif déjà en place pour le jeton de test, posé pour la même raison : « les messages qu'il
 * consomme sont écartés des étapes suivantes, sinon un seul message déclencherait deux choses ».
 *
 * ⚠️ Seuls les messages qui ont VRAIMENT démarré quelque chose sont consommés. Une automation qui ne
 * correspond pas, qui est en anti-rebond ou dont la condition échoue ne doit rien retirer à personne : le
 * message reste une réponse ordinaire au parcours en cours.
 */
export async function processTriggers(payload: unknown, deps: TriggerDeps, consumed?: ReadonlySet<string>): Promise<ReadonlySet<string>> {
  const demarres = new Set<string>();
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
      const partis = await deps.run(tenantId, { kind: 'message', waId: m.waId, body: m.body, isNewContact, channel: 'whatsapp', ...(m.referral ? { adId: m.referral.adId } : {}) });
      if (partis > 0) demarres.add(m.messageId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('processTriggers: message ignoré:', err instanceof Error ? err.message : err);
    }
  }
  return demarres;
}
