import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { TenantConflictError } from '../account/es-store.pg';

export interface EmbeddedSignupRouteDeps {
  /** config_id de la configuration ES (dashboard Meta, Facebook Login for Business). Vide -> feature OFF. */
  configId: string;
  /** App ID Meta (public : sert au FB.init du front). */
  appId: string;
  graphVersion: string;
  exchangeCode(code: string): Promise<string>;
  /** Preuve d'appartenance du WABA (GET /{waba_id} avec le business token) : throw si le token ne le possède pas. */
  verifyWaba(wabaId: string, businessToken: string): Promise<void>;
  /**
   * Comptes WhatsApp auxquels le business token donne accès. Sert quand la popup n'a PAS annoncé les
   * identifiants (client qui rouvre un parcours déjà abouti : Meta n'a plus rien à configurer, donc plus rien à
   * annoncer). Optionnelles : sans elles, la route garde son ancien contrat (les deux identifiants exigés).
   */
  wabasForToken?(businessToken: string): Promise<string[]>;
  listPhones?(wabaId: string, businessToken: string): Promise<Array<{ id: string }>>;
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
    // `wabaId` / `phoneNumberId` sont FACULTATIFS : la popup ne les annonce que lorsqu'elle exécute vraiment les
    // étapes de configuration. Un client qui rouvre le parcours après un premier passage abouti n'obtient qu'un
    // code, et restait donc bloqué DÉFINITIVEMENT (mesuré le 2026-08-17). Absents -> on les retrouve (1 bis).
    if (!nonEmpty(b.code)) return reply.code(400).send({ error: 'code requis' });
    const code = b.code.trim();

    // 1. Code -> business token. Échec = rien n'est rattaché (le code a un TTL de 30 s : re-cliquer suffit).
    let businessToken: string;
    try {
      businessToken = await deps.exchangeCode(code);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`embedded-signup: échange du code impossible (tenant ${tenant}) : ${msg}`);
      return reply.code(422).send({ error: `échange du code Meta échoué : ${msg}` });
    }

    // 1 bis. Identifiants non annoncés -> on les lit dans le TOKEN (les comptes auxquels il donne accès), puis
    //        dans le compte (ses numéros). Aucune perte de sûreté : ils viennent du token du client lui-même,
    //        ils ne peuvent donc pas désigner les biens d'un autre, et l'étape 2 les vérifie quand même. On
    //        REFUSE l'ambiguïté (plusieurs comptes ou plusieurs numéros) au lieu d'en choisir un au hasard :
    //        rattacher le mauvais numéro serait bien pire qu'un message d'erreur.
    let wabaId = nonEmpty(b.wabaId) ? b.wabaId.trim() : '';
    let phoneNumberId = nonEmpty(b.phoneNumberId) ? b.phoneNumberId.trim() : '';
    if (wabaId === '' || phoneNumberId === '') {
      if (!deps.wabasForToken || !deps.listPhones) {
        return reply.code(400).send({ error: 'code, wabaId et phoneNumberId requis' });
      }
      try {
        if (wabaId === '') {
          const wabas = await deps.wabasForToken(businessToken);
          if (wabas.length === 0) {
            // eslint-disable-next-line no-console
            console.error(`embedded-signup: le token du tenant ${tenant} n'expose aucun compte WhatsApp (granular_scopes sans cible)`);
            return reply.code(422).send({ error: 'le compte Meta connecté n’expose aucun compte WhatsApp. Termine le parcours Meta jusqu’au bout, en partageant bien ton compte WhatsApp avec l’application.' });
          }
          if (wabas.length > 1) {
            return reply.code(409).send({ error: `ce compte Meta donne accès à ${wabas.length} comptes WhatsApp : impossible de deviner lequel rattacher.` });
          }
          wabaId = wabas[0]!;
        }
        if (phoneNumberId === '') {
          const phones = await deps.listPhones(wabaId, businessToken);
          if (phones.length === 0) {
            return reply.code(422).send({ error: 'ce compte WhatsApp ne contient aucun numéro. Ajoute-le dans le parcours Meta.' });
          }
          if (phones.length > 1) {
            return reply.code(409).send({ error: `ce compte WhatsApp contient ${phones.length} numéros : impossible de deviner lequel rattacher.` });
          }
          phoneNumberId = phones[0]!.id;
        }
        // eslint-disable-next-line no-console
        console.info(`embedded-signup: identifiants retrouvés depuis le token (waba=${wabaId}, numéro=${phoneNumberId}) faute d'annonce par la popup`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(`embedded-signup: repêchage des identifiants impossible (tenant ${tenant}) : ${msg}`);
        return reply.code(422).send({ error: `lecture du compte WhatsApp impossible : ${msg}` });
      }
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
      // eslint-disable-next-line no-console
      console.error(`embedded-signup: preuve d'appartenance refusée (tenant ${tenant}, waba ${wabaId}, numéro ${phoneNumberId}) : ${msg}`);
      return reply.code(422).send({ error: `le compte Meta connecté ne donne pas accès à ce numéro/WABA : ${msg}` });
    }

    const warnings: string[] = [];
    // 3. Rattachement au workspace. Un WABA/numéro déjà rattaché à un AUTRE workspace est REFUSÉ (409), pas réaffecté
    //    en silence : on interrompt AVANT d'abonner les webhooks, de register ou de stocker le token. La migration
    //    volontaire d'un numéro entre workspaces passe par le chemin admin dédié, pas par l'Embedded Signup.
    try {
      await deps.link({ tenantId: tenant, wabaId, phoneNumberId, displayPhoneNumber: phone.displayPhoneNumber, verifiedName: phone.verifiedName });
    } catch (err) {
      if (err instanceof TenantConflictError) {
        return reply.code(409).send({ error: 'ce numéro ou ce WABA est déjà rattaché à un autre workspace' });
      }
      throw err;
    }

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
