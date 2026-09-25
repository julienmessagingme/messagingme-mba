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
   * ⚠️ ELLE PEUT AVOIR PLUSIEURS ÉTAGES DEPUIS LE 2026-09-12, et ce commentaire a affirmé le contraire
   * (« à un seul étage aujourd'hui, toujours ») : `insertCampaignRow` écrit la chaîne complète que
   * l'assistant décrit, la bascule fait avancer `etage_courant`, et le moteur sert le canal de l'étage.
   *
   * ⚠️ LE RANG 1 RESTE REDONDANT avec `channel`, `templateName`, `rcsMessage` et `workflowId`, et c'est
   * volontaire : ces colonnes sont la SEULE source du contenu du rang 1 (invariant de la migration 0134,
   * `contenuDeLEtage`). Elles partiront dans une migration ULTÉRIEURE, elles sont encore lues.
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
  /**
   * L'ÉTAGE OÙ EN EST CE DESTINATAIRE dans la chaîne de sa campagne
   * (`campaign_recipients.etage_courant`, migration 0134).
   *
   * 🔴 ÉCRIT PAR LA BASCULE, LU PAR LE MOTEUR, et il a manqué le second pendant un lot : le balayage
   * faisait avancer le rang, personne ne s'en servait pour décider quoi envoyer, donc un repli renvoyait
   * le contenu du rang 1 sur le canal du rang 1, c'est-à-dire le message qui venait d'échouer.
   *
   * OPTIONNEL : absent veut dire « cet appelant ne le sait pas » (faux d'un test, câblage d'avant 0134),
   * et vaut alors `RANG_INITIAL`. La colonne, elle, est `not null default 1` : la base ne peut pas
   * l'omettre, seul un faux le peut.
   */
  etageCourant?: number;
  /**
   * Les variables propres à ce destinataire (API publique, `campaign_recipients.variables`, migration 0174).
   * `null` ou absent = aucune, le cas de toute campagne de la console. Relues par l'envoi d'un message RCS.
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
   * Le run s'est arrêté sur sa DURÉE MAXIMALE, et il reste des destinataires en attente (lot 5).
   *
   * Distinct de `paused` : personne n'a rien décidé, la campagne reste `running`, et l'appelant la réenfile
   * pour continuer. C'est ce qui empêche une campagne de 5 000 destinataires d'occuper la file pendant près
   * de trois heures pendant que celles des autres clients attendent.
   */
  reste?: boolean;
}
