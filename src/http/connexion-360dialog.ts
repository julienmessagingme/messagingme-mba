import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { gardeEtendue, type Guard, type PreHandler } from '../auth/middleware';
import { espaceVerifie } from './scope';
import { journaliser } from '../lib/journal';
import { makeJournal, type AuditSink } from '../audit/journal';
import { CLE_360DIALOG, rattacher360dialog, type DepsRattachement360 } from '../account/rattacher-360dialog';

/**
 * LE BOUTON « ONBOARD WITH 360DIALOG » (lot 3, recadré par Julien le 2026-10-15) : l'admin de l'espace colle la clé
 * d'API d'un numéro pris sur le compte client 360dialog, et le serveur fait le reste, comme `/ops/360dialog`
 * (`rattacher360dialog`, la logique commune). Pas d'onboarding intégré ni de compte partenaire. La clé prouve la
 * possession du numéro ; le compte d'un autre espace reste refusé par `linkTenant`. Recoller la clé d'un numéro déjà
 * relié la remplace : c'est la réparation d'une clé refusée. 🔴 La clé n'est jamais renvoyée ni journalisée.
 */
export interface Connexion360dialogDeps extends DepsRattachement360 {
  audit: AuditSink;
}

const corpsSchema = z.object({
  cle: z.string().trim().regex(CLE_360DIALOG),
  numeroAffiche: z.string().trim().max(32).optional(),
}).strict();

/** `garde` : admin ; `limiteCouteuse` : chaque essai appelle 360dialog (lecture du numéro, pose du webhook). */
export function registerConnexion360dialog(app: FastifyInstance, deps: Connexion360dialogDeps, garde: Guard, limiteCouteuse?: PreHandler): void {
  const journal = makeJournal(deps.audit);

  app.post('/tenants/:tenantId/360dialog/connecter', gardeEtendue(garde, limiteCouteuse), async (req, reply) => {
    const tenant = espaceVerifie(req);
    const lu = corpsSchema.safeParse(req.body ?? {});
    if (!lu.success) return reply.code(400).send({ error: 'collez la clé d’API 360dialog du numéro (sans espace ni retour à la ligne)' });

    const issue = await rattacher360dialog(deps, tenant, lu.data.cle, lu.data.numeroAffiche || null);
    // Jamais un 5xx vers la console : Cloudflare et NPM remplacent son corps, et le message utile serait perdu.
    if (!issue.ok) return reply.code(issue.statut >= 500 ? 422 : issue.statut).send({ error: issue.error, ...(issue.rattache ? { rattache: true } : {}) });

    journaliser('info', 'connexion_360dialog', { tenantId: tenant, phoneNumberId: issue.phoneNumberId, wabaId: issue.wabaId, webhook: issue.webhook });
    await journal(tenant, req, 'numero.connecte', { kind: 'phone_number', id: issue.phoneNumberId }, { wabaId: issue.wabaId, fournisseur: '360dialog' });
    return reply.code(200).send({
      connected: true,
      wabaId: issue.wabaId,
      phoneNumberId: issue.phoneNumberId,
      displayPhoneNumber: lu.data.numeroAffiche || null,
    });
  });
}
