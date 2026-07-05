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
  const contacts = await repo.listContactsForBuild(input.tenantId);
  const recipients = buildRecipients(input.category, input.paramMapping, contacts);
  return repo.createWithRecipients(input, recipients);
}
