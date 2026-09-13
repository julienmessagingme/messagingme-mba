import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { creerRecap, type Recap } from '../../src/aide/recap.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * LE RÉCAP DE LA VEILLE, côté base.
 *
 * 🔴 POURQUOI EN INTÉGRATION ET PAS AVEC UN DOUBLE. Tout ce qui décide ici est du SQL, et rien de ce qui
 * compte ne se vérifie autrement : le PIÈGE DES DEUX SOURCES (la date d'analyse n'est pas la date de la
 * conversation), les BORNES de journée dans le fuseau des stats, la différence entre une conversation qui a
 * parlé et une conversation qui s'est ouverte, et l'isolation entre espaces. Un faux dépôt dirait oui à tout.
 *
 * Jamais joué en local (le `DATABASE_URL` local pointe la PRODUCTION), joué par le job `integration`.
 *
 * ⚠️ CHAQUE TEST A SON PROPRE JOUR. Les tests partagent un espace et n'effacent rien entre eux : un jour par
 * test rend chaque assertion absolue (« 1 », pas « un de plus qu'avant »), donc lisible quand elle casse.
 * Tous les jours choisis sont en mars, avant le changement d'heure du 29 mars 2026 : Paris y vaut UTC+1, ce
 * qui rend les instants de ce fichier lisibles à l'oeil.
 */
describe.skipIf(!url)('le récap de la veille (Postgres)', () => {
  let pool: Pool;
  let recap: (tenantId: string, jour: string) => Promise<Recap>;
  let tenantId: string;
  let autreTenantId: string;
  let n = 0;

  /**
   * Une conversation, ses messages et, s'il y a lieu, son analyse.
   *
   * ⚠️ `creeeLe` (l'ouverture) et les dates des MESSAGES sont distincts, et c'est tout l'intérêt : c'est ce
   * qui permet de poser un habitué qui reparle des mois après son ouverture.
   */
  async function conversation(o: {
    tenant?: string;
    creeeLe: string;
    messages?: Array<{ a: string; sens?: 'in' | 'out' }>;
    analyse?: { le: string; topic: string };
    test?: boolean;
  }): Promise<string> {
    const tenant = o.tenant ?? tenantId;
    n += 1;
    const conv = await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, created_at, last_message_at, is_test)
       values ($1, $2, $3, $3, $4) returning id`,
      [tenant, `+3360000${String(n).padStart(4, '0')}`, o.creeeLe, o.test === true],
    );
    const id = conv.rows[0]!.id;
    for (const m of o.messages ?? []) {
      await pool.query(
        `insert into conversation_messages (conversation_id, direction, type, body, created_at)
         values ($1, $2, 'text', 'coucou', $3)`,
        [id, m.sens ?? 'in', m.a],
      );
    }
    if (o.analyse) {
      await pool.query(
        `insert into conversation_analysis
           (conversation_id, tenant_id, sentiment, intent, topic, resolved, handled_by, exchanges_count,
            action_suggestion, confidence, justification, llm_provider, llm_model, created_at)
         values ($1, $2, 'neutre', 'information', $3, true, 'humain', 2, 'aucune', 0.9, 'rien', 'test', 'test', $4)`,
        [id, tenant, o.analyse.topic, o.analyse.le],
      );
    }
    return id;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 8 });
    recap = creerRecap(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-recap') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-recap-autre') returning id`)).rows[0]!.id;
  });

  afterAll(async () => {
    await pool.query('delete from tenants where id = any($1::uuid[])', [[tenantId, autreTenantId]]);
    await pool.end();
  });

  /**
   * 🔴 LE TEST QUI COMPTE, ET SON MIROIR JUSTE EN DESSOUS. `conversation_analysis.created_at` est réécrit à
   * chaque ré-analyse : s'y fier ferait entrer une vieille conversation ré-analysée hier et sortir une
   * conversation d'hier analysée ce matin. Les deux erreurs sont plausibles et invisibles.
   */
  it('🔴 une conversation d AVANT-HIER ré-analysée le jour du récap n y est PAS', async () => {
    await conversation({
      creeeLe: '2026-03-01T10:00:00+01:00',
      messages: [{ a: '2026-03-01T10:00:00+01:00' }],
      analyse: { le: '2026-03-02T09:00:00+01:00', topic: 'remboursement' },
    });
    const r = await recap(tenantId, '2026-03-02');
    expect(r.conversations).toBe(0);
    expect(r.themes).toEqual([]);
  });

  it('🔴 et une conversation DU JOUR analysée le lendemain y est, avec son thème', async () => {
    await conversation({
      creeeLe: '2026-03-03T10:00:00+01:00',
      messages: [{ a: '2026-03-03T10:00:00+01:00' }],
      analyse: { le: '2026-03-04T08:00:00+01:00', topic: 'Retard de livraison' },
    });
    const r = await recap(tenantId, '2026-03-03');
    expect(r.conversations).toBe(1);
    expect(r.themes).toEqual([{ topic: 'retard de livraison', n: 1 }]);
    expect(r.conversationsAnalysees).toBe(1);
  });

  it('une conversation du jour SANS analyse est comptée mais pas thématisée', async () => {
    await conversation({ creeeLe: '2026-03-05T10:00:00+01:00', messages: [{ a: '2026-03-05T10:00:00+01:00' }] });
    const r = await recap(tenantId, '2026-03-05');
    expect(r.conversations).toBe(1);
    expect(r.conversationsAnalysees).toBe(0);
    expect(r.themes).toEqual([]);
  });

  /**
   * 🔴 « UNE CONVERSATION DU JOUR » = UNE CONVERSATION QUI A PARLÉ, PAS UNE LIGNE CRÉÉE. Une conversation est
   * unique par `(tenant_id, wa_id)` pour toujours : compter les créations ferait dire « 1 conversation,
   * 4 messages » à un espace où trois habitués ont écrit, ce qui est visiblement incohérent.
   */
  it('🔴 un habitué qui reparle compte dans les conversations, pas dans les nouvelles', async () => {
    await conversation({ creeeLe: '2026-01-15T10:00:00+01:00', messages: [{ a: '2026-03-06T10:00:00+01:00' }] });
    await conversation({ creeeLe: '2026-03-06T11:00:00+01:00', messages: [{ a: '2026-03-06T11:00:00+01:00' }] });
    const r = await recap(tenantId, '2026-03-06');
    expect(r.conversations).toBe(2);
    expect(r.conversationsNouvelles).toBe(1);
  });

  it('les messages sont comptés par SENS, et une conversation muette ce jour-là ne compte pas', async () => {
    await conversation({
      creeeLe: '2026-03-07T09:00:00+01:00',
      messages: [
        { a: '2026-03-07T09:00:00+01:00', sens: 'in' },
        { a: '2026-03-07T09:05:00+01:00', sens: 'out' },
        { a: '2026-03-07T09:06:00+01:00', sens: 'out' },
      ],
    });
    // Ouverte ce jour-là mais sans le moindre message : elle n'a rien dit, elle ne compte pas.
    await conversation({ creeeLe: '2026-03-07T23:00:00+01:00' });
    const r = await recap(tenantId, '2026-03-07');
    expect(r.messagesEntrants).toBe(1);
    expect(r.messagesSortants).toBe(2);
    expect(r.conversations).toBe(1);
  });

  /**
   * ⚠️ LES BORNES SONT CELLES DE `BOUNDS_CTE`, donc de la journée civile EN HEURE LOCALE. Filtrer en UTC
   * décalerait la journée d'une heure en hiver et de deux en été : le récap perdrait la dernière heure de
   * la soirée et gagnerait celle du lendemain, sans que rien ne le signale.
   */
  it('⚠️ 23h59 est dans la journée, 00h00 le lendemain n y est pas', async () => {
    await conversation({ creeeLe: '2026-03-08T23:59:00+01:00', messages: [{ a: '2026-03-08T23:59:00+01:00' }] });
    await conversation({ creeeLe: '2026-03-09T00:00:00+01:00', messages: [{ a: '2026-03-09T00:00:00+01:00' }] });
    const r = await recap(tenantId, '2026-03-08');
    expect(r.conversations).toBe(1);
    expect(r.messagesEntrants).toBe(1);
  });

  /**
   * ⚠️ LE MÊME JOUR DE LA SEMAINE, pas l'avant-veille. Le 2026-03-17 est un mardi, le 2026-03-10 aussi :
   * comparer un mardi à un lundi ferait annoncer un effondrement toutes les semaines.
   */
  it('la semaine précédente se lit sept jours avant, jour pour jour', async () => {
    await conversation({
      creeeLe: '2026-03-10T10:00:00+01:00',
      messages: [{ a: '2026-03-10T10:00:00+01:00' }, { a: '2026-03-10T10:01:00+01:00' }],
      analyse: { le: '2026-03-11T08:00:00+01:00', topic: 'horaires' },
    });
    await conversation({ creeeLe: '2026-03-17T10:00:00+01:00', messages: [{ a: '2026-03-17T10:00:00+01:00' }] });
    const r = await recap(tenantId, '2026-03-17');
    expect(r.conversations).toBe(1);
    expect(r.semainePrecedente).toEqual({ conversations: 1, messagesEntrants: 2, themes: ['horaires'] });
  });

  it('un jour sans rien rend des zéros, jamais une absence', async () => {
    const r = await recap(tenantId, '2026-03-20');
    expect(r).toMatchObject({
      jour: '2026-03-20',
      conversations: 0,
      conversationsNouvelles: 0,
      conversationsAnalysees: 0,
      messagesEntrants: 0,
      messagesSortants: 0,
      themes: [],
    });
    expect(r.semainePrecedente).toEqual({ conversations: 0, messagesEntrants: 0, themes: [] });
  });

  /**
   * 🔴 `tenant_id = $1` EST LE SEUL CONTRÔLE (le pooler est superuser, la RLS est contournée), et
   * `conversation_messages` n'a pas de `tenant_id` : l'isolation passe forcément par la jointure sur
   * `conversations`. C'est la première fois que le bot d'aide lit les données d'un client.
   */
  it('🔴 un AUTRE espace ne voit rien', async () => {
    await conversation({
      tenant: autreTenantId,
      creeeLe: '2026-03-24T10:00:00+01:00',
      messages: [{ a: '2026-03-24T10:00:00+01:00' }],
      analyse: { le: '2026-03-25T08:00:00+01:00', topic: 'sav' },
    });
    const r = await recap(tenantId, '2026-03-24');
    expect(r.conversations).toBe(0);
    expect(r.themes).toEqual([]);
    // ...et l'autre espace voit bien la sienne : sans ce second sens, un filtre qui ne rend JAMAIS rien
    // passerait le test précédent.
    expect((await recap(autreTenantId, '2026-03-24')).conversations).toBe(1);
  });

  /**
   * 🔴 LES ESSAIS DU CLIENT NE SONT PAS DES CLIENTS. `conversations.is_test` existe depuis la migration 0053
   * pour ça, et TOUTES les requêtes soeurs la filtrent (`src/stats/store.pg.ts`,
   * `src/stats/conversation-stats.pg.ts`). Sur un petit espace, deux essais depuis son propre téléphone
   * suffisent à fausser « hier : X conversations » de façon visible, et à faire commenter au modèle un
   * écart qui n'existe pas.
   */
  it('🔴 une conversation de TEST n entre ni dans les volumes ni dans les sujets', async () => {
    await conversation({
      creeeLe: '2026-03-22T10:00:00+01:00',
      messages: [{ a: '2026-03-22T10:00:00+01:00' }, { a: '2026-03-22T10:01:00+01:00', sens: 'out' }],
      analyse: { le: '2026-03-23T08:00:00+01:00', topic: 'essai interne' },
      test: true,
    });
    // ...et une VRAIE conversation le même jour, pour que le test ne passe pas sur un filtre qui rend
    // toujours zéro.
    await conversation({ creeeLe: '2026-03-22T11:00:00+01:00', messages: [{ a: '2026-03-22T11:00:00+01:00' }] });
    const r = await recap(tenantId, '2026-03-22');
    expect(r.conversations).toBe(1);
    expect(r.conversationsNouvelles).toBe(1);
    expect(r.messagesEntrants).toBe(1);
    expect(r.messagesSortants).toBe(0);
    expect(r.themes).toEqual([]);
    expect(r.conversationsAnalysees).toBe(0);
  });

  it('les thèmes sont regroupés sans tenir compte de la casse, et bornés à cinq', async () => {
    for (const topic of ['Livraison', 'livraison', 'LIVRAISON ', 'facture', 'sav', 'devis', 'rendez-vous', 'horaires']) {
      await conversation({
        creeeLe: '2026-03-26T10:00:00+01:00',
        messages: [{ a: '2026-03-26T10:00:00+01:00' }],
        analyse: { le: '2026-03-27T08:00:00+01:00', topic },
      });
    }
    const r = await recap(tenantId, '2026-03-26');
    expect(r.conversationsAnalysees).toBe(8);
    expect(r.themes).toHaveLength(5);
    expect(r.themes[0]).toEqual({ topic: 'livraison', n: 3 });
  });
});
