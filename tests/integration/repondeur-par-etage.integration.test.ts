import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgCampaignRepo, type CreateCampaignInput } from '../../src/campaign/store.pg';
import { PgInboxStore } from '../../src/inbox/store.pg';
import { PgAgentStore } from '../../src/agent/agent-store.pg';

/**
 * LE RÉPONDEUR D'UN ÉTAGE, EN BASE (plan docs/superpowers/plans/2026-10-30-repondeur-par-etage.md, tâches 1 et 3).
 *
 * 🔴 CE QUE SEULE UNE BASE PEUT PROUVER. La remise lit `PgCampaignRepo.repondeurDeLaReponse` à chaque entrant qu'elle
 * reçoit : un faux rendrait ce qu'on lui dit de rendre, et ne montrerait ni que la ligne se choisit AVANT le filtre (une
 * vieille campagne ne passe pas devant celle d'hier), ni que l'isolation se pose avant le `limit`, ni que le compte des
 * entrants depuis l'envoi est juste, ni que les CHECK de 0263 refusent ce qu'ils doivent sur un devenir NUL (le piège du
 * NULL), ni que supprimer un agent désigné ne lève pas 23514.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du poste pointe l'ANCIENNE base de production. La CI monte un
 * Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('le répondeur désigné par l’étage d’une campagne', () => {
  let pool: Pool;
  let repo: PgCampaignRepo;
  let inbox: PgInboxStore;
  let agents: PgAgentStore;
  let tenantId = '';
  let autreTenantId = '';
  let agentId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    repo = new PgCampaignRepo(pool);
    inbox = new PgInboxStore(pool);
    agents = new PgAgentStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-repondeur-etage') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-repondeur-etage-autre') returning id`)).rows[0]!.id;
  });

  beforeEach(async () => {
    // Chaque cas repart sans conversation ni campagne : sinon la campagne « la plus récente » d'un cas serait celle d'un
    // autre, et l'ordre d'exécution déciderait du verdict.
    for (const t of [tenantId, autreTenantId]) {
      await pool.query('delete from conversations where tenant_id = $1', [t]);
      await pool.query('delete from campaigns where tenant_id = $1', [t]);
      await pool.query('delete from contacts where tenant_id = $1', [t]);
    }
    agentId = (await agents.create(tenantId, `Léa ${Date.now()}`, 'Je suis une IA.', 'anthropic/claude-haiku-4.5')).id;
  });

  afterAll(async () => {
    for (const t of [tenantId, autreTenantId]) {
      if (!t) continue;
      await pool.query('delete from conversations where tenant_id = $1', [t]);
      await pool.query('delete from campaigns where tenant_id = $1', [t]);
      await pool.query('delete from contacts where tenant_id = $1', [t]);
      await pool.query('delete from tenants where id = $1', [t]);
    }
    await pool.end();
  });

  /** Une campagne de l'espace, par le VRAI chemin d'écriture (`insertCampaignRow`). */
  const campagne = (t: string, nom: string, o: Partial<CreateCampaignInput> = {}): Promise<string> => repo.insertCampaign({
    tenantId: t, phoneNumberId: 'pn-repondeur', name: nom, category: 'marketing',
    templateName: 't', templateLanguage: 'fr', paramMapping: [], ...o,
  });

  /** Le contact et sa conversation, sans aucun envoi. */
  const contactEtConversation = async (t: string, numero: string): Promise<{ contactId: string; conversationId: string }> => {
    const contactId = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, opt_in_status) values ($1, $2, 'opted_in') returning id`, [t, `+${numero}`],
    )).rows[0]!.id;
    const conversationId = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, contact_id, last_message_at, last_preview, last_direction)
       values ($1, $2, $3, now(), 'coucou', 'out') returning id`, [t, numero, contactId],
    )).rows[0]!.id;
    return { contactId, conversationId };
  };

  /** Ce contact a été SERVI par cette campagne, à cet instant, sur cet étage. */
  const servi = async (campaignId: string, contactId: string, numero: string, sentAt: string, etage = 1): Promise<void> => {
    await pool.query(
      `insert into campaign_recipients (campaign_id, contact_id, to_e164, resolved_params, status, sent_at, etage_courant)
       values ($1, $2, $3, '[]'::jsonb, 'sent', $4::timestamptz, $5)`,
      [campaignId, contactId, `+${numero}`, sentAt, etage],
    );
  };

  /** Un message du contact, par le VRAI `recordInbound`, qui le date à `now()`. */
  const entrant = (t: string, numero: string, id: string, o: { type?: string; body?: string } = {}) => inbox.recordInbound(t, {
    phoneNumberId: 'pn-repondeur', waId: numero, messageId: `wamid.itest-repondeur-${id}-${Date.now()}`,
    type: o.type ?? 'text', body: o.body ?? 'Oui', buttonPayload: null, profileName: null, field: 'messages',
  });

  const ilYa = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

  it('🔴 écrit puis relu : l’étage 1 (colonnes de la campagne) et un étage de la chaîne portent leur répondeur', async () => {
    const id = await campagne(tenantId, 'ecrite', {
      devenir: 'mba', repondeur: 'agent', repondeurAgentId: agentId,
      chaine: [
        { rang: 1, canal: 'whatsapp' },
        { rang: 2, canal: 'rcs', rcsMessage: { text: 'Bonjour' }, devenir: 'mba', repondeur: 'mba' },
      ],
    });
    const chaine = (await repo.getCampaign(id))?.chaine ?? [];
    expect(chaine.find((e) => e.rang === 1)).toMatchObject({ devenir: 'mba', repondeur: 'agent', repondeurAgentId: agentId });
    const deux = chaine.find((e) => e.rang === 2);
    expect(deux).toMatchObject({ devenir: 'mba', repondeur: 'mba' });
    expect(deux).not.toHaveProperty('repondeurAgentId');
    // Une campagne sans répondeur se relit comme avant : aucune clé de plus (les lecteurs qui comparent en `toEqual`).
    const sans = (await repo.getCampaign(await campagne(tenantId, 'sans', { devenir: 'mba' })))?.chaine?.[0];
    expect(sans).not.toHaveProperty('repondeur');
    expect(sans).not.toHaveProperty('repondeurAgentId');
  });

  it('rend l’agent IA de l’étage où était le destinataire, avec le nom de la campagne pour la frise', async () => {
    const numero = '33600000201';
    const { contactId } = await contactEtConversation(tenantId, numero);
    const id = await campagne(tenantId, 'Rentrée', {
      devenir: 'mba', repondeur: 'mba',
      chaine: [{ rang: 1, canal: 'whatsapp' }, { rang: 2, canal: 'rcs', rcsMessage: { text: 'Bonjour' }, devenir: 'mba', repondeur: 'agent', repondeurAgentId: agentId }],
    });
    // Le destinataire a basculé sur l'étage 2 : c'est SON répondeur qui décide, pas celui de l'étage 1.
    await servi(id, contactId, numero, ilYa(60), 2);
    await entrant(tenantId, numero, 'etage2');
    expect(await repo.repondeurDeLaReponse(tenantId, numero)).toEqual({ nom: 'Rentrée', cible: 'agent', agentId });
  });

  /**
   * 🔴 LA PLUS RÉCENTE CAMPAGNE SERVIE GAGNE, MÊME SI ELLE NE DÉSIGNE RIEN : la ligne se choisit (`order by ... limit 1`)
   * AVANT le filtre `repondeur is not null`. Filtrer avant ferait répondre l'agent d'une campagne d'août à la réponse
   * d'une campagne de septembre. Ses deux sens : seule, l'ancienne est retenue ; puis masquée.
   */
  it('🔴 une campagne plus récente sans répondeur masque une ancienne qui en désignait un', async () => {
    const numero = '33600000211';
    const { contactId } = await contactEtConversation(tenantId, numero);
    const ancienne = await campagne(tenantId, 'ancienne', { devenir: 'mba', repondeur: 'agent', repondeurAgentId: agentId });
    await servi(ancienne, contactId, numero, ilYa(600));
    await entrant(tenantId, numero, 'masque');
    expect((await repo.repondeurDeLaReponse(tenantId, numero))?.nom, 'seule, l’ancienne décide').toBe('ancienne');

    const recente = await campagne(tenantId, 'recente', { devenir: 'mba' });
    await servi(recente, contactId, numero, ilYa(30));
    expect(await repo.repondeurDeLaReponse(tenantId, numero)).toBeNull();
  });

  /**
   * 🔴 SEULE LA PREMIÈRE RÉPONSE DEPUIS L'ENVOI DÉCIDE (`premiere_reponse`), ce qui rend « jusqu'à ce que l'agent la
   * close » vrai sans état de plus : après lui, le message suivant suit le réglage de l'espace. Un entrant d'AVANT l'envoi
   * ne compte pas ; une RÉACTION non plus (un pouce levé ne démarre aucun robot, `reactionsSeules`, et le texte qui suit
   * doit encore être la première réponse). Les entrants passent par le vrai `recordInbound`, qui date à `now()`.
   */
  it('🔴 la première réponse décide, une réaction ne la consomme pas, la seconde ne décide plus', async () => {
    const numero = '33600000221';
    const { contactId, conversationId } = await contactEtConversation(tenantId, numero);
    const id = await campagne(tenantId, 'premiere', { devenir: 'mba', repondeur: 'mba' });
    await servi(id, contactId, numero, ilYa(60));
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, created_at)
       values ($1, 'in', 'text', 'avant l envoi', now() - interval '2 hours')`, [conversationId],
    );
    await entrant(tenantId, numero, 'pouce', { type: 'reaction', body: String.fromCodePoint(0x1f44d) });
    expect(await repo.repondeurDeLaReponse(tenantId, numero), 'un pouce ne consomme pas la première réponse').toEqual({ nom: 'premiere', cible: 'mba' });
    await entrant(tenantId, numero, 'r1', { body: 'Oui' });
    expect(await repo.repondeurDeLaReponse(tenantId, numero), 'la première réponse décide').toEqual({ nom: 'premiere', cible: 'mba' });
    await entrant(tenantId, numero, 'r2', { body: 'Vous êtes là ?' });
    expect(await repo.repondeurDeLaReponse(tenantId, numero), 'la seconde ne décide plus').toBeNull();
  });

  /**
   * 🔴 L'ISOLATION SE POSE AVANT DE CHOISIR LA LIGNE. Une ligne de destinataire FORGÉE relie le contact de l'espace A à
   * une campagne plus récente de l'espace B, dont l'étage désigne un agent de B : `c.tenant_id = $1` dans la
   * sous-requête l'écarte avant le `limit`, et c'est la campagne de A qui répond. Posé après, B serait choisie puis
   * filtrée (le répondeur de A perdu) ; absent, l'agent de B parlerait au client de A.
   */
  it('🔴 une campagne d’un autre espace ne décide jamais, même plus récente et reliée au contact', async () => {
    const numero = '33600000231';
    const { contactId } = await contactEtConversation(tenantId, numero);
    const deA = await campagne(tenantId, 'de A', { devenir: 'mba', repondeur: 'mba' });
    await servi(deA, contactId, numero, ilYa(120));
    const agentDeB = (await agents.create(autreTenantId, `Hugo ${Date.now()}`, 'Je suis une IA.', 'anthropic/claude-haiku-4.5')).id;
    const deB = await campagne(autreTenantId, 'de B', { devenir: 'mba', repondeur: 'agent', repondeurAgentId: agentDeB });
    await servi(deB, contactId, numero, ilYa(10));
    await entrant(tenantId, numero, 'isolation');
    expect(await repo.repondeurDeLaReponse(tenantId, numero)).toEqual({ nom: 'de A', cible: 'mba' });
    // L'espace B n'a aucune conversation avec ce numéro : rien, pas la campagne de A.
    expect(await repo.repondeurDeLaReponse(autreTenantId, numero)).toBeNull();
  });

  /**
   * 🔴 SUPPRIMER L'AGENT DÉSIGNÉ NE LÈVE PAS, ET L'ÉTAGE RETOMBE SUR LE RÉPONDEUR DE L'ESPACE. Le `set null` de la clé
   * étrangère laisse `repondeur = 'agent'` sans identifiant, état qu'aucun CHECK ne refuse (le refuser ferait échouer la
   * suppression en 23514, la leçon de 0144) et que la lecture rend comme « rien de désigné ».
   */
  it('🔴 l’agent désigné supprimé : la suppression passe, l’identifiant repasse à nul, la réponse suit l’espace', async () => {
    const numero = '33600000241';
    const { contactId } = await contactEtConversation(tenantId, numero);
    const id = await campagne(tenantId, 'agent supprime', { devenir: 'mba', repondeur: 'agent', repondeurAgentId: agentId });
    await servi(id, contactId, numero, ilYa(60));
    await entrant(tenantId, numero, 'supprime');
    expect(await repo.repondeurDeLaReponse(tenantId, numero)).toEqual({ nom: 'agent supprime', cible: 'agent', agentId });

    expect(await agents.remove(tenantId, agentId)).toBe(true);
    const { rows } = await pool.query<{ repondeur: string | null; repondeur_agent_id: string | null }>(
      'select repondeur, repondeur_agent_id from campaign_etages where campaign_id = $1 and rang = 1', [id],
    );
    expect(rows[0]).toEqual({ repondeur: 'agent', repondeur_agent_id: null });
    expect(await repo.repondeurDeLaReponse(tenantId, numero)).toBeNull();
  });

  /**
   * 🔴 LES CHECK REFUSENT CE QUE LA VALIDATION REFUSE, Y COMPRIS SUR UN DEVENIR NUL. `devenir = 'mba'` vaut NULL quand
   * `devenir` est nul, et un CHECK qui vaut NULL passe : c'est pour ça que 0263 écrit `is not distinct from`. Les deux
   * sens : ce qui doit passer passe (dont l'état d'après la suppression d'un agent).
   */
  it('🔴 les CHECK de 0263 : refusés sur un devenir nul ou un identifiant orphelin, acceptés sinon', async () => {
    const id = await campagne(tenantId, 'checks');
    const essai = async (rang: number, v: { devenir: string | null; repondeur: string | null; agent: string | null }): Promise<string | null> => {
      try {
        await pool.query(
          `insert into campaign_etages (campaign_id, rang, canal, devenir, repondeur, repondeur_agent_id) values ($1, $2, 'rcs', $3, $4, $5)`,
          [id, rang, v.devenir, v.repondeur, v.agent],
        );
        await pool.query('delete from campaign_etages where campaign_id = $1 and rang = $2', [id, rang]);
        return null;
      } catch (e) {
        return (e as { constraint?: string }).constraint ?? String(e);
      }
    };
    expect(await essai(2, { devenir: null, repondeur: 'mba', agent: null })).toBe('campaign_etages_repondeur_devenir_chk');
    expect(await essai(2, { devenir: 'inbox', repondeur: 'agent', agent: agentId })).toBe('campaign_etages_repondeur_devenir_chk');
    expect(await essai(2, { devenir: 'mba', repondeur: 'humain', agent: null })).toBe('campaign_etages_repondeur_chk');
    expect(await essai(2, { devenir: 'mba', repondeur: null, agent: agentId })).toBe('campaign_etages_repondeur_agent_chk');
    expect(await essai(2, { devenir: 'mba', repondeur: 'mba', agent: agentId })).toBe('campaign_etages_repondeur_agent_chk');
    expect(await essai(2, { devenir: 'mba', repondeur: 'agent', agent: agentId })).toBeNull();
    expect(await essai(2, { devenir: 'mba', repondeur: 'agent', agent: null }), 'l’état d’après la suppression d’un agent').toBeNull();
    expect(await essai(2, { devenir: 'mba', repondeur: 'mba', agent: null })).toBeNull();
    expect(await essai(2, { devenir: null, repondeur: null, agent: null }), 'un étage d’avant le réglage').toBeNull();
  });
});
