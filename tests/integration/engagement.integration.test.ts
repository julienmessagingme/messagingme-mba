import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgContactHistoryStore } from '../../src/crm/contact-history.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * « ENGAGÉ » dans l'historique d'un contact, contre une vraie base.
 *
 * Julien, le 2026-09-02 : « dans les fiches du mini CRM, dans la partie historique je veux voir en plus de
 * l'indicateur Lu dans la campagne, Engagé, ce qui montre que la personne a au moins réagi ou a appuyé
 * quelque part dans le Template envoyé ».
 *
 * 🔴 POURQUOI EN INTÉGRATION. Tout se joue dans une fenêtre SQL (`lead(sent_at) over (...)`) croisée avec un
 * `exists` sur les messages entrants. Un faux magasin rendrait ce qu'on lui fait rendre et ne dirait rien des
 * seuls cas qui comptent : deux campagnes le même jour, et une réponse tardive. Ce sont eux qui décident si
 * l'indicateur informe ou s'il ment.
 *
 * Jamais joué en local (le `DATABASE_URL` local pointe la PRODUCTION), joué par le job `integration`.
 */
describe.skipIf(!url)('historique d’un contact : l’indicateur « engagé » (Postgres)', () => {
  let pool: Pool;
  let store: PgContactHistoryStore;
  let tenantId = '';
  let contactId = '';
  let conversationId = '';
  const WA = '33600007701';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 3 });
    store = new PgContactHistoryStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-engage') returning id`)).rows[0]!.id;
    contactId = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164) values ($1, $2) returning id`,
      [tenantId, `+${WA}`],
    )).rows[0]!.id;
    conversationId = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, contact_id, last_message_at) values ($1, $2, $3, now()) returning id`,
      [tenantId, WA, contactId],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]).catch(() => {});
    await pool.end().catch(() => {});
  });

  /** Une campagne envoyée à ce contact à l'instant donné. Rend son identifiant. */
  async function envoi(nom: string, sentAt: string): Promise<string> {
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
  }

  /** Un message dans le fil. `direction` décide de qui parle. */
  async function message(direction: 'in' | 'out', at: string, body = 'ok', payload: string | null = null): Promise<void> {
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, button_payload, created_at)
       values ($1, $2, 'text', $3, $4, $5::timestamptz)`,
      [conversationId, direction, body, payload, at],
    );
  }

  /**
   * Un lien tracé de la FAMILLE RCS (migration 0107) : ni nom de template, ni index de bouton, la maille
   * étant l'adresse. L'insertion elle-même vaut vérification de la contrainte de famille.
   */
  async function lien(code: string, destination: string): Promise<void> {
    await pool.query(
      `insert into tracked_links (code, tenant_id, destination, avec_jeton, confirmed_at)
       values ($1, $2, $3, true, now())`,
      [code, tenantId, destination],
    );
  }

  /** Un clic. `attribue` faux = clic ANONYME (URL sans jeton), le cas des templates approuvés avant 0106. */
  async function clic(code: string, at: string, attribue = true): Promise<void> {
    await pool.query(
      `insert into tracked_link_clicks (code, tenant_id, contact_id, at) values ($1, $2, $3, $4::timestamptz)`,
      [code, tenantId, attribue ? contactId : null, at],
    );
  }

  /** L'historique, indexé par nom de campagne : les tests parlent de campagnes, pas de rangs. */
  async function engagements(): Promise<Record<string, boolean>> {
    const h = await store.getContactHistory(tenantId, contactId);
    return Object.fromEntries((h?.sends ?? []).map((s) => [s.campaignName, s.engage]));
  }

  /** Table rase entre deux cas : chacun décrit sa propre chronologie. */
  async function reset(): Promise<void> {
    await pool.query('delete from campaigns where tenant_id = $1', [tenantId]);
    await pool.query('delete from conversation_messages where conversation_id = $1', [conversationId]);
    // Les liens d'abord effacés par cascade sur les clics : `tracked_link_clicks.code` référence
    // `tracked_links(code)`, un delete sur les liens emporte donc les clics du cas précédent.
    await pool.query('delete from tracked_links where tenant_id = $1', [tenantId]);
  }

  it('une RÉPONSE dans les 24 h après l’envoi vaut engagement', async () => {
    await reset();
    await envoi('A', '2026-09-01T10:00:00Z');
    await message('in', '2026-09-01T10:05:00Z', 'oui je suis intéressé');
    expect(await engagements()).toEqual({ A: true });
  });

  it('un APPUI DE BOUTON vaut engagement, comme une réponse écrite', async () => {
    // Un appui arrive comme un message entrant portant son payload. Exiger le payload exclurait « oui » écrit
    // à la main, qui est pourtant la même réaction.
    await reset();
    await envoi('A', '2026-09-01T10:00:00Z');
    await message('in', '2026-09-01T10:05:00Z', 'Oui', 'BTN_OUI');
    expect(await engagements()).toEqual({ A: true });
  });

  it('🔴 une réponse arrivée APRÈS le prochain envoi ne crédite PAS le premier', async () => {
    // Le cas qui fait mentir un indicateur naïf : deux campagnes le même jour se créditeraient l'une l'autre,
    // et la première afficherait un engagement qu'elle n'a pas produit.
    await reset();
    await envoi('A', '2026-09-01T10:00:00Z');
    await envoi('B', '2026-09-01T14:00:00Z');
    await message('in', '2026-09-01T15:00:00Z', 'je réponds au second');
    expect(await engagements()).toEqual({ A: false, B: true });
  });

  it('🔴 une réponse TROIS JOURS plus tard n’est pas une réaction à cet envoi', async () => {
    // Vingt-quatre heures, parce que c'est aussi la fenêtre de service : au-delà, la personne ne pouvait même
    // plus répondre librement, et ce qu'elle écrit relève d'autre chose.
    await reset();
    await envoi('A', '2026-09-01T10:00:00Z');
    await message('in', '2026-09-04T10:00:00Z', 'trop tard');
    expect(await engagements()).toEqual({ A: false });
  });

  it('un message ANTÉRIEUR à l’envoi ne compte pas', async () => {
    await reset();
    await envoi('A', '2026-09-01T10:00:00Z');
    await message('in', '2026-09-01T09:00:00Z', 'avant');
    expect(await engagements()).toEqual({ A: false });
  });

  it('🔴 un message SORTANT ne compte pas : c’est la personne qui doit réagir', async () => {
    // Sans le filtre de direction, notre propre relance suffirait à déclarer le contact engagé, et l'écran
    // dirait que les gens réagissent alors que c'est nous qui parlons.
    await reset();
    await envoi('A', '2026-09-01T10:00:00Z');
    await message('out', '2026-09-01T10:05:00Z', 'notre relance');
    expect(await engagements()).toEqual({ A: false });
  });

  it('un envoi JAMAIS PARTI n’est jamais engagé, même si le contact a écrit', async () => {
    // `sent_at` nul veut dire qu'il n'y a rien eu à quoi réagir. Sans cette garde, la comparaison sur un nul
    // rendrait un résultat indéfini plutôt que faux.
    await reset();
    const id = (await pool.query<{ id: string }>(
      `insert into campaigns (tenant_id, name, category) values ($1, 'A', 'marketing') returning id`,
      [tenantId],
    )).rows[0]!.id;
    await pool.query(
      `insert into campaign_recipients (campaign_id, contact_id, to_e164, status) values ($1, $2, $3, 'pending')`,
      [id, contactId, `+${WA}`],
    );
    await message('in', '2026-09-01T10:05:00Z', 'coucou');
    expect(await engagements()).toEqual({ A: false });
  });

  /**
   * LE CLIC SUR UN LIEN (migrations 0106 et 0107).
   *
   * 🔴 C'ÉTAIT UN TROU, PAS UN BONUS. Un bouton URL fait SORTIR le contact de la conversation : il n'en
   * revient aucun message entrant. La personne la PLUS engagée de la campagne, celle qui a ouvert le lien,
   * s'affichait donc comme n'ayant pas réagi. C'est aussi la seule chose qui rende visible l'attribution :
   * sans elle, on saurait qui a cliqué sans jamais le montrer.
   */
  describe('le clic sur un lien tracé', () => {
    it('🔴 vaut engagement, alors qu’il ne produit AUCUN message entrant', async () => {
      await reset();
      await envoi('A', '2026-09-01T10:00:00Z');
      await lien('aaaaaaaaaaaa', 'https://exemple.fr/offre');
      await clic('aaaaaaaaaaaa', '2026-09-01T10:05:00Z');
      expect(await engagements()).toEqual({ A: true });
    });

    it('🔴 un clic ANONYME ne crédite personne', async () => {
      // Les templates approuvés avant le 2026-09-02 portent une adresse figée chez Meta, sans jeton : leurs
      // clics arrivent sans contact. Les compter ici crediterait le contact ouvert d'un geste qui pourrait
      // être celui de n'importe qui, ce qui est pire que de ne rien dire.
      await reset();
      await envoi('A', '2026-09-01T10:00:00Z');
      await lien('bbbbbbbbbbbb', 'https://exemple.fr/offre');
      await clic('bbbbbbbbbbbb', '2026-09-01T10:05:00Z', false);
      expect(await engagements()).toEqual({ A: false });
    });

    it('🔴 un clic arrivé APRÈS le prochain envoi ne crédite pas le premier', async () => {
      // Les MÊMES bornes que la réponse écrite. Sans elles, deux campagnes du même jour se créditeraient
      // l'une l'autre sur un seul clic.
      await reset();
      await envoi('A', '2026-09-01T10:00:00Z');
      await envoi('B', '2026-09-01T14:00:00Z');
      await lien('cccccccccccc', 'https://exemple.fr/offre');
      await clic('cccccccccccc', '2026-09-01T15:00:00Z');
      expect(await engagements()).toEqual({ A: false, B: true });
    });

    it('un clic TROIS JOURS plus tard n’est pas une réaction à cet envoi', async () => {
      await reset();
      await envoi('A', '2026-09-01T10:00:00Z');
      await lien('dddddddddddd', 'https://exemple.fr/offre');
      await clic('dddddddddddd', '2026-09-04T10:00:00Z');
      expect(await engagements()).toEqual({ A: false });
    });

    it('🔴 un clic d’un AUTRE espace ne peut pas déclarer un engagement', async () => {
      // Le pooler est superuser, la RLS est bypassée : le `tc.tenant_id` de la sous-requête est le seul
      // contrôle. Le jeton étant unique GLOBALEMENT, un identifiant de contact peut circuler entre espaces.
      await reset();
      await envoi('A', '2026-09-01T10:00:00Z');
      const autre = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-engage-3') returning id`)).rows[0]!.id;
      try {
        await pool.query(
          `insert into tracked_links (code, tenant_id, destination, avec_jeton, confirmed_at)
           values ('eeeeeeeeeeee', $1, 'https://exemple.fr/offre', true, now())`,
          [autre],
        );
        await pool.query(
          `insert into tracked_link_clicks (code, tenant_id, contact_id, at)
           values ('eeeeeeeeeeee', $1, $2, '2026-09-01T10:05:00Z'::timestamptz)`,
          [autre, contactId],
        );
        expect(await engagements()).toEqual({ A: false });
      } finally {
        await pool.query('delete from tenants where id = $1', [autre]).catch(() => {});
      }
    });
  });

  it('🔴 le fil d’un AUTRE espace ne peut pas déclarer un engagement', async () => {
    // Le pooler est superuser, la RLS est bypassée : le `cv.tenant_id` de la sous-requête est le seul
    // contrôle. Sans lui, un message du fil d'un homonyme chez un autre client compterait ici.
    await reset();
    await envoi('A', '2026-09-01T10:00:00Z');
    const autre = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-engage-2') returning id`)).rows[0]!.id;
    try {
      const convAutre = (await pool.query<{ id: string }>(
        `insert into conversations (tenant_id, wa_id, contact_id, last_message_at) values ($1, $2, null, now()) returning id`,
        [autre, WA],
      )).rows[0]!.id;
      await pool.query(
        `insert into conversation_messages (conversation_id, direction, type, body, created_at)
         values ($1, 'in', 'text', 'chez le voisin', '2026-09-01T10:05:00Z'::timestamptz)`,
        [convAutre],
      );
      expect(await engagements()).toEqual({ A: false });
    } finally {
      await pool.query('delete from tenants where id = $1', [autre]).catch(() => {});
    }
  });
});
