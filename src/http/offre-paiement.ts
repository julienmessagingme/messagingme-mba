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
}

/** Le corps ne porte qu'une périodicité, jamais un prix ni un montant : une clé inconnue est refusée. */
const corpsSchema = z.object({ periodicite: z.enum(['mois', 'an']) }).strict();

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
}
