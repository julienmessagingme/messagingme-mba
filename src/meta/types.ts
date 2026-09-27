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
 * Résout l'identité d'un destinataire en champ Meta : un numéro va dans `to`, un BSUID dans `recipient`.
 * Numéro = E.164 avec `+`, ou chiffres nus <= 15 (wa_id). BSUID = 16 chiffres et plus, ou alphanumérique.
 * Cohérent avec `classifyWaId` côté CRM. Source unique de routage pour tous les envois de template.
 */
export function messagingTarget(identity: string): { to: string } | { recipient: string } {
  const t = identity.trim();
  const isPhone = /^\+\d+$/.test(t) || /^\d{1,15}$/.test(t);
  return isPhone ? { to: t } : { recipient: t };
}
