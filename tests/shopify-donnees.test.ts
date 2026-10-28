import { describe, it, expect } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { verifierSignatureShopify } from '../src/shopify/signature';
import {
  donneesDeCommande, donneesDExpedition, montantAffiche, montantBoutique, numeroDeCommandeDExpedition, schemaCommande, schemaExpedition,
  telephoneDeCommande, telephoneDExpedition, valeurDeVariable,
} from '../src/shopify/donnees';
import { domaineShopify, lienInstallation, verifierBoutique } from '../src/shopify/connexion';

/**
 * LE CONNECTEUR SHOPIFY, SES PIÈCES PURES (plan 2026-10-21, lot 1) : la signature, la lecture des corps mesurés au lot 0,
 * la vérification d'une connexion. Les corps ci-dessous reprennent la forme des vrais webhooks reçus le 2026-10-21.
 */

const SECRET = randomBytes(16).toString('hex');
const signer = (corps: Buffer, secret = SECRET) => createHmac('sha256', secret).update(corps).digest('base64');

describe('la signature d’un webhook Shopify', () => {
  const corps = Buffer.from(JSON.stringify({ id: 1, name: '#1001' }));

  it('accepte le HMAC base64 du corps brut avec le secret de la boutique', () => {
    expect(verifierSignatureShopify(corps, signer(corps), SECRET)).toBe(true);
  });

  it('🔴 refuse un autre secret, un corps changé d’un octet, un en-tête absent ou mal formé, un secret vide', () => {
    expect(verifierSignatureShopify(corps, signer(corps, 'autre'), SECRET)).toBe(false);
    expect(verifierSignatureShopify(Buffer.from(JSON.stringify({ id: 2, name: '#1001' })), signer(corps), SECRET)).toBe(false);
    expect(verifierSignatureShopify(corps, undefined, SECRET)).toBe(false);
    expect(verifierSignatureShopify(corps, 'pas-du-base64', SECRET)).toBe(false);
    expect(verifierSignatureShopify(corps, signer(corps, ''), '')).toBe(false);
  });
});

/** Une commande payée telle que reçue le 2026-10-21 (sans client), réduite à ce que le connecteur lit. */
const commande = (over: Record<string, unknown> = {}) => ({
  id: 6786850717755, name: '#1002', checkout_token: 'jeton-du-checkout', customer: null, phone: null,
  order_status_url: 'https://messaging-me-essai.myshopify.com/70386155579/orders/3d23/authenticate?key=b325',
  shipping_address: { first_name: 'Julien', phone: '+33633921577', country_code: 'FR' }, billing_address: null,
  total_price: '12.00', presentment_currency: 'EUR', total_price_set: { presentment_money: { amount: '12.00', currency_code: 'EUR' } },
  ...over,
});

describe('la lecture des corps mesurés', () => {
  it('une commande : téléphone de livraison d’abord, puis facturation, client, commande', () => {
    const c = schemaCommande.parse(commande());
    expect(telephoneDeCommande(c, 'US')).toBe('+33633921577');
    const sansLivraison = schemaCommande.parse(commande({ shipping_address: null, billing_address: { phone: '06 12 34 56 78', country_code: 'FR' } }));
    expect(telephoneDeCommande(sansLivraison, 'US')).toBe('+33612345678');
    const client = schemaCommande.parse(commande({ shipping_address: null, customer: { id: 9, phone: '+33611111111' } }));
    expect(telephoneDeCommande(client, null)).toBe('+33611111111');
    expect(telephoneDeCommande(schemaCommande.parse(commande({ shipping_address: null })), null)).toBeNull();
  });

  it('un numéro national se lit au pays de SON adresse, à défaut à celui de la boutique', () => {
    const c = schemaCommande.parse(commande({ shipping_address: { phone: '0612345678', country_code: null } }));
    expect(telephoneDeCommande(c, 'FR')).toBe('+33612345678');
    const be = schemaCommande.parse(commande({ shipping_address: { phone: '0470123456', country_code: 'BE' } }));
    expect(telephoneDeCommande(be, 'FR')).toBe('+32470123456');
  });

  it('les données d’une commande : prénom, numéro, montant payé dans la devise du client, lien', () => {
    const d = donneesDeCommande(schemaCommande.parse(commande()));
    expect(d.first_name).toBe('Julien');
    expect(d.order_number).toBe('#1002');
    expect(d.order_status_url).toContain('/authenticate?key=');
    expect(d.order_total).toMatch(/12,00\s€/);
  });

  it('🔴 le montant est celui que le client a payé (presentment_money), pas celui de la boutique', () => {
    const c = schemaCommande.parse(commande({
      total_price: '12.00', presentment_currency: 'USD',
      total_price_set: { presentment_money: { amount: '11.04', currency_code: 'EUR' } },
    }));
    expect(montantAffiche(c)).toMatch(/11,04\s€/);
  });

  it('une expédition : téléphone de destination, suivi, numéro de commande sans le suffixe', () => {
    const f = schemaExpedition.parse({
      id: 6247859585083, order_id: 6786850717755, name: '#1002.1', tracking_company: 'Colissimo',
      tracking_number: '6A12345678901', tracking_url: 'https://www.laposte.fr/outils/suivre-vos-envois?code=6A12345678901',
      destination: { first_name: 'Julien', phone: '+33633921577', country_code: 'FR' },
    });
    expect(telephoneDExpedition(f, 'US')).toBe('+33633921577');
    expect(donneesDExpedition(f)).toEqual({
      first_name: 'Julien', order_number: '#1002', carrier: 'Colissimo', tracking_number: '6A12345678901',
      tracking_url: 'https://www.laposte.fr/outils/suivre-vos-envois?code=6A12345678901',
    });
    expect(numeroDeCommandeDExpedition('#1002')).toBe('#1002');
  });

  it('une valeur part sur une ligne, sans tabulation ni suite d’espaces, et vide vaut absente', () => {
    expect(valeurDeVariable('  Jean\n\tPierre    Martin ')).toBe('Jean Pierre Martin');
    expect(valeurDeVariable('   ')).toBeNull();
    expect(valeurDeVariable(null)).toBeNull();
    expect(donneesDExpedition(schemaExpedition.parse({ id: 1, order_id: 2, name: '#1.1', tracking_url: null, destination: null }))).toEqual({ order_number: '#1' });
  });

  it('un corps qui n’a pas la forme attendue est refusé, sans lever', () => {
    expect(schemaCommande.safeParse({ name: '#1' }).success).toBe(false);
    expect(schemaCommande.safeParse(commande({ id: 'abc' })).success).toBe(false);
  });
});

/** Le montant d'une vente attribuée (plan 2026-10-28, tâche 3) : la devise de la BOUTIQUE, pour que les ventes s'additionnent. */
describe('le montant d’une vente attribuée', () => {
  it('montantBoutique lit shop_money, pas ce que le client a vu', () => {
    const c = schemaCommande.parse(commande({
      total_price: '12.00', presentment_currency: 'USD',
      total_price_set: { presentment_money: { amount: '13.10', currency_code: 'USD' }, shop_money: { amount: '12.00', currency_code: 'EUR' } },
    }));
    expect(montantBoutique(c, 'GBP')).toEqual({ montant: '12.00', devise: 'EUR' });
    expect(montantAffiche(c)).toMatch(/13,10\s\$/);
  });

  it('sans shop_money, repli sur total_price et la devise de la boutique', () => {
    const c = schemaCommande.parse(commande({ total_price: '30.5', total_price_set: null }));
    expect(montantBoutique(c, 'EUR')).toEqual({ montant: '30.5', devise: 'EUR' });
  });

  it('un montant ou une devise illisible ne donne rien', () => {
    expect(montantBoutique(schemaCommande.parse(commande({ total_price: '12,00', total_price_set: null })), 'EUR')).toBeNull();
    expect(montantBoutique(schemaCommande.parse(commande({ total_price: '12.00', total_price_set: null })), null)).toBeNull();
    expect(montantBoutique(schemaCommande.parse(commande({ total_price: '12.00', total_price_set: null })), 'euro')).toBeNull();
    expect(montantBoutique(schemaCommande.parse(commande({
      total_price: null, total_price_set: { shop_money: { amount: '-1', currency_code: 'EUR' } },
    })), 'EUR')).toBeNull();
  });

  it('montantAffiche lit toujours presentment_money, et se passe de lui', () => {
    const sansPresentment = schemaCommande.parse(commande({
      total_price: '9.00', presentment_currency: 'EUR', total_price_set: { shop_money: { amount: '9.00', currency_code: 'EUR' } },
    }));
    expect(montantAffiche(sansPresentment)).toMatch(/9,00\s€/);
  });

  it('le drapeau test et la page d’arrivée se lisent, absents ou non', () => {
    const c = schemaCommande.parse(commande({ test: true, landing_site: '/?utm_source=whatsapp' }));
    expect([c.test, c.landing_site]).toEqual([true, '/?utm_source=whatsapp']);
    expect(schemaCommande.parse(commande()).test ?? false).toBe(false);
  });
});

describe('le domaine d’une boutique', () => {
  it('accepte le domaine, l’adresse complète ou le nom nu, et rien d’autre', () => {
    expect(domaineShopify('Ma-Boutique.myshopify.com')).toBe('ma-boutique.myshopify.com');
    expect(domaineShopify('https://ma-boutique.myshopify.com/admin')).toBe('ma-boutique.myshopify.com');
    expect(domaineShopify('ma-boutique')).toBe('ma-boutique.myshopify.com');
    // L'adresse de l'admin, que le marchand de la console a sous les yeux.
    expect(domaineShopify('https://admin.shopify.com/store/ma-boutique/settings/apps')).toBe('ma-boutique.myshopify.com');
    expect(domaineShopify('admin.shopify.com/store/ma-boutique')).toBe('ma-boutique.myshopify.com');
    expect(domaineShopify('https://admin.shopify.com/store/')).toBeNull();
    expect(domaineShopify('admin.shopify.com')).toBeNull();
    for (const faux of ['ma-boutique.com', 'evil.com/x.myshopify.com', '127.0.0.1', 'a.myshopify.com.evil.com', '', '-x.myshopify.com', 42]) {
      expect(domaineShopify(faux)).toBeNull();
    }
  });

  it('le lien d’installation est celui mesuré', () => {
    expect(lienInstallation('ma-boutique.myshopify.com', 'abc123')).toBe('https://admin.shopify.com/store/ma-boutique/oauth/install?client_id=abc123');
  });
});

describe('la vérification d’une connexion', () => {
  const reponse = (status: number, corps: unknown) => new Response(typeof corps === 'string' ? corps : JSON.stringify(corps), { status });

  function faux(...reponses: Array<Response | Error>) {
    const appels: Array<{ url: string; init: RequestInit | undefined }> = [];
    const appeler = (async (url: string, init?: RequestInit) => {
      appels.push({ url, init });
      const r = reponses.shift();
      if (!r) throw new Error('appel non prévu');
      if (r instanceof Error) throw r;
      return r;
    }) as unknown as typeof fetch;
    return { appeler, appels };
  }

  it('demande un jeton en client_credentials, en JSON, puis lit la boutique ; le jeton n’est pas rendu', async () => {
    const f = faux(reponse(200, { access_token: 'shpat_x', scope: 'read_orders', expires_in: 86399 }), reponse(200, { shop: { name: 'Essai', country_code: 'FR', currency: 'EUR' } }));
    const r = await verifierBoutique('b.myshopify.com', 'cid', 'sec', f.appeler);
    expect(r).toEqual({ ok: true, nom: 'Essai', pays: 'FR', devise: 'EUR' });
    expect(f.appels[0]!.url).toBe('https://b.myshopify.com/admin/oauth/access_token');
    expect((f.appels[0]!.init!.headers as Record<string, string>).accept).toBe('application/json');
    expect(String(f.appels[0]!.init!.body)).toContain('grant_type=client_credentials');
    expect(f.appels[1]!.url).toBe('https://b.myshopify.com/admin/api/2026-10/shop.json');
    expect((f.appels[1]!.init!.headers as Record<string, string>)['x-shopify-access-token']).toBe('shpat_x');
  });

  it('chaque refus mesuré rend le geste qui le règle', async () => {
    const pasInstallee = await verifierBoutique('b.myshopify.com', 'cid', 'sec', faux(reponse(400, { error: 'app_not_installed' })).appeler);
    expect(pasInstallee).toMatchObject({ ok: false, code: 'app_non_installee' });
    expect(pasInstallee.ok === false && pasInstallee.message).toContain('https://admin.shopify.com/store/b/oauth/install?client_id=cid');
    expect(await verifierBoutique('b.myshopify.com', 'cid', 'sec', faux(reponse(400, { error: 'shop_not_permitted' })).appeler)).toMatchObject({ ok: false, code: 'hors_organisation' });
    expect(await verifierBoutique('b.myshopify.com', 'cid', 'sec', faux(reponse(401, { error: 'invalid_client' })).appeler)).toMatchObject({ ok: false, code: 'identifiants' });
    expect(await verifierBoutique('b.myshopify.com', 'cid', 'sec', faux(reponse(404, '<!DOCTYPE html>')).appeler)).toMatchObject({ ok: false, code: 'boutique_inconnue' });
  });

  it('une panne de Shopify ou du réseau est passagère, jamais une connexion refusée', async () => {
    expect(await verifierBoutique('b.myshopify.com', 'cid', 'sec', faux(reponse(503, 'indisponible')).appeler)).toMatchObject({ ok: false, code: 'passager' });
    expect(await verifierBoutique('b.myshopify.com', 'cid', 'sec', faux(new Error('ECONNRESET')).appeler)).toMatchObject({ ok: false, code: 'passager' });
    expect(await verifierBoutique('b.myshopify.com', 'cid', 'sec', faux(reponse(200, { access_token: 'x' }), reponse(500, '')).appeler)).toMatchObject({ ok: false, code: 'passager' });
  });
});
