import 'dotenv/config';
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

  /** L'historique, indexé par nom de campagne : les tests parlent de campagnes, pas de rangs. */
  async function engagements(): Promise<Record<string, boolean>> {
    const h = await store.getContactHistory(tenantId, contactId);
    return Object.fromEntries((h?.sends ?? []).map((s) => [s.campaignName, s.engage]));
  }

  /** Table rase entre deux cas : chacun décrit sa propre chronologie. */
  async function reset(): Promise<void> {
    await pool.query('delete from campaigns where tenant_id = $1', [tenantId]);
    await pool.query('delete from conversation_messages where conversation_id = $1', [conversationId]);
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
