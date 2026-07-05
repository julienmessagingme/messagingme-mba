import type { TemplateParam } from '../crm/template';

export type CampaignCategory = 'marketing' | 'utility';
export type CampaignStatus = 'draft' | 'running' | 'paused' | 'completed' | 'failed';
export type RecipientStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';
export type QualityRating = 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';

export interface Campaign {
  id: string;
  tenantId: string;
  phoneNumberId: string;
  category: CampaignCategory;
  templateName: string;
  templateLanguage: string;
  paramMapping: TemplateParam[];
  status: CampaignStatus;
}

export interface Recipient {
  id: string;
  contactId: string;
  toE164: string;
  resolvedParams: string[];
  status: RecipientStatus;
}

export interface GuardrailThresholds {
  /** Fenêtre de fréquence par contact (ms). */
  frequencyWindowMs: number;
  /** Taux d'échec au-delà duquel on met la campagne en pause. */
  maxFailureRate: number;
  /** Nb d'envois minimum avant d'évaluer le taux d'échec. */
  minSendsForFailureCheck: number;
}

export interface RunReport {
  sent: number;
  skipped: number;
  failed: number;
  paused: boolean;
  reason?: string;
}
