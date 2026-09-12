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
  /** Si présent : la campagne DÉMARRE ce workflow par destinataire (au lieu d'envoyer un template). */
  workflowId: string | null;
  /**
   * Cible NODE (/v1/sends, D-1) : avec `workflowId`, le run démarre à CE bloc au lieu de l'entrée du scénario.
   * La fenêtre 24 h a été vérifiée par destinataire à la création de l'envoi. null = comportement classique.
   */
  startNodeId: string | null;
  /** Débit max en messages/minute (1..80). null = aucun throttle (le run part au rythme boucle + latence Meta). */
  ratePerMinute: number | null;
  /** Canal d'envoi. Absent = 'whatsapp' (campagnes créées avant la migration 0056). */
  channel?: 'whatsapp' | 'rcs';
  /** Agent RCS (`rcs_agents.agent_id`). Requis si `channel = 'rcs'`. */
  rcsAgentId?: string | null;
  /** Message RCS de la campagne, tel que validé à la création. Requis si `channel = 'rcs'`. */
  rcsMessage?: unknown;
  /**
   * Campagne AU FIL DE L'EAU : l'id du webhook entrant qui lui amène ses destinataires un par un, à mesure
   * qu'ils arrivent. null = campagne ordinaire, dont la liste est figée à la création.
   *
   * Une seule décision du moteur en dépend, et elle est décisive : une campagne au fil de l'eau ne se TERMINE
   * pas quand sa file est vide, elle reste `running` en attendant l'arrivant suivant.
   */
  webhookId?: string | null;
  /**
   * N'envoyer QUE pendant les heures d'ouverture de l'espace (migration 0122). Absent/false = comportement
   * historique, l'envoi part quelle que soit l'heure.
   *
   * Vaut pour « maintenant » COMME pour « plus tard » : ce n'est pas un mode de lancement, c'est une
   * contrainte de la campagne, relue à chaque run. C'est ce qui la fait tenir après une reprise, alors qu'un
   * choix porté par le lancement se serait perdu à la première pause.
   */
  businessHoursOnly?: boolean;
  /**
   * LA CHAÎNE D'ÉTAGES de la campagne (migration 0134), triée par rang.
   *
   * ⚠️ À UN SEUL ÉTAGE AUJOURD'HUI, TOUJOURS, et c'est ce qui rend ce lot invisible : `rangSuivant` rend
   * alors null, donc aucune bascule n'est possible et le moteur suit exactement le chemin d'avant. La
   * chaîne est REDONDANTE avec `channel`, `templateName`, `rcsMessage` et `workflowId` tant que le
   * formulaire de création n'a pas basculé dessus ; elle devient la seule source quand ce sera fait, et
   * les colonnes d'origine partiront dans une migration ULTÉRIEURE (elles sont encore lues).
   *
   * OPTIONNELLE : `getCampaign` la rend toujours, mais un faux câblé par un test n'a rien à fournir. Absente
   * veut donc dire « cet appelant ne s'en sert pas », jamais « cette campagne n'a pas d'étage ».
   */
  chaine?: Etage[];
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
  /**
   * Le run s'est arrêté sur sa DURÉE MAXIMALE, et il reste des destinataires en attente (lot 5).
   *
   * Distinct de `paused` : personne n'a rien décidé, la campagne reste `running`, et l'appelant la réenfile
   * pour continuer. C'est ce qui empêche une campagne de 5 000 destinataires d'occuper la file pendant près
   * de trois heures pendant que celles des autres clients attendent.
   */
  reste?: boolean;
}
