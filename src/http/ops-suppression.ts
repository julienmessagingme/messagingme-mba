import type { FastifyInstance } from 'fastify';
import { auteurOps, type PreHandler } from '../auth/middleware';
import { estUuid } from './scope';
import { journaliser } from '../lib/journal';
import type { VerrousCourts } from '../db/verrous-courts';
import {
  nomCorrespond, prevoirEtapes, supprimerEspace, type BilanSuppression, type ContexteTiers, type DepsSuppression,
} from '../ops/suppression-espace';

/**
 * SUPPRIMER UN ESPACE DEPUIS /ops (RC8). Deux routes, derrière la garde d'exploitation (`makeRequireOps`, la même
 * instance que `/ops`) :
 *  - `GET /ops/espaces/:tenantId/suppression` : le bilan (ce que la cascade emportera, les liens Stripe, les adresses
 *    effacées et gardées) et les étapes prévues, celles qui seront sautées et pourquoi ;
 *  - `DELETE /ops/espaces/:tenantId` `{ nom }` : la suppression, après la saisie exacte du nom. Elle rend le déroulé.
 *
 * 🔴 JAMAIS DE 5XX : Cloudflare en mange le corps, et l'exploitant doit lire ce qui a été fait. Une suppression qui a
 * tourné rend 200 avec `supprime` et ses étapes, qu'elle ait abouti ou qu'une étape l'ait arrêtée ; une panne imprévue
 * rend 422 lisible. La ligne de journal porte l'auteur (`par`), comme chaque écriture de `/ops`.
 */
export interface OpsSuppressionDeps {
  /** `PgSuppressionEspaceStore.bilan` : `null` = espace inconnu. */
  bilan(tenantId: string): Promise<BilanSuppression | null>;
  /** Le jeton que Meta recevrait, HubSpot, et ce que cette instance sait faire. */
  contexte(tenantId: string): Promise<ContexteTiers>;
  gestes: DepsSuppression;
  /** Une seule suppression à la fois par espace, pour toutes les copies de l'API (double clic, deux onglets). */
  verrous: Pick<VerrousCourts, 'prendre' | 'relacher'>;
}

/** Le bail d'une suppression : Vercel, Meta, Salesforce, HubSpot et DIDWW, chacun borné, puis la purge. */
const BAIL_SUPPRESSION_MS = 10 * 60_000;

export function registerOpsSuppression(app: FastifyInstance, deps: OpsSuppressionDeps, garde: PreHandler): void {
  const opts = { preHandler: garde };
  const inconnu = { error: 'espace inconnu' };

  app.get('/ops/espaces/:tenantId/suppression', opts, async (req, reply) => {
    const { tenantId } = req.params as { tenantId: string };
    if (!estUuid(tenantId)) return reply.code(404).send(inconnu);
    try {
      const bilan = await deps.bilan(tenantId);
      if (bilan === null) return reply.code(404).send(inconnu);
      return reply.code(200).send({ bilan, etapes: prevoirEtapes(bilan, await deps.contexte(tenantId)) });
    } catch (err) {
      journaliser('error', 'ops_bilan_suppression_impossible', { err, tenantId });
      return reply.code(422).send({ error: 'le bilan n’a pas pu être lu : réessayez' });
    }
  });

  app.delete('/ops/espaces/:tenantId', opts, async (req, reply) => {
    const { tenantId } = req.params as { tenantId: string };
    if (!estUuid(tenantId)) return reply.code(404).send(inconnu);
    const saisi = ((req.body ?? {}) as { nom?: unknown }).nom;
    if (typeof saisi !== 'string' || saisi.trim() === '') return reply.code(400).send({ error: 'nom requis : tapez le nom de l’espace' });
    const par = auteurOps(req);
    let prise: Awaited<ReturnType<OpsSuppressionDeps['verrous']['prendre']>>;
    try {
      prise = await deps.verrous.prendre([[`suppression-espace:${tenantId}`, BAIL_SUPPRESSION_MS]]);
    } catch (err) {
      // Jamais de 5xx : une base qui ne répond pas ici rend un refus lisible, et rien n'a été fait.
      journaliser('error', 'ops_suppression_espace_impossible', { err, tenantId, par });
      return reply.code(422).send({ error: 'la suppression n’a pas pu commencer : réessayez dans un instant' });
    }
    if (prise === null) return reply.code(409).send({ error: 'une suppression de cet espace est déjà en cours' });
    try {
      const bilan = await deps.bilan(tenantId);
      if (bilan === null) return reply.code(404).send(inconnu);
      if (!nomCorrespond(saisi, bilan.nom)) return reply.code(400).send({ error: 'le nom ne correspond pas à celui de l’espace' });
      const r = await supprimerEspace(deps.gestes, bilan, await deps.contexte(tenantId), par);
      journaliser('warn', 'ops_suppression_espace', {
        tenantId, nom: bilan.nom, supprime: r.supprime, etapes: r.etapes, comptes: r.comptes, par, at: new Date().toISOString(),
      });
      return reply.code(200).send({ tenantId, nom: bilan.nom, ...r });
    } catch (err) {
      journaliser('error', 'ops_suppression_espace_impossible', { err, tenantId, par });
      return reply.code(422).send({ error: 'la suppression n’a pas pu aller au bout : relisez le bilan, puis recommencez' });
    } finally {
      await deps.verrous.relacher(prise).catch(() => undefined);
    }
  });
}
