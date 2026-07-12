import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { computeAccountStatus, normalizeQuality, type AccountSignals, type QualityRating } from '../account/service';
import type { PullResult } from '../account/pull';

/** Numéro principal du tenant, avec le statut PERSISTÉ (dernier pull connu). */
export interface PhoneNumberRecord {
  id: string;
  displayPhoneNumber: string | null;
  status: string | null;
  qualityRating: string | null;
  messagingLimitTier: string | null;
}

export interface AccountRouteDeps {
  /** Numéro principal du tenant (avec statut persisté). null si le tenant n'a aucun numéro. */
  getPhoneNumber(tenantId: string): Promise<PhoneNumberRecord | null>;
  /** Pull Graph live du statut. null = pas de tentative (pas de token). Ne throw jamais. */
  pullStatus(phoneNumberId: string): Promise<PullResult | null>;
  /** Persiste le statut fraîchement pull (coalesce : n'écrase pas un connu par un undefined). */
  saveStatus(phoneNumberId: string, patch: { status?: string; qualityRating?: string; messagingLimitTier?: string }): Promise<void>;
}

function scopeTenant(req: { params: unknown; auth?: { tenantId: string } }): string | null {
  const { tenantId } = req.params as { tenantId: string };
  const authTenant = req.auth?.tenantId;
  if (authTenant !== undefined && authTenant !== tenantId) return null;
  return authTenant ?? tenantId;
}

export interface AccountStatusResponse {
  hasNumber: boolean;
  number: string | null;
  tier: string | null;
  quality: QualityRating;
  numberStatus: string | null;
  status: ReturnType<typeof computeAccountStatus>;
}

/**
 * Statut du compte WhatsApp (page Accueil) : numéro + pastille vert/ambre/rouge/gris.
 * Pull Graph live à chaque appel, persiste le résultat (rafraîchit quality/status/tier en base),
 * puis compose le statut. Un échec de pull ne fait JAMAIS échouer la route (statut gris/rouge).
 */
export function registerAccount(app: FastifyInstance, deps: AccountRouteDeps, requireAuth?: Guard): void {
  const guard = requireAuth ? { preHandler: requireAuth } : {};

  app.get('/tenants/:tenantId/account-status', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });

    const pn = await deps.getPhoneNumber(tenant);
    if (!pn) {
      const body: AccountStatusResponse = {
        hasNumber: false,
        number: null,
        tier: null,
        quality: 'UNKNOWN',
        numberStatus: null,
        status: { dot: 'grey', label: 'Aucun numéro', reason: "Aucun numéro WhatsApp n'est rattaché à ce compte." },
      };
      return reply.code(200).send(body);
    }

    const pull = await deps.pullStatus(pn.id);
    // Valeurs affichées : le pull frais prime, sinon on retombe sur le dernier connu (persisté).
    let quality = normalizeQuality(pn.qualityRating);
    let numberStatus = pn.status ?? undefined;
    let tier = pn.messagingLimitTier;
    let display = pn.displayPhoneNumber;
    let signals: AccountSignals;

    if (pull && pull.ok) {
      await deps.saveStatus(pn.id, {
        ...(pull.status !== undefined ? { status: pull.status } : {}),
        ...(pull.qualityRating !== undefined ? { qualityRating: pull.qualityRating } : {}),
        ...(pull.messagingLimitTier !== undefined ? { messagingLimitTier: pull.messagingLimitTier } : {}),
      });
      quality = normalizeQuality(pull.qualityRating ?? pn.qualityRating);
      numberStatus = pull.status ?? numberStatus;
      tier = pull.messagingLimitTier ?? tier;
      display = pull.displayPhoneNumber ?? display;
      signals = { reachable: true, quality, numberStatus };
    } else if (pull && !pull.ok) {
      signals = { reachable: false, authError: pull.authError, quality, numberStatus };
    } else {
      // pull === null : pas de tentative live (token absent) -> statut sur le dernier connu, marqué indisponible.
      signals = { reachable: false, quality, numberStatus };
    }

    const body: AccountStatusResponse = {
      hasNumber: true,
      number: display ?? null,
      tier: tier ?? null,
      quality,
      numberStatus: numberStatus ?? null,
      status: computeAccountStatus(signals),
    };
    return reply.code(200).send(body);
  });
}
