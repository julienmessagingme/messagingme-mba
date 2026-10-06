import { z } from 'zod';
import type { PgAbonnementsNumeroStore } from '../stripe/abonnements.pg';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { gardeEtendue, type Guard, type PreHandler } from '../auth/middleware';
import { espaceVerifie } from './scope';
import { journaliser } from '../lib/journal';
import { corpsDuRefus } from '../lib/issue';
import { lireFactureStripe, StripeError } from '../stripe/client';
import { verifierSignatureStripe } from '../stripe/signature';
import { creditDeLOffre, definitionOffre, OFFRES_RECHARGE } from '../stripe/offres';
import { ouvrirPaiement, RECHARGE_INDISPONIBLE, type DepsPaiement } from '../stripe/paiement';
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
    const r = await ouvrirPaiement(deps, tenant, req.body, req.auth?.userId ?? '');
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

export interface StripeWebhookRouteDeps {
  /** Le secret de signature de la destination déclarée chez Stripe (`whsec_...`). Vide : tout est refusé. */
  secret: string;
  /**
   * Le mode de la clé Stripe configurée (`estCleLive`). Un événement d'un AUTRE mode ne crédite rien : un paiement
   * de test ne donne jamais de vrais euros de modèle, et un paiement réel reçu par une instance réglée en test ne se
   * crédite pas sur une base qui n'est pas la bonne. Requis : la configuration refuse le secret sans la clé.
   */
  livemode: boolean;
  paiements: { crediterPaiement(p: PaiementStripe): Promise<IssuePaiement> };
  /**
   * Après un crédit : remonter le plafond de la clé de modèle de l'espace (`remonterPlafondApresRecharge`, qui
   * recalcule la cible depuis le solde : le montant de CE crédit ne lui sert pas). La route ne l'attend pas (le
   * câblage le fait suivre par l'arrêt propre du processus) ; un échec est journalisé et ne change pas la réponse :
   * le crédit est écrit.
   */
  apresCredit(tenantId: string): Promise<void>;
  /**
   * L'abonnement du numéro fourni (lot 3c, livraison B) : `enregistrer` (l'abonnement et le numéro, ensemble),
   * `majStatut` et `noterFinPrevue` (lot 4) du magasin (`PgAbonnementsNumeroStore`), `alerter`, qui prévient Julien
   * (Telegram, ne lève jamais), et `reprendreCampagnes`, qui lève les pauses `numero_suspendu` de l'espace au paiement
   * (lot 4 ; le balayage du worker rattrape une reprise manquée).
   */
  numero: Pick<PgAbonnementsNumeroStore, 'enregistrer' | 'majStatut' | 'noterFinPrevue'> & {
    alerter(texte: string): Promise<void>;
    reprendreCampagnes(tenantId: string): Promise<void>;
  };
  now?: () => number;
}

/** Les deux événements qui créditent. Tout autre événement rend 200 sans effet. */
const EVENEMENTS_CREDITANTS = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded']);
/**
 * Les quatre événements de l'abonnement du numéro ; la session payée (`checkout.session.completed`) en est le
 * cinquième. `customer.subscription.updated` (lot 4) porte la résiliation programmée.
 */
const EVENEMENTS_ABONNEMENT = new Set([
  'invoice.paid', 'invoice.payment_failed', 'customer.subscription.deleted', 'customer.subscription.updated',
]);

/** Une session d'abonnement : seules les nôtres, `produit: numero`, nous concernent. */
const sessionAbonnementSchema = z.object({
  id: z.string().min(1),
  mode: z.literal('subscription'),
  payment_status: z.string(),
  subscription: z.union([z.string().startsWith('sub_'), z.object({ id: z.string().startsWith('sub_') })]),
  metadata: z.object({ tenant_id: z.uuid(), produit: z.literal('numero') }),
});

/**
 * Une facture (version d'API `2025-11-17.clover`) : l'abonnement et ses métadonnées sont sous `parent.subscription_details`
 * (lu dans la documentation de Stripe le 2026-10-06), la fin de la période payée sur ses lignes.
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
const abonnementSchema = z.object({ id: z.string().startsWith('sub_') });
/**
 * Un abonnement modifié (version d'API `2025-11-17.clover`, lu dans la documentation de Stripe le 2026-10-06) : la
 * résiliation programmée est `cancel_at` (une date) ou `cancel_at_period_end` (la fin de la période en cours, qui vit sur
 * les lignes, `items.data[].current_period_end`, et plus à la racine).
 */
const abonnementModifieSchema = z.object({
  id: z.string().startsWith('sub_'),
  cancel_at: z.number().int().nullable().optional(),
  cancel_at_period_end: z.boolean().optional(),
  items: z.object({ data: z.array(z.object({ current_period_end: z.number().int().optional() })) }).optional(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
});
const metaNumeroSchema = z.object({ tenant_id: z.uuid(), produit: z.literal('numero') });
const idDe = (v: string | { id: string }): string => (typeof v === 'string' ? v : v.id);

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

  /**
   * L'abonnement du numéro fourni (lot 3c, livraison B). L'ordre d'arrivée des événements ne change pas l'état final :
   * une facture payée arrivée avant la session enregistre l'abonnement depuis ses métadonnées, et la session qui suit
   * ne fait que le retrouver. Rien n'est coupé avant le lot 4 : un retard ou une résiliation préviennent Julien. Un
   * objet illisible rend 422 (Stripe rejoue) ; une panne de base lève, donc 5xx, et Stripe rejoue aussi.
   */
  const enregistrer = async (a: { tenantId: string; abonnementId: string; livemode: boolean; periodeFin: Date | null }): Promise<void> => {
    const issue = await deps.numero.enregistrer(a);
    // Un réabonnement payé rend le numéro : les campagnes en pause sur sa suspension repartent.
    if (issue.etat === 'enregistre') await deps.numero.reprendreCampagnes(a.tenantId);
    if (issue.etat === 'doublon') {
      await deps.numero.alerter(`Abonnement en double : ${a.abonnementId} pour l'espace ${a.tenantId}, qui en a déjà un. À annuler et rembourser chez Stripe. Tant qu'il ne l'est pas, chacune de ses factures redonne cette alerte.`);
    } else if (issue.etat === 'enregistre' && issue.numero === null) {
      await deps.numero.alerter(`URGENT : l'espace ${a.tenantId} a payé son numéro (${a.abonnementId}) mais la réserve est vide. Déclare un numéro dans /ops : il lui sera attribué.`);
    }
    // `resilie` : un événement en retard pour un abonnement déjà résilié (jaune 3 de la relecture de la livraison B).
  };

  async function traiterAbonnement(evenement: string, type: string, livemode: boolean, objet: unknown, reply: FastifyReply) {
    const illisible = () => {
      journaliser('error', 'stripe_abonnement_illisible', { evenement, type });
      return reply.code(422).send({ error: 'événement illisible' });
    };
    if (type === 'checkout.session.completed') {
      const lu = sessionAbonnementSchema.safeParse(objet);
      if (!lu.success) return illisible();
      if (lu.data.payment_status !== 'paid') return reply.code(200).send({ recu: true });
      await enregistrer({ tenantId: lu.data.metadata.tenant_id, abonnementId: idDe(lu.data.subscription), livemode, periodeFin: null });
      return reply.code(200).send({ recu: true });
    }
    if (type === 'customer.subscription.deleted') {
      const lu = abonnementSchema.safeParse(objet);
      if (!lu.success) return illisible();
      const a = await deps.numero.majStatut(lu.data.id, 'resilie', null);
      if (a) await deps.numero.alerter(`Abonnement du numéro terminé : espace ${a.tenantId} (${a.abonnementId}). Ses envois sont coupés ; le numéro est gardé 7 jours pour un réabonnement, puis libéré.`);
      return reply.code(200).send({ recu: true });
    }
    if (type === 'customer.subscription.updated') {
      const lu = abonnementModifieSchema.safeParse(objet);
      if (!lu.success) return illisible();
      // Seules nos métadonnées en font un abonnement du numéro : le compte Stripe vend aussi autre chose.
      if (!metaNumeroSchema.safeParse(lu.data.metadata ?? {}).success) return reply.code(200).send({ recu: true });
      const fins = (lu.data.items?.data ?? []).map((l) => l.current_period_end).filter((v): v is number => typeof v === 'number');
      const finDePeriode = fins.length > 0 ? Math.max(...fins) : null;
      const fin = lu.data.cancel_at ?? (lu.data.cancel_at_period_end === true ? finDePeriode : null);
      await deps.numero.noterFinPrevue(lu.data.id, fin === null ? null : new Date(fin * 1000));
      return reply.code(200).send({ recu: true });
    }
    const lu = factureSchema.safeParse(objet);
    if (!lu.success) return illisible();
    const details = lu.data.parent?.subscription_details;
    // Une facture sans abonnement (une recharge) : pas la nôtre.
    if (!details) return reply.code(200).send({ recu: true });
    const abonnementId = idDe(details.subscription);
    // La fin de la période que la facture couvre, la plus lointaine de ses lignes : payée, elle avance la période de
    // l'abonnement ; échouée, elle dit si cette période est DÉJÀ payée.
    const fins = (lu.data.lines?.data ?? []).map((l) => l.period?.end).filter((v): v is number => typeof v === 'number');
    const finFacture = fins.length > 0 ? new Date(Math.max(...fins) * 1000) : null;
    if (type === 'invoice.payment_failed') {
      // 🔴 Stripe ne garantit pas l'ordre : un échec rejoué APRÈS le paiement de la même facture ne repose rien, sans
      // quoi un client qui a payé serait coupé sept jours plus tard (rouge 2 de la relecture du lot 4).
      const a = await deps.numero.majStatut(abonnementId, 'en_retard', null, finFacture);
      if (a) await deps.numero.alerter(`Renouvellement du numéro échoué : espace ${a.tenantId} (${a.abonnementId}). Stripe réessaie ; sans paiement, ses envois seront coupés 7 jours après le premier échec.`);
      return reply.code(200).send({ recu: true });
    }
    // invoice.paid : la fin de la période payée.
    const periodeFin = finFacture;
    const paye = await deps.numero.majStatut(abonnementId, 'actif', periodeFin);
    if (paye) {
      // Une facture payée en retard sur un abonnement fini ne rend rien : seul un abonnement actif rouvre les envois.
      if (paye.statut === 'actif') await deps.numero.reprendreCampagnes(paye.tenantId);
      return reply.code(200).send({ recu: true });
    }
    // Inconnu : arrivée avant la session. Seules nos métadonnées en font un abonnement du numéro.
    const meta = metaNumeroSchema.safeParse(details.metadata ?? {});
    if (meta.success) await enregistrer({ tenantId: meta.data.tenant_id, abonnementId, livemode, periodeFin });
    return reply.code(200).send({ recu: true });
  }

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
    const abonnement = EVENEMENTS_ABONNEMENT.has(ev.data.type)
      || (ev.data.type === 'checkout.session.completed' && sessionAbonnementSchema.safeParse(ev.data.data.object).success);
    if (!EVENEMENTS_CREDITANTS.has(ev.data.type) && !abonnement) return reply.code(200).send({ recu: true });

    // 2 bis. 🔴 Le mode de l'événement doit être celui de la clé configurée (relecture du 2026-09-29). Rejouer n'y
    //        changerait rien, donc 200, et une trace en erreur : c'est une destination mal déclarée chez Stripe.
    if (ev.data.livemode !== deps.livemode) {
      journaliser('error', 'stripe_mode_incoherent', { evenement: ev.data.id, type: ev.data.type, livemodeEvenement: ev.data.livemode, livemodeCle: deps.livemode });
      return reply.code(200).send({ recu: true, credite: false });
    }

    // 2 ter. L'abonnement du numéro (lot 3c) : son propre chemin, qui ne crédite rien.
    if (abonnement) return traiterAbonnement(ev.data.id, ev.data.type, ev.data.livemode, ev.data.data.object, reply);

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
    // Paiement différé pas encore arrivé : `async_payment_succeeded` viendra. `no_payment_required` est une session
    // réglée à zéro par un code promo à 100 % : elle crédite, comme un paiement (décision de Julien du 2026-09-29).
    if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
      return reply.code(200).send({ recu: true });
    }

    // 4. 🔴 Le recoupement : l'offre des métadonnées doit correspondre au prix HT de la ligne, en euros, pour cet
    //    espace. `amount_subtotal` est le prix AVANT remise : un code promo ne change pas le crédit, qui reste plein
    //    (décision de Julien du 2026-09-29), et un prix Stripe qui ne vaut pas l'offre est toujours refusé. Sinon aucun crédit, et une trace en erreur : rejouer n'y changerait rien, donc 200.
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
      deps.apresCredit(tenantId).catch((err: unknown) => {
        journaliser('error', 'stripe_plafond_non_remonte', { tenantId, err });
      });
    }
    return reply.code(200).send({ recu: true, credite: issue === 'credite' });
  });
}
