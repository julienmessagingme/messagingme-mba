import { extractInbound, type InboundMessage } from './inbound';
import { messageDe } from '../lib/erreur';

/**
 * L'arrivée publicitaire : une ligne par message entrant qui porte un `referral`. Meta ne joint le `referral`
 * (donc `ctwa_clid`) qu'au premier message après le clic, et le webhook brut est purgé : c'est ici ou jamais.
 * Les champs `pub_id` et `pub_titre` de la fiche gardent la dernière pub ; cette ligne garde chaque arrivée, pour
 * le renvoi des conversions. Le standby n'est pas exclu, contrairement aux étapes voisines : on veut savoir si
 * un lead arrivé pendant que l'agent de Meta tenait la conversation porte son `referral`.
 */
export interface ArriveePub {
  messageId: string;
  adId: string;
  sourceType: string | null;
  titre: string | null;
  url: string | null;
  ctwaClid: string | null;
  enStandby: boolean;
}

/** Ce que l'écriture a constaté : écrite, déjà vue (webhook redélivré), ou aucune fiche pour ce `wa_id`. */
export type IssueArrivee = 'ecrite' | 'deja_vue' | 'sans_contact';

export function arriveeDepuisMessage(m: Pick<InboundMessage, 'messageId' | 'field' | 'referral'>): ArriveePub | null {
  if (!m.referral) return null;
  return {
    messageId: m.messageId,
    adId: m.referral.adId,
    sourceType: m.referral.sourceType,
    titre: m.referral.titre,
    url: m.referral.url,
    ctwaClid: m.referral.ctwaClid,
    enStandby: m.field === 'standby',
  };
}

export interface ArriveesPubDeps {
  /** Tenant propriétaire du numéro business. `null` si le numéro nous est inconnu. */
  phoneNumberTenant(phoneNumberId: string): Promise<string | null>;
  /** Écrit l'arrivée, rattachée à la fiche que `waId` désigne (règle partagée `MATCH_BY_WAID_SQL`). */
  enregistrer(tenantId: string, waId: string, a: ArriveePub): Promise<IssueArrivee>;
}

/**
 * Pour chaque message entrant qui porte un `referral`, écrit son arrivée, après l'upsert du contact
 * (`handleWebhookJob`) puisqu'elle retrouve la fiche par son `wa_id` : si l'auto-création a échoué, l'arrivée
 * est perdue et le journal le dit, sans le numéro. Isolée par message, ne lève jamais.
 */
export async function processArriveesPub(payload: unknown, deps: ArriveesPubDeps): Promise<void> {
  for (const m of extractInbound(payload)) {
    const a = arriveeDepuisMessage(m);
    if (!a) continue;
    try {
      const tenantId = await deps.phoneNumberTenant(m.phoneNumberId);
      if (!tenantId) continue;
      const issue = await deps.enregistrer(tenantId, m.waId, a);
      if (issue === 'sans_contact') {
        // eslint-disable-next-line no-console
        console.error(`arrivée publicitaire perdue, aucune fiche pour le message ${m.messageId}`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('processArriveesPub: arrivée ignorée:', messageDe(err));
    }
  }
}
