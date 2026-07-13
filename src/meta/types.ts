export interface SendResult {
  messageId: string;
}

export interface TemplateSpec {
  name: string;
  /** Code langue, ex. "fr" ou "fr_FR". */
  language: string;
  components?: unknown[];
}

export interface MarketingParams {
  /** Numéro E.164 (prioritaire si `recipient` aussi fourni). */
  to?: string;
  /** BSUID (business-scoped user ID). */
  recipient?: string;
  template: TemplateSpec;
}

/**
 * Résout l'identité d'un destinataire en champ Meta : un NUMÉRO va dans `to`, un BSUID dans `recipient`.
 * Numéro = E.164 avec `+` (campagne : `+33…`) OU chiffres nus <= 15 (wa_id webhook/workflow : `33…`).
 * BSUID = 16 chiffres et + OU alphanumérique (jamais avec `+`). Cohérent avec `classifyWaId` côté CRM, qui
 * n'émet jamais un BSUID court purement numérique. Source UNIQUE de routage pour tous les envois de template.
 */
export function messagingTarget(identity: string): { to: string } | { recipient: string } {
  const t = identity.trim();
  const isPhone = /^\+\d+$/.test(t) || /^\d{1,15}$/.test(t);
  return isPhone ? { to: t } : { recipient: t };
}
