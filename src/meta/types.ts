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
