import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { gardeEtendue, type Guard, type PreHandler } from '../auth/middleware';
import { espaceVerifie } from './scope';
import { corpsDuRefus, type Issue } from '../lib/issue';
import type { PeriodicitePro } from '../stripe/pro';
import type { DemandeSieges } from '../stripe/sieges';
import type { FactureEspace } from '../stripe/gestion-pro';

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
  /**
   * Les sièges du Pro (spec offres v2, livraison 7, `changerSieges`, `src/stripe/sieges.ts`) : Stripe d'abord, la limite
   * ensuite, et un ajout seulement si son prorata est payé.
   */
  sieges(tenantId: string, demande: DemandeSieges, payeur: string): Promise<Issue<{ sieges: number }>>;
  /** Résilier le Pro à la fin de sa période, ou annuler cette résiliation (`changerResiliationPro`, `src/stripe/gestion-pro.ts`). */
  resiliation(tenantId: string, resilier: boolean, payeur: string): Promise<Issue<{ finPrevueLe: string | null }>>;
  /** Les dernières factures de l'espace chez Stripe (`facturesDeLEspace`) : Pro, numéro et recharges. */
  factures(tenantId: string, payeur: string): Promise<Issue<{ factures: FactureEspace[]; plusSurStripe: boolean }>>;
}

/** Le corps ne porte qu'une périodicité, jamais un prix ni un montant : une clé inconnue est refusée. */
const corpsSchema = z.object({ periodicite: z.enum(['mois', 'an']) }).strict();
/**
 * Un siège à la fois, depuis l'état que l'écran a lu : jamais un prix ni un montant (le prix vient de la configuration et de
 * Stripe), et jamais un saut (une requête ne charge pas mille sièges sur la carte, Y7 de la relecture).
 */
const corpsSiegesSchema = z.object({ depuis: z.number().int().min(0).max(1000), cible: z.number().int().min(0).max(1000) })
  .strict()
  .refine((c) => Math.abs(c.cible - c.depuis) === 1);
/** Rendre le numéro : un booléen, rien d'autre. */
const corpsRendreSchema = z.object({ rendre: z.boolean() }).strict();
/** Résilier ou annuler la résiliation : un booléen, rien d'autre (ni date, ni abonnement : c'est celui de l'espace). */
const corpsResiliationSchema = z.object({ resilier: z.boolean() }).strict();

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
   * Les utilisateurs en plus du Pro (livraison 7) : un administrateur, sous le plafond coûteux (chaque ajout écrit chez
   * Stripe et facture un prorata). La console l'appelle après un refus d'invitation qui propose le siège.
   */
  app.post('/tenants/:tenantId/offre/sieges', couteux, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const lu = corpsSiegesSchema.safeParse(req.body ?? {});
    if (!lu.success) return reply.code(400).send({ error: 'depuis et cible requis : un siège de plus ou de moins à la fois' });
    const r = await deps.sieges(tenant, lu.data, req.auth?.userId ?? '');
    if (!r.ok) return reply.code(r.statut).send(corpsDuRefus(r));
    return reply.code(200).send(r.valeur);
  });

  /**
   * Résilier le Pro, ou annuler la résiliation (2026-10-26) : un administrateur, sous le plafond coûteux (chaque clic écrit
   * chez Stripe). Rend la fin prévue que Stripe dit après le changement (`null` : plus aucune fin).
   */
  app.post('/tenants/:tenantId/offre/resiliation', couteux, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const lu = corpsResiliationSchema.safeParse(req.body ?? {});
    if (!lu.success) return reply.code(400).send({ error: 'resilier requis : true ou false' });
    const r = await deps.resiliation(tenant, lu.data.resilier, req.auth?.userId ?? '');
    if (!r.ok) return reply.code(r.statut).send(corpsDuRefus(r));
    return reply.code(200).send(r.valeur);
  });

  /**
   * Les factures de l'espace (2026-10-26), lues chez Stripe à chaque ouverture de l'onglet : un administrateur, sous la
   * garde seule (et le plafond par utilisateur qu'elle porte). 🟡 PAS le plafond coûteux : il est partagé avec le lancement
   * de campagne et l'import, et une lecture de l'onglet n'a pas à les épuiser (relecture du 2026-10-26). Ouverte à la Free,
   * qui paie des recharges et un numéro.
   */
  app.get('/tenants/:tenantId/offre/factures', { preHandler: garde }, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const r = await deps.factures(tenant, req.auth?.userId ?? '');
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
