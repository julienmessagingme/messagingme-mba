import { buildRecipients } from './build';
import type { BuildContact, BuiltRecipient, SkippedRecipient } from './build';
import type { CreateCampaignInput } from './store.pg';

/** Sous-ensemble du repo requis pour créer une campagne (fakable en test). */
export interface CampaignRepoLike {
  listContactsForBuild(tenantId: string): Promise<BuildContact[]>;
  /** Les contacts choisis, et eux seuls, sans charger tout le CRM. */
  listContactsForBuildByIds(tenantId: string, ids: string[]): Promise<BuildContact[]>;
  createWithRecipients(
    input: CreateCampaignInput,
    recipients: BuiltRecipient[],
  ): Promise<{ campaignId: string; recipientCount: number }>;
}

/**
 * Crée une campagne et matérialise ses destinataires : charge les contacts du tenant,
 * applique buildRecipients (opt-in marketing + dédup + résolution des variables) avant toute
 * écriture (un paramMapping invalide throw sans rien persister), puis crée campagne +
 * destinataires dans une transaction. Retourne l'id + le nb réel inséré.
 */
export async function createCampaignWithRecipients(
  input: CreateCampaignInput,
  repo: CampaignRepoLike,
): Promise<{ campaignId: string; recipientCount: number; skipped: SkippedRecipient[] }> {
  // Campagne au fil de l'eau : elle naît vide, ses destinataires arrivent un par un par le webhook.
  if (input.webhookId) {
    const cree = await repo.createWithRecipients(input, []);
    return { ...cree, skipped: [] };
  }
  // La sélection se fait en base : filtrer en mémoire ramènerait tout le CRM à chaque création.
  // L'opt-in et le numéro requis restent appliqués par `buildRecipients`.
  const ids = input.contactIds && input.contactIds.length > 0 ? input.contactIds : null;
  const contacts = ids
    ? await repo.listContactsForBuildByIds(input.tenantId, ids)
    : await repo.listContactsForBuild(input.tenantId);
  // recipients = envoyables ; skipped = variable manquante (ex. prénom absent) -> remontés pour l'avertissement.
  const { recipients, skipped } = buildRecipients(input.category, input.paramMapping, contacts, { now: new Date() }, input.channel ?? 'whatsapp');
  const result = await repo.createWithRecipients(input, recipients);
  return { ...result, skipped };
}
