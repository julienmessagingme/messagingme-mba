import type { TemplateParam } from '../crm/template';

export type CampaignCategory = 'marketing' | 'utility';
export type CampaignStatus = 'draft' | 'running' | 'paused' | 'completed' | 'failed' | 'scheduled';
export type RecipientStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';
export type QualityRating = 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';

export interface Campaign {
  id: string;
  tenantId: string;
  phoneNumberId: string;
  category: CampaignCategory;
  /** Template à envoyer ('' pour une campagne workflow). */
  templateName: string;
  templateLanguage: string;
  paramMapping: TemplateParam[];
  status: CampaignStatus;
  /** Si présent : la campagne DÉMARRE ce workflow par destinataire (au lieu d'envoyer un template). */
  workflowId: string | null;
  /**
   * Cible NODE (/v1/sends, D-1) : avec `workflowId`, le run démarre à CE bloc au lieu de l'entrée du scénario.
   * La fenêtre 24 h a été vérifiée par destinataire à la création de l'envoi. null = comportement classique.
   */
  startNodeId: string | null;
  /** Débit max en messages/minute (1..80). null = aucun throttle (le run part au rythme boucle + latence Meta). */
  ratePerMinute: number | null;
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
