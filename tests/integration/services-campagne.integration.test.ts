import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgStatsStore } from '../../src/stats/store.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * LES MESSAGES DE SERVICE IMPUTES AUX CAMPAGNES.
 *
 * 🔴 POURQUOI EN INTEGRATION, ET CE QU'AUCUN TEST UNITAIRE NE POUVAIT FAIRE. La partie PURE de ce calcul
 * (ajouter un cout de service au cout des templates) a neuf cas dans `tests/cout-campagne-service.test.ts`,
 * et ils passeraient TOUS a l'identique avec la requete fautive : ils fournissent la `Map` a la main. Or
 * tout le risque est dans le SQL, et il porte deux regles qui ne se voient nulle part ailleurs : un message
 * n'est impute qu'a UNE campagne (deux fenetres de sept jours se chevauchent des que deux campagnes partent
 * a moins d'une semaine d'ecart), et il doit tomber DANS la periode affichee (le prix unitaire qu'on lui
 * applique en vient). Les deux ont ete trouvees en revue, la seconde apres coup.
 *
 * Jamais joue en local (le DATABASE_URL local pointe la PRODUCTION), joue par le job `integration`.
 */
describe.skipIf(!url)('imputation des messages de service (Postgres)', () => {
  let pool: Pool;
  let store: PgStatsStore;
  let tenantId = '';
  let contactId = '';
  let conversationId = '';
  let campagneMars1 = '';
  let campagneMars4 = '';
  let campagneFevrier = '';

  const WA = '33600009900';

  const campagne = async (nom: string, sentAt: string): Promise<string> => {
    const id = (await pool.query<{ id: string }>(
      `insert into campaigns (tenant_id, name, category, template_name, template_language)
       values ($1, $2, 'marketing', 'promo', 'fr') returning id`,
      [tenantId, nom],
    )).rows[0]!.id;
    await pool.query(
      `insert into campaign_recipients (campaign_id, contact_id, to_e164, status, sent_at)
       values ($1, $2, $3, 'sent', $4::timestamptz)`,
      [id, contactId, `+${WA}`, sentAt],
    );
    return id;
  };

  /** Un SORTANT hors template sur WhatsApp : c'est la definition exacte d'un message de service. */
  const service = async (at: string, type = 'text'): Promise<void> => {
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, channel, type, body, created_at)
       values ($1, 'out', 'whatsapp', $2, 'ok', $3::timestamptz)`,
      [conversationId, type, at],
    );
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    store = new PgStatsStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-services-camp') returning id`)).rows[0]!.id;
    contactId = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164) values ($1, $2) returning id`, [tenantId, `+${WA}`],
    )).rows[0]!.id;
    conversationId = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, contact_id, last_message_at) values ($1, $2, $3, now()) returning id`,
      [tenantId, WA, contactId],
    )).rows[0]!.id;

    // Deux campagnes a TROIS jours d'ecart : leurs fenetres de sept jours se chevauchent du 4 au 8.
    campagneMars1 = await campagne('mars-1', '2026-03-01T10:00:00+01');
    campagneMars4 = await campagne('mars-4', '2026-03-04T10:00:00+01');
    // Une campagne de fevrier, dont un message de service tombe AVANT la periode affichee.
    campagneFevrier = await campagne('fevrier', '2026-02-26T10:00:00+01');

    await service('2026-03-02T09:00:00+01');            // dans la fenetre de mars-1 seulement
    await service('2026-03-05T09:00:00+01');            // dans les DEUX fenetres
    await service('2026-03-06T09:00:00+01');            // dans les DEUX fenetres
    await service('2026-03-20T09:00:00+01');            // hors de toute fenetre de sept jours
    await service('2026-02-27T09:00:00+01');            // dans la fenetre de fevrier, HORS periode
    await service('2026-03-05T10:00:00+01', 'template'); // un template n'est PAS un message de service
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]).catch(() => {});
    await pool.end().catch(() => {});
  });

  const mars = { from: '2026-03-01', to: '2026-03-10' };
  const toutes = () => [campagneMars1, campagneMars4, campagneFevrier];

  /**
   * 🔴 LA REGLE QUI EMPECHE DE FACTURER DEUX FOIS. Deux campagnes vers le meme contact a trois jours
   * d'ecart ont des fenetres qui se chevauchent : sans « la derniere recue avant lui », les messages du 5 et
   * du 6 compteraient pour les DEUX, et le total des campagnes depasserait le cout reel des messages.
   *
   * ⚠️ `engagementsParCampagne` peut legitimement crediter deux campagnes du meme engage : compter des
   * PERSONNES et compter des EUROS n'obeit pas a la meme regle.
   */
  it('🔴 un message est impute a UNE seule campagne, la derniere recue avant lui', async () => {
    const m = await store.servicesParCampagne(tenantId, toutes(), mars);
    expect(m.get(campagneMars1), 'le seul message du 2 mars').toBe(1);
    expect(m.get(campagneMars4), 'ceux du 5 et du 6, pas ceux de mars-1').toBe(2);
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    expect(total, 'trois messages imputes, jamais cinq').toBe(3);
  });

  /**
   * 🔴 LA BORNE DE PERIODE, ET SON ABSENCE RENDAIT LE CHIFFRE FAUX. Le prix unitaire applique a ces messages
   * vient d'une lecture BORNEE par la periode affichee, et le cout template de la meme campagne l'est aussi.
   * Sans borne ici, une campagne se voyait imputer tous ses messages de service depuis toujours au prix
   * effectif d'une seule periode : la somme des campagnes depassait le total de la ligne « Messages » de la
   * meme carte. Ni « ce qu'elle a coute sur la periode », ni « ce qu'elle a coute en tout » : plausible et faux.
   */
  it('🔴 un message ANTERIEUR a la periode n est impute a personne', async () => {
    const m = await store.servicesParCampagne(tenantId, toutes(), mars);
    expect(m.get(campagneFevrier) ?? 0, 'son message du 27 fevrier est hors periode').toBe(0);
  });

  it('la periode elargie le reprend, et lui seul', async () => {
    // La preuve que c'est bien la BORNE qui l'excluait, et pas la fenetre de sept jours ni le filtre.
    const m = await store.servicesParCampagne(tenantId, toutes(), { from: '2026-02-01', to: '2026-03-10' });
    expect(m.get(campagneFevrier)).toBe(1);
    expect(m.get(campagneMars1)).toBe(1);
    expect(m.get(campagneMars4)).toBe(2);
  });

  it('un TEMPLATE n est pas un message de service, et un message hors fenetre non plus', async () => {
    // Le template du 5 mars et le sortant du 20 mars sont tous deux dans la periode ; aucun ne doit compter.
    const m = await store.servicesParCampagne(tenantId, toutes(), mars);
    expect([...m.values()].reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('un ENTRANT n est jamais un message de service', async () => {
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, channel, type, body, created_at)
       values ($1, 'in', 'whatsapp', 'text', 'merci', '2026-03-05T11:00:00+01')`,
      [conversationId],
    );
    const m = await store.servicesParCampagne(tenantId, toutes(), mars);
    expect([...m.values()].reduce((a, b) => a + b, 0), 'toujours trois').toBe(3);
  });

  it('aucune campagne demandee -> aucune requete, une map vide', async () => {
    expect((await store.servicesParCampagne(tenantId, [], mars)).size).toBe(0);
  });

  /**
   * 🔴 L'ISOLATION : la RLS est contournee (connexion superuser), donc le filtre `tenant_id` en code est le
   * SEUL controle. Un identifiant de campagne d'un autre espace ne doit rien rendre.
   */
  it('🔴 une campagne d un AUTRE espace ne rend rien', async () => {
    const autre = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-services-autre') returning id`)).rows[0]!.id;
    try {
      const m = await store.servicesParCampagne(autre, toutes(), mars);
      expect(m.size, 'les campagnes ne sont pas a cet espace').toBe(0);
    } finally {
      await pool.query('delete from tenants where id = $1', [autre]);
    }
  });
});
