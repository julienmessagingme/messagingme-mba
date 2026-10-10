import { z } from 'zod';
import { journaliser } from '../lib/journal';
import type { FinDuPro } from '../offres/numero-inclus';
import type { PgAbonnementsOffreStore, PeriodiciteOffre, RaisonFinOffre } from '../offres/abonnements-offre.pg';
import type { PgAbonnementsNumeroStore } from './abonnements.pg';
import { lienTableauStripe } from './liens';

/**
 * Le traitement des événements Stripe qui décrivent le cycle de vie du Pro ou du numéro fourni. La route garde le
 * protocole HTTP (signature, enveloppe et mode) ; ce module reconnaît les abonnements, interprète leurs objets et
 * applique leurs transitions. Les pannes inattendues remontent : Stripe doit alors rejouer l'événement.
 */

export interface DepsTraitementAbonnements {
  /**
   * L'abonnement du numéro fourni : l'enregistrement atomique de l'abonnement et du numéro, ses changements de statut,
   * l'alerte d'exploitation et la reprise des campagnes suspendues quand le paiement rend le numéro.
   */
  numero: Pick<PgAbonnementsNumeroStore, 'enregistrer' | 'majStatut' | 'noterFinPrevue'> & {
    alerter(texte: string): Promise<void>;
    reprendreCampagnes(tenantId: string): Promise<void>;
  };
  /**
   * Le Pro : son abonnement, l'invalidation immédiate du cache de l'offre, les alertes et les effets rejouables du
   * numéro inclus. `surPassageEnPro` et `surFinDuPro` sont appelés à chaque événement concerné, rejeux compris.
   */
  pro: Pick<PgAbonnementsOffreStore, 'enregistrer' | 'majStatut' | 'modifier' | 'finir' | 'vivant'> & {
    invalider(tenantId: string): void;
    alerter(texte: string): Promise<void>;
    surPassageEnPro(tenantId: string): Promise<void>;
    surFinDuPro(f: FinDuPro): Promise<unknown>;
  };
  now?: () => number;
}

export interface EvenementStripeVerifie {
  id: string;
  type: string;
  livemode: boolean;
  objet: unknown;
}

export type IssueTraitementAbonnement =
  | { issue: 'non_abonnement' }
  | { issue: 'acquitte' }
  | { issue: 'illisible'; domaine: 'pro' | 'numero' };

const NON_ABONNEMENT = { issue: 'non_abonnement' } as const;
const ACQUITTE = { issue: 'acquitte' } as const;

/** Les événements toujours confiés au traitement des abonnements. Une session Checkout doit d'abord être reconnue. */
const TYPES_ABONNEMENT = new Set([
  'invoice.paid', 'invoice.payment_failed', 'customer.subscription.deleted', 'customer.subscription.updated',
]);

/** Une session d'abonnement du numéro fourni. */
const sessionNumeroSchema = z.object({
  id: z.string().min(1),
  mode: z.literal('subscription'),
  payment_status: z.string(),
  subscription: z.union([z.string().startsWith('sub_'), z.object({ id: z.string().startsWith('sub_') })]),
  metadata: z.object({ tenant_id: z.uuid(), produit: z.literal('numero') }),
});

/**
 * Une facture Stripe `2025-11-17.clover` : l'abonnement et ses métadonnées sont sous
 * `parent.subscription_details`, la fin de la période payée sur ses lignes.
 */
const factureSchema = z.object({
  id: z.string().startsWith('in_'),
  parent: z.object({
    subscription_details: z.object({
      subscription: z.union([z.string(), z.object({ id: z.string() })]),
      metadata: z.record(z.string(), z.string()).nullable().optional(),
    }).nullable().optional(),
  }).nullable().optional(),
  lines: z.object({ data: z.array(z.object({ period: z.object({ end: z.number().int() }).optional() })) }).optional(),
});

const abonnementNumeroSchema = z.object({ id: z.string().startsWith('sub_') });

/** La fin programmée vit à la racine ou sur les lignes de l'abonnement selon le geste effectué dans Stripe. */
const abonnementNumeroModifieSchema = z.object({
  id: z.string().startsWith('sub_'),
  cancel_at: z.number().int().nullable().optional(),
  cancel_at_period_end: z.boolean().optional(),
  items: z.object({ data: z.array(z.object({ current_period_end: z.number().int().optional() })) }).optional(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
});

const metaNumeroSchema = z.object({ tenant_id: z.uuid(), produit: z.literal('numero') });
/** La périodicité est posée à la création puis peut être relue sur le prix après un changement dans le portail. */
const metaProSchema = z.object({ tenant_id: z.uuid(), produit: z.literal('pro'), periodicite: z.enum(['mois', 'an']).optional() });

/**
 * La marque du Pro suffit à aiguiller vers ce chemin : un objet marqué mais mal formé doit être refusé en 422, jamais
 * tomber silencieusement dans le traitement du numéro ou de la recharge.
 */
const marqueProSchema = z.object({ metadata: z.object({ produit: z.literal('pro') }) });
const factureMarqueeProSchema = z.object({ parent: z.object({ subscription_details: marqueProSchema }) });

const sessionProSchema = z.object({
  id: z.string().min(1),
  mode: z.literal('subscription'),
  payment_status: z.string(),
  subscription: z.union([z.string().startsWith('sub_'), z.object({ id: z.string().startsWith('sub_') })]),
  metadata: metaProSchema,
});

const abonnementProSchema = z.object({
  id: z.string().startsWith('sub_'),
  metadata: metaProSchema,
  cancel_at: z.number().int().nullable().optional(),
  cancel_at_period_end: z.boolean().optional(),
  ended_at: z.number().int().nullable().optional(),
  cancellation_details: z.object({ reason: z.string().nullable().optional() }).nullable().optional(),
  items: z.object({
    data: z.array(z.object({
      current_period_end: z.number().int().optional(),
      price: z.object({ recurring: z.object({ interval: z.string() }).nullable().optional() }).optional(),
    })),
  }).optional(),
  // Le client et la carte sont repris pour recréer le numéro seul à la fin du Pro.
  customer: z.union([z.string(), z.object({ id: z.string() })]).nullable().optional(),
  default_payment_method: z.union([z.string(), z.object({ id: z.string() })]).nullable().optional(),
});

const PERIODICITE_DE_STRIPE: Readonly<Record<string, PeriodiciteOffre>> = { month: 'mois', year: 'an' };
const idDe = (v: string | { id: string }): string => (typeof v === 'string' ? v : v.id);
const raisonDeLaFin = (reason: string | null | undefined): RaisonFinOffre =>
  (reason === 'payment_failed' || reason === 'payment_disputed' ? 'impaye' : 'resiliation');

function espaceDisparu(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23503';
}

function objetDuPro(type: string, objet: unknown): boolean {
  return (type.startsWith('invoice.') ? factureMarqueeProSchema : marqueProSchema).safeParse(objet).success;
}

export function creerTraitementAbonnements(deps: DepsTraitementAbonnements) {
  const maintenant = deps.now ?? (() => Date.now());

  function concerne(e: Pick<EvenementStripeVerifie, 'type' | 'objet'>): boolean {
    return TYPES_ABONNEMENT.has(e.type)
      || (e.type === 'checkout.session.completed'
        && (sessionNumeroSchema.safeParse(e.objet).success || objetDuPro(e.type, e.objet)));
  }

  function illisible(e: EvenementStripeVerifie, domaine: 'pro' | 'numero'): IssueTraitementAbonnement {
    journaliser('error', domaine === 'pro' ? 'stripe_pro_illisible' : 'stripe_abonnement_illisible', {
      evenement: e.id, type: e.type,
    });
    return { issue: 'illisible', domaine };
  }

  async function enregistrerNumero(a: {
    tenantId: string;
    abonnementId: string;
    livemode: boolean;
    periodeFin: Date | null;
  }): Promise<void> {
    let issue: Awaited<ReturnType<typeof deps.numero.enregistrer>>;
    try {
      issue = await deps.numero.enregistrer(a);
    } catch (err) {
      // Un espace supprimé peut encore être facturé. La clé étrangère ne guérira pas au rejeu : acquitter et alerter.
      if (!espaceDisparu(err)) throw err;
      journaliser('error', 'stripe_abonnement_espace_disparu', {
        tenantId: a.tenantId, abonnement: a.abonnementId, livemode: a.livemode,
      });
      await deps.numero.alerter(`L'espace supprimé ${a.tenantId} paie encore son abonnement ${a.abonnementId} : à résilier chez Stripe. ${lienTableauStripe('subscriptions', a.abonnementId, a.livemode)}`);
      return;
    }
    // Un réabonnement payé rend le numéro : les campagnes en pause sur sa suspension repartent.
    if (issue.etat === 'enregistre') await deps.numero.reprendreCampagnes(a.tenantId);
    if (issue.etat === 'doublon') {
      await deps.numero.alerter(`Abonnement en double : ${a.abonnementId} pour l'espace ${a.tenantId}, qui en a déjà un. À annuler et rembourser chez Stripe. Tant qu'il ne l'est pas, chacune de ses factures redonne cette alerte.`);
    } else if (issue.etat === 'enregistre' && issue.numero === null) {
      await deps.numero.alerter(`URGENT : l'espace ${a.tenantId} a payé son numéro (${a.abonnementId}) mais la réserve est vide. Déclare un numéro dans /ops : il lui sera attribué.`);
    }
  }

  async function traiterPro(e: EvenementStripeVerifie): Promise<IssueTraitementAbonnement> {
    const enregistrer = async (a: {
      tenantId: string;
      abonnementId: string;
      periodicite: PeriodiciteOffre;
      periodeFin: Date | null;
    }): Promise<void> => {
      let issue: Awaited<ReturnType<typeof deps.pro.enregistrer>>;
      try {
        issue = await deps.pro.enregistrer({ ...a, livemode: e.livemode });
      } catch (err) {
        // Même politique que le numéro pour un espace supprimé : ce 23503 est définitif, donc alerte et acquittement.
        if (!espaceDisparu(err)) throw err;
        journaliser('error', 'stripe_pro_espace_disparu', {
          tenantId: a.tenantId, abonnement: a.abonnementId, livemode: e.livemode,
        });
        await deps.pro.alerter(`L'espace supprimé ${a.tenantId} paie encore son Pro ${a.abonnementId} : à résilier chez Stripe. ${lienTableauStripe('subscriptions', a.abonnementId, e.livemode)}`);
        return;
      }
      if (issue.etat === 'enregistre') {
        deps.pro.invalider(issue.tenantId);
        if (issue.nouveau) {
          await deps.pro.alerter(`Nouveau Pro : espace ${issue.tenantId} (${a.abonnementId}, ${a.periodicite === 'an' ? 'annuel' : 'mensuel'}).`);
        }
        // Rejouable : une panne du premier passage ne doit jamais perdre l'effet sur le numéro inclus.
        await deps.pro.surPassageEnPro(issue.tenantId);
      } else if (issue.etat === 'doublon') {
        await deps.pro.alerter(`Pro en double : ${a.abonnementId} pour l'espace ${a.tenantId}, qui a déjà un Pro vivant. À annuler et rembourser chez Stripe.`);
      }
    };

    if (e.type === 'checkout.session.completed') {
      const lu = sessionProSchema.safeParse(e.objet);
      if (!lu.success) return illisible(e, 'pro');
      if (lu.data.payment_status !== 'paid' && lu.data.payment_status !== 'no_payment_required') return ACQUITTE;
      await enregistrer({
        tenantId: lu.data.metadata.tenant_id,
        abonnementId: idDe(lu.data.subscription),
        periodicite: lu.data.metadata.periodicite ?? 'mois',
        periodeFin: null,
      });
      return ACQUITTE;
    }

    if (e.type === 'customer.subscription.updated' || e.type === 'customer.subscription.deleted') {
      const lu = abonnementProSchema.safeParse(e.objet);
      if (!lu.success) return illisible(e, 'pro');
      const lignes = lu.data.items?.data ?? [];
      if (e.type === 'customer.subscription.deleted') {
        const fin = lu.data.ended_at ? new Date(lu.data.ended_at * 1000) : new Date(maintenant());
        const raison = raisonDeLaFin(lu.data.cancellation_details?.reason);
        const a = await deps.pro.finir(lu.data.id, raison, fin);
        if (a) {
          deps.pro.invalider(a.tenantId);
          if (a.premiereFin) {
            await deps.pro.alerter(`Pro terminé (${raison === 'impaye' ? 'impayé' : 'résiliation'}) : espace ${a.tenantId} (${a.abonnementId}). L'espace revient en Free.`);
          }
          // La première raison et la première date, gardées en base, prévalent lors des rejeux.
          await deps.pro.surFinDuPro({
            tenantId: a.tenantId,
            abonnementPro: a.abonnementId,
            livemode: e.livemode,
            raison: a.finRaison ?? raison,
            finiLe: a.finiLe ?? fin,
            rendreNumero: a.rendreNumero,
            finPrevueLe: a.finPrevueLe,
            customerId: lu.data.customer ? idDe(lu.data.customer) : null,
            carte: lu.data.default_payment_method ? idDe(lu.data.default_payment_method) : null,
          });
        }
        return ACQUITTE;
      }
      const fins = lignes.map((l) => l.current_period_end).filter((v): v is number => typeof v === 'number');
      const finDePeriode = fins.length > 0 ? Math.max(...fins) : null;
      const finPrevue = lu.data.cancel_at ?? (lu.data.cancel_at_period_end === true ? finDePeriode : null);
      const intervalle = lignes.map((l) => l.price?.recurring?.interval).find((v): v is string => typeof v === 'string');
      const a = await deps.pro.modifier(lu.data.id, {
        finPrevueLe: finPrevue === null ? null : new Date(finPrevue * 1000),
        periodicite: intervalle ? (PERIODICITE_DE_STRIPE[intervalle] ?? null) : null,
      });
      if (a) deps.pro.invalider(a.tenantId);
      return ACQUITTE;
    }

    const lu = factureSchema.safeParse(e.objet);
    const details = lu.success ? lu.data.parent?.subscription_details : null;
    const meta = metaProSchema.safeParse(details?.metadata ?? {});
    if (!lu.success || !details || !meta.success) return illisible(e, 'pro');
    const abonnementId = idDe(details.subscription);
    const fins = (lu.data.lines?.data ?? []).map((l) => l.period?.end).filter((v): v is number => typeof v === 'number');
    const finFacture = fins.length > 0 ? new Date(Math.max(...fins) * 1000) : null;
    if (e.type === 'invoice.payment_failed') {
      const a = await deps.pro.majStatut(abonnementId, 'en_retard', null, finFacture);
      if (a) {
        deps.pro.invalider(a.tenantId);
        await deps.pro.alerter(`Renouvellement du Pro échoué : espace ${a.tenantId} (${a.abonnementId}). Stripe réessaie ; sans paiement, l'espace reviendra en Free.`);
      }
      return ACQUITTE;
    }
    // Une facture peut arriver avant la session Checkout : elle suffit alors à enregistrer le Pro.
    const paye = await deps.pro.majStatut(abonnementId, 'actif', finFacture);
    if (paye) deps.pro.invalider(paye.tenantId);
    else {
      await enregistrer({
        tenantId: meta.data.tenant_id,
        abonnementId,
        periodicite: meta.data.periodicite ?? 'mois',
        periodeFin: finFacture,
      });
    }
    return ACQUITTE;
  }

  async function traiterNumero(e: EvenementStripeVerifie): Promise<IssueTraitementAbonnement> {
    if (e.type === 'checkout.session.completed') {
      const lu = sessionNumeroSchema.safeParse(e.objet);
      if (!lu.success) return illisible(e, 'numero');
      if (lu.data.payment_status !== 'paid') return ACQUITTE;
      await enregistrerNumero({
        tenantId: lu.data.metadata.tenant_id,
        abonnementId: idDe(lu.data.subscription),
        livemode: e.livemode,
        periodeFin: null,
      });
      return ACQUITTE;
    }

    if (e.type === 'customer.subscription.deleted') {
      const lu = abonnementNumeroSchema.safeParse(e.objet);
      if (!lu.success) return illisible(e, 'numero');
      const a = await deps.numero.majStatut(lu.data.id, 'resilie', null);
      if (a) {
        await deps.numero.alerter(await deps.pro.vivant(a.tenantId)
          ? `Abonnement du numéro seul arrêté : espace ${a.tenantId} (${a.abonnementId}). Le numéro est inclus dans son Pro.`
          : `Abonnement du numéro terminé : espace ${a.tenantId} (${a.abonnementId}). Ses envois sont coupés ; le numéro est gardé 7 jours pour un réabonnement, puis libéré.`);
      }
      return ACQUITTE;
    }

    if (e.type === 'customer.subscription.updated') {
      const lu = abonnementNumeroModifieSchema.safeParse(e.objet);
      if (!lu.success) return illisible(e, 'numero');
      if (!metaNumeroSchema.safeParse(lu.data.metadata ?? {}).success) return ACQUITTE;
      const fins = (lu.data.items?.data ?? []).map((l) => l.current_period_end).filter((v): v is number => typeof v === 'number');
      const finDePeriode = fins.length > 0 ? Math.max(...fins) : null;
      const fin = lu.data.cancel_at ?? (lu.data.cancel_at_period_end === true ? finDePeriode : null);
      await deps.numero.noterFinPrevue(lu.data.id, fin === null ? null : new Date(fin * 1000));
      return ACQUITTE;
    }

    const lu = factureSchema.safeParse(e.objet);
    if (!lu.success) return illisible(e, 'numero');
    const details = lu.data.parent?.subscription_details;
    if (!details) return ACQUITTE;
    const abonnementId = idDe(details.subscription);
    const fins = (lu.data.lines?.data ?? []).map((l) => l.period?.end).filter((v): v is number => typeof v === 'number');
    const finFacture = fins.length > 0 ? new Date(Math.max(...fins) * 1000) : null;
    if (e.type === 'invoice.payment_failed') {
      // Un échec rejoué après le paiement ne doit pas régresser un abonnement déjà payé.
      const a = await deps.numero.majStatut(abonnementId, 'en_retard', null, finFacture);
      if (a) {
        await deps.numero.alerter(`Renouvellement du numéro échoué : espace ${a.tenantId} (${a.abonnementId}). Stripe réessaie ; sans paiement, ses envois seront coupés 7 jours après le premier échec.`);
      }
      return ACQUITTE;
    }
    const paye = await deps.numero.majStatut(abonnementId, 'actif', finFacture);
    if (paye) {
      // Une facture tardive sur un abonnement terminal ne rend rien : seul un abonnement actif reprend les campagnes.
      if (paye.statut === 'actif') await deps.numero.reprendreCampagnes(paye.tenantId);
      return ACQUITTE;
    }
    const meta = metaNumeroSchema.safeParse(details.metadata ?? {});
    if (meta.success) {
      await enregistrerNumero({ tenantId: meta.data.tenant_id, abonnementId, livemode: e.livemode, periodeFin: finFacture });
    }
    return ACQUITTE;
  }

  async function traiter(e: EvenementStripeVerifie): Promise<IssueTraitementAbonnement> {
    if (!concerne(e)) return NON_ABONNEMENT;
    // Le Pro est aiguillé en premier ; un objet marqué Pro ne tombe jamais dans le chemin du numéro.
    return objetDuPro(e.type, e.objet) ? traiterPro(e) : traiterNumero(e);
  }

  return { concerne, traiter };
}
