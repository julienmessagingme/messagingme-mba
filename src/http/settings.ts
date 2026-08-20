import type { FastifyInstance } from 'fastify';
import { forbidNonAdmin } from '../auth/middleware';
import type { Guard } from '../auth/middleware';
import type { TenantSettings, MbaHandoffMode } from '../settings/store.pg';
import type { BusinessHours, DayHours } from '../workflow/conditions';
import { withinBusinessHours } from '../workflow/conditions';
import { scopeTenant } from './scope';

export interface SettingsRouteDeps {
  getSettings(tenantId: string): Promise<TenantSettings>;
  /**
   * Le canal RCS est-il exploitable pour ce tenant ? Vrai dès qu'un agent RCS lui est rattaché. Volontairement
   * DÉRIVÉ de l'état réel plutôt que porté par un réglage à basculer : le jour où l'agent est validé et
   * enregistré, l'outil s'allume seul, et il n'existe aucun état où l'interface promet un canal qui ne peut
   * pas envoyer. Absent du câblage -> false, donc briques éteintes.
   */
  rcsEnabledFor?(tenantId: string): Promise<boolean>;
  setMbaEnabled(tenantId: string, enabled: boolean): Promise<void>;
  setHubspotListsEnabled(tenantId: string, enabled: boolean): Promise<void>;
  /** Auto-relance des échecs de livraison (F6). */
  setAutoRetryEnabled(tenantId: string, enabled: boolean): Promise<void>;
  /** Durée du gel après prise de main par un opérateur, en secondes. null = défaut du serveur. */
  setControlHandbackSeconds(tenantId: string, seconds: number | null): Promise<void>;
  /** Quand l'agent de Meta passe la main à un humain (écran « Activation »). */
  setMbaHandoffMode(tenantId: string, mode: MbaHandoffMode): Promise<void>;
  /**
   * Applique `handoff.enabled` chez Meta. Optionnelle : absente, le choix est enregistré en base et c'est le
   * balayage qui l'appliquera. Best-effort : un échec ne fait PAS échouer l'enregistrement, sinon Meta
   * injoignable empêcherait le client de régler son propre outil.
   */
  applyMbaHandoffEnabled?(tenantId: string, enabled: boolean): Promise<void>;
  /** Fuseau IANA du tenant. */
  setTimezone(tenantId: string, timezone: string): Promise<void>;
  /** Heures d'ouverture par jour ('0'..'6'). */
  setBusinessHours(tenantId: string, hours: BusinessHours): Promise<void>;
}

/** Fuseau IANA valide ? (Intl throw sur un identifiant inconnu.) */
function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.trim() === '') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Normalise/valide les heures d'ouverture d'un corps hostile : 7 jours '0'..'6', HH:MM valides, close > open si
 *  ouvert. null si invalide (une plage cassée est rejetée, pas silencieusement corrigée). */
function normalizeBusinessHours(raw: unknown): BusinessHours | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: BusinessHours = {};
  for (let d = 0; d <= 6; d += 1) {
    const day = r[String(d)];
    if (!day || typeof day !== 'object') return null;
    const dd = day as Record<string, unknown>;
    const closed = dd.closed === true;
    if (closed) { out[String(d)] = { closed: true, open: '', close: '' }; continue; }
    const open = String(dd.open ?? '');
    const close = String(dd.close ?? '');
    if (!HHMM.test(open) || !HHMM.test(close)) return null;
    if (close <= open) return null; // plage vide/inversée -> refus
    out[String(d)] = { closed: false, open, close } satisfies DayHours;
  }
  return out;
}

/** Réglages tenant : GET ouvert (lecture), PUT admin-only (toggle MBA). */
export function registerSettings(app: FastifyInstance, deps: SettingsRouteDeps, requireAuth?: Guard): void {
  const guard = requireAuth ? { preHandler: requireAuth } : {};

  app.get('/tenants/:tenantId/settings', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const settings = await deps.getSettings(tenant);
    const rcsEnabled = deps.rcsEnabledFor ? await deps.rcsEnabledFor(tenant) : false;
    return reply.code(200).send({ ...settings, rcsEnabled });
  });

  app.put('/tenants/:tenantId/settings', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const mbaEnabled = (req.body as { mbaEnabled?: unknown } | null)?.mbaEnabled;
    if (typeof mbaEnabled !== 'boolean') return reply.code(400).send({ error: 'mbaEnabled (booléen) requis' });
    await deps.setMbaEnabled(tenant, mbaEnabled);
    return reply.code(200).send({ mbaEnabled });
  });

  // Toggle « Campagnes via données HubSpot » (admin-only). Route dédiée pour ne pas surcharger le PUT ci-dessus
  // (qui exige mbaEnabled). OFF -> aucun appel au connecteur ; ON -> le client devra re-consentir crm.lists.read.
  app.patch('/tenants/:tenantId/settings/hubspot-lists', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const enabled = (req.body as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled !== 'boolean') return reply.code(400).send({ error: 'enabled (booléen) requis' });
    await deps.setHubspotListsEnabled(tenant, enabled);
    return reply.code(200).send({ hubspotListsEnabled: enabled });
  });

  // Toggle « Auto-relance des échecs » (F6, admin-only). Route dédiée (même raison que ci-dessus).
  app.patch('/tenants/:tenantId/settings/auto-retry', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const enabled = (req.body as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled !== 'boolean') return reply.code(400).send({ error: 'enabled (booléen) requis' });
    await deps.setAutoRetryEnabled(tenant, enabled);
    return reply.code(200).send({ autoRetryEnabled: enabled });
  });

  /**
   * Durée du GEL d'une conversation après qu'un opérateur a pris la main : pendant ce temps, ni le
   * scénario ni l'agent de Meta n'écrivent au client. Route dédiée, même raison que ci-dessus.
   *
   * `null` remet le défaut du serveur. `0` supprime la reprise automatique : la conversation reste à
   * l'humain jusqu'à ce qu'il la rende, ce qui est un choix légitime mais qui déplace la responsabilité
   * sur l'opérateur.
   *
   * Borne haute à 7 jours : au-delà, ce n'est plus un gel, c'est un abandon, et la conversation
   * n'apparaîtrait nulle part comme problématique. Mieux vaut refuser que d'accepter en silence une
   * valeur qui casse la promesse « le client finit toujours par avoir une réponse ».
   */
  app.patch('/tenants/:tenantId/settings/control-handback', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const raw = (req.body as { seconds?: unknown } | null)?.seconds;
    if (raw === null) {
      await deps.setControlHandbackSeconds(tenant, null);
      return reply.code(200).send({ controlHandbackSeconds: null });
    }
    const MAX = 7 * 24 * 3600;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > MAX) {
      return reply.code(400).send({ error: `seconds invalide (entier 0..${MAX}, ou null pour le défaut)` });
    }
    await deps.setControlHandbackSeconds(tenant, raw);
    return reply.code(200).send({ controlHandbackSeconds: raw });
  });

  /**
   * Quand l'agent de Meta passe-t-il la main à un humain ? (admin-only, route dédiée comme ses voisines).
   *
   * Le choix est enregistré en base D'ABORD : c'est lui la source de vérité, et le balayage s'en sert pour
   * faire varier `business_hours` au fil de la journée. L'écriture chez Meta suit, en best-effort, pour que
   * le réglage soit vrai immédiatement plutôt qu'au prochain passage du balayage. Un échec côté Meta ne fait
   * pas échouer l'enregistrement : le balayage rattrapera, et refuser le réglage parce que Meta hoquette
   * empêcherait le client de piloter son propre outil.
   *
   * ⚠️ `enabled` ne décide PAS si l'agent transfère (il décide seul), mais s'il LÂCHE le fil ensuite. C'est
   * pourquoi « jamais » ne coupe pas les transferts : il laisse l'agent garder la conversation.
   */
  app.patch('/tenants/:tenantId/settings/mba-handoff', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const mode = (req.body as { mode?: unknown } | null)?.mode;
    if (mode !== 'always' && mode !== 'business_hours' && mode !== 'never') {
      return reply.code(400).send({ error: "mode invalide ('always' | 'business_hours' | 'never')" });
    }
    await deps.setMbaHandoffMode(tenant, mode);
    let applique = false;
    if (deps.applyMbaHandoffEnabled) {
      // Pour `business_hours` seulement, l'état À CET INSTANT : le client règle souvent son outil pendant ses
      // heures d'ouverture, et verrait sinon un passage de main éteint jusqu'au balayage suivant. Les deux
      // autres modes n'ont pas besoin de relire les horaires.
      let voulu = mode === 'always';
      if (mode === 'business_hours') {
        const s = await deps.getSettings(tenant);
        voulu = withinBusinessHours(new Date(), s.timezone, s.businessHours);
      }
      try {
        await deps.applyMbaHandoffEnabled(tenant, voulu);
        applique = true;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`mba-handoff: application chez Meta impossible pour ${tenant}:`, err instanceof Error ? err.message : err);
      }
    }
    return reply.code(200).send({ mbaHandoffMode: mode, appliqueChezMeta: applique });
  });


  // Fuseau horaire du tenant (admin-only). Base de NOW / weekday / heures d'ouverture du node condition.
  app.patch('/tenants/:tenantId/settings/timezone', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const tz = (req.body as { timezone?: unknown } | null)?.timezone;
    if (!isValidTimeZone(tz)) return reply.code(400).send({ error: 'timezone IANA invalide (ex. Europe/Paris)' });
    await deps.setTimezone(tenant, tz);
    return reply.code(200).send({ timezone: tz });
  });

  // Heures d'ouverture par jour (admin-only). Corps { '0'..'6': { closed, open 'HH:MM', close 'HH:MM' } }.
  app.patch('/tenants/:tenantId/settings/business-hours', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const hours = normalizeBusinessHours((req.body as { businessHours?: unknown } | null)?.businessHours);
    if (hours === null) return reply.code(400).send({ error: 'businessHours invalide (7 jours, HH:MM, close > open)' });
    await deps.setBusinessHours(tenant, hours);
    return reply.code(200).send({ businessHours: hours });
  });
}
