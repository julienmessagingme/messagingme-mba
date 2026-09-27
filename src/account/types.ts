/** Types de persistance du compte (numéro principal, lien portail HubSpot), hors de la couche HTTP. */
/** Numéro principal de l'espace, avec le statut persisté (dernier pull connu). */
export interface PhoneNumberRecord {
  id: string;
  displayPhoneNumber: string | null;
  status: string | null;
  qualityRating: string | null;
  messagingLimitTier: string | null;
  nameStatus: string | null;
  codeVerificationStatus: string | null;
  throughputLevel: string | null;
  verifiedName: string | null;
  wabaHealthStatus: string | null;
  accountReviewStatus: string | null;
  businessVerificationStatus: string | null;
  marketingMessagesLiteApiStatus: string | null;
  ownerBusinessName: string | null;
  /** Synchro HubSpot active pour ce numéro (réglage admin). */
  hubspotConnected: boolean;
  /** Instant de mise en pause (texte). null = jamais activé ou actif ; non nul avec connected=false = en pause. */
  hubspotPausedAt: string | null;
  /** Instant où le numéro a été délié de l'espace (ISO). null = relié. */
  delieLe: string | null;
}

/**
 * Lien vers le portail HubSpot de l'espace (`mmhs.tenant_portals`). `connected=false` : aucun portail installé.
 * `hubDomain` peut être null (portail ancien ou domaine non renvoyé) : l'UI retombe sur `hubId`.
 */
export interface HubspotPortalLink {
  connected: boolean;
  hubId?: string;
  hubDomain?: string | null;
  /** Le portail a-t-il accordé le scope crm.lists.read (import de listes possible sans re-consentement) ? */
  listsScopeGranted?: boolean;
}
