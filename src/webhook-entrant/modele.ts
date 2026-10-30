import type { RegleMapping } from './mapping';

/** Ce dont la route publique a besoin pour traiter un appel. */
export interface WebhookPublic {
  id: string;
  tenantId: string;
  enabled: boolean;
  /** Empreinte du secret d'en-tête, ou null si ce webhook n'en exige pas. */
  secretHash: string | null;
  mapping: RegleMapping[];
  createContact: boolean;
  /** Les contacts nés de ce webhook sont-ils consentants ? */
  optIn: boolean;
  /** Nom tracé dans `contacts.opt_in_source`. */
  name: string;
  /** null = ce webhook n'écrit que des champs, aucun scénario à déclencher. */
  automationId: string | null;
  /** Une campagne au fil de l'eau en cours attend-elle les arrivants de cette adresse ? */
  alimenteCampagne?: boolean;
}

/** Ce que l'écran d'administration affiche. Le secret n'en sort jamais. */
export interface WebhookRow {
  id: string;
  name: string;
  enabled: boolean;
  code: string;
  hasSecret: boolean;
  mapping: RegleMapping[];
  createContact: boolean;
  optIn: boolean;
  workflowId: string | null;
  startNodeId: string | null;
  cooldownSeconds: number | null;
  lastPayload: unknown;
  lastReceivedAt: string | null;
  contactsCreated: number;
  createdAt: string;
}

/** État complet écrit par la configuration. Le code et le secret sont générés ailleurs. */
export interface WebhookInput {
  name: string;
  enabled: boolean;
  mapping: RegleMapping[];
  createContact: boolean;
  optIn: boolean;
  /** null = aucun scénario : la ligne compagnon est supprimée. */
  workflowId: string | null;
  startNodeId: string | null;
  cooldownSeconds: number | null;
}

export type IssueCreationWebhook =
  | { kind: 'cree'; id: string; code: string }
  | { kind: 'scenario_inconnu' };

export type IssueModificationWebhook =
  | { kind: 'modifie' }
  | { kind: 'introuvable' }
  | { kind: 'scenario_inconnu' };

export type IssueSuppressionWebhook =
  | { kind: 'supprime' }
  | { kind: 'introuvable' }
  | { kind: 'campagne_vivante'; campagne: string };
