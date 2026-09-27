import type { AutomationEvent } from '../automation/match';
import type { EntrantRattache } from './rattachement';
import type { RoutageDuMessage } from '../pubs/routage';
import { messageDe } from '../lib/erreur';

/**
 * Déclenche les automations sur les messages entrants (mot-clé, 1er message d'un nouveau contact). Isolé dans
 * le handler : ne doit jamais faire échouer le job webhook partagé.
 * Un `standby` (le MBA tient le fil) ne déclenche rien, sinon un scénario lui reprendrait implicitement le
 * contrôle. Seule exception, ici : un lead de publicité routé vers un scénario, dont le routage a déjà repris
 * le fil par `take` chez Meta. La restriction `seule` le traduit, et seul `processRoutagePub` la produit, après
 * une reprise confirmée.
 */
export interface TriggerDeps {
  /**
   * Ce message est-il le premier d'un contact inconnu ? Signal calculé à l'upsert d'inbound (`created`), relu
   * ici ; false si indisponible.
   */
  isNewContact(tenantId: string, waId: string): Promise<boolean>;
  /**
   * Évalue et démarre les automations correspondantes ; rend le nombre de scénarios démarrés. `opts` est requis :
   * une flèche à deux paramètres reste assignable à un contrat qui en déclare trois, et un câblage qui ignore la
   * restriction laisserait un lead de publicité ramassable par n'importe quelle automation.
   */
  run(tenantId: string, ev: AutomationEvent, opts: { seuleAutomation: string | null }): Promise<number>;
}

/**
 * Rend les `messageId` qui ont réellement démarré un scénario. Quand un message est à la fois la réponse
 * attendue par un parcours et le déclencheur d'un autre scénario, le déclencheur gagne : le message est retiré
 * au parcours, sinon le client recevrait deux messages (d'où cette étape avant l'avance). Seuls les messages
 * qui ont vraiment démarré quelque chose sont consommés.
 */
export async function processTriggers(
  entrants: readonly EntrantRattache[],
  deps: TriggerDeps,
  consumed?: ReadonlySet<string>,
  /**
   * Ce que le routage publicitaire a décidé, message par message. Absent, ou sans entrée pour ce message : chemin
   * ordinaire (trafic non publicitaire, ou routage en échec).
   */
  routage?: ReadonlyMap<string, RoutageDuMessage>,
): Promise<ReadonlySet<string>> {
  const demarres = new Set<string>();
  for (const { message: m, tenantId } of entrants) {
    const route = routage?.get(m.messageId);
    const restriction = route?.restriction ?? { sorte: 'tous' as const };
    // L'unique exception à « un message `standby` ne déclenche rien » : le routage d'un lead publicitaire a déjà
    // repris le fil chez Meta. Toute autre restriction, `aucun` comprise, laisse la règle intacte.
    if (m.field && m.field !== 'messages' && restriction.sorte !== 'seule') continue;
    // Message déjà consommé par une étape prioritaire (jeton de test) : il a déjà démarré un scénario, une
    // automation par mot-clé ne doit pas en démarrer un second par-dessus.
    if (consumed?.has(m.messageId)) continue;
    // Le routage a écarté ce message : sa pub confie ses leads à l'agent de Meta, ou le contact est bloqué ou
    // désabonné. Ni « toutes les pubs » ni « nouveau contact » ne doivent le ramasser.
    if (restriction.sorte === 'aucun') continue;
    // Isolation par message : une erreur sur un contact ne prive pas les autres de leur déclenchement.
    try {
      if (!tenantId) continue;
      const isNewContact = await deps.isNewContact(tenantId, m.waId);
      const partis = await deps.run(
        tenantId,
        {
          kind: 'message', waId: m.waId, body: m.body, isNewContact, channel: 'whatsapp',
          ...(m.referral ? { adId: m.referral.adId } : {}),
          ...(route?.campagneId ? { campagneId: route.campagneId } : {}),
        },
        { seuleAutomation: restriction.sorte === 'seule' ? restriction.automationId : null },
      );
      if (partis > 0) demarres.add(m.messageId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('processTriggers: message ignoré:', messageDe(err));
    }
  }
  return demarres;
}
