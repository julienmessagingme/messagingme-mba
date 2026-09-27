import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Guard } from '../auth/middleware';
import { makeJournal, type AuditSink } from '../audit/journal';
import { espaceVerifie } from './scope';
import type { VueIntegrationBatch } from '../signaux/integration-batch.pg';

/**
 * Paramètres > Intégrations > Batch : brancher l'outil qui reçoit les signaux.
 * 🔴 Réservé aux admins, lecture comprise (monté sous `g.admin`) : ces clés font sortir des données de contacts.
 * 🔴 Les clés ne reviennent jamais, ni dans une réponse ni dans l'audit ; le chiffrement se fait dans le câblage.
 */
export interface IntegrationBatchRouteDeps {
  lire(tenantId: string): Promise<VueIntegrationBatch | null>;
  /** Chiffre les clés reçues et écrit. `false` = premier branchement sans les deux clés : rien n'est écrit. */
  enregistrer(tenantId: string, r: { cleRest?: string; cleProjet?: string; envoyerResume: boolean }): Promise<boolean>;
  supprimer(tenantId: string): Promise<boolean>;
  /**
   * L'instance sait-elle chiffrer une clé ? Calculé au câblage : `ENCRYPTION_KEY` peut être vide, `encryptSecret`
   * lèverait alors, et la route rendrait 500 au lieu d'un refus affichable.
   */
  chiffrementPret: boolean;
  audit: AuditSink;
}

/** Le corps du réglage, lu comme une entrée externe. `.strict()` : une clé inconnue est une faute, pas un ajout. */
const corpsReglage = z.object({
  cleRest: z.string().trim().min(1).max(256).optional(),
  cleProjet: z.string().trim().min(1).max(256).optional(),
  envoyerResume: z.boolean(),
}).strict();

const vue = (v: VueIntegrationBatch | null) => (v === null ? { branche: false } : { branche: true, ...v });
/**
 * La ligne d'audit ne nomme pas l'outil : elle s'affiche dans un écran de la marque, et ce nom est réservé à
 * l'écran de réglage (même règle que `NOM_APPEL_SIGNAUX`). Le détail ne porte que l'option et le changement de clés.
 */
const CIBLE = { kind: 'integration', id: 'signaux' };

export function registerIntegrationBatch(app: FastifyInstance, deps: IntegrationBatchRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };
  const journal = makeJournal(deps.audit);

  app.get('/tenants/:tenantId/integrations/batch', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    return reply.code(200).send(vue(await deps.lire(tenant)));
  });

  app.put('/tenants/:tenantId/integrations/batch', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const corps = corpsReglage.safeParse(req.body ?? {});
    if (!corps.success) {
      const i = corps.error.issues[0];
      return reply.code(400).send({ error: `${i && i.path.length > 0 ? i.path.join('.') : 'corps'} : ${i?.message ?? 'invalide'}` });
    }
    const { cleRest, cleProjet, envoyerResume } = corps.data;
    if ((cleRest !== undefined || cleProjet !== undefined) && !deps.chiffrementPret) {
      // Chiffrement absent : 503 et une phrase affichable. Changer la seule option ne chiffre rien et reste permis.
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
      envoyerResume, clesChangees: cleRest !== undefined || cleProjet !== undefined,
    });
    return reply.code(200).send(vue(await deps.lire(tenant)));
  });

  app.delete('/tenants/:tenantId/integrations/batch', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (!(await deps.supprimer(tenant))) return reply.code(404).send({ error: 'Batch n’est pas branché sur cet espace.' });
    await journal(tenant, req, 'integration.debranchee', CIBLE);
    return reply.code(200).send({ branche: false });
  });
}
