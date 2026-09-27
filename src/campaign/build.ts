import { resolveTemplateParams } from '../crm/template';
import type { ResolvableContact, TemplateParam, ResolveOpts } from '../crm/template';
import { optInAllows } from './guardrails';
import type { CampaignCategory } from './types';

export interface BuildContact extends ResolvableContact {
  id: string;
  /** BSUID (identité sans numéro). Le destinataire = phone_e164 sinon bsuid. */
  bsuid?: string | null;
  optInStatus: 'opted_in' | 'opted_out' | 'unknown';
  /**
   * Les variables propres à ce destinataire d'un envoi de l'API publique : ni lues ni écrites sur la fiche,
   * elles vivent avec l'envoi. Absentes pour la console.
   */
  variables?: Readonly<Record<string, string>>;
}

/**
 * Un contact vu par un envoi de l'API publique : ce que la construction lit, plus ce qui l'écarte avec un
 * motif. `bloque` est lu, jamais filtré : la lecture de la console retire les bloqués, l'API doit les rapporter.
 */
export interface ContactEnvoi extends BuildContact {
  /** `blocked_at is not null` : écarté `blocked_contact`. */
  bloque: boolean;
  /** `rcs_optout_at is not null` : STOP reçu en RCS, écarté `opted_out` sur une ouverture RCS. */
  rcsDesabonne: boolean;
}

export interface BuiltRecipient {
  contactId: string;
  toE164: string;
  resolvedParams: string[];
  /** Gardées avec le destinataire : relues à l'envoi d'un message RCS et au renvoi. */
  variables?: Readonly<Record<string, string>>;
}

/** Destinataire écarté à la construction, avec son motif. */
export interface SkippedRecipient {
  contactId: string;
  toE164: string;
  /**
   * `missing_variable` : une variable du template n'a pas de valeur sur la fiche.
   * `not_opted_in` : campagne marketing sur un contact sans opt-in explicite (ou en opt-out).
   * `no_phone_number` : campagne RCS sur un contact identifié seulement par BSUID (le RCS exige un numéro).
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
 * Construit la liste des destinataires d'une campagne : filtre l'opt-in (marketing), exige une identité (numéro
 * ou BSUID), dédoublonne par identité et résout les variables du template. Un contact dont une variable manque
 * part dans `skipped` (jamais un envoi `text:''` rejeté par Meta). Voie directe (template) seulement : le
 * scénario résout au runtime.
 */
export function buildRecipients(
  category: CampaignCategory,
  paramMapping: TemplateParam[],
  contacts: BuildContact[],
  opts?: ResolveOpts,
  /** Canal de la campagne, 'whatsapp' par défaut. */
  channel: 'whatsapp' | 'rcs' = 'whatsapp',
): BuildResult {
  const seen = new Set<string>();
  const recipients: BuiltRecipient[] = [];
  const skipped: SkippedRecipient[] = [];
  for (const c of contacts) {
    const to = c.phone_e164 ?? c.bsuid ?? null; // destinataire = numéro sinon BSUID
    if (!to) continue; // campagne outbound -> identité requise
    // Le RCS s'adresse à un numéro : un contact identifié par BSUID serait rejeté en 400 par le provider après
    // avoir été compté « envoyé ». On l'écarte avec son motif.
    if (channel === 'rcs' && !c.phone_e164) {
      skipped.push({ contactId: c.id, toE164: to, reason: 'no_phone_number' });
      continue;
    }
    // Écart rapporté : sinon une campagne marketing sans opt-in rend 0 destinataire sans dire pourquoi.
    if (!optInAllows(category, c)) { skipped.push({ contactId: c.id, toE164: to, reason: 'not_opted_in' }); continue; }
    if (seen.has(to)) continue;
    seen.add(to);
    const { values, missing } = resolveTemplateParams(paramMapping, c, c.variables ? { ...opts, variables: c.variables } : opts);
    if (missing.length > 0) {
      skipped.push({ contactId: c.id, toE164: to, reason: 'missing_variable', missing });
      continue;
    }
    recipients.push({ contactId: c.id, toE164: to, resolvedParams: values, ...(c.variables ? { variables: c.variables } : {}) });
  }
  return { recipients, skipped };
}
