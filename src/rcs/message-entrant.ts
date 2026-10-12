import type { RcsMo } from './callback';
import { apercuMo } from './callback';
import { estDemandeArret } from '../crm/consentement';
import type { InboundMessage } from '../webhooks/inbound';
import { enfilerEvenementAutomation, type FileDEvenements } from '../automation/event-job';
import { signalDeLaReponse, signalDesabonnement, type Emetteur } from '../signaux/emetteur';
import { tenter } from '../lib/tenter';
import { messageDe } from '../lib/erreur';

/** Les seules opérations dont a besoin le traitement d'une réponse RCS. */
export interface DepsMessageEntrantRcs {
  optout: { markOptedOut(tenantId: string, from: string): Promise<boolean> };
  inbox: { recordInbound(tenantId: string, message: InboundMessage, channel: 'rcs'): Promise<unknown> };
  contacts: { upsertFromInbound(tenantId: string, from: string, profileName: null): Promise<'created' | 'updated' | 'skipped'> };
  automations: FileDEvenements;
  signaux: Pick<Emetteur, 'emettreSignal'>;
  parcours: { advance(tenantId: string, from: string, messageId: string, postbackData: string | null, channel: 'rcs'): Promise<unknown> };
}

/**
 * Traite un message entrant après l'authentification du rappel smsmode par la route HTTP.
 * Le STOP précède toute autre écriture ; la réponse est annoncée après la fiche contact, pour que les
 * webhooks sortants puissent la relire. Les automations et le parcours sont secondaires : leur panne ne doit
 * pas faire rejouer un rappel dont l'opt-out et l'Inbox sont déjà enregistrés.
 */
export async function traiterMessageEntrantRcs(deps: DepsMessageEntrantRcs, tenantId: string, mo: RcsMo): Promise<void> {
  if (mo.kind === 'text' && estDemandeArret(mo.text)) {
    const marque = await deps.optout.markOptedOut(tenantId, mo.from);
    if (!marque) {
      // eslint-disable-next-line no-console
      console.error(`STOP RCS reçu de ${mo.from} (${tenantId}) sans fiche contact : rien à désabonner`);
    } else {
      // L'identifiant du STOP rend ce signal stable lors d'une redélivrance du rappel.
      await deps.signaux.emettreSignal(tenantId, signalDesabonnement(mo.from, 'rcs', mo.messageId));
    }
  }

  // Une position ou un fichier n'ont pas de texte : l'aperçu évite une bulle vide et conserve leur contenu.
  await deps.inbox.recordInbound(tenantId, {
    phoneNumberId: '',
    waId: mo.from,
    messageId: mo.messageId,
    type: mo.kind === 'suggestion' ? 'button' : mo.kind,
    body: apercuMo(mo),
    buttonPayload: mo.postbackData,
    profileName: null,
    field: 'messages',
  }, 'rcs');

  try {
    const issue = await deps.contacts.upsertFromInbound(tenantId, mo.from, null);
    // Le canal est explicite : une réponse RCS n'ouvre pas la fenêtre de service WhatsApp.
    await enfilerEvenementAutomation(deps.automations, {
      tenantId,
      event: { kind: 'message', waId: mo.from, body: mo.kind === 'text' ? mo.text : null, isNewContact: issue === 'created', channel: 'rcs' },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('automations RCS ignorées:', messageDe(err));
  }

  // Le bouton tapé est transmis ; le texte libre est relu dans l'Inbox par les webhooks sortants.
  await deps.signaux.emettreSignal(tenantId, signalDeLaReponse({
    messageId: mo.messageId, waId: mo.from, bouton: mo.kind === 'suggestion' ? mo.text : null,
  }, 'rcs'));

  await tenter('avance de scénario sur réponse RCS ignorée:', () =>
    deps.parcours.advance(tenantId, mo.from, mo.messageId, mo.postbackData, 'rcs'));
}
