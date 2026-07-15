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

/** Destinataire écarté à la construction, avec le motif (variable(s) de template manquante(s) -> positions). */
export interface SkippedRecipient {
  contactId: string;
  toE164: string;
  reason: 'missing_variable';
  missing: number[];
}

export interface BuildResult {
  recipients: BuiltRecipient[];
  skipped: SkippedRecipient[];
}

/**
 * Construit la liste des destinataires d'une campagne : filtre l'opt-in (marketing), exige une identité (numéro OU
 * BSUID), dédup par identité, et résout les variables du template par contact. Un contact dont une variable est
 * MANQUANTE (ex. prénom absent) part dans `skipped` (jamais un envoi `text:''` rejeté par Meta) -> l'appelant
 * avertit « X contacts sautés ». Ne concerne que la voie DIRECTE (template) ; le workflow résout au runtime (worker).
 */
export function buildRecipients(
  category: CampaignCategory,
  paramMapping: TemplateParam[],
  contacts: BuildContact[],
): BuildResult {
  const seen = new Set<string>();
  const recipients: BuiltRecipient[] = [];
  const skipped: SkippedRecipient[] = [];
  for (const c of contacts) {
    const to = c.phone_e164 ?? c.bsuid ?? null; // destinataire = numéro sinon BSUID
    if (!to) continue; // campagne outbound -> identité requise
    if (!optInAllows(category, c)) continue;
    if (seen.has(to)) continue;
    seen.add(to);
    const { values, missing } = resolveTemplateParams(paramMapping, c);
    if (missing.length > 0) {
      skipped.push({ contactId: c.id, toE164: to, reason: 'missing_variable', missing });
      continue;
    }
    recipients.push({ contactId: c.id, toE164: to, resolvedParams: values });
  }
  return { recipients, skipped };
}
