import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { gardeEtendue, type Guard, type PreHandler } from '../auth/middleware';
import { espaceVerifie } from './scope';
import { corpsDuRefus, type Issue } from '../lib/issue';
import type { PeriodicitePro } from '../stripe/pro';

/**
 * PAYER LE PRO DEPUIS LA CONSOLE (lot 6, livraison B1, tâche 10, spec § 6). Deux routes d'administrateur, sous le plafond
 * des opérations coûteuses (chaque clic crée des objets chez Stripe), qui ne rendent qu'une ADRESSE : le paiement reste un
 * geste humain sur la page de Stripe, et seul le webhook signé fait passer l'espace en Pro.
 *
 * ⚠️ AUCUNE GARDE D'OFFRE sur ce module (son entrée du registre n'en déclare pas) : c'est une Base qui doit pouvoir payer.
 */
export interface OffrePaiementRouteDeps {
  /** `ouvrirPro` (`src/stripe/pro.ts`) : un espace déjà Pro reçoit l'adresse du portail (`portail: true`). */
  ouvrir(tenantId: string, periodicite: PeriodicitePro, payeur: string): Promise<Issue<{ url: string; portail: boolean }>>;
  /** `ouvrirPortailPro` : carte, factures, périodicité, résiliation. */
  portail(tenantId: string, payeur: string): Promise<Issue<{ url: string }>>;
  /**
   * Rendre le numéro fourni à la fin du Pro (lot 6, B2b, `PgAbonnementsOffreStore.rendreLeNumero`) : `false` sans Pro
   * vivant.
   */
  rendreLeNumero(tenantId: string, rendre: boolean): Promise<boolean>;
}

/** Le corps ne porte qu'une périodicité, jamais un prix ni un montant : une clé inconnue est refusée. */
const corpsSchema = z.object({ periodicite: z.enum(['mois', 'an']) }).strict();
/** Rendre le numéro : un booléen, rien d'autre. */
const corpsRendreSchema = z.object({ rendre: z.boolean() }).strict();

export function registerOffrePaiement(app: FastifyInstance, deps: OffrePaiementRouteDeps, garde: Guard, limiteCouteuse: PreHandler): void {
  const couteux = gardeEtendue(garde, limiteCouteuse);

  app.post('/tenants/:tenantId/offre/paiement', couteux, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const lu = corpsSchema.safeParse(req.body ?? {});
    if (!lu.success) return reply.code(400).send({ error: 'periodicite requise : mois ou an' });
    const r = await deps.ouvrir(tenant, lu.data.periodicite, req.auth?.userId ?? '');
    if (!r.ok) return reply.code(r.statut).send(corpsDuRefus(r));
    return reply.code(200).send(r.valeur);
  });

  app.post('/tenants/:tenantId/offre/portail', couteux, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const r = await deps.portail(tenant, req.auth?.userId ?? '');
    if (!r.ok) return reply.code(r.statut).send(corpsDuRefus(r));
    return reply.code(200).send(r.valeur);
  });

  /**
   * Rendre le numéro fourni à la FIN du Pro (lot 6, B2b, décision de Julien du 2026-10-07), ou revenir sur ce choix tant
   * que le Pro court. Une écriture en base, rien chez Stripe : la garde d'administrateur seule, sans le plafond coûteux.
   */
  app.put('/tenants/:tenantId/offre/numero', { preHandler: garde }, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const lu = corpsRendreSchema.safeParse(req.body ?? {});
    if (!lu.success) return reply.code(400).send({ error: 'rendre requis : true ou false' });
    if (!(await deps.rendreLeNumero(tenant, lu.data.rendre))) {
      return reply.code(409).send({ error: 'Cet espace n’a pas de Pro en cours : il n’y a pas de fin du Pro où rendre le numéro.', cause: 'aucun_pro' });
    }
    return reply.code(200).send({ rendreNumero: lu.data.rendre });
  });
}
