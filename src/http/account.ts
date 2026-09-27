import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { computeAccountStatus, normalizeQuality, type AccountSignals, type QualityRating } from '../account/service';
import type { PullResult, PhoneStatusPatch } from '../account/pull';
import type { PhoneNumberRecord, HubspotPortalLink } from '../account/types';
import { espaceVerifie } from './scope';
import { messageDe } from '../lib/erreur';

// Ré-exportés : le serveur et les tests les importent par cette route.
export type { PhoneNumberRecord, HubspotPortalLink } from '../account/types';

export interface AccountRouteDeps {
  /** Numéro principal du tenant (avec statut persisté). null si le tenant n'a aucun numéro. */
  getPhoneNumber(tenantId: string): Promise<PhoneNumberRecord | null>;
  /**
   * La photo de profil WhatsApp du numéro, relue à l'affichage (l'URL de Meta est signée et expire). Son échec ne
   * fait jamais échouer la route : une pastille absente n'empêche personne de travailler.
   */
  photoNumero(tenantId: string, phoneNumberId: string): Promise<string | null>;
  /** Pull Graph live du statut (numéro + santé WABA du tenant). null = pas de tentative (pas de token). Ne throw jamais. */
  pullStatus(phoneNumberId: string, tenantId: string): Promise<PullResult | null>;
  /** Persiste le statut fraîchement pull (coalesce : n'écrase pas un connu par un undefined). */
  saveStatus(phoneNumberId: string, patch: PhoneStatusPatch): Promise<void>;
  /** Active/coupe/pause la synchro HubSpot d'un numéro (scopé tenant). `updated=false` si le numéro n'appartient pas
  *  au tenant ; `resumedFrom` non-null = on vient de reprendre depuis une pause -> déclencher le rattrapage. */
  setHubspotConnected(phoneNumberId: string, tenantId: string, connected: boolean): Promise<{ updated: boolean; resumedFrom: string | null }>;
  /** Enfile le rattrapage HubSpot (best-effort) à la reprise après pause. No-op si le pipeline analyse/push est inerte. */
  enqueueHubspotCatchup(tenantId: string): Promise<void>;
  /** Portail HubSpot lié à ce tenant (lecture cross-schema mmhs). `{ connected: false }` si aucun mapping. */
  getHubspotPortal(tenantId: string): Promise<HubspotPortalLink>;
  /** Déconnexion complète : délie le portail HubSpot côté connecteur (mm-hubspot révoque le token si dernier tenant).
  *  Optionnel : absent si le canal service n'est pas configuré -> la route répond 503. À appeler avant le reset local. */
  disconnectHubspot?(tenantId: string): Promise<{ disconnected: boolean; revoked: boolean }>;
  /** Reflet local de la déconnexion : coupe hubspot_connected de tous les numéros du tenant (après succès connecteur). */
  disconnectHubspotTenant(tenantId: string): Promise<{ updated: boolean }>;
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
  /**
   * Photo de profil WhatsApp du numéro (la pastille que voient les destinataires). `null` = aucune photo ou lecture
   * impossible, cas courant. L'URL est signée et expire : jamais stockée, elle se relit.
   */
  photoProfilUrl: string | null;
  /** Synchro HubSpot active pour le numéro principal (pastille + toggle). */
  hubspotConnected: boolean;
  /** Instant de pause : non-null + hubspotConnected=false -> « en pause » (vs « jamais activé » si null). */
  hubspotPausedAt: string | null;
  /** Portail HubSpot lié au tenant (mmhs.tenant_portals). Sert à afficher le portail branché ou le CTA « Connecter HubSpot ». */
  hubspotPortal: HubspotPortalLink;
  /**
   * Instant où le numéro a été délié de l'espace (ISO). `null` = relié, ou aucun numéro.
   * Délié, le numéro reste affiché : c'est ce qui permet de le relier d'un clic depuis l'Accueil.
   */
  delieLe: string | null;
  status: ReturnType<typeof computeAccountStatus>;
}

/**
 * Statut du compte WhatsApp (page Accueil) : numéro + pastille vert/ambre/rouge/gris + champs Meta enrichis
 * + drapeau HubSpot. Pull Graph live à chaque appel, persiste le résultat (rafraîchit en base), puis compose.
 * Un échec de pull ne fait jamais échouer la route (statut gris/rouge). Route admin-only (garde de groupe).
 */
export function registerAccount(app: FastifyInstance, deps: AccountRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  /**
   * Déconnexion complète du portail, partagée par ses deux portes (celle d'un numéro, celle de l'espace). On délie
   * le portail côté connecteur (qui révoque le token si dernier espace), puis on coupe en base seulement si l'appel
   * a réussi : l'inverse laisserait mba « coupé » pendant que le portail pousse encore. Tous les numéros de
   * l'espace passent coupés.
   */
  async function deconnecterPortail(tenant: string): Promise<{ ok: true; disconnected: boolean } | { ok: false; code: 502 | 503; error: string }> {
    if (!deps.disconnectHubspot) return { ok: false, code: 503, error: 'canal de déconnexion HubSpot indisponible' };
    let result: { disconnected: boolean; revoked: boolean };
    try {
      result = await deps.disconnectHubspot(tenant);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('disconnectHubspot (connecteur) échoué, reset local NON appliqué (anti-drift):', messageDe(err));
      // 502 gardé : c'est notre panne (le connecteur est un service à nous, déjà rejoué par `withRetry`), et l'écran
      // ne lit pas ce corps (il annule sa bascule optimiste). Le jour où il affichera `error`, ce code passe en 422.
      return { ok: false, code: 502, error: 'échec de la déconnexion côté connecteur HubSpot' };
    }
    await deps.disconnectHubspotTenant(tenant);
    return { ok: true, disconnected: result.disconnected };
  }

  /**
   * Déconnexion complète d'un espace sans numéro : un espace peut relier un portail sans numéro, et l'interrupteur
   * refuse de s'éteindre tant qu'un portail est relié ; sans cette porte, il l'enfermerait. Même geste que la porte
   * d'un numéro : `deconnecterPortail`.
   */
  app.post('/tenants/:tenantId/hubspot/deconnexion', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const r = await deconnecterPortail(tenant);
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    return reply.code(200).send({ hubspotConnected: false, disconnected: r.disconnected });
  });

  app.get('/tenants/:tenantId/account-status', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);

    // Portail HubSpot du tenant (lecture cross-schema mmhs). Au mieux : un échec (mmhs indisponible, colonne
    // pas encore migrée) ne fait jamais échouer la route -> on retombe sur « non connecté », comme le pull.
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
        photoProfilUrl: null,
        hubspotConnected: false,
        hubspotPausedAt: null,
        hubspotPortal,
        delieLe: null,
        status: { dot: 'grey', label: 'Aucun numéro', reason: "Aucun numéro WhatsApp n'est rattaché à ce compte." },
      };
      return reply.code(200).send(body);
    }

    // La pastille, en même temps que le pull (deux appels Meta indépendants, on ne les met pas en file).
    // `catch(() => null)` : voir la dépendance, une photo manquante ne vaut pas un Accueil en erreur.
    const [pull, photo] = await Promise.all([
      deps.pullStatus(pn.id, tenant),
      deps.photoNumero(tenant, pn.id).catch(() => null),
    ]);
    // Le pull frais est enregistré (en coalesce), sauf le numéro d'affichage, qui ne se réécrit pas d'ici.
    const frais = pull && pull.ok ? pull : undefined;
    if (frais) {
      const { ok: _ok, displayPhoneNumber: _affiche, ...patch } = frais;
      await deps.saveStatus(pn.id, patch);
    }
    // Valeurs affichées : le pull frais prime, sinon on retombe sur le dernier connu (persisté).
    const quality = normalizeQuality(frais?.qualityRating ?? pn.qualityRating);
    const numberStatus = frais?.status ?? pn.status ?? undefined;
    let signals: AccountSignals;
    if (frais) {
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
      number: frais?.displayPhoneNumber ?? pn.displayPhoneNumber ?? null,
      tier: frais?.messagingLimitTier ?? pn.messagingLimitTier ?? null,
      quality,
      numberStatus: numberStatus ?? null,
      nameStatus: frais?.nameStatus ?? pn.nameStatus ?? null,
      codeVerificationStatus: frais?.codeVerificationStatus ?? pn.codeVerificationStatus ?? null,
      throughputLevel: frais?.throughputLevel ?? pn.throughputLevel ?? null,
      verifiedName: frais?.verifiedName ?? pn.verifiedName ?? null,
      wabaHealthStatus: frais?.wabaHealthStatus ?? pn.wabaHealthStatus ?? null,
      accountReviewStatus: frais?.accountReviewStatus ?? pn.accountReviewStatus ?? null,
      businessVerificationStatus: frais?.businessVerificationStatus ?? pn.businessVerificationStatus ?? null,
      marketingMessagesLiteApiStatus: frais?.marketingMessagesLiteApiStatus ?? pn.marketingMessagesLiteApiStatus ?? null,
      ownerBusinessName: frais?.ownerBusinessName ?? pn.ownerBusinessName ?? null,
      photoProfilUrl: photo,
      hubspotConnected: pn.hubspotConnected,
      hubspotPausedAt: pn.hubspotPausedAt,
      hubspotPortal,
      delieLe: pn.delieLe,
      // Délié, la pastille le dit, au lieu d'un « opérationnel » vrai chez Meta et faux chez nous : cet espace
      // n'envoie ni ne reçoit plus rien par ce numéro.
      status: pn.delieLe
        ? { dot: 'grey', label: 'Numéro délié', reason: 'Numéro délié de cet espace : aucun message WhatsApp ne part, et les messages reçus ne sont pas enregistrés.' }
        : computeAccountStatus(signals),
    };
    return reply.code(200).send(body);
  });

  // Toggle HubSpot par numéro (admin) : coupe ou active vraiment la synchro (le worker gate le push d'analyse
  // sur ce drapeau). 🔴 Scopé espace en SQL : un admin ne peut pas basculer le numéro d'un autre client.
  app.patch('/tenants/:tenantId/phone-numbers/:phoneNumberId/hubspot', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { phoneNumberId } = req.params as { phoneNumberId: string };
    const body = (req.body ?? {}) as { connected?: unknown; action?: unknown };
    if (typeof body.connected !== 'boolean') return reply.code(400).send({ error: 'connected requis (booléen)' });
    if (body.action !== undefined && body.action !== 'pause' && body.action !== 'disconnect') {
      return reply.code(400).send({ error: "action invalide ('pause' ou 'disconnect')" });
    }
    // Déconnexion complète, uniquement en coupant : voir `deconnecterPortail`.
    if (body.action === 'disconnect') {
      if (body.connected !== false) return reply.code(400).send({ error: 'disconnect impose connected:false' });
      const r = await deconnecterPortail(tenant);
      if (!r.ok) return reply.code(r.code).send({ error: r.error });
      return reply.code(200).send({ phoneNumberId, hubspotConnected: false, disconnected: r.disconnected });
    }
    const { updated, resumedFrom } = await deps.setHubspotConnected(phoneNumberId, tenant, body.connected);
    if (!updated) return reply.code(404).send({ error: 'numéro inconnu pour ce tenant' });
    // Reprise après pause (resumedFrom non-null) -> déclenche le rattrapage. Au mieux : un échec d'enqueue ne fait
    // jamais échouer le toggle (les marques pending_catchup restent, un futur resume les rejouera).
    let catchupTriggered = false;
    if (resumedFrom !== null) {
      catchupTriggered = await deps.enqueueHubspotCatchup(tenant).then(() => true).catch((err) => {
        // Journalisé (pas silencieux) : le filet de sécurité (sweep worker) rejouera les marques restées, donc pas
        // de perte même si cet enqueue immédiat échoue.
        // eslint-disable-next-line no-console
        console.error('enqueueHubspotCatchup échoué (best-effort ; le sweep rattrapera):', messageDe(err));
        return false;
      });
    }
    return reply.code(200).send({ phoneNumberId, hubspotConnected: body.connected, catchupTriggered });
  });
}
