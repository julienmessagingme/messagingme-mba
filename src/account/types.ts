/**
 * Types de PERSISTANCE du compte (numéro principal, lien portail HubSpot). Ils vivaient dans la couche HTTP,
 * que le store importait : seule dépendance store -> http de tout `src/`, à rebours du sens habituel
 * (une route importe son store, jamais l'inverse).
 */
/** Numéro principal du tenant, avec le statut PERSISTÉ (dernier pull connu). */
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
  /** Synchro HubSpot active pour ce numéro (toggle admin). Le backfill 0028 met les numéros existants à true. */
  hubspotConnected: boolean;
  /** Instant de mise en PAUSE (timestamptz texte). null = jamais activé OU actif ; non-null + connected=false = en pause (F3-a). */
  hubspotPausedAt: string | null;
}

/**
 * Lien vers le portail HubSpot du tenant (mapping mmhs.tenant_portals). `connected=false` -> aucun portail installé
 * pour ce tenant (la console propose « Connecter HubSpot »). `hubDomain` = nom/domaine du portail (peut être null si
 * le portail a été installé avant la colonne hub_domain, ou domaine non renvoyé) -> l'UI retombe sur `hubId`.
 */
export interface HubspotPortalLink {
  connected: boolean;
  hubId?: string;
  hubDomain?: string | null;
  /** Le portail a-t-il accordé le scope crm.lists.read (import de listes possible sans re-consentement) ? */
  listsScopeGranted?: boolean;
}
