import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgCreditStore, NOTE_CREDIT_OFFERT } from '../../src/agent/credits.pg';
import { PgUserStore } from '../../src/user/store.pg';
import { PgEmbeddedSignupStore, TenantConflictError } from '../../src/account/es-store.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * Le solde prépayé d'un workspace (migration 0087).
 *
 * 🔴 POURQUOI EN INTÉGRATION, ET PAS AVEC UN DOUBLE. Tout ce qui compte ici est du SQL. L'atomicité du
 * mouvement (le worker joue plusieurs tours en parallèle, y compris pour le même workspace : un
 * « lire puis écrire » perdrait une consommation sur deux au premier croisement, et le client paierait moins
 * que ce qu'il a consommé), l'`insert ... on conflict` qui crée la ligne au premier mouvement, le fait que
 * le solde et son journal soient écrits dans la MÊME instruction, et l'isolation entre clients. Un faux
 * store dirait oui à tout.
 *
 * Jamais joué en local (le DATABASE_URL local pointe la PRODUCTION), joué par le job `integration`.
 */
describe.skipIf(!url)('solde prépayé d un workspace (Postgres)', () => {
  let pool: Pool;
  let credits: PgCreditStore;
  let tenantId: string;
  let autreTenantId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 8 });
    credits = new PgCreditStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-credits') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-credits-autre') returning id`)).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    if (autreTenantId) await pool.query('delete from tenants where id = $1', [autreTenantId]);
    await pool.end();
  });

  it('🔴 un workspace sans ligne a un solde de ZÉRO, donc ses agents ne démarrent pas', async () => {
    // Le bon défaut : un crédit implicite ferait payer une consommation que personne n'a autorisée.
    expect(await credits.solde(tenantId)).toBe(0);
  });

  it('la recharge crée la ligne au premier mouvement, et la consommation la descend', async () => {
    expect(await credits.crediter(tenantId, 10_000_000, 'mise en service')).toBe(10_000_000);
    expect(await credits.debiter(tenantId, 4_200)).toBe(9_995_800);
    expect(await credits.solde(tenantId)).toBe(9_995_800);
  });

  it('🔴 le solde et son JOURNAL sont écrits ensemble', async () => {
    // Un solde sans journal est inexplicable la première fois qu'il baisse : c'est ce qui permet de répondre
    // à un client qui demande où est passé son argent.
    const m = await credits.mouvements(tenantId, 10);
    expect(m).toHaveLength(2);
    expect(m[0]).toMatchObject({ deltaMicroEur: -4_200, raison: 'conso' });
    expect(m[1]).toMatchObject({ deltaMicroEur: 10_000_000, raison: 'recharge', note: 'mise en service' });
  });

  it('une consommation SANS session porte une note, sinon elle serait inexplicable', async () => {
    // Le cas de l'essai depuis la console : il consomme pour de vrai (le fournisseur facture), mais n'ouvre
    // aucune session. Sans la note, le journal montrerait une baisse que rien ne rattache à quoi que ce soit.
    await credits.debiter(tenantId, 300, { note: 'essai depuis la console' });
    expect((await credits.mouvements(tenantId, 1))[0]).toMatchObject({
      deltaMicroEur: -300, raison: 'conso', note: 'essai depuis la console',
    });
    expect((await credits.mouvements(tenantId, 1))[0]!.sessionId).toBeUndefined();
  });

  it('🔴 DIX consommations SIMULTANÉES sont toutes comptées', async () => {
    // LE test de ce module. Le worker joue plusieurs tours en parallèle pour le même workspace : un
    // « lire puis écrire » en perdrait, et le client paierait moins que ce qu'il a consommé.
    const avant = await credits.solde(tenantId);
    await Promise.all(Array.from({ length: 10 }, () => credits.debiter(tenantId, 1_000)));
    expect(await credits.solde(tenantId)).toBe(avant - 10_000);
    expect(await credits.mouvements(tenantId, 50)).toHaveLength(13);
  });

  it('🔴 le solde peut devenir NÉGATIF, et c est voulu', async () => {
    // Un tour déjà joué a déjà coûté chez le fournisseur. Refuser de l'enregistrer pour garder un zéro
    // propre reviendrait à offrir la dernière conversation. La garde est à l'ENTRÉE du tour.
    const neuf = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-credits-neg') returning id`)).rows[0]!.id;
    try {
      await credits.crediter(neuf, 1_000, 'mise en service');
      expect(await credits.debiter(neuf, 5_000)).toBe(-4_000);
    } finally {
      await pool.query('delete from tenants where id = $1', [neuf]);
    }
  });

  it('un montant nul ou négatif n écrit RIEN, et surtout ne devient pas un rechargement déguisé', async () => {
    const avant = await credits.solde(tenantId);
    const lignes = (await credits.mouvements(tenantId, 100)).length;
    expect(await credits.debiter(tenantId, 0)).toBe(avant);
    expect(await credits.debiter(tenantId, -5_000)).toBe(avant);
    expect(await credits.crediter(tenantId, 0, 'rien du tout')).toBe(avant);
    expect(await credits.mouvements(tenantId, 100)).toHaveLength(lignes);
  });

  it('🔴 les soldes de deux clients sont ÉTANCHES', async () => {
    const mien = await credits.solde(tenantId);
    await credits.crediter(autreTenantId, 7_000_000, 'mise en service');
    expect(await credits.solde(tenantId)).toBe(mien);
    expect(await credits.solde(autreTenantId)).toBe(7_000_000);
    // Et le journal aussi : le mouvement de l'un n'apparaît pas chez l'autre.
    expect(await credits.mouvements(autreTenantId, 10)).toHaveLength(1);
  });

  it('la suppression d un workspace emporte son solde et son journal', async () => {
    // `on delete cascade` : un solde orphelin serait de l'argent qui appartient à personne.
    const jetable = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-credits-jetable') returning id`)).rows[0]!.id;
    await credits.crediter(jetable, 1_000, 'mise en service');
    await pool.query('delete from tenants where id = $1', [jetable]);
    const reste = await pool.query('select 1 from agent_credits where tenant_id = $1', [jetable]);
    expect(reste.rowCount).toBe(0);
  });

  /**
   * LES TRADUCTIONS D'UN JOUR, EN UNE LIGNE (migration 0190, 2026-09-28). Le solde bouge à chaque traduction, le
   * journal garde une ligne par espace et par jour de Paris. 🔴 Tout ce qui compte est du SQL : l'upsert sur l'index
   * unique PARTIEL (un prédicat qui ne correspond plus rend 42P10 à chaque débit), et la sérialisation de deux débits
   * simultanés sur la même ligne.
   */
  describe('le débit des traductions', () => {
    let trad: string;
    beforeAll(async () => {
      trad = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-credits-trad') returning id`)).rows[0]!.id;
      await credits.crediter(trad, 1_000_000, 'mise en service');
    });
    afterAll(async () => { if (trad) await pool.query('delete from tenants where id = $1', [trad]); });

    it('🔴 deux traductions du même jour font UNE ligne, et le solde descend des deux', async () => {
      expect(await credits.debiterTraduction(trad, 1_200)).toBe(998_800);
      expect(await credits.debiterTraduction(trad, 300)).toBe(998_500);
      const lignes = (await credits.mouvements(trad, 50)).filter((m) => m.raison === 'traduction');
      expect(lignes).toHaveLength(1);
      expect(lignes[0]!.deltaMicroEur).toBe(-1_500);
      expect(lignes[0]!.sessionId).toBeUndefined();
      expect(lignes[0]!.note).toMatch(/^traductions du \d{2}\/\d{2}$/);
    });

    it('🔴 dix traductions SIMULTANÉES sont toutes débitées, sur la même ligne', async () => {
      const avant = await credits.solde(trad);
      const ligneAvant = (await credits.mouvements(trad, 50)).find((m) => m.raison === 'traduction')!.deltaMicroEur;
      await Promise.all(Array.from({ length: 10 }, () => credits.debiterTraduction(trad, 100)));
      expect(await credits.solde(trad)).toBe(avant - 1_000);
      const lignes = (await credits.mouvements(trad, 50)).filter((m) => m.raison === 'traduction');
      expect(lignes).toHaveLength(1);
      expect(lignes[0]!.deltaMicroEur).toBe(ligneAvant - 1_000);
    });

    it('la ligne porte le jour de PARIS, pas celui du serveur', async () => {
      const r = await pool.query<{ ok: boolean }>(
        `select jour = (now() at time zone 'Europe/Paris')::date as ok
           from agent_credit_mouvements where tenant_id = $1 and raison = 'traduction'`,
        [trad],
      );
      expect(r.rows.map((x) => x.ok)).toEqual([true]);
    });

    it('🔴 la ligne du jour est PAR ESPACE : un autre espace a la sienne', async () => {
      await credits.debiterTraduction(autreTenantId, 50);
      const miennes = (await credits.mouvements(trad, 50)).filter((m) => m.raison === 'traduction');
      const siennes = (await credits.mouvements(autreTenantId, 50)).filter((m) => m.raison === 'traduction');
      expect(miennes).toHaveLength(1);
      expect(siennes).toHaveLength(1);
      expect(siennes[0]!.deltaMicroEur).toBe(-50);
    });

    it('un montant nul n écrit rien', async () => {
      const avant = await credits.solde(trad);
      const ligne = (await credits.mouvements(trad, 50)).find((m) => m.raison === 'traduction')!.deltaMicroEur;
      expect(await credits.debiterTraduction(trad, 0)).toBe(avant);
      expect((await credits.mouvements(trad, 50)).find((m) => m.raison === 'traduction')!.deltaMicroEur).toBe(ligne);
    });

    it('les autres mouvements gardent UNE ligne chacun, sans jour', async () => {
      // L'agrégat ne vaut que pour la traduction : une consommation d'agent agrégée perdrait sa session.
      await credits.debiter(trad, 10);
      await credits.debiter(trad, 10);
      const r = await pool.query<{ n: string; jours: string }>(
        `select count(*)::text as n, count(jour)::text as jours
           from agent_credit_mouvements where tenant_id = $1 and raison = 'conso'`,
        [trad],
      );
      expect(r.rows[0]).toEqual({ n: '2', jours: '0' });
    });

    it('🔴 mouvements() rend la raison TELLE QU ÉCRITE, y compris une raison inconnue', async () => {
      // Elle ramenait tout ce qui n'était pas `recharge` à `conso` : un crédit offert se lisait comme une
      // consommation. Une valeur écrite par une version plus récente passe telle quelle.
      await pool.query(
        `insert into agent_credit_mouvements (tenant_id, delta_micro_eur, raison, note) values ($1, 1, 'achat', 'itest')`,
        [trad],
      );
      const raisons = new Set((await credits.mouvements(trad, 50)).map((m) => m.raison));
      expect([...raisons].sort()).toEqual(['achat', 'conso', 'recharge', 'traduction']);
    });
  });

  /**
   * LES 5 € OFFERTS À LA CONNEXION DU PREMIER NUMÉRO (migration 0191, décision de Julien du 2026-09-29). Les deux
   * bornes sont des CONTRAINTES (clé primaire sur l'espace, unique sur le numéro) : seule une vraie base les tient.
   */
  describe('le crédit offert à la connexion du premier numéro', () => {
    const CINQ = { creditOffertMicroEur: 5_000_000 };
    const suffixe = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const espaces: string[] = [];
    const numeros: string[] = [];
    const wabas: string[] = [];
    async function espace(nom: string): Promise<string> {
      const id = (await pool.query<{ id: string }>(`insert into tenants (name) values ($1) returning id`, [nom])).rows[0]!.id;
      espaces.push(id);
      return id;
    }
    async function relier(tenantId: string, o: { waba?: string; numero?: string } = {}): Promise<{ numero: string; offert: number }> {
      const waba = o.waba ?? `waba-offre-${suffixe()}`;
      const numero = o.numero ?? `pn-offre-${suffixe()}`;
      wabas.push(waba);
      numeros.push(numero);
      const r = await new PgEmbeddedSignupStore(pool, CINQ).linkTenant({ tenantId, wabaId: waba, phoneNumberId: numero, displayPhoneNumber: null, verifiedName: null });
      return { numero, offert: r.creditOffertMicroEur };
    }
    afterAll(async () => {
      await pool.query('delete from phone_numbers where id = any($1::text[])', [numeros]);
      await pool.query('delete from waba where id = any($1::text[])', [wabas]);
      // `credits_offerts` n'a pas de clé étrangère vers `tenants`, délibérément : on la nettoie à la main.
      await pool.query('delete from credits_offerts where tenant_id = any($1::uuid[]) or phone_number_id = any($2::text[])', [espaces, numeros]);
      await pool.query('delete from tenants where id = any($1::uuid[])', [espaces]);
    });

    it('🔴 la création d un espace n offre RIEN', async () => {
      const email = `credit.offert.${suffixe()}@exemple.fr`;
      const { tenantId: t } = await new PgUserStore(pool).createTenantWithAdmin('Espace itest crédit', { email, name: null, passwordHash: null });
      espaces.push(t);
      try {
        expect(await credits.solde(t)).toBe(0);
        expect(await credits.mouvements(t, 10)).toHaveLength(0);
      } finally {
        // L'espace d'abord : il emporte l'utilisateur, qui référence encore l'identité (clé étrangère sans
        // cascade). Dans l'autre ordre, le nettoyage lève et fait échouer un test dont l'assertion est passée.
        await pool.query('delete from tenants where id = $1', [t]);
        await pool.query('delete from identities where lower(email) = lower($1)', [email]);
      }
    });

    it('🔴 premier numéro : 5 € et UNE ligne `offert`, sans clé Vercel ouverte', async () => {
      const t = await espace('itest-offre-premier');
      const r = await relier(t);
      expect(r.offert).toBe(5_000_000);
      expect(await credits.solde(t)).toBe(5_000_000);
      const m = await credits.mouvements(t, 10);
      expect(m).toHaveLength(1);
      expect(m[0]).toMatchObject({ deltaMicroEur: 5_000_000, raison: 'offert', note: NOTE_CREDIT_OFFERT });
      const cles = await pool.query('select 1 from agent_gateway_keys where tenant_id = $1', [t]);
      expect(cles.rowCount).toBe(0);
      // Rejouer l'inscription sur le MÊME numéro (geste idempotent) n'offre rien de plus.
      expect((await relier(t, { numero: r.numero })).offert).toBe(0);
      expect(await credits.solde(t)).toBe(5_000_000);
    });

    it('🔴 second numéro du même espace (le premier détaché) : rien', async () => {
      const t = await espace('itest-offre-second');
      const premier = await relier(t);
      expect(premier.offert).toBe(5_000_000);
      await pool.query('delete from phone_numbers where id = $1', [premier.numero]);
      expect((await relier(t)).offert).toBe(0);
      expect(await credits.solde(t)).toBe(5_000_000);
    });

    it('🔴 le même numéro relié à un AUTRE espace : rien, même après son départ du premier', async () => {
      const a = await espace('itest-offre-a');
      const b = await espace('itest-offre-b');
      const r = await relier(a);
      await pool.query('delete from phone_numbers where id = $1', [r.numero]);
      expect((await relier(b, { numero: r.numero })).offert).toBe(0);
      expect(await credits.solde(b)).toBe(0);
      expect(await credits.mouvements(b, 10)).toHaveLength(0);
    });

    it('🔴 une liaison REFUSÉE (numéro d un autre espace) n offre rien', async () => {
      const a = await espace('itest-offre-refus-a');
      const b = await espace('itest-offre-refus-b');
      const r = await relier(a);
      await expect(relier(b, { numero: r.numero })).rejects.toBeInstanceOf(TenantConflictError);
      expect(await credits.solde(b)).toBe(0);
      const offre = await pool.query('select 1 from credits_offerts where tenant_id = $1', [b]);
      expect(offre.rowCount).toBe(0);
    });
  });

  /**
   * L'HISTORIQUE MONTRÉ AU CLIENT (page Crédit IA) : les tours d'agent agrégés par jour de Paris, le reste tel quel,
   * et aucune note (celle d'une recharge porte l'adresse de l'exploitant).
   */
  describe('l historique du client', () => {
    let h: string;
    beforeAll(async () => {
      h = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-credits-historique') returning id`)).rows[0]!.id;
      await credits.crediter(h, 1_000_000, 'julien@exemple.fr : geste');
      await credits.debiter(h, 100);
      await credits.debiter(h, 250);
      await credits.debiterTraduction(h, 40);
    });
    afterAll(async () => { if (h) await pool.query('delete from tenants where id = $1', [h]); });

    it('🔴 les tours d agent du jour font UNE ligne, sans note, et la recharge garde la sienne', async () => {
      const lignes = await credits.historique(h, 50);
      const agents = lignes.filter((l) => l.raison === 'conso');
      expect(agents).toHaveLength(1);
      expect(agents[0]!.deltaMicroEur).toBe(-350);
      expect(agents[0]!.jour).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(lignes.find((l) => l.raison === 'recharge')).toMatchObject({ deltaMicroEur: 1_000_000, jour: null });
      expect(lignes.find((l) => l.raison === 'traduction')!.jour).toBe(agents[0]!.jour);
      // Aucune note ne sort vers le client : la forme de la ligne n'en porte pas.
      expect(lignes.every((l) => !('note' in l))).toBe(true);
    });

    it('🔴 l historique est PAR ESPACE : ni les mouvements ni l agrégat des tours d un autre', async () => {
      const siennes = await credits.historique(autreTenantId, 50);
      expect(siennes.some((l) => l.deltaMicroEur === -350 || l.deltaMicroEur === 1_000_000)).toBe(false);
    });
  });
});
