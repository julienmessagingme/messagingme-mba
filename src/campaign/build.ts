import { resolveTemplateParams } from '../crm/template';
import type { ResolvableContact, TemplateParam } from '../crm/template';
import { optInAllows } from './guardrails';
import type { CampaignCategory } from './types';

export interface BuildContact extends ResolvableContact {
  id: string;
  optInStatus: 'opted_in' | 'opted_out' | 'unknown';
}

export interface BuiltRecipient {
  contactId: string;
  toE164: string;
  resolvedParams: string[];
}

/**
 * Construit la liste des destinataires d'une campagne : filtre l'opt-in (marketing),
 * exige un numéro, dédup par numéro, et résout les variables du template par contact.
 */
export function buildRecipients(
  category: CampaignCategory,
  paramMapping: TemplateParam[],
  contacts: BuildContact[],
): BuiltRecipient[] {
  const seen = new Set<string>();
  const out: BuiltRecipient[] = [];
  for (const c of contacts) {
    const phone = c.phone_e164;
    if (!phone) continue; // campagne outbound -> numéro requis
    if (!optInAllows(category, c)) continue;
    if (seen.has(phone)) continue;
    seen.add(phone);
    out.push({ contactId: c.id, toE164: phone, resolvedParams: resolveTemplateParams(paramMapping, c) });
  }
  return out;
}
