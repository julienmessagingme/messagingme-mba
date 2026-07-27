import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { forbidNonAdmin } from '../auth/middleware';
import { computeAccountStatus, normalizeQuality, type AccountSignals, type QualityRating } from '../account/service';
import type { PullResult } from '../account/pull';

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

/** Sous-ensemble de champs persistables au pull (tout optionnel : coalesce à l'écriture). */
export type StatusPatch = {
  status?: string; qualityRating?: string; messagingLimitTier?: string;
  nameStatus?: string; codeVerificationStatus?: string; throughputLevel?: string; verifiedName?: string;
  wabaHealthStatus?: string; accountReviewStatus?: string; businessVerificationStatus?: string;
  marketingMessagesLiteApiStatus?: string; ownerBusinessName?: string;
};

export interface AccountRouteDeps {
  /** Numéro principal du tenant (avec statut persisté). null si le tenant n'a aucun numéro. */
  getPhoneNumber(tenantId: string): Promise<PhoneNumberRecord | null>;
  /** Pull Graph live du statut (numéro + santé WABA du tenant). null = pas de tentative (pas de token). Ne throw jamais. */
  pullStatus(phoneNumberId: string, tenantId: string): Promise<PullResult | null>;
  /** Persiste le statut fraîchement pull (coalesce : n'écrase pas un connu par un undefined). */
  saveStatus(phoneNumberId: string, patch: StatusPatch): Promise<void>;
  /** Active/coupe/pause la synchro HubSpot d'un numéro (scopé tenant). `updated=false` si le numéro n'appartient pas
   *  au tenant ; `resumedFrom` non-null = on vient de REPRENDRE depuis une pause -> déclencher le rattrapage. */
  setHubspotConnected(phoneNumberId: string, tenantId: string, connected: boolean): Promise<{ updated: boolean; resumedFrom: string | null }>;
  /** Enfile le rattrapage HubSpot (best-effort) à la reprise après pause. No-op si le pipeline analyse/push est inerte. */
  enqueueHubspotCatchup(tenantId: string): Promise<void>;
  /** Portail HubSpot lié à ce tenant (lecture cross-schema mmhs). `{ connected: false }` si aucun mapping. */
  getHubspotPortal(tenantId: string): Promise<HubspotPortalLink>;
  /** Déconnexion complète : délie le portail HubSpot côté connecteur (mm-hubspot révoque le token si dernier tenant).
   *  OPTIONNEL : absent si le canal service n'est pas configuré -> la route répond 503. À appeler AVANT le reset local. */
  disconnectHubspot?(tenantId: string): Promise<{ disconnected: boolean; revoked: boolean }>;
  /** Reflet LOCAL de la déconnexion : coupe hubspot_connected de TOUS les numéros du tenant (après succès connecteur). */
  disconnectHubspotTenant(tenantId: string): Promise<{ updated: boolean }>;
}

function scopeTenant(req: { params: unknown; auth?: { tenantId: string } }): string | null {
  const { tenantId } = req.params as { tenantId: string };
  const authTenant = req.auth?.tenantId;
  if (authTenant !== undefined && authTenant !== tenantId) return null;
  return authTenant ?? tenantId;
}

export interface AccountStatusResponse {
  hasNumber: boolean;
  /** Id Meta du numéro principal (requis côté front pour le PATCH du toggle HubSpot). null si aucun numéro. */
  phoneNumberId: string | null;
  number: string | null;
  tier: string | null;
  quality: QualityRating;
  numberStatus: string | null;
  /** Statut de vérification du nom (name_status). null = inconnu. */
  nameStatus: string | null;
  /** Vérification du numéro (code_verification_status). null = inconnu. */
  codeVerificationStatus: string | null;
  /** Débit d'envoi (throughput level). null = inconnu. */
  throughputLevel: string | null;
  /** Nom d'affichage vérifié (verified_name). null = inconnu. */
  verifiedName: string | null;
  /** Santé WABA (health_status.can_send_message). null = inconnu. */
  wabaHealthStatus: string | null;
  /** Revue du compte WABA (account_review_status). null = inconnu. */
  accountReviewStatus: string | null;
  /** Vérification d'entreprise (business_verification_status). null = inconnu. */
  businessVerificationStatus: string | null;
  /** Onboarding API MM Lite (marketing_messages_lite_api_status : "ONBOARDED" / autre). null = inconnu / non communiqué. */
  marketingMessagesLiteApiStatus: string | null;
  /** Nom du business propriétaire du WABA (owner_business_info.name). null = inconnu. */
  ownerBusinessName: string | null;
  /** Synchro HubSpot active pour le numéro principal (pastille + toggle). */
  hubspotConnected: boolean;
  /** Instant de pause (F3-a) : non-null + hubspotConnected=false -> « en pause » (vs « jamais activé » si null). */
  hubspotPausedAt: string | null;
  /** Portail HubSpot lié au tenant (mmhs.tenant_portals). Sert à afficher le portail branché ou le CTA « Connecter HubSpot ». */
  hubspotPortal: HubspotPortalLink;
  status: ReturnType<typeof computeAccountStatus>;
}

/**
 * Statut du compte WhatsApp (page Accueil) : numéro + pastille vert/ambre/rouge/gris + champs Meta enrichis
 * + drapeau HubSpot. Pull Graph live à chaque appel, persiste le résultat (rafraîchit en base), puis compose.
 * Un échec de pull ne fait JAMAIS échouer la route (statut gris/rouge). Route admin-only (guard de groupe).
 */
export function registerAccount(app: FastifyInstance, deps: AccountRouteDeps, requireAuth?: Guard): void {
  const guard = requireAuth ? { preHandler: requireAuth } : {};

  app.get('/tenants/:tenantId/account-status', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });

    // Portail HubSpot du tenant (lecture cross-schema mmhs). Best-effort : un échec (mmhs indisponible, colonne
    // pas encore migrée) NE fait JAMAIS échouer la route -> on retombe sur « non connecté », comme le pull.
    const hubspotPortal = await deps.getHubspotPortal(tenant).catch(() => ({ connected: false as const }));

    const pn = await deps.getPhoneNumber(tenant);
    if (!pn) {
      const body: AccountStatusResponse = {
        hasNumber: false,
        phoneNumberId: null,
        number: null,
        tier: null,
        quality: 'UNKNOWN',
        numberStatus: null,
        nameStatus: null,
        codeVerificationStatus: null,
        throughputLevel: null,
        verifiedName: null,
        wabaHealthStatus: null,
        accountReviewStatus: null,
        businessVerificationStatus: null,
        marketingMessagesLiteApiStatus: null,
        ownerBusinessName: null,
        hubspotConnected: false,
        hubspotPausedAt: null,
        hubspotPortal,
        status: { dot: 'grey', label: 'Aucun numéro', reason: "Aucun numéro WhatsApp n'est rattaché à ce compte." },
      };
      return reply.code(200).send(body);
    }

    const pull = await deps.pullStatus(pn.id, tenant);
    // Valeurs affichées : le pull frais prime, sinon on retombe sur le dernier connu (persisté).
    let quality = normalizeQuality(pn.qualityRating);
    let numberStatus = pn.status ?? undefined;
    let tier = pn.messagingLimitTier;
    let display = pn.displayPhoneNumber;
    let nameStatus = pn.nameStatus;
    let codeVerificationStatus = pn.codeVerificationStatus;
    let throughputLevel = pn.throughputLevel;
    let verifiedName = pn.verifiedName;
    let wabaHealthStatus = pn.wabaHealthStatus;
    let accountReviewStatus = pn.accountReviewStatus;
    let businessVerificationStatus = pn.businessVerificationStatus;
    let marketingMessagesLiteApiStatus = pn.marketingMessagesLiteApiStatus;
    let ownerBusinessName = pn.ownerBusinessName;
    let signals: AccountSignals;

    if (pull && pull.ok) {
      await deps.saveStatus(pn.id, {
        ...(pull.status !== undefined ? { status: pull.status } : {}),
        ...(pull.qualityRating !== undefined ? { qualityRating: pull.qualityRating } : {}),
        ...(pull.messagingLimitTier !== undefined ? { messagingLimitTier: pull.messagingLimitTier } : {}),
        ...(pull.nameStatus !== undefined ? { nameStatus: pull.nameStatus } : {}),
        ...(pull.codeVerificationStatus !== undefined ? { codeVerificationStatus: pull.codeVerificationStatus } : {}),
        ...(pull.throughputLevel !== undefined ? { throughputLevel: pull.throughputLevel } : {}),
        ...(pull.verifiedName !== undefined ? { verifiedName: pull.verifiedName } : {}),
        ...(pull.wabaHealthStatus !== undefined ? { wabaHealthStatus: pull.wabaHealthStatus } : {}),
        ...(pull.accountReviewStatus !== undefined ? { accountReviewStatus: pull.accountReviewStatus } : {}),
        ...(pull.businessVerificationStatus !== undefined ? { businessVerificationStatus: pull.businessVerificationStatus } : {}),
        ...(pull.marketingMessagesLiteApiStatus !== undefined ? { marketingMessagesLiteApiStatus: pull.marketingMessagesLiteApiStatus } : {}),
        ...(pull.ownerBusinessName !== undefined ? { ownerBusinessName: pull.ownerBusinessName } : {}),
      });
      quality = normalizeQuality(pull.qualityRating ?? pn.qualityRating);
      numberStatus = pull.status ?? numberStatus;
      tier = pull.messagingLimitTier ?? tier;
      display = pull.displayPhoneNumber ?? display;
      nameStatus = pull.nameStatus ?? nameStatus;
      codeVerificationStatus = pull.codeVerificationStatus ?? codeVerificationStatus;
      throughputLevel = pull.throughputLevel ?? throughputLevel;
      verifiedName = pull.verifiedName ?? verifiedName;
      wabaHealthStatus = pull.wabaHealthStatus ?? wabaHealthStatus;
      accountReviewStatus = pull.accountReviewStatus ?? accountReviewStatus;
      businessVerificationStatus = pull.businessVerificationStatus ?? businessVerificationStatus;
      marketingMessagesLiteApiStatus = pull.marketingMessagesLiteApiStatus ?? marketingMessagesLiteApiStatus;
      ownerBusinessName = pull.ownerBusinessName ?? ownerBusinessName;
      signals = { reachable: true, quality, numberStatus };
    } else if (pull && !pull.ok) {
      signals = { reachable: false, authError: pull.authError, quality, numberStatus };
    } else {
      // pull === null : pas de tentative live (token absent) -> statut sur le dernier connu, marqué indisponible.
      signals = { reachable: false, quality, numberStatus };
    }

    const body: AccountStatusResponse = {
      hasNumber: true,
      phoneNumberId: pn.id,
      number: display ?? null,
      tier: tier ?? null,
      quality,
      numberStatus: numberStatus ?? null,
      nameStatus: nameStatus ?? null,
      codeVerificationStatus: codeVerificationStatus ?? null,
      throughputLevel: throughputLevel ?? null,
      verifiedName: verifiedName ?? null,
      wabaHealthStatus: wabaHealthStatus ?? null,
      accountReviewStatus: accountReviewStatus ?? null,
      businessVerificationStatus: businessVerificationStatus ?? null,
      marketingMessagesLiteApiStatus: marketingMessagesLiteApiStatus ?? null,
      ownerBusinessName: ownerBusinessName ?? null,
      hubspotConnected: pn.hubspotConnected,
      hubspotPausedAt: pn.hubspotPausedAt,
      hubspotPortal,
      status: computeAccountStatus(signals),
    };
    return reply.code(200).send(body);
  });

  // Toggle HubSpot PAR numéro (admin-only) : coupe/active vraiment la synchro (le push d'analyse est gaté par
  // ce drapeau côté worker). Scopé tenant en SQL (un admin ne peut pas flipper le numéro d'un autre client).
  app.patch('/tenants/:tenantId/phone-numbers/:phoneNumberId/hubspot', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const { phoneNumberId } = req.params as { phoneNumberId: string };
    const body = (req.body ?? {}) as { connected?: unknown; action?: unknown };
    if (typeof body.connected !== 'boolean') return reply.code(400).send({ error: 'connected requis (booléen)' });
    if (body.action !== undefined && body.action !== 'pause' && body.action !== 'disconnect') {
      return reply.code(400).send({ error: "action invalide ('pause' ou 'disconnect')" });
    }
    // DÉCONNEXION COMPLÈTE (candidat 2), uniquement en COUPANT : on délie le portail côté connecteur (qui révoque le
    // token si dernier tenant) PUIS on coupe en base SEULEMENT si l'appel a réussi. Jamais l'inverse : couper en base
    // avant confirmation laisserait un drift (mba « coupé » alors que le portail pousse encore). La déconnexion est
    // tenant-wide (le portail est lié par tenant) -> tous les numéros du tenant passent coupés.
    if (body.action === 'disconnect') {
      if (body.connected !== false) return reply.code(400).send({ error: 'disconnect impose connected:false' });
      if (!deps.disconnectHubspot) return reply.code(503).send({ error: 'canal de déconnexion HubSpot indisponible' });
      let result: { disconnected: boolean; revoked: boolean };
      try {
        result = await deps.disconnectHubspot(tenant);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('disconnectHubspot (connecteur) échoué, reset local NON appliqué (anti-drift):', err instanceof Error ? err.message : err);
        return reply.code(502).send({ error: 'échec de la déconnexion côté connecteur HubSpot' });
      }
      await deps.disconnectHubspotTenant(tenant);
      return reply.code(200).send({ phoneNumberId, hubspotConnected: false, disconnected: result.disconnected });
    }
    const { updated, resumedFrom } = await deps.setHubspotConnected(phoneNumberId, tenant, body.connected);
    if (!updated) return reply.code(404).send({ error: 'numéro inconnu pour ce tenant' });
    // Reprise après pause (resumedFrom non-null) -> déclenche le rattrapage. BEST-EFFORT : un échec d'enqueue ne
    // fait JAMAIS échouer le toggle (le registre durable = les marques pending_catchup, un futur resume les rejouera).
    let catchupTriggered = false;
    if (resumedFrom !== null) {
      catchupTriggered = await deps.enqueueHubspotCatchup(tenant).then(() => true).catch((err) => {
        // Journalisé (pas silencieux) : le filet de sécurité (sweep worker) rejouera les marques restées, donc pas
        // de perte même si cet enqueue immédiat échoue.
        // eslint-disable-next-line no-console
        console.error('enqueueHubspotCatchup échoué (best-effort ; le sweep rattrapera):', err instanceof Error ? err.message : err);
        return false;
      });
    }
    return reply.code(200).send({ phoneNumberId, hubspotConnected: body.connected, catchupTriggered });
  });
}
