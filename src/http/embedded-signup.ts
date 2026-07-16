import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';

export interface EmbeddedSignupRouteDeps {
  /** config_id de la configuration ES (dashboard Meta, Facebook Login for Business). Vide -> feature OFF. */
  configId: string;
  /** App ID Meta (public : sert au FB.init du front). */
  appId: string;
  graphVersion: string;
  exchangeCode(code: string): Promise<string>;
  /** Preuve d'appartenance du WABA (GET /{waba_id} avec le business token) : throw si le token ne le possède pas. */
  verifyWaba(wabaId: string, businessToken: string): Promise<void>;
  getPhone(phoneNumberId: string, businessToken: string): Promise<{ displayPhoneNumber: string | null; verifiedName: string | null; status: string | null }>;
  subscribeApp(wabaId: string, businessToken: string): Promise<void>;
  register(phoneNumberId: string, businessToken: string, pin: string): Promise<void>;
  link(input: { tenantId: string; wabaId: string; phoneNumberId: string; displayPhoneNumber: string | null; verifiedName: string | null }): Promise<void>;
  /** Persiste le token business (le câblage chiffre AVANT, la route ne voit jamais le stockage en clair). */
  saveCredentials(wabaId: string, tenantId: string, businessToken: string, pin: string | null): Promise<void>;
}

function scopeTenant(req: { params: unknown; auth?: { tenantId: string } }): string | null {
  const { tenantId } = req.params as { tenantId: string };
  const authTenant = req.auth?.tenantId;
  if (authTenant !== undefined && authTenant !== tenantId) return null;
  return authTenant ?? tenantId;
}
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/**
 * Embedded Signup (Tech Provider), admin-only. Deux routes :
 *  - GET  /embedded-signup/config   : de quoi le front lance la popup (appId + configId publics, pas de secret).
 *  - POST /embedded-signup/complete : reçoit { code, wabaId, phoneNumberId } de la popup (code TTL 30 s !),
 *    échange le code -> business token, rattache WABA + numéro au workspace, abonne les webhooks, register si
 *    numéro neuf (jamais pour un numéro déjà CONNECTED), stocke le token chiffré. Les étapes NON bloquantes qui
 *    échouent remontent en `warnings` (jamais de demi-échec silencieux).
 */
export function registerEmbeddedSignup(app: FastifyInstance, deps: EmbeddedSignupRouteDeps, guard?: Guard): void {
  const opts = guard ? { preHandler: guard } : {};

  app.get('/tenants/:tenantId/embedded-signup/config', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const enabled = deps.configId !== '' && deps.appId !== '';
    return reply.code(200).send({ enabled, appId: deps.appId, configId: deps.configId, graphVersion: deps.graphVersion });
  });

  app.post('/tenants/:tenantId/embedded-signup/complete', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (deps.configId === '') return reply.code(503).send({ error: 'Embedded Signup non configuré (META_ES_CONFIG_ID)' });
    const b = (req.body ?? {}) as { code?: unknown; wabaId?: unknown; phoneNumberId?: unknown };
    if (!nonEmpty(b.code) || !nonEmpty(b.wabaId) || !nonEmpty(b.phoneNumberId)) {
      return reply.code(400).send({ error: 'code, wabaId et phoneNumberId requis' });
    }
    const code = b.code.trim();
    const wabaId = b.wabaId.trim();
    const phoneNumberId = b.phoneNumberId.trim();

    // 1. Code -> business token. Échec = rien n'est rattaché (le code a un TTL de 30 s : re-cliquer suffit).
    let businessToken: string;
    try {
      businessToken = await deps.exchangeCode(code);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ error: `échange du code Meta échoué : ${msg}` });
    }

    // 2. PREUVE D'APPARTENANCE (garde anti-hijack cross-tenant) : le business token est scopé au client qui a
    //    complété l'ES ; il ne peut lire le WABA et le numéro QUE s'ils lui appartiennent. Ces deux appels sont
    //    BLOQUANTS : si l'un échoue, le token ne possède pas l'asset demandé -> 502 et on ne persiste RIEN (ni
    //    rattachement, ni webhooks, ni register, ni token). Sans ça, un tenant pourrait rattacher les assets d'un
    //    autre en forgeant wabaId/phoneNumberId. `getPhone` renvoie aussi le vrai `status` (décide du register).
    let phone: { displayPhoneNumber: string | null; verifiedName: string | null; status: string | null };
    try {
      await deps.verifyWaba(wabaId, businessToken);
      phone = await deps.getPhone(phoneNumberId, businessToken);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ error: `le compte Meta connecté ne donne pas accès à ce numéro/WABA : ${msg}` });
    }

    const warnings: string[] = [];
    // 3. Rattachement au workspace (réaffecte si le numéro était sur un autre workspace).
    await deps.link({ tenantId: tenant, wabaId, phoneNumberId, displayPhoneNumber: phone.displayPhoneNumber, verifiedName: phone.verifiedName });

    // 4. Webhooks du WABA -> notre app (idempotent). Échec = averti (sans webhooks : ni statuts ni réponses).
    try {
      await deps.subscribeApp(wabaId, businessToken);
    } catch (err) {
      warnings.push(`abonnement webhooks : ${err instanceof Error ? err.message : String(err)}`);
    }

    // 5. Register : SEULEMENT si le numéro n'est pas déjà sur la Cloud API (numéro neuf). PIN généré et conservé
    //    (c'est le PIN 2FA du numéro : nécessaire aux re-régistrations).
    let pin: string | null = null;
    if (phone.status !== 'CONNECTED') {
      pin = String(randomInt(100000, 1000000)); // PIN 2FA du numéro : CSPRNG (cohérent avec le reste du repo)
      try {
        await deps.register(phoneNumberId, businessToken, pin);
      } catch (err) {
        warnings.push(`register du numéro : ${err instanceof Error ? err.message : String(err)}`);
        pin = null; // le pin n'a pas été posé -> ne pas le stocker comme s'il l'était
      }
    }

    // 6. Token business conservé (chiffré au repos par le câblage).
    await deps.saveCredentials(wabaId, tenant, businessToken, pin);

    return reply.code(200).send({
      connected: true,
      wabaId,
      phoneNumberId,
      displayPhoneNumber: phone.displayPhoneNumber,
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  });
}
