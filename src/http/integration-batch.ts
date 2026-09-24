import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Guard } from '../auth/middleware';
import { makeJournal, type AuditSink } from '../audit/journal';
import { scopeTenant } from './scope';
import type { VueIntegrationBatch } from '../signaux/integration-batch.pg';

/**
 * PARAMÈTRES > INTÉGRATIONS > BATCH (spec 2026-09-24, § 8) : brancher l'outil qui reçoit les signaux.
 *
 * 🔴 RÉSERVÉ AUX ADMINS, LECTURE COMPRISE (montée sous `g.admin`) : ces clés font sortir des données de
 * contacts de l'espace, c'est une décision de la marque, comme un connecteur.
 *
 * 🔴 LES CLÉS NE REVIENNENT JAMAIS : ni dans une réponse, ni dans le journal d'audit. Le chiffrement se fait
 * dans le câblage (`enregistrer`), jamais ici.
 */
export interface IntegrationBatchRouteDeps {
  lire(tenantId: string): Promise<VueIntegrationBatch | null>;
  /** Chiffre les clés reçues et écrit. `false` = premier branchement sans les DEUX clés : rien n'est écrit. */
  enregistrer(tenantId: string, r: { cleRest?: string; cleProjet?: string; envoyerResume: boolean }): Promise<boolean>;
  supprimer(tenantId: string): Promise<boolean>;
  /**
   * L'instance sait-elle CHIFFRER une clé ? REQUIS, et calculé une fois au câblage. `ENCRYPTION_KEY` vaut `''`
   * par défaut et la configuration ne l'exige que pour d'autres fonctions : sans elle, `encryptSecret` lève, et
   * la route rendrait 500 (une page Cloudflare sans explication) au lieu d'un refus que l'écran peut afficher.
   */
  chiffrementPret: boolean;
  audit?: AuditSink;
}

/** Le corps du réglage, lu comme une entrée externe. `.strict()` : une clé inconnue est une faute, pas un ajout. */
const corpsReglage = z.object({
  cleRest: z.string().trim().min(1).max(256).optional(),
  cleProjet: z.string().trim().min(1).max(256).optional(),
  envoyerResume: z.boolean(),
}).strict();

const vue = (v: VueIntegrationBatch | null) => (v === null ? { branche: false } : { branche: true, ...v });
const CIBLE = { kind: 'integration', id: 'batch' };

export function registerIntegrationBatch(app: FastifyInstance, deps: IntegrationBatchRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };
  const journal = makeJournal(deps.audit);

  app.get('/tenants/:tenantId/integrations/batch', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    return reply.code(200).send(vue(await deps.lire(tenant)));
  });

  app.put('/tenants/:tenantId/integrations/batch', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const corps = corpsReglage.safeParse(req.body ?? {});
    if (!corps.success) {
      const i = corps.error.issues[0];
      return reply.code(400).send({ error: `${i && i.path.length > 0 ? i.path.join('.') : 'corps'} : ${i?.message ?? 'invalide'}` });
    }
    const { cleRest, cleProjet, envoyerResume } = corps.data;
    if ((cleRest !== undefined || cleProjet !== undefined) && !deps.chiffrementPret) {
      // Même patron que les routes dont la configuration manque (publicités, installation HubSpot) : 503, et
      // une phrase que l'écran affiche telle quelle. Changer la seule option ne chiffre rien et reste permis.
      return reply.code(503).send({ error: 'Le chiffrement des secrets n’est pas configuré sur cette instance : impossible d’enregistrer des clés.' });
    }
    const avant = await deps.lire(tenant);
    const fait = await deps.enregistrer(tenant, {
      ...(cleRest !== undefined ? { cleRest } : {}),
      ...(cleProjet !== undefined ? { cleProjet } : {}),
      envoyerResume,
    });
    if (!fait) return reply.code(400).send({ error: 'La clé REST et la clé de projet sont requises pour brancher Batch.' });
    await journal(tenant, req, avant === null ? 'integration.branchee' : 'integration.modifiee', CIBLE, {
      outil: 'batch', envoyerResume, clesChangees: cleRest !== undefined || cleProjet !== undefined,
    });
    return reply.code(200).send(vue(await deps.lire(tenant)));
  });

  app.delete('/tenants/:tenantId/integrations/batch', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!(await deps.supprimer(tenant))) return reply.code(404).send({ error: 'Batch n’est pas branché sur cet espace.' });
    await journal(tenant, req, 'integration.debranchee', CIBLE, { outil: 'batch' });
    return reply.code(200).send({ branche: false });
  });
}
