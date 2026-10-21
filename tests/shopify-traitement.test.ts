import { describe, it, expect } from 'vitest';
import { traiterWebhookShopify, type BoutiqueRecue, type DepsTraitementShopify } from '../src/shopify/traitement';
import { envoyerShopify, type EnvoyerPublic } from '../src/shopify/envoi';
import type { MessageBranche, Reservation } from '../src/shopify/store.pg';
import type { Emission } from '../src/emails-produit/emission';
import type { RapportEnvoi, ResultatEnvoiPublic } from '../src/api/envoi-public';

/**
 * LE TRAITEMENT D'UN WEBHOOK SHOPIFY VÉRIFIÉ, ET SON ENVOI (plan 2026-10-21, lot 1).
 *
 * 🔴 Ce qui se joue : un message parti ne se rappelle pas. Un webhook rejoué qui renverrait, un STOP ignoré, un
 * consentement écrit sans que le marchand l'ait affirmé, une fiche créée pour un événement sans message (elle compterait
 * dans la limite de l'offre) : aucun ne lève d'exception. Aucun envoi réel ici, l'envoi public est simulé.
 */

const T = '5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01';
const BOUTIQUE: BoutiqueRecue = { tenantId: T, domaine: 'b.myshopify.com', etat: 'connectee', pays: 'FR', consentementAffirme: false };

const commande = (over: Record<string, unknown> = {}) => ({
  id: 1002, name: '#1002', checkout_token: 'ck', customer: { id: 77, phone: null, first_name: 'Julien' },
  order_status_url: 'https://b.myshopify.com/1/orders/x/authenticate?key=k',
  shipping_address: { first_name: 'Julien', phone: '+33633921577', country_code: 'FR' },
  total_price_set: { presentment_money: { amount: '12.00', currency_code: 'EUR' } },
  ...over,
});
const expedition = { id: 5001, order_id: 1002, name: '#1002.1', tracking_company: 'Colissimo', tracking_number: '6A1', tracking_url: 'https://suivi/6A1', destination: { first_name: 'Julien', phone: '+33633921577', country_code: 'FR' } };

const MESSAGE: MessageBranche = {
  evenement: 'order_paid', modele: 'commande_payee', langue: 'fr', variables: ['first_name', 'order_number', 'order_status_url'],
  actif: true, modifieLe: '2026-10-21T00:00:00.000Z',
};

const rapport = (over: Partial<RapportEnvoi> = {}): RapportEnvoi => ({
  sendId: 's1', opening: 'whatsapp_template', recipientCount: 1, created: 1, matched: 0, skipped: [], skippedTotal: 0, ...over,
});

function monter(o: {
  messages?: MessageBranche[]; reservation?: Reservation; reponse?: ResultatEnvoiPublic; envoyerLeve?: boolean;
} = {}) {
  const journal = {
    reserve: [] as string[], issues: [] as Array<[string, string]>, liberes: [] as string[], liees: [] as unknown[],
    envois: [] as Array<{ corps: unknown; options: unknown }>, emails: [] as Emission[], effaces: [] as string[][],
    coupees: [] as string[], boutiquesEffacees: [] as string[],
  };
  const deps: DepsTraitementShopify = {
    store: {
      message: async (_t, e) => (o.messages ?? [MESSAGE]).find((m) => m.evenement === e) ?? null,
      reserverEvenement: async (_t, cle) => { journal.reserve.push(cle); return o.reservation ?? 'nouveau'; },
      noterIssue: async (_t, cle, issue) => { journal.issues.push([cle, issue]); },
      libererEvenement: async (_t, cle) => { journal.liberes.push(cle); },
      noterDernierEvenement: async () => undefined,
      lierCommande: async (...a) => { journal.liees.push(a); },
      couperParDomaine: async (d) => { journal.coupees.push(d); },
      effacerBoutique: async (t) => { journal.boutiquesEffacees.push(t); },
      contactsLies: async (_t, commandes, client) => (commandes.includes('1002') || client === '77' ? ['fiche-1'] : []),
    },
    envoyer: async (_t, corps, compter, options) => {
      journal.envois.push({ corps, options });
      if (o.envoyerLeve) throw new Error('panne');
      expect(await compter(1)).toBe(true);
      return o.reponse ?? { statut: 201, corps: rapport() };
    },
    ficheParTelephone: async (_t, e164) => (e164 === '+33633921577' ? 'fiche-1' : null),
    effacerFiches: async (_t, ids) => { journal.effaces.push([...ids]); },
    emails: { emettre: async (e) => { journal.emails.push(e); return {}; } },
    pageOffre: 'https://console.test/offre',
    maintenant: () => Date.parse('2026-10-21T10:00:00Z'),
  };
  return { deps, journal };
}

describe('une commande payée', () => {
  it('envoie le modèle branché, avec les données en variables, la clé métier et le nom de la ligne', async () => {
    const { deps, journal } = monter();
    expect(await traiterWebhookShopify(deps, BOUTIQUE, 'orders/paid', commande())).toEqual({ statut: 200 });
    expect(journal.envois).toHaveLength(1);
    const corps = journal.envois[0]!.corps as Record<string, unknown>;
    expect(corps).toMatchObject({
      idempotencyKey: 'shopify:b.myshopify.com:orders/paid:1002',
      target: { template: { name: 'commande_payee', language: 'fr' } },
      params: [
        { position: 1, source: { type: 'variable', key: 'first_name' } },
        { position: 2, source: { type: 'variable', key: 'order_number' } },
        { position: 3, source: { type: 'variable', key: 'order_status_url' } },
      ],
      recipients: [{ phone: '+33633921577', variables: { first_name: 'Julien', order_number: '#1002', order_status_url: 'https://b.myshopify.com/1/orders/x/authenticate?key=k' } }],
    });
    expect(journal.envois[0]!.options).toEqual({ nom: 'Shopify · commande payée · #1002', sansCampagneVide: true });
    expect(journal.issues).toEqual([['shopify:b.myshopify.com:orders/paid:1002', 'envoye']]);
    expect(journal.liees).toEqual([[T, '1002', '77', 'fiche-1']]);
  });

  it('🔴 sans consentement affirmé, la fiche n’est PAS écrite consentante ; affirmé, elle l’est, avec sa source', async () => {
    const a = monter();
    await traiterWebhookShopify(a.deps, BOUTIQUE, 'orders/paid', commande());
    expect((a.journal.envois[0]!.corps as { recipients: Array<Record<string, unknown>> }).recipients[0]).not.toHaveProperty('consent');
    const b = monter();
    await traiterWebhookShopify(b.deps, { ...BOUTIQUE, consentementAffirme: true }, 'orders/paid', commande());
    expect((b.journal.envois[0]!.corps as { recipients: Array<Record<string, unknown>> }).recipients[0]).toMatchObject({ consent: 'opted_in', consentSource: 'shopify:b.myshopify.com' });
  });

  it('🔴 aucun message branché (ou éteint) : rien ne se réserve, rien ne part, aucune fiche ne se crée', async () => {
    for (const messages of [[], [{ ...MESSAGE, actif: false }]]) {
      const { deps, journal } = monter({ messages });
      expect(await traiterWebhookShopify(deps, BOUTIQUE, 'orders/paid', commande())).toEqual({ statut: 200 });
      expect(journal.reserve).toEqual([]);
      expect(journal.envois).toEqual([]);
    }
  });

  it('🔴 un événement déjà servi ne repart pas ; un événement en cours fait réessayer Shopify', async () => {
    const servi = monter({ reservation: 'servi' });
    expect(await traiterWebhookShopify(servi.deps, BOUTIQUE, 'orders/paid', commande())).toEqual({ statut: 200 });
    expect(servi.journal.envois).toEqual([]);
    const enCours = monter({ reservation: 'en_cours' });
    expect(await traiterWebhookShopify(enCours.deps, BOUTIQUE, 'orders/paid', commande())).toEqual({ statut: 503 });
    expect(enCours.journal.envois).toEqual([]);
  });

  it('sans téléphone ou avec une donnée manquante : l’issue est inscrite, rien ne part', async () => {
    const sansTel = monter();
    await traiterWebhookShopify(sansTel.deps, BOUTIQUE, 'orders/paid', commande({ shipping_address: null, customer: null }));
    expect(sansTel.journal.issues).toEqual([['shopify:b.myshopify.com:orders/paid:1002', 'sans_telephone']]);
    expect(sansTel.journal.envois).toEqual([]);
    const sansLien = monter();
    await traiterWebhookShopify(sansLien.deps, BOUTIQUE, 'orders/paid', commande({ order_status_url: null }));
    expect(sansLien.journal.issues).toEqual([['shopify:b.myshopify.com:orders/paid:1002', 'donnee_manquante']]);
    expect(sansLien.journal.envois).toEqual([]);
  });

  it('🔴 une panne en route libère la réservation et fait réessayer Shopify (la clé d’envoi protège du doublon)', async () => {
    const { deps, journal } = monter({ envoyerLeve: true });
    expect(await traiterWebhookShopify(deps, BOUTIQUE, 'orders/paid', commande())).toEqual({ statut: 503 });
    expect(journal.liberes).toEqual(['shopify:b.myshopify.com:orders/paid:1002']);
    expect(journal.issues).toEqual([]);
  });

  it('la limite de contacts : l’issue est inscrite et UN e-mail du mois part aux admins', async () => {
    const { deps, journal } = monter({ reponse: { statut: 200, corps: rapport({ sendId: '', recipientCount: 0, created: 0, skipped: [{ index: 0, reason: 'plan_limit_reached' }], skippedTotal: 1 }) } });
    await traiterWebhookShopify(deps, BOUTIQUE, 'orders/paid', commande());
    expect(journal.issues).toEqual([['shopify:b.myshopify.com:orders/paid:1002', 'limite_contacts']]);
    expect(journal.emails).toEqual([{
      cle: 'shopify_limite_contacts', tenantId: T, a: 'admins', occasion: '2026-10',
      valeurs: { boutique: 'b.myshopify.com', lien_offre: 'https://console.test/offre' },
    }]);
  });
});

describe('une expédition', () => {
  it('envoie le message d’expédition, téléphone de destination et suivi, sans attendre la commande', async () => {
    const { deps, journal } = monter({ messages: [{ ...MESSAGE, evenement: 'order_fulfilled', modele: 'colis_parti', variables: ['order_number', 'tracking_url'] }] });
    expect(await traiterWebhookShopify(deps, BOUTIQUE, 'fulfillments/create', expedition)).toEqual({ statut: 200 });
    expect(journal.envois[0]!.corps).toMatchObject({
      idempotencyKey: 'shopify:b.myshopify.com:fulfillments/create:5001',
      recipients: [{ phone: '+33633921577', variables: { order_number: '#1002', tracking_url: 'https://suivi/6A1' } }],
    });
    expect(journal.envois[0]!.options).toMatchObject({ nom: 'Shopify · commande expédiée · #1002' });
  });
});

describe('une boutique coupée, la désinstallation et les sujets RGPD', () => {
  it('🔴 coupée : aucun message ne part, mais les sujets RGPD se traitent encore', async () => {
    const { deps, journal } = monter();
    const coupee = { ...BOUTIQUE, etat: 'coupee' as const };
    expect(await traiterWebhookShopify(deps, coupee, 'orders/paid', commande())).toEqual({ statut: 200 });
    expect(journal.envois).toEqual([]);
    await traiterWebhookShopify(deps, coupee, 'shop/redact', { shop_id: 1, shop_domain: 'b.myshopify.com' });
    expect(journal.boutiquesEffacees).toEqual([T]);
  });

  it('🔴 shop/redact sur une boutique reconnectée (connectée) : le branchement vivant n’est pas effacé', async () => {
    const { deps, journal } = monter();
    expect(await traiterWebhookShopify(deps, BOUTIQUE, 'shop/redact', { shop_id: 1, shop_domain: 'b.myshopify.com' })).toEqual({ statut: 200 });
    expect(journal.boutiquesEffacees).toEqual([]);
  });

  it('la source du consentement reste dans sa borne, même pour un long domaine', async () => {
    const { deps, journal } = monter();
    const long = `${'a'.repeat(90)}.myshopify.com`;
    await traiterWebhookShopify(deps, { ...BOUTIQUE, domaine: long, consentementAffirme: true }, 'orders/paid', commande());
    const r = (journal.envois[0]!.corps as { recipients: Array<{ consentSource: string }> }).recipients[0]!;
    expect(r.consentSource.length).toBeLessThanOrEqual(100);
  });

  it('app/uninstalled coupe la boutique par son domaine', async () => {
    const { deps, journal } = monter();
    await traiterWebhookShopify(deps, BOUTIQUE, 'app/uninstalled', { id: 1 });
    expect(journal.coupees).toEqual(['b.myshopify.com']);
  });

  it('customers/redact efface les fiches liées aux commandes, au client et à son numéro, une fois chacune', async () => {
    const { deps, journal } = monter();
    const r = await traiterWebhookShopify(deps, BOUTIQUE, 'customers/redact', {
      shop_id: 1, shop_domain: 'b.myshopify.com', customer: { id: 77, email: 'x@y.z', phone: '+33633921577' }, orders_to_redact: [1002],
    });
    expect(r).toEqual({ statut: 200 });
    expect(journal.effaces).toEqual([['fiche-1']]);
  });

  it('customers/data_request prévient les admins, sans aucune donnée du client dans l’e-mail', async () => {
    const { deps, journal } = monter();
    await traiterWebhookShopify(deps, BOUTIQUE, 'customers/data_request', { customer: { id: 77, email: 'x@y.z', phone: '+33600000000' }, orders_requested: [1002] });
    expect(journal.emails).toHaveLength(1);
    expect(journal.emails[0]).toMatchObject({ cle: 'shopify_demande_donnees', a: 'admins', valeurs: { boutique: 'b.myshopify.com' } });
    expect(JSON.stringify(journal.emails[0]!.valeurs)).not.toContain('x@y.z');
  });

  it('un corps bien signé mais illisible rend 200 (Shopify ne doit pas réessayer en boucle) ; un sujet inconnu aussi', async () => {
    const { deps, journal } = monter();
    expect(await traiterWebhookShopify(deps, BOUTIQUE, 'orders/paid', { pas: 'une commande' })).toEqual({ statut: 200 });
    expect(await traiterWebhookShopify(deps, BOUTIQUE, 'products/update', {})).toEqual({ statut: 200 });
    expect(journal.envois).toEqual([]);
  });
});

describe('l’adaptateur de l’envoi public : l’issue de chaque réponse', () => {
  const envoi = { tenantId: T, cle: 'k', nomLigne: 'n', modele: 'm', langue: 'fr', variables: [], valeurs: {}, telephone: '+33600000000', sourceConsentement: null };
  const rendant = (r: ResultatEnvoiPublic): EnvoyerPublic => async () => r;
  const ecarte = (reason: RapportEnvoi['skipped'][number]['reason']) => rendant({ statut: 200, corps: rapport({ sendId: '', recipientCount: 0, skipped: [{ index: 0, reason }] }) });

  it('chaque motif devient son issue', async () => {
    expect(await envoyerShopify(rendant({ statut: 201, corps: rapport() }), envoi)).toBe('envoye');
    expect(await envoyerShopify(ecarte('opted_out'), envoi)).toBe('desabonne');
    expect(await envoyerShopify(ecarte('no_consent'), envoi)).toBe('sans_consentement');
    expect(await envoyerShopify(ecarte('blocked_contact'), envoi)).toBe('bloque');
    expect(await envoyerShopify(ecarte('plan_limit_reached'), envoi)).toBe('limite_contacts');
    expect(await envoyerShopify(ecarte('invalid_phone'), envoi)).toBe('sans_telephone');
    expect(await envoyerShopify(rendant({ statut: 402, corps: { code: 'plan_limit_reached', limite: 'envoisModelesMois' } }), envoi)).toBe('limite_modeles');
    expect(await envoyerShopify(rendant({ statut: 409, corps: { code: 'idempotency_in_progress' } }), envoi)).toBe('en_cours');
    expect(await envoyerShopify(rendant({ statut: 409, corps: { code: 'number_unlinked' } }), envoi)).toBe('numero_indisponible');
    expect(await envoyerShopify(rendant({ statut: 422, corps: { code: 'template_not_approved' } }), envoi)).toBe('modele_refuse');
  });

  it('un modèle sans variable ne porte ni params ni variables', async () => {
    let corps: unknown;
    await envoyerShopify(async (_t, c) => { corps = c; return { statut: 201, corps: rapport() }; }, envoi);
    expect(corps).toMatchObject({ params: [], recipients: [{ phone: '+33600000000' }] });
    expect((corps as { recipients: Array<Record<string, unknown>> }).recipients[0]).not.toHaveProperty('variables');
  });
});
