import { resolveTemplateParams } from '../crm/template';
import type { ResolvableContact, TemplateParam } from '../crm/template';
import { optInAllows } from './guardrails';
import type { CampaignCategory } from './types';

export interface BuildContact extends ResolvableContact {
  id: string;
  /** BSUID (identité sans numéro). Le destinataire = phone_e164 sinon bsuid. */
  bsuid?: string | null;
  optInStatus: 'opted_in' | 'opted_out' | 'unknown';
}

export interface BuiltRecipient {
  contactId: string;
  toE164: string;
  resolvedParams: string[];
}

/**
 * Construit la liste des destinataires d'une campagne : filtre l'opt-in (marketing),
 * exige une identité (numéro OU BSUID), dédup par identité, et résout les variables du template par contact.
 */
export function buildRecipients(
  category: CampaignCategory,
  paramMapping: TemplateParam[],
  contacts: BuildContact[],
): BuiltRecipient[] {
  const seen = new Set<string>();
  const out: BuiltRecipient[] = [];
  for (const c of contacts) {
    const to = c.phone_e164 ?? c.bsuid ?? null; // destinataire = numéro sinon BSUID
    if (!to) continue; // campagne outbound -> identité requise
    if (!optInAllows(category, c)) continue;
    if (seen.has(to)) continue;
    seen.add(to);
    out.push({ contactId: c.id, toE164: to, resolvedParams: resolveTemplateParams(paramMapping, c) });
  }
  return out;
}
