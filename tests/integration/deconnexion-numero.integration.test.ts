import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomInt } from 'node:crypto';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgDeconnexionNumeroStore } from '../../src/account/deconnexion-numero.pg';
import { PgEmbeddedSignupStore, SecondNumeroRefuseError } from '../../src/account/es-store.pg';
import { consommateurMba } from '../../src/agent/consommateur';

// Ne PAS lancer ce fichier en local : le DATABASE_URL du .env local pointe sur la base de PRODUCTION (cf.
// CLAUDE.md du dépôt), et ce fichier crée puis supprime des espaces. La CI monte un Postgres jetable pour ça.
const url = process.env.DATABASE_URL ?? '';

/**
 * « DÉCONNECTER LE NUMÉRO » contre un vrai Postgres (`src/account/deconnexion-numero.pg.ts`).
 *
 * 🔴 CE QUE SEULE UNE BASE PEUT PROUVER : que la transaction passe les contraintes (CHECK du répondeur, clés étrangères,
 * cascades), qu'elle n'efface QUE ce qui part (contacts, campagnes RCS et finies, crédit offert restent), que la clause
 * `tenant_id` laisse un espace voisin intact, et surtout que l'espace détaché peut ENSUITE connecter un autre numéro,
 * ce qui est toute la raison du geste.
 */
describe.skipIf(!url)('Déconnecter le numéro (Postgres réel)', () => {
  let pool: Pool;
  let store: PgDeconnexionNumeroStore;
  let tenant: string;
  let voisin: string;
  // Des chiffres seulement : la clé de consommateur de l'agent de Meta l'exige (`atc_consommateur_chk`).
  const chiffres = () => `9${String(randomInt(1e9, 1e10))}`;
  const PN = chiffres();
  const PN_VOISIN = chiffres();
  const PN_NEUF = chiffres();
  const WABA = `itest-deco-waba-${PN}`;
  const WABA_VOISIN = `itest-deco-waba-${PN_VOISIN}`;
  const NUMERO = `336${String(randomInt(1e7, 1e8))}`;
  const NUMERO_VOISIN = `336${String(randomInt(1e7, 1e8))}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    store = new PgDeconnexionNumeroStore(pool);
    const t = async (nom: string) => (await pool.query<{ id: string }>(`insert into tenants (name) values ($1) returning id`, [nom])).rows[0]!.id;
    tenant = await t('itest-deconnexion');
    voisin = await t('itest-deconnexion-voisin');
    // Le même décor pour les deux espaces : le voisin doit sortir intact de tout ce que l'espace subit.
    for (const [espace, pn, waba, numero] of [[tenant, PN, WABA, NUMERO], [voisin, PN_VOISIN, WABA_VOISIN, NUMERO_VOISIN]] as const) {
      await pool.query(`insert into waba (id, tenant_id, name) values ($1, $2, 'itest')`, [waba, espace]);
      await pool.query(
        `insert into phone_numbers (id, tenant_id, waba_id, display_phone_number, status) values ($1, $2, $3, $4, 'CONNECTED')`,
        [pn, espace, waba, `+${numero}`],
      );
      await pool.query(`insert into waba_credentials (waba_id, tenant_id, business_token_enc) values ($1, $2, 'chiffre')`, [waba, espace]);
      await pool.query(
        `insert into tenant_settings (tenant_id, mba_enabled, repondeur_mode) values ($1, true, 'mba')
         on conflict (tenant_id) do update set mba_enabled = true, repondeur_mode = 'mba'`,
        [espace],
      );
      const contact = (await pool.query<{ id: string }>(
        `insert into contacts (tenant_id, phone_e164) values ($1, '+33600000088') returning id`, [espace],
      )).rows[0]!.id;
      for (const waId of ['33600000088', '33600000089', '33600000090']) {
        const conv = (await pool.query<{ id: string }>(
          `insert into conversations (tenant_id, wa_id, contact_id) values ($1, $2, $3) returning id`, [espace, waId, contact],
        )).rows[0]!.id;
        await pool.query(
          `insert into conversation_messages (conversation_id, direction, type, body, created_at) values ($1, 'in', 'text', 'bonjour', now())`,
          [conv],
        );
      }
      await pool.query(
        `insert into webhook_events (source, meta_message_id, payload, phone_number_id) values ('messages', $1, '{}'::jsonb, $2)`,
        [`itest-deco-${pn}`, pn],
      );
      await pool.query(`insert into mba_liste (tenant_id, wa_id, phone_number_id, entree_id) values ($1, '33600000088', $2, 'e1')`, [espace, pn]);
      const outil = (await pool.query<{ id: string }>(
        `insert into agent_tools (tenant_id, origin, name, title, description, ne_pas_utiliser, params, binding, risk, pour_agent_meta)
         values ($1, 'mba', 'pose_vip', 'T', 'D', 'N', '[]'::jsonb, '{"handler":"tag_fixe","tag":"vip"}'::jsonb, 'write', true) returning id`,
        [espace],
      )).rows[0]!.id;
      await pool.query(
        `insert into agent_tool_consommateurs (tenant_id, tool_id, consommateur, tool_name) values ($1, $2, $3, 'pose_vip')`,
        [espace, outil, consommateurMba(pn)],
      );
      await pool.query(`insert into credits_offerts (tenant_id, phone_number_id, montant_micro_eur) values ($1, $2, 1000000)`, [espace, pn]);
    }
  });

  afterAll(async () => {
    for (const id of [tenant, voisin]) if (id) await pool.query('delete from tenants where id = $1', [id]).catch(() => {});
    await pool.query('delete from webhook_events where phone_number_id = any($1::text[])', [[PN, PN_VOISIN]]).catch(() => {});
    await pool.query('delete from credits_offerts where phone_number_id = any($1::text[])', [[PN, PN_VOISIN]]).catch(() => {});
    await pool.end().catch(() => {});
  });

  async function campagne(espace: string, o: { status: string; channel?: string; pn?: string | null; etages?: string[] }): Promise<string> {
    const id = (await pool.query<{ id: string }>(
      `insert into campaigns (tenant_id, phone_number_id, name, category, template_name, template_language, status, param_mapping, channel)
       values ($1, $2, 'itest-deco', 'marketing', 'tpl', 'fr', $3, '[]'::jsonb, $4) returning id`,
      [espace, o.pn === undefined ? (espace === tenant ? PN : PN_VOISIN) : o.pn, o.status, o.channel ?? 'whatsapp'],
    )).rows[0]!.id;
    for (const [i, canal] of (o.etages ?? []).entries()) {
      await pool.query(`insert into campaign_etages (campaign_id, rang, canal) values ($1, $2, $3)`, [id, i + 1, canal]);
    }
    return id;
  }
  const statut = async (id: string) => (await pool.query<{ status: string }>('select status from campaigns where id = $1', [id])).rows[0]!.status;
  // `count(*)` sans alias : la colonne s'appelle `count`.
  const compte = async (sql: string, p: unknown[]) => Number((await pool.query<{ count: string }>(sql, p)).rows[0]!.count);

  it('🔴 le geste complet : bilan, purge, détachement ; ce qui part, ce qui reste, et le voisin intact', async () => {
    const enCours = await campagne(tenant, { status: 'running' });
    const programmee = await campagne(tenant, { status: 'scheduled' });
    const enPause = await campagne(tenant, { status: 'paused' });
    const rcsAvecRepli = await campagne(tenant, { status: 'running', channel: 'rcs', pn: null, etages: ['rcs', 'whatsapp'] });
    const rcsSeule = await campagne(tenant, { status: 'running', channel: 'rcs', pn: null });
    const finie = await campagne(tenant, { status: 'completed' });
    const brouillon = await campagne(tenant, { status: 'draft' });
    const chezLeVoisin = await campagne(voisin, { status: 'running' });

    // Le bilan, lu sans rien écrire.
    const b = await store.bilan(tenant);
    // Trois campagnes WhatsApp vivantes ; la campagne RCS à repli WhatsApp n'en est pas.
    expect(b).toEqual({
      phoneNumberId: PN, affiche: `+${NUMERO}`, wabaId: WABA, partage: false, numeroFourni: null,
      conversations: 3, campagnesArretees: 3, mbaAllume: true, contactsSurLaListe: 1,
    });

    // La purge par lots (2 par passage pour en faire plusieurs).
    expect(await store.purgerConversations(tenant, 2)).toBe(3);
    expect(await compte('select count(*) from conversations where tenant_id = $1', [tenant])).toBe(0);

    // Une conversation arrive pendant le geste : la transaction l'emporte.
    await pool.query(`insert into conversations (tenant_id, wa_id) values ($1, '33600000091')`, [tenant]);
    await pool.query(`update tenant_settings set campaigns_paused = true where tenant_id = $1`, [tenant]);
    expect(await store.detacher(tenant)).toEqual({ conversations: 1, campagnesArretees: 3 });

    // Ce qui part.
    for (const id of [enCours, programmee, enPause]) expect(await statut(id)).toBe('failed');
    expect(await compte('select count(*) from phone_numbers where tenant_id = $1', [tenant])).toBe(0);
    expect(await compte('select count(*) from waba where tenant_id = $1', [tenant])).toBe(0);
    expect(await compte('select count(*) from waba_credentials where tenant_id = $1', [tenant])).toBe(0);
    expect(await compte('select count(*) from conversations where tenant_id = $1', [tenant])).toBe(0);
    expect(await compte('select count(*) from webhook_events where phone_number_id = $1', [PN])).toBe(0);
    expect(await compte('select count(*) from mba_liste where tenant_id = $1', [tenant])).toBe(0);
    expect(await compte('select count(*) from agent_tool_consommateurs where tenant_id = $1', [tenant])).toBe(0);
    const reglages = (await pool.query<{ mba_enabled: boolean; repondeur_mode: string; campaigns_paused: boolean }>(
      'select mba_enabled, repondeur_mode, campaigns_paused from tenant_settings where tenant_id = $1', [tenant],
    )).rows[0]!;
    // La pause HubSpot vivait sur la ligne du numéro : faute de numéro, elle retombe.
    expect(reglages).toEqual({ mba_enabled: false, repondeur_mode: 'equipe', campaigns_paused: false });

    // Ce qui reste : une campagne RCS continue, repli WhatsApp compris (une campagne `failed` pourrait être remise
    // `running` par une relance ; son étage WhatsApp devient simplement inservable).
    expect(await statut(rcsAvecRepli)).toBe('running');
    expect(await statut(rcsSeule)).toBe('running');
    expect(await statut(finie)).toBe('completed');
    expect(await statut(brouillon)).toBe('draft');
    expect(await compte('select count(*) from contacts where tenant_id = $1', [tenant])).toBe(1);
    expect(await compte('select count(*) from agent_tools where tenant_id = $1', [tenant])).toBe(1);
    // Le crédit de bienvenue reste « une fois par numéro ».
    expect(await compte('select count(*) from credits_offerts where phone_number_id = $1', [PN])).toBe(1);

    // 🔴 Le voisin, intact.
    expect(await statut(chezLeVoisin)).toBe('running');
    expect(await compte('select count(*) from phone_numbers where tenant_id = $1', [voisin])).toBe(1);
    expect(await compte('select count(*) from waba_credentials where tenant_id = $1', [voisin])).toBe(1);
    expect(await compte('select count(*) from conversations where tenant_id = $1', [voisin])).toBe(3);
    expect(await compte('select count(*) from conversation_messages m join conversations c on c.id = m.conversation_id where c.tenant_id = $1', [voisin])).toBe(3);
    expect(await compte('select count(*) from webhook_events where phone_number_id = $1', [PN_VOISIN])).toBe(1);
    expect(await compte('select count(*) from mba_liste where tenant_id = $1', [voisin])).toBe(1);
    expect(await compte('select count(*) from agent_tool_consommateurs where tenant_id = $1', [voisin])).toBe(1);
    expect((await pool.query('select mba_enabled from tenant_settings where tenant_id = $1', [voisin])).rows[0]).toEqual({ mba_enabled: true });

    // Rejouer ne fait rien : plus de numéro.
    expect(await store.detacher(tenant)).toBeNull();
    expect(await store.bilan(tenant)).toBeNull();
  });

  it('🔴 l’espace détaché connecte ensuite un AUTRE numéro, ce qu’il ne pouvait pas avant', async () => {
    const inscriptions = new PgEmbeddedSignupStore(pool, { creditOffertMicroEur: 0 });
    // Avant : l'espace voisin a son numéro, un second est refusé.
    await expect(inscriptions.linkTenant({ tenantId: voisin, wabaId: WABA_VOISIN, phoneNumberId: PN_NEUF, displayPhoneNumber: null, verifiedName: null }))
      .rejects.toBeInstanceOf(SecondNumeroRefuseError);
    // Après la déconnexion (premier cas), l'espace prend un numéro neuf sur un compte neuf.
    await inscriptions.linkTenant({ tenantId: tenant, wabaId: `itest-deco-waba-${PN_NEUF}`, phoneNumberId: PN_NEUF, displayPhoneNumber: '+33500000000', verifiedName: null });
    expect((await store.bilan(tenant))?.phoneNumberId).toBe(PN_NEUF);
  });

  it('un objet nommé par un autre espace se voit dans le bilan (rien ne se fera chez Meta)', async () => {
    // Une campagne du voisin qui nomme le numéro neuf de l'espace : partagé.
    const id = await campagne(voisin, { status: 'draft', pn: PN_NEUF });
    expect((await store.bilan(tenant))?.partage).toBe(true);
    await pool.query('delete from campaigns where id = $1', [id]);
    expect((await store.bilan(tenant))?.partage).toBe(false);
  });

  it('🔴 un compte WhatsApp qui porte encore le numéro d’un AUTRE espace survit au détachement, et ce numéro aussi', async () => {
    const wabaNeuf = `itest-deco-waba-${PN_NEUF}`;
    const PN_PARTAGE = chiffres();
    // Inatteignable par l'inscription aujourd'hui (elle refuse le compte d'un autre espace), posé ici à la main.
    await pool.query(
      `insert into phone_numbers (id, tenant_id, waba_id, display_phone_number, status) values ($1, $2, $3, '+33599999999', 'CONNECTED')`,
      [PN_PARTAGE, voisin, wabaNeuf],
    );
    expect((await store.bilan(tenant))?.partage).toBe(true);
    expect(await store.detacher(tenant)).not.toBeNull();
    expect(await compte('select count(*) from phone_numbers where id = $1 and tenant_id = $2', [PN_PARTAGE, voisin])).toBe(1);
    expect(await compte('select count(*) from waba where id = $1', [wabaNeuf])).toBe(1);
    expect(await compte('select count(*) from phone_numbers where tenant_id = $1', [tenant])).toBe(0);
    // L'espace repart sans numéro, et reprend un numéro neuf pour la suite.
    await pool.query('delete from phone_numbers where id = $1', [PN_PARTAGE]);
    const inscriptions = new PgEmbeddedSignupStore(pool, { creditOffertMicroEur: 0 });
    await inscriptions.linkTenant({ tenantId: tenant, wabaId: wabaNeuf, phoneNumberId: PN_NEUF, displayPhoneNumber: '+33500000000', verifiedName: null });
  });

  it('le numéro fourni n’est annoncé perdu que s’il EST le numéro connecté, chiffres égaux', async () => {
    const didww = `itest-deco-${PN_NEUF}`;
    // Ses chiffres sont ceux du numéro connecté (« +33500000000 ») : il est perdu, et vu de Meta.
    await pool.query(
      `insert into numeros_fournis (numero, didww_did_id, statut, tenant_id, attribue_le) values ('33500000000', $1, 'attribue', $2, now())`,
      [didww, tenant],
    );
    expect((await store.bilan(tenant))?.numeroFourni).toEqual({ numero: '33500000000', vuDeMeta: true });
    // D'autres chiffres : l'espace a connecté son propre numéro, il garde le numéro fourni qu'il paie.
    await pool.query(`update phone_numbers set display_phone_number = '+33511111111' where id = $1`, [PN_NEUF]);
    expect((await store.bilan(tenant))?.numeroFourni).toBeNull();
    // 🔴 Des chiffres INCONNUS non plus : on ne résilie pas chez DIDWW sur un doute.
    await pool.query(`update phone_numbers set display_phone_number = null where id = $1`, [PN_NEUF]);
    expect((await store.bilan(tenant))?.numeroFourni).toBeNull();
    await pool.query('delete from numeros_fournis where didww_did_id = $1', [didww]);
  });
});
