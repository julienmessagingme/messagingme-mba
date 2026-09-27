import type { TemplateParam } from '../crm/template';
import type { Etage } from './etages';

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
  /** Si présent : la campagne démarre ce workflow par destinataire (au lieu d'envoyer un template). */
  workflowId: string | null;
  /**
   * Cible node (/v1/sends) : avec `workflowId`, le run démarre à ce bloc au lieu de l'entrée du scénario. La
   * fenêtre 24 h a été vérifiée par destinataire à la création de l'envoi. null = comportement classique.
   */
  startNodeId: string | null;
  /** Débit max en messages/minute (1..80). null = aucun throttle (le run part au rythme boucle + latence Meta). */
  ratePerMinute: number | null;
  /** Canal d'envoi. Absent = 'whatsapp'. */
  channel?: 'whatsapp' | 'rcs';
  /** Agent RCS (`rcs_agents.agent_id`). Requis si `channel = 'rcs'`. */
  rcsAgentId?: string | null;
  /** Message RCS de la campagne, tel que validé à la création. Requis si `channel = 'rcs'`. */
  rcsMessage?: unknown;
  /**
   * Campagne au fil de l'eau : l'id du webhook entrant qui lui amène ses destinataires un par un. null = liste
   * figée à la création. Une telle campagne ne se termine pas quand sa file est vide, elle reste `running` en
   * attendant l'arrivant suivant.
   */
  webhookId?: string | null;
  /**
   * N'envoyer que pendant les heures d'ouverture de l'espace. Absent/false = l'envoi part à toute heure.
   * C'est une contrainte de la campagne, relue à chaque run, pas un mode de lancement : elle tient donc après
   * une reprise.
   */
  businessHoursOnly?: boolean;
  /**
   * La chaîne d'étages de la campagne, triée par rang.
   *
   * Le rang 1 reste redondant avec `channel`, `templateName`, `rcsMessage` et `workflowId`, qui sont la seule
   * source de son contenu (`contenuDeLEtage`).
   *
   * Optionnelle : `getCampaign` la rend toujours, mais un faux de test n'a rien à fournir. Absente veut dire
   * « cet appelant ne s'en sert pas », jamais « cette campagne n'a pas d'étage ».
   */
  chaine?: Etage[];
}

export interface Recipient {
  id: string;
  contactId: string;
  toE164: string;
  resolvedParams: string[];
  status: RecipientStatus;
  /**
   * L'étage où en est ce destinataire dans la chaîne (`campaign_recipients.etage_courant`), écrit par la
   * bascule et lu par le moteur pour décider quoi envoyer.
   *
   * Optionnel : absent veut dire « cet appelant ne le sait pas » (faux de test) et vaut `RANG_INITIAL`. La
   * colonne, elle, est `not null default 1`.
   */
  etageCourant?: number;
  /**
   * Les variables propres à ce destinataire (API publique, `campaign_recipients.variables`). `null` ou absent =
   * aucune, le cas de toute campagne de la console. Relues par l'envoi d'un message RCS.
   */
  variables?: Readonly<Record<string, string>> | null;
}

export interface GuardrailThresholds {
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
  /**
   * Le run s'est arrêté sur sa durée maximale et il reste des destinataires en attente. Distinct de `paused` :
   * la campagne reste `running` et l'appelant la réenfile, pour qu'une grosse campagne n'occupe pas la file
   * pendant que celles des autres clients attendent.
   */
  reste?: boolean;
}
