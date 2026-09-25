import { extractInbound, type InboundMessage } from './inbound';
import { messageDe } from '../lib/erreur';

/**
 * L'ARRIVÉE PUBLICITAIRE : une ligne par message entrant qui porte un `referral` (lot 1 des publicités
 * Click-to-WhatsApp, spec `docs/superpowers/specs/2026-09-22-pubs-ctwa-design.md` § 2).
 *
 * 🔴 ICI OU JAMAIS. Meta ne joint le `referral`, donc `ctwa_clid`, qu'au PREMIER message après le clic, et le
 * corps brut du webhook est purgé à 30 jours. Les champs `pub_id` et `pub_titre` de la fiche gardent la
 * DERNIÈRE pub ; cette ligne garde CHAQUE arrivée, et c'est elle que le renvoi des conversions lira.
 *
 * ⚠️ LE STANDBY N'EST PAS EXCLU, contrairement aux étapes voisines. C'est même la mesure qu'on attend : un lead
 * arrivé pendant que l'agent de Meta tenait la conversation porte-t-il son `referral` ? La réponse décide du
 * plan A ou du plan B du lot 3.
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
 * Pour chaque message entrant qui porte un `referral`, écrit son arrivée.
 *
 * ⚠️ APRÈS l'upsert du contact (`handleWebhookJob`) : l'écriture retrouve la fiche par son `wa_id`. Si
 * l'auto-création a échoué juste avant, l'arrivée est perdue, et le journal le dit (sans le numéro).
 *
 * ⚠️ ISOLÉE PAR MESSAGE, comme ses voisines, et elle ne lève jamais : Meta groupe plusieurs contacts dans un
 * même webhook, et l'échec de l'un ne doit priver ni les autres, ni les étapes suivantes du job.
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
