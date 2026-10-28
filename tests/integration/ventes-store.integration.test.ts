import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgVentesStore } from '../../src/shopify/ventes.pg';
import { LIGNE_RELANCE_PANIER } from '../../src/shopify/attribution';

/**
 * Intégration du STORE DES VENTES (migration 0261, plan 2026-10-28, tâche 2). Ce qu'aucun faux ne prouve : quelles lignes de
 * Campagnes et quels messages deviennent une touche, l'unicité par commande, l'anonymisation. Espace jetable, détruit ici.
 */
const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('le store des ventes', () => {
  let pool: Pool;
  let store: PgVentesStore;
  let T = '';
  let contact = '';
  let fil = '';
  const maintenant = new Date('2026-10-20T12:00:00Z');
  const ilYA = (heures: number) => new Date(maintenant.getTime() - heures * 3_600_000);
  const depuis = ilYA(5 * 24);

  async function campagne(nom: string, o: { delivery?: string | null; workflow?: boolean; modele?: string; envoye?: Date } = {}): Promise<string> {
    const wf = o.workflow
      ? (await pool.query<{ id: string }>(`insert into workflows (tenant_id, name) values ($1, 'itest') returning id`, [T])).rows[0]!.id
      : null;
    const k = (await pool.query<{ id: string }>(
      `insert into campaigns (tenant_id, phone_number_id, name, category, template_name, template_language, status, workflow_id)
       values ($1, 'pn', $2, 'marketing', $3, 'fr', 'completed', $4) returning id`,
      [T, nom, o.modele ?? 'promo', wf],
    )).rows[0]!.id;
    await pool.query(
      `insert into campaign_recipients (campaign_id, contact_id, to_e164, status, sent_at, delivery_status)
       values ($1, $2, '+33600000001', 'sent', $3, $4)`,
      [k, contact, o.envoye ?? ilYA(24), o.delivery === undefined ? 'delivered' : o.delivery],
    );
    return k;
  }

  async function message(origine: string, statut: string | null, le = ilYA(2)): Promise<void> {
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, origin, statut, created_at)
       values ($1, 'out', 'text', 'x', $2, $3, $4)`,
      [fil, origine, statut, le],
    );
  }

  async function vider(): Promise<void> {
    await pool.query('delete from conversation_messages where conversation_id = $1', [fil]);
    await pool.query('delete from campaigns where tenant_id = $1', [T]);
    await pool.query('delete from workflows where tenant_id = $1', [T]);
    await pool.query('delete from ventes_attribuees where tenant_id = $1', [T]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    store = new PgVentesStore(pool);
    T = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-ventes') returning id`)).rows[0]!.id;
    contact = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164) values ($1, '+33600000001') returning id`, [T],
    )).rows[0]!.id;
    fil = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, contact_id) values ($1, '33600000001', $2) returning id`, [T, contact],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    await pool.query('delete from tenants where id = $1', [T]);
    await pool.end();
  });

  it('une campagne livrée dans la période est une touche campagne, avec son modèle', async () => {
    await vider();
    const k = await campagne('Soldes', { modele: 'soldes_hiver' });
    expect(await store.touches(T, contact, depuis, maintenant, false)).toEqual([
      { source: 'campagne', le: ilYA(24), campaignId: k, modele: 'soldes_hiver', lanceScenario: false },
    ]);
  });

  it('🔴 les lignes Shopify (confirmation, expédition) et [API] ne sont jamais une touche', async () => {
    await vider();
    await campagne('Shopify · commande payée · #1002');
    await campagne('Shopify · commande expédiée · #1002');
    await campagne('[API] essai');
    expect(await store.touches(T, contact, depuis, maintenant, false)).toEqual([]);
  });

  it('la relance de panier est une touche relance_panier, sans campagne', async () => {
    await vider();
    await campagne(LIGNE_RELANCE_PANIER, { modele: 'relance' });
    expect(await store.touches(T, contact, depuis, maintenant, false)).toEqual([
      { source: 'relance_panier', le: ilYA(24), campaignId: null, modele: 'relance', lanceScenario: false },
    ]);
  });

  it('un envoi seulement parti (sent) ne compte pas, sauf en filière application ; un échec jamais', async () => {
    await vider();
    await campagne('Parti', { delivery: 'sent' });
    await campagne('Échoué', { delivery: 'failed' });
    await message('ia', null);
    expect(await store.touches(T, contact, depuis, maintenant, false)).toEqual([]);
    const enApplication = await store.touches(T, contact, depuis, maintenant, true);
    expect(enApplication.map((t) => t.source).sort()).toEqual(['agent', 'campagne']);
  });

  it('une campagne qui lance un scénario compte sans accusé (son identifiant de message est synthétique)', async () => {
    await vider();
    await campagne('Avec scénario', { delivery: null, workflow: true });
    const [t] = await store.touches(T, contact, depuis, maintenant, false);
    expect(t).toMatchObject({ source: 'campagne', lanceScenario: true });
  });

  it('les messages ia et mba sont des touches agent et agent_meta, scenario une touche scenario ; humain, mcp et api non', async () => {
    await vider();
    await message('ia', 'delivered', ilYA(3));
    await message('mba', 'read', ilYA(2));
    await message('scenario', 'delivered', ilYA(1));
    for (const o of ['humain', 'mcp', 'api', 'campagne']) await message(o, 'delivered');
    expect((await store.touches(T, contact, depuis, maintenant, false)).map((t) => t.source)).toEqual(['scenario', 'agent_meta', 'agent']);
  });

  it('hors de la période, rien ; la dernière touche d’un modèle se lit sans limite de date', async () => {
    await vider();
    const k = await campagne('Ancienne', { modele: 'vieux', envoye: ilYA(24 * 30) });
    expect(await store.touches(T, contact, depuis, maintenant, false)).toEqual([]);
    expect(await store.derniereToucheDuModele(T, contact, 'vieux', maintenant, false)).toMatchObject({ source: 'campagne', campaignId: k });
    expect(await store.derniereToucheDuModele(T, contact, 'autre', maintenant, false)).toBeNull();
  });

  it('🔴 enregistrer deux fois la même commande rend deja et laisse une ligne', async () => {
    await vider();
    const vente = {
      commandeId: '820982911946154508', contactId: contact, montant: '49.90', devise: 'EUR', payeeLe: maintenant, test: false,
      source: 'agent' as const, campaignId: null, preuve: null, relanceLe: null,
    };
    expect(await store.enregistrer(T, vente)).toBe('enregistree');
    expect(await store.enregistrer(T, vente)).toBe('deja');
    const n = (await pool.query<{ n: number }>('select count(*)::int as n from ventes_attribuees where tenant_id = $1', [T])).rows[0]!.n;
    expect(n).toBe(1);
  });

  it('anonymiserCommandes vide commande_id et contact_id, garde montant, devise et source', async () => {
    await vider();
    await store.enregistrer(T, {
      commandeId: '111', contactId: contact, montant: '12.5', devise: 'EUR', payeeLe: maintenant, test: false,
      source: 'relance_panier', campaignId: null, preuve: 'panier', relanceLe: ilYA(1),
    });
    expect(await store.anonymiserCommandes(T, ['111'])).toBe(1);
    const r = (await pool.query('select commande_id, contact_id, montant::text, devise, source from ventes_attribuees where tenant_id = $1', [T])).rows[0];
    expect(r).toEqual({ commande_id: null, contact_id: null, montant: '12.500', devise: 'EUR', source: 'relance_panier' });
  });

  it('panierRelance rend la date d’une relance partie, rien pour un panier non relancé ou refusé', async () => {
    await pool.query(
      `insert into shopify_paniers (tenant_id, jeton, telephone, relance_le, issue) values
         ($1, 'tok-envoye', '+33600000001', $2, 'envoye'), ($1, 'tok-refuse', '+33600000001', $2, 'desabonne'),
         ($1, 'tok-attente', '+33600000001', null, null)`,
      [T, ilYA(30)],
    );
    expect(await store.panierRelance(T, 'tok-envoye')).toEqual({ relanceLe: ilYA(30) });
    expect(await store.panierRelance(T, 'tok-refuse')).toBeNull();
    expect(await store.panierRelance(T, 'tok-attente')).toBeNull();
    expect(await store.panierRelance(T, 'inconnu')).toBeNull();
  });
});
