import { buildRecipients } from './build';
import type { BuildContact, BuiltRecipient } from './build';
import type { CreateCampaignInput } from './store.pg';

/** Sous-ensemble du repo requis pour créer une campagne (fakable en test). */
export interface CampaignRepoLike {
  listContactsForBuild(tenantId: string): Promise<BuildContact[]>;
  createWithRecipients(
    input: CreateCampaignInput,
    recipients: BuiltRecipient[],
  ): Promise<{ campaignId: string; recipientCount: number }>;
}

/**
 * Crée une campagne et matérialise ses destinataires : charge les contacts du tenant,
 * applique buildRecipients (opt-in marketing + dédup + résolution des variables) AVANT toute
 * écriture (un paramMapping invalide throw sans rien persister), puis crée campagne +
 * destinataires dans UNE transaction. Retourne l'id + le nb réel inséré.
 */
export async function createCampaignWithRecipients(
  input: CreateCampaignInput,
  repo: CampaignRepoLike,
): Promise<{ campaignId: string; recipientCount: number }> {
  const all = await repo.listContactsForBuild(input.tenantId);
  // Restreindre aux contacts choisis si une sélection est fournie (sinon tous). L'opt-in + le
  // numéro requis restent appliqués par buildRecipients : choisir un contact ne force pas l'envoi.
  const ids = input.contactIds && input.contactIds.length > 0 ? new Set(input.contactIds) : null;
  const contacts = ids ? all.filter((c) => ids.has(c.id)) : all;
  const recipients = buildRecipients(input.category, input.paramMapping, contacts);
  return repo.createWithRecipients(input, recipients);
}
