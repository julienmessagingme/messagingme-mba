import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { gardeEtendue, type Guard, type PreHandler } from '../auth/middleware';
import { espaceVerifie } from './scope';
import { journaliser } from '../lib/journal';
import { corpsDuRefus } from '../lib/issue';
import { lireFactureStripe, StripeError } from '../stripe/client';
import { verifierSignatureStripe } from '../stripe/signature';
import { ouvrirPaiement, RECHARGE_INDISPONIBLE, type DepsPaiement } from '../stripe/paiement';
import { creerTraitementAbonnements, type DepsTraitementAbonnements } from '../stripe/traitement-abonnements';
import { creerTraitementRecharge, type DepsTraitementRecharge } from '../stripe/traitement-recharge';

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

export type { StripeConfigure } from '../stripe/paiement';

/** L'ouverture d'un paiement (`src/stripe/paiement.ts`, les MÊMES objets que le MCP reçoit), plus les factures. */
export interface CreditPaiementRouteDeps extends DepsPaiement {
  /**
   * La facture d'un paiement DE CET ESPACE (`PgStripeStore.factureDe`) : `null` = paiement inconnu ici (ou d'un autre
   * espace), `factureId` nul = Stripe n'en a pas émis. Requis : la route n'a pas d'autre source.
   */
  factures: { factureDe(tenantId: string, sessionId: string): Promise<{ factureId: string | null } | null> };
}

/** Une session Checkout, telle que Stripe les nomme. Autre chose ne désigne aucun paiement : 404, sans lecture. */
const SESSION_STRIPE = /^cs_[A-Za-z0-9_]{1,250}$/;

/**
 * Qui peut ouvrir un paiement, selon le MODE de la clé Stripe : tout admin en live ; en test, seul un exploitant
 * (`OPS_EMAILS`), parce qu'une carte de test créditerait sinon de vrais euros de modèle à n'importe quel client.
 * Une fonction et pas trois lignes dans le câblage : inverser la condition du mode doit faire échouer un test
 * (`tests/http-credit-stripe.test.ts`), et le câblage qui lui passe le mode est tenu par un autre.
 */
export function creerPayeurAutorise(o: {
  livemode: boolean;
  adresseDe(userId: string): Promise<string | null>;
  estExploitant(adresse: string): boolean;
}): (userId: string) => Promise<boolean> {
  return async (userId) => {
    if (o.livemode) return true;
    const adresse = await o.adresseDe(userId);
    return adresse !== null && o.estExploitant(adresse);
  };
}

/** Le refus de l'ouverture d'un paiement, repris tel quel par les factures : mêmes règles, même phrase à l'écran. */
const INDISPONIBLE = corpsDuRefus(RECHARGE_INDISPONIBLE);

export function registerCreditPaiement(app: FastifyInstance, deps: CreditPaiementRouteDeps, garde: Guard, limiteCouteuse: PreHandler): void {
  // Admin (la garde) et plafond coûteux : chaque clic crée des objets chez Stripe.
  const couteux = gardeEtendue(garde, limiteCouteuse);

  /**
   * Ouvre une session Checkout pour une offre et rend son adresse ; la console y redirige. Le corps ne porte qu'une
   * offre, jamais un montant ni un prix (`ouvrirPaiement`).
   */
  app.post('/tenants/:tenantId/credit/paiement', couteux, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const r = await ouvrirPaiement(deps, tenant, req.body, req.auth?.userId ?? '', 'console');
    if (!r.ok) return reply.code(r.statut).send(corpsDuRefus(r));
    return reply.code(200).send({ url: r.valeur.url });
  });

  /**
   * La facture d'un achat (décision de Julien du 2026-09-29) : l'adresse de sa page hébergée par Stripe (consultation
   * et PDF), que la console ouvre dans un onglet. Mêmes gardes que le paiement : admin, espace vérifié, plafond coûteux
   * (chaque clic appelle Stripe), et la même règle du mode test.
   *
   * 🔴 LE PAIEMENT SE RELIT DANS CET ESPACE (`tenant_id = $1`) : un identifiant de session d'un autre espace rend 404,
   * exactement comme un identifiant inconnu, et Stripe n'est pas appelé. La facture vient de notre base, jamais de la
   * requête. Aucun refus ne part en 5xx sur une erreur de Stripe : Cloudflare en remplacerait le corps.
   */
  app.get('/tenants/:tenantId/credit/factures/:sessionId', couteux, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const sessionId = (req.params as { sessionId?: unknown }).sessionId;
    const s = deps.stripe;
    if (s === null) return reply.code(503).send(INDISPONIBLE);
    if (!(await deps.payeurAutorise(req.auth?.userId ?? ''))) return reply.code(503).send(INDISPONIBLE);
    const inconnu = { error: 'paiement inconnu', code: 'paiement_inconnu' } as const;
    if (typeof sessionId !== 'string' || !SESSION_STRIPE.test(sessionId)) return reply.code(404).send(inconnu);

    const paiement = await deps.factures.factureDe(tenant, sessionId);
    if (paiement === null) return reply.code(404).send(inconnu);
    if (paiement.factureId === null) {
      return reply.code(404).send({ error: 'Ce paiement n’a pas de facture chez Stripe.', code: 'sans_facture' });
    }

    try {
      const facture = await lireFactureStripe(s.transport, { cle: s.cle, facture: paiement.factureId });
      if (facture.url === null) {
        // Une facture sans page hébergée : encore un brouillon chez Stripe, ou finalisée hors de Checkout.
        journaliser('error', 'stripe_facture_sans_adresse', { tenantId: tenant, session: sessionId, facture: paiement.factureId });
        return reply.code(422).send({ error: 'La facture n’est pas encore consultable chez Stripe. Réessayez plus tard.', code: 'facture_sans_adresse' });
      }
      return reply.code(200).send({ url: facture.url });
    } catch (err) {
      if (!(err instanceof StripeError)) throw err;
      // Le message de Stripe reste au journal : il parle de NOTRE compte (clé sans droit de lecture des factures,
      // par exemple), et peut citer la fin de la clé.
      journaliser('error', 'stripe_facture_impossible', {
        tenantId: tenant, session: sessionId, operation: err.operation, status: err.status, type: err.type, code: err.code, err: err.message,
      });
      return reply.code(422).send({
        error: 'La facture n’a pas pu être ouverte. Réessayez dans un instant ; si cela persiste, contactez-nous.',
        code: 'facture_impossible',
      });
    }
  });
}

// ------------------------------------------------------------------------------------------------------------
// Le webhook (signé par Stripe)
// ------------------------------------------------------------------------------------------------------------

/** Corps brut, capturé par le parser JSON global (celui du receveur Meta). */
type AvecCorpsBrut = FastifyRequest & { rawBody?: Buffer };

/** Les abonnements (`traitement-abonnements.ts`) et la recharge (`traitement-recharge.ts`), plus le protocole HTTP. */
export interface StripeWebhookRouteDeps extends DepsTraitementAbonnements, Pick<DepsTraitementRecharge, 'paiements' | 'apresCredit'> {
  /** Le secret de signature de la destination déclarée chez Stripe (`whsec_...`). Vide : tout est refusé. */
  secret: string;
  /**
   * Le mode de la clé Stripe configurée (`estCleLive`). Un événement d'un AUTRE mode ne crédite rien : un paiement
   * de test ne donne jamais de vrais euros de modèle, et un paiement réel reçu par une instance réglée en test ne se
   * crédite pas sur une base qui n'est pas la bonne. Requis : la configuration refuse le secret sans la clé.
   */
  livemode: boolean;
}

const evenementSchema = z.object({
  id: z.string(),
  type: z.string(),
  livemode: z.boolean(),
  data: z.object({ object: z.unknown() }),
});

export function registerStripeWebhook(app: FastifyInstance, deps: StripeWebhookRouteDeps): void {
  const maintenant = deps.now ?? (() => Date.now());
  const abonnements = creerTraitementAbonnements(deps);
  const recharges = creerTraitementRecharge({
    paiements: deps.paiements,
    apresCredit: (tenantId) => deps.apresCredit(tenantId),
    alerter: (texte) => deps.numero.alerter(texte),
  });

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
    const evenement = {
      id: ev.data.id,
      type: ev.data.type,
      livemode: ev.data.livemode,
      objet: ev.data.data.object,
    };
    const abonnement = abonnements.concerne(evenement);
    if (!recharges.concerne(evenement) && !abonnement) {
      return reply.code(200).send({ recu: true });
    }

    // 2 bis. 🔴 Le mode de l'événement doit être celui de la clé configurée. Rejouer n'y changerait rien, donc
    // 200 et une trace en erreur : c'est une destination mal déclarée chez Stripe.
    if (evenement.livemode !== deps.livemode) {
      journaliser('error', 'stripe_mode_incoherent', {
        evenement: evenement.id,
        type: evenement.type,
        livemodeEvenement: evenement.livemode,
        livemodeCle: deps.livemode,
      });
      return reply.code(200).send({ recu: true, credite: false });
    }

    // 2 ter. Les abonnements Pro et numéro ont leur propre chemin, qui ne crédite rien.
    if (abonnement) {
      const issue = await abonnements.traiter(evenement);
      if (issue.issue === 'illisible') return reply.code(422).send({ error: 'événement illisible' });
      if (issue.issue === 'acquitte') return reply.code(200).send({ recu: true });
    }

    // 3. La recharge du crédit IA (`src/stripe/traitement-recharge.ts`). Une session créditante illisible est de l'argent
    // encaissé sans crédit : 422 pour demander le rejeu de Stripe. Tout le reste est acquitté en 200.
    const recharge = await recharges.traiter(evenement);
    if (recharge.issue === 'illisible') return reply.code(422).send({ error: 'session illisible' });
    return reply.code(200).send(recharge.issue === 'acquitte' && recharge.credite !== undefined ? { recu: true, credite: recharge.credite } : { recu: true });
  });
}
