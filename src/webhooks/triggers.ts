import { extractInbound } from './inbound';
import type { AutomationEvent } from '../automation/match';
import type { RoutageDuMessage } from '../pubs/routage';

/**
 * Déclenche les automations sur les messages entrants (mot-clé, 1er message d'un nouveau contact). ISOLÉ dans
 * le handler (ne doit JAMAIS faire échouer le job webhook partagé avec les statuts/inbox/flow/avance).
 *
 * ⚠️ Même règle que l'avance de scénario : on ignore un `standby` (le MBA tient le fil), sinon déclencher un
 * scénario lui reprendrait implicitement le contrôle. L'inbox, elle, enregistre bien ce message.
 *
 * 🔴 ET C'EST ICI, ET NULLE PART AILLEURS, QUE CETTE DOCTRINE A UNE EXCEPTION (lot 3 des publicités, spec
 * § 3.3). Un lead qui arrive d'une publicité dont la destination est un scénario est un cas où l'on veut
 * précisément reprendre le contrôle : le routage l'a DÉJÀ fait, explicitement, par `take` chez Meta, avant
 * d'arriver ici. La condition qui traduit cela est la restriction `seule`, et elle ne peut pas être posée
 * par erreur : seul `processRoutagePub` la produit, et seulement après une reprise confirmée par Meta.
 * **Pour tout le reste du dépôt, un message `standby` ne déclenche toujours rien.**
 */
export interface TriggerDeps {
  /** Tenant propriétaire du numéro business. null si inconnu. */
  phoneNumberTenant(phoneNumberId: string): Promise<string | null>;
  /**
   * Ce message est-il le PREMIER d'un contact inconnu ? Le signal est calculé à l'upsert d'inbound
   * (`created`), il est juste relu ici. false si l'information n'est pas disponible.
   */
  isNewContact(tenantId: string, waId: string): Promise<boolean>;
  /**
   * Évalue et démarre les automations correspondantes. Renvoie le nombre de scénarios démarrés.
   *
   * 🔴 `opts` EST REQUIS, PAS OPTIONNEL, et la forme change exprès (lot 3). Un câblage écrit pour l'ancienne
   * signature continuerait de compiler en ignorant la restriction : une flèche à deux paramètres est
   * assignable à un contrat qui en déclare trois, et le troisième est avalé EN SILENCE (mesuré dans ce dépôt,
   * cf. le CLAUDE.md). Le symptôme serait qu'un lead de publicité redevienne ramassable par n'importe quelle
   * automation par mot-clé, sans qu'aucun type ne bouge.
   */
  run(tenantId: string, ev: AutomationEvent, opts: { seuleAutomation: string | null }): Promise<number>;
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
export async function processTriggers(
  payload: unknown,
  deps: TriggerDeps,
  consumed?: ReadonlySet<string>,
  /**
   * Ce que le routage publicitaire a décidé, message par message (lot 3). Absent, ou sans entrée pour ce
   * message : chemin ordinaire, c'est-à-dire le comportement d'avant ce lot. C'est le cas de tout le trafic
   * non publicitaire, et aussi d'un routage qui a échoué.
   */
  routage?: ReadonlyMap<string, RoutageDuMessage>,
): Promise<ReadonlySet<string>> {
  const demarres = new Set<string>();
  for (const m of extractInbound(payload)) {
    const route = routage?.get(m.messageId);
    const restriction = route?.restriction ?? { sorte: 'tous' as const };
    // ⚠️ L'UNIQUE EXCEPTION À « UN MESSAGE `standby` NE DÉCLENCHE RIEN » (voir l'en-tête du fichier) : le
    // routage d'un lead publicitaire a repris le fil chez Meta AVANT cette ligne, donc le déclencher ne
    // reprend plus rien implicitement. Toute autre restriction, `aucun` comprise, laisse la règle intacte.
    if (m.field && m.field !== 'messages' && restriction.sorte !== 'seule') continue;
    // Message déjà consommé par une étape prioritaire (jeton de test) : il a déjà démarré un scénario, une
    // automation par mot-clé ne doit pas en démarrer un second par-dessus.
    if (consumed?.has(m.messageId)) continue;
    // Le routage a écarté ce message : sa pub confie ses leads à l'agent de Meta, ou le contact est bloqué ou
    // désabonné. Ni « toutes les pubs » ni « nouveau contact » ne doivent le ramasser.
    if (restriction.sorte === 'aucun') continue;
    // Isolation PAR MESSAGE : une erreur sur un contact ne doit pas priver les autres de leur déclenchement.
    try {
      const tenantId = await deps.phoneNumberTenant(m.phoneNumberId);
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
      console.error('processTriggers: message ignoré:', err instanceof Error ? err.message : err);
    }
  }
  return demarres;
}
