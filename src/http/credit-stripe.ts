import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { gardeEtendue, type Guard, type PreHandler } from '../auth/middleware';
import { espaceVerifie } from './scope';
import { journaliser } from '../lib/journal';
import { creerClientStripe, creerSessionCheckout, StripeError, type TransportStripe } from '../stripe/client';
import { verifierSignatureStripe } from '../stripe/signature';
import { creditDeLOffre, definitionOffre, OFFRES_RECHARGE, type OffreRecharge } from '../stripe/offres';
import type { IssuePaiement, PaiementStripe } from '../stripe/store.pg';

/**
 * Recharger le crédit IA par Stripe : la route qui ouvre un paiement, et le webhook qui crédite.
 * Cadrage : `docs/superpowers/specs/2026-09-28-recharge-stripe-design.md`.
 *
 * 🔴 LE RETOUR DE LA PAGE DE PAIEMENT NE CRÉDITE RIEN. Seul le webhook, signé par Stripe, crédite : une adresse de
 * retour se tape à la main, une signature ne se forge pas.
 */

// ------------------------------------------------------------------------------------------------------------
// La route de paiement (admin)
// ------------------------------------------------------------------------------------------------------------

/** Stripe configuré sur cette instance. `null` = recharge pas encore disponible (503). */
export interface StripeConfigure {
  /** La clé secrète (restreinte). Jamais journalisée, jamais rendue. */
  cle: string;
  /** Le mode de la clé : le client Stripe d'un espace est gardé par mode (migration 0191). */
  livemode: boolean;
  /** L'identifiant Stripe du prix de chaque offre. Vide = cette offre n'est pas encore en vente. */
  prix: Readonly<Record<OffreRecharge, string>>;
  transport: TransportStripe;
  /** L'adresse de la page Crédit IA de la console, où Stripe renvoie après le paiement ou l'abandon. */
  pageCredit: string;
}

export interface CreditPaiementRouteDeps {
  stripe: StripeConfigure | null;
  clients: {
    clientDe(tenantId: string, livemode: boolean): Promise<string | null>;
    retenirClient(tenantId: string, livemode: boolean, customerId: string): Promise<string>;
  };
  /**
   * Ce compte peut-il ouvrir un paiement ? Toujours oui en live. 🔴 En mode test, seul un exploitant : une carte de
   * test créditerait sinon de vrais euros de modèle à n'importe quel client, le temps des essais.
   */
  payeurAutorise(userId: string): Promise<boolean>;
}

const corpsPaiement = z.object({ offre: z.enum(OFFRES_RECHARGE) });

/** Le même refus pour « pas configuré » et « pas encore ouvert à ce compte » : l'écran dit la même chose. */
const INDISPONIBLE = { error: 'recharge pas encore disponible', code: 'recharge_indisponible' } as const;

export function registerCreditPaiement(app: FastifyInstance, deps: CreditPaiementRouteDeps, garde: Guard, limiteCouteuse: PreHandler): void {
  // Admin (la garde) et plafond coûteux : chaque clic crée des objets chez Stripe.
  const couteux = gardeEtendue(garde, limiteCouteuse);

  /**
   * Ouvre une session Checkout pour une offre et rend son adresse ; la console y redirige. Le corps ne porte qu'une
   * offre, jamais un montant ni un prix.
   */
  app.post('/tenants/:tenantId/credit/paiement', couteux, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const corps = corpsPaiement.safeParse(req.body ?? {});
    if (!corps.success) return reply.code(400).send({ error: 'offre inconnue (refill_50 ou refill_100)' });
    const offre = corps.data.offre;
    const s = deps.stripe;
    if (s === null || s.prix[offre] === '') return reply.code(503).send(INDISPONIBLE);
    if (!(await deps.payeurAutorise(req.auth?.userId ?? ''))) return reply.code(503).send(INDISPONIBLE);

    try {
      let client = await deps.clients.clientDe(tenant, s.livemode);
      if (client === null) {
        const cree = await creerClientStripe(s.transport, { cle: s.cle, tenantId: tenant });
        client = await deps.clients.retenirClient(tenant, s.livemode, cree);
      }
      const session = await creerSessionCheckout(s.transport, {
        cle: s.cle,
        tenantId: tenant,
        offre,
        prix: s.prix[offre],
        customerId: client,
        urlSucces: `${s.pageCredit}?paiement=recu`,
        urlAbandon: `${s.pageCredit}?paiement=abandon`,
        idempotence: `session-${tenant}-${randomUUID()}`,
      });
      return reply.code(200).send({ url: session.url });
    } catch (err) {
      if (!(err instanceof StripeError)) throw err;
      // 🔴 4xx et jamais 5xx : Cloudflare remplacerait le corps. Le message de Stripe (Stripe Tax pas activé, prix
      // archivé...) part dans le journal et pas au navigateur : il parle de NOTRE compte, et un message d'erreur
      // d'authentification de Stripe cite la fin de la clé.
      journaliser('error', 'stripe_paiement_impossible', {
        tenantId: tenant, offre, operation: err.operation, status: err.status, type: err.type, code: err.code, err: err.message,
      });
      return reply.code(422).send({
        error: 'Le paiement n’a pas pu être préparé. Réessayez dans un instant ; si cela persiste, contactez-nous.',
        code: 'paiement_impossible',
      });
    }
  });
}

// ------------------------------------------------------------------------------------------------------------
// Le webhook (signé par Stripe)
// ------------------------------------------------------------------------------------------------------------

/** Corps brut, capturé par le parser JSON global (celui du receveur Meta). */
type AvecCorpsBrut = FastifyRequest & { rawBody?: Buffer };

export interface StripeWebhookRouteDeps {
  /** Le secret de signature de la destination déclarée chez Stripe (`whsec_...`). Vide : tout est refusé. */
  secret: string;
  paiements: { crediterPaiement(p: PaiementStripe): Promise<IssuePaiement> };
  /**
   * Après un crédit : remonter le plafond de la clé de modèle de l'espace (`remonterPlafondApresRecharge`). La route
   * ne l'attend pas (le câblage le fait suivre par l'arrêt propre du processus) ; un échec est journalisé et ne
   * change pas la réponse : le crédit est écrit.
   */
  apresCredit(tenantId: string, creditMicroEur: number): Promise<void>;
  now?: () => number;
}

/** Les deux événements qui créditent. Tout autre événement rend 200 sans effet. */
const EVENEMENTS_CREDITANTS = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded']);

const evenementSchema = z.object({
  id: z.string(),
  type: z.string(),
  livemode: z.boolean(),
  data: z.object({ object: z.unknown() }),
});

/** Ce qu'on lit d'une session Checkout, et rien de plus (`safeParse`, les autres champs sont ignorés). */
const sessionSchema = z.object({
  id: z.string().min(1),
  mode: z.string(),
  payment_status: z.string(),
  amount_subtotal: z.number().int().nullable(),
  amount_total: z.number().int().nullable(),
  currency: z.string().nullable(),
  client_reference_id: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
  // Un identifiant, ou l'objet facture si l'événement l'a déplié.
  invoice: z.union([z.string(), z.object({ id: z.string() })]).nullable().optional(),
});

/** NOS métadonnées. Une session qui ne les porte pas n'est pas une recharge : le compte vend peut-être autre chose. */
const metadonneesSchema = z.object({
  tenant_id: z.uuid(),
  offre: z.enum(OFFRES_RECHARGE),
});

export function registerStripeWebhook(app: FastifyInstance, deps: StripeWebhookRouteDeps): void {
  const maintenant = deps.now ?? (() => Date.now());

  app.post('/webhooks/stripe', async (req, reply) => {
    // 1. 🔴 La signature, sur le corps brut, AVANT de lire quoi que ce soit du corps.
    const brut = (req as AvecCorpsBrut).rawBody;
    const entete = req.headers['stripe-signature'];
    const signature = Array.isArray(entete) ? entete[0] : entete;
    if (!brut || !verifierSignatureStripe(brut, signature, deps.secret, maintenant())) {
      return reply.code(401).send({ error: 'signature invalide' });
    }

    // 2. L'enveloppe. Signée mais illisible : 400, Stripe rejouera, et le tableau de bord montrera l'échec.
    const ev = evenementSchema.safeParse(req.body);
    if (!ev.success) {
      journaliser('error', 'stripe_webhook_illisible', { issues: ev.error.issues.length });
      return reply.code(400).send({ error: 'événement illisible' });
    }
    if (!EVENEMENTS_CREDITANTS.has(ev.data.type)) return reply.code(200).send({ recu: true });

    // 3. La session. Un événement qui crédite et qu'on ne sait pas lire est de l'argent encaissé sans crédit : 422,
    //    donc rejoué par Stripe pendant trois jours, le temps de corriger le code.
    const lue = sessionSchema.safeParse(ev.data.data.object);
    if (!lue.success) {
      journaliser('error', 'stripe_session_illisible', { evenement: ev.data.id, type: ev.data.type });
      return reply.code(422).send({ error: 'session illisible' });
    }
    const session = lue.data;
    const meta = metadonneesSchema.safeParse(session.metadata ?? {});
    // Pas une de nos recharges : 200 sans effet, sinon Stripe rejouerait un événement qui ne nous concerne pas.
    if (session.mode !== 'payment' || !meta.success) return reply.code(200).send({ recu: true });
    // Paiement différé pas encore arrivé : `async_payment_succeeded` viendra.
    if (session.payment_status !== 'paid') return reply.code(200).send({ recu: true });

    // 4. 🔴 Le recoupement : l'offre des métadonnées doit correspondre à ce que Stripe a ENCAISSÉ hors taxe, en euros,
    //    pour cet espace. Sinon aucun crédit, et une trace en erreur : rejouer n'y changerait rien, donc 200.
    const { tenant_id: tenantId, offre } = meta.data;
    const attendu = definitionOffre(offre).htCentimes;
    const reference = session.client_reference_id ?? null;
    if (session.currency !== 'eur' || session.amount_subtotal !== attendu || (reference !== null && reference !== tenantId)) {
      journaliser('error', 'stripe_paiement_incoherent', {
        evenement: ev.data.id, session: session.id, tenantId, offre, attenduCentimes: attendu,
        payeCentimes: session.amount_subtotal, devise: session.currency, referenceConcorde: reference === null || reference === tenantId,
      });
      return reply.code(200).send({ recu: true, credite: false });
    }

    // 5. Une transaction : la ligne de paiement (idempotence), le crédit, le mouvement `achat`. Une panne de base
    //    lève, donc 5xx, et Stripe rejoue : c'est ce qu'on veut.
    const credit = creditDeLOffre(offre);
    const facture = session.invoice === undefined || session.invoice === null
      ? null
      : typeof session.invoice === 'string' ? session.invoice : session.invoice.id;
    const issue = await deps.paiements.crediterPaiement({
      sessionId: session.id,
      tenantId,
      offre,
      creditMicroEur: credit,
      htCentimes: attendu,
      ttcCentimes: session.amount_total,
      factureId: facture,
      livemode: ev.data.livemode,
    });
    if (issue === 'espace_inconnu') {
      journaliser('error', 'stripe_paiement_espace_inconnu', { evenement: ev.data.id, session: session.id, tenantId });
      return reply.code(200).send({ recu: true, credite: false });
    }
    if (issue === 'credite') {
      // Après la transaction, et SANS la faire attendre à Stripe : la réponse part dès que le crédit est écrit (Stripe
      // abandonne un webhook trop lent, et Vercel peut prendre jusqu'à 30 s). Un échec se journalise : le crédit est
      // écrit, le plafond rattrapera au mouvement suivant.
      deps.apresCredit(tenantId, credit).catch((err: unknown) => {
        journaliser('error', 'stripe_plafond_non_remonte', { tenantId, err });
      });
    }
    return reply.code(200).send({ recu: true, credite: issue === 'credite' });
  });
}
