import { resolveTemplateParams } from '../crm/template';
import type { ResolvableContact, TemplateParam, ResolveOpts } from '../crm/template';
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

/** Destinataire écarté à la construction, avec son MOTIF. */
export interface SkippedRecipient {
  contactId: string;
  toE164: string;
  /**
   * `missing_variable` : une variable du template n'a pas de valeur sur la fiche.
   * `not_opted_in` : campagne MARKETING sur un contact sans opt-in explicite (ou en opt-out).
   * `no_phone_number` : campagne RCS sur un contact identifié seulement par BSUID. Le RCS s'adresse à un
   * NUMÉRO ; envoyer un BSUID à un opérateur est un 400 garanti, et le compter « envoyé » est un mensonge.
   */
  reason: 'missing_variable' | 'not_opted_in' | 'no_phone_number';
  /** Positions des variables sans valeur. Renseigné pour `missing_variable` seulement. */
  missing?: number[];
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
  opts?: ResolveOpts,
  /** Canal de la campagne. Absent = 'whatsapp' : tous les appelants historiques gardent leur comportement. */
  channel: 'whatsapp' | 'rcs' = 'whatsapp',
): BuildResult {
  const seen = new Set<string>();
  const recipients: BuiltRecipient[] = [];
  const skipped: SkippedRecipient[] = [];
  for (const c of contacts) {
    const to = c.phone_e164 ?? c.bsuid ?? null; // destinataire = numéro sinon BSUID
    if (!to) continue; // campagne outbound -> identité requise
    // Le RCS s'adresse à un NUMÉRO. Un contact identifié seulement par BSUID (WhatsApp sans numéro) passerait
    // ici avec `toE164 = <bsuid>` : le provider le rejetterait en 400, et d'ici là il serait compté « envoyé ».
    // On l'écarte avec son motif, comme les autres écarts, plutôt que de le laisser mentir dans le rapport.
    if (channel === 'rcs' && !c.phone_e164) {
      skipped.push({ contactId: c.id, toE164: to, reason: 'no_phone_number' });
      continue;
    }
    // Écart RAPPORTÉ, et non silencieux : une campagne marketing sur une liste sans opt-in explicite rendait
    // 0 destinataire sans que rien ne dise pourquoi. Le motif était déjà nommé sur la voie API
    // (`buildApiRecipients`), il manquait sur la voie écran, qui est justement celle qu'un opérateur utilise.
    if (!optInAllows(category, c)) { skipped.push({ contactId: c.id, toE164: to, reason: 'not_opted_in' }); continue; }
    if (seen.has(to)) continue;
    seen.add(to);
    const { values, missing } = resolveTemplateParams(paramMapping, c, opts);
    if (missing.length > 0) {
      skipped.push({ contactId: c.id, toE164: to, reason: 'missing_variable', missing });
      continue;
    }
    recipients.push({ contactId: c.id, toE164: to, resolvedParams: values });
  }
  return { recipients, skipped };
}
