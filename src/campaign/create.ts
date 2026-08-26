import { buildRecipients } from './build';
import type { BuildContact, BuiltRecipient, SkippedRecipient } from './build';
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
): Promise<{ campaignId: string; recipientCount: number; skipped: SkippedRecipient[] }> {
  // Campagne AU FIL DE L'EAU : elle naît VIDE, et c'est normal. Ses destinataires n'existent pas encore, ils
  // arriveront un par un par le webhook. Charger le CRM ici serait au mieux inutile, au pire trompeur : on
  // matérialiserait une liste que la campagne n'a jamais eu vocation à toucher.
  if (input.webhookId) {
    const cree = await repo.createWithRecipients(input, []);
    return { ...cree, skipped: [] };
  }
  const all = await repo.listContactsForBuild(input.tenantId);
  // Restreindre aux contacts choisis si une sélection est fournie (sinon tous). L'opt-in + le
  // numéro requis restent appliqués par buildRecipients : choisir un contact ne force pas l'envoi.
  const ids = input.contactIds && input.contactIds.length > 0 ? new Set(input.contactIds) : null;
  const contacts = ids ? all.filter((c) => ids.has(c.id)) : all;
  // recipients = envoyables ; skipped = variable manquante (ex. prénom absent) -> remontés pour l'avertissement.
  const { recipients, skipped } = buildRecipients(input.category, input.paramMapping, contacts, { now: new Date() }, input.channel ?? 'whatsapp');
  const result = await repo.createWithRecipients(input, recipients);
  return { ...result, skipped };
}
