import { buildRecipients } from './build';
import type { BuildContact, BuiltRecipient } from './build';
import type { CreateCampaignInput } from './store.pg';

/** Sous-ensemble du repo requis pour créer une campagne (fakable en test). */
export interface CampaignRepoLike {
  insertCampaign(input: CreateCampaignInput): Promise<string>;
  listContactsForBuild(tenantId: string): Promise<BuildContact[]>;
  insertRecipients(campaignId: string, recipients: BuiltRecipient[]): Promise<number>;
}

/**
 * Crée une campagne et matérialise ses destinataires : insère la campagne (draft),
 * charge les contacts du tenant, applique buildRecipients (opt-in marketing + dédup +
 * résolution des variables), persiste les destinataires. Retourne l'id + le nb réel inséré.
 */
export async function createCampaignWithRecipients(
  input: CreateCampaignInput,
  repo: CampaignRepoLike,
): Promise<{ campaignId: string; recipientCount: number }> {
  // Construire (et donc valider les params) AVANT d'insérer la campagne : si buildRecipients
  // throw, on n'a pas persisté de campagne draft orpheline.
  const contacts = await repo.listContactsForBuild(input.tenantId);
  const recipients = buildRecipients(input.category, input.paramMapping, contacts);
  const campaignId = await repo.insertCampaign(input);
  const recipientCount = await repo.insertRecipients(campaignId, recipients);
  return { campaignId, recipientCount };
}
