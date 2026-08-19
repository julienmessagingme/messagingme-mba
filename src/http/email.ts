import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Transporter } from 'nodemailer';
import { forbidNonAdmin } from '../auth/middleware';
import type { Guard } from '../auth/middleware';
import { sendSmtpEmail } from '../email/smtp';
import { scopeTenant } from './scope';
import type {
  EmailAccount,
  EmailAccountInput,
  EmailAccountUpdate,
  DecryptedEmailAccount,
  EmailTemplate,
  EmailTemplateInput,
  EmailTemplateUpdate,
} from '../email/types';

/**
 * Routes des boîtes SMTP et modèles d'email (node « Envoi de mail »), admin-only. Calqué sur
 * `src/http/workflows.ts` : `guard` (optionnel, posé au montage) porte l'auth/rôle en prod ; `scopeTenant` puis
 * `forbidNonAdmin` défendent chaque écriture dans la route elle-même, comme workflows.ts (utile aussi en test,
 * où `registerEmailRoutes` peut être monté sans guard). Les lectures ne posent que `scopeTenant`.
 *
 * Le mot de passe SMTP n'est JAMAIS renvoyé : `EmailAccount` (email/types.ts) ne le porte déjà pas ; seul
 * `DecryptedEmailAccount` (jamais sérialisé ici) l'ajoute. `publicAccount` se contente d'annoncer `hasPassword`.
 */

const accountCreate = z.object({
  label: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  username: z.string().min(1),
  password: z.string().min(1),
  fromAddress: z.string().email(),
  fromName: z.string().nullish(),
  replyTo: z.string().email().nullish(),
});
const accountPatch = accountCreate.partial();

const templateCreate = z.object({
  name: z.string().min(1),
  format: z.enum(['basic', 'html']),
  subject: z.string().min(1),
  body: z.string().min(1),
});
const templatePatch = templateCreate.partial();

const testSendBody = z.object({ to: z.string().email() });

/** Ajoute juste l'indicateur d'affichage : `EmailAccount` ne porte déjà aucun secret. */
function publicAccount(a: EmailAccount): EmailAccount & { hasPassword: true } {
  return { ...a, hasPassword: true };
}

/** Surface minimale requise sur le store de comptes (dépendance PAR INTERFACE, pas par classe concrète : comme
 *  `WorkflowRouteDeps`/`MbaRouteDeps`, pour rester injectable par un faux store en test, sans Postgres). */
export interface EmailAccountsDep {
  list(tenantId: string): Promise<EmailAccount[]>;
  create(tenantId: string, input: EmailAccountInput): Promise<EmailAccount>;
  update(tenantId: string, id: string, patch: EmailAccountUpdate): Promise<EmailAccount | null>;
  softDelete(tenantId: string, id: string): Promise<boolean>;
  markVerified(tenantId: string, id: string): Promise<void>;
}

export interface EmailTemplatesDep {
  list(tenantId: string): Promise<EmailTemplate[]>;
  create(tenantId: string, input: EmailTemplateInput): Promise<EmailTemplate>;
  update(tenantId: string, id: string, patch: EmailTemplateUpdate): Promise<EmailTemplate | null>;
  softDelete(tenantId: string, id: string): Promise<boolean>;
}

export interface EmailResolverDep {
  getTransport(tenantId: string, accountId: string): Promise<{ transport: Transporter; account: DecryptedEmailAccount } | null>;
  /** Doit être appelée après toute écriture d'un compte (patch/delete) : le transport en cache porterait sinon
   *  un mot de passe ou un hôte périmé. */
  invalidate(accountId: string): void;
}

export interface EmailRoutesDeps {
  accounts: EmailAccountsDep;
  templates: EmailTemplatesDep;
  resolver: EmailResolverDep;
}

export function registerEmailRoutes(app: FastifyInstance, deps: EmailRoutesDeps, guard?: Guard): void {
  const opts = guard ? { preHandler: guard } : {};

  // ---- Boîtes SMTP ----
  app.get('/tenants/:tenantId/email/accounts', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const accounts = await deps.accounts.list(tenant);
    return reply.code(200).send({ accounts: accounts.map(publicAccount) });
  });

  app.post('/tenants/:tenantId/email/accounts', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const parsed = accountCreate.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'compte invalide' });
    const created = await deps.accounts.create(tenant, parsed.data);
    return reply.code(200).send(publicAccount(created));
  });

  app.patch('/tenants/:tenantId/email/accounts/:id', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const parsed = accountPatch.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'compte invalide' });
    const { id } = req.params as { id: string };
    const updated = await deps.accounts.update(tenant, id, parsed.data);
    if (!updated) return reply.code(404).send({ error: 'compte introuvable' });
    // Le transport en cache (hôte/identifiants) serait sinon périmé après ce patch.
    deps.resolver.invalidate(id);
    return reply.code(200).send(publicAccount(updated));
  });

  app.delete('/tenants/:tenantId/email/accounts/:id', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const ok = await deps.accounts.softDelete(tenant, id);
    deps.resolver.invalidate(id);
    if (!ok) return reply.code(404).send({ error: 'compte introuvable' });
    return reply.code(200).send({ ok: true });
  });

  // Test d'envoi : 4xx (422) sur échec, JAMAIS 5xx (Cloudflare remplace le corps des 5xx par sa propre page
  // d'erreur, ce qui masquerait le message utile) ; journalisé côté serveur dans les deux cas.
  app.post('/tenants/:tenantId/email/accounts/:id/test', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const parsed = testSendBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'destinataire de test invalide' });
    const { id } = req.params as { id: string };
    const resolved = await deps.resolver.getTransport(tenant, id);
    if (!resolved) return reply.code(404).send({ error: 'compte introuvable' });
    try {
      await sendSmtpEmail(resolved.transport, resolved.account, {
        to: parsed.data.to,
        subject: 'Test MessagingMe',
        text: 'Ceci est un test de votre boîte SMTP.',
      });
      await deps.accounts.markVerified(tenant, id);
      return reply.code(200).send({ ok: true });
    } catch (err) {
      // `console.error` et non `req.log` : Fastify est construit en `logger: false` (server.ts), donc
      // `req.log` est un no-op silencieux, cf. le même choix dans support.ts/embedded-signup.ts.
      // eslint-disable-next-line no-console
      console.error(`email: test SMTP échoué (compte ${id}):`, err instanceof Error ? err.message : err);
      return reply.code(422).send({ ok: false, error: 'envoi de test échoué' });
    }
  });

  // ---- Modèles d'email ----
  app.get('/tenants/:tenantId/email/templates', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    return reply.code(200).send({ templates: await deps.templates.list(tenant) });
  });

  app.post('/tenants/:tenantId/email/templates', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const parsed = templateCreate.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'modèle invalide' });
    const created = await deps.templates.create(tenant, parsed.data);
    return reply.code(200).send(created);
  });

  app.patch('/tenants/:tenantId/email/templates/:id', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const parsed = templatePatch.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'modèle invalide' });
    const { id } = req.params as { id: string };
    const updated = await deps.templates.update(tenant, id, parsed.data);
    if (!updated) return reply.code(404).send({ error: 'modèle introuvable' });
    return reply.code(200).send(updated);
  });

  app.delete('/tenants/:tenantId/email/templates/:id', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const ok = await deps.templates.softDelete(tenant, id);
    if (!ok) return reply.code(404).send({ error: 'modèle introuvable' });
    return reply.code(200).send({ ok: true });
  });
}
