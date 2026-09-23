import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgInboxStore } from '../../src/inbox/store.pg';

/**
 * Les compteurs du menu de dossiers de l'Inbox.
 *
 * 🔴 CE QUE CES TESTS PROTÈGENT. Un compteur faux est PIRE qu'un compteur absent, parce qu'on le croit. Ils
 * portent donc sur TOUTE la base et pas sur une page, ils s'accordent entre eux (la somme de « Tout » et
 * d'« Archivé » ne dépasse jamais le nombre de conversations), et ils appliquent EXACTEMENT les mêmes
 * filtres que la liste qu'ils commentent.
 *
 * ⚠️ Ce dernier point est une CORRECTION. L'ancien `countATraiter` ne retirait pas les contacts BLOQUÉS
 * alors que `listConversations` les retire : son chiffre pouvait dépasser le nombre de lignes affichées,
 * sans que rien ne l'explique. Le compteur unifié ferme cet écart, ce qui peut faire BAISSER le nombre chez
 * un client qui a des contacts bloqués.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la PRODUCTION. La CI monte un
 * Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('compteurs du menu de dossiers', () => {
  let pool: Pool;
  let store: PgInboxStore;
  let tenantId = '';
  let jean = '';
  let marie = '';
  let convBloquee = '';

  /** Une conversation prête à l'emploi : son contact, son détenteur, son affectation, son archivage. */
  async function conversation(waId: string, opts: {
    tenu?: boolean; signalee?: boolean; archivee?: boolean; affectee?: string; bloque?: boolean;
  } = {}): Promise<string> {
    const contact = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, blocked_at)
       values ($1, $2, ${opts.bloque ? 'now()' : 'null'}) returning id`,
      [tenantId, `+${waId}`],
    )).rows[0]!.id;
    // ⚠️ UN SENS DE DERNIER MESSAGE, PARCE QUE TOUTE CONVERSATION REELLE EN PORTE UN (2026-09-23). La
    // fixture n'en ecrivait aucun, donc elle fabriquait un etat que la production n'a pas : mesure faite le
    // 2026-09-23, les 15 conversations existantes portent toutes leur sens (la reprise de 0130 les a
    // renseignees). Depuis que « A traiter » exige un message, une fixture sans sens vidait le dossier et
    // faisait tomber des tests qui ne parlent pas de ca.
    const conv = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, contact_id, last_message_at, last_direction, control_owner, assigned_to, archived_at)
       values ($1, $2, $3, now(), 'in', $4, $5, ${opts.archivee ? 'now()' : 'null'}) returning id`,
      [tenantId, waId, contact, opts.tenu ? 'app_human' : 'app_workflow', opts.affectee ?? null],
    )).rows[0]!.id;
    if (opts.signalee) {
      await pool.query(
        // ⚠️ La table exige DOUZE colonnes non nulles : le schema d'analyse est complet par construction
        // (un LLM qui omet un champ ne doit pas produire une analyse a trous). Une fixture partielle fait
        // echouer le beforeAll entier, et vitest le rapporte comme « 6 skipped », ce qui ressemble a un
        // test desactive plutot qu a une erreur.
        `insert into conversation_analysis
           (conversation_id, tenant_id, sentiment, intent, topic, resolved, abusive,
            handled_by, exchanges_count, entities, action_suggestion, confidence, justification,
            llm_provider, llm_model)
         values ($1, $2, 'negatif', 'reclamation', 'insultes', false, true,
                 'humain', 2, '{}'::jsonb, 'escalader', 0.9, 'insultes envers le support',
                 'itest', 'itest')`,
        [conv, tenantId],
      );
    }
    return conv;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    store = new PgInboxStore(pool);
    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-inbox-compteurs') returning id`,
    )).rows[0]!.id;
    const membre = async (email: string, nom: string): Promise<string> => (await pool.query<{ id: string }>(
      `insert into users (tenant_id, email, name, password_hash, role) values ($1, $2, $3, 'x', 'agent') returning id`,
      [tenantId, email, nom],
    )).rows[0]!.id;
    jean = await membre('jean@itest.test', 'Jean');
    marie = await membre('marie@itest.test', 'Marie');

    // Quatre NON archivées : deux tenues (dont une signalée), deux au scénario. Deux affectées à Jean.
    await conversation('33600000001', { tenu: true, affectee: jean });
    await conversation('33600000002', { tenu: true, signalee: true, affectee: jean });
    await conversation('33600000003', {});
    await conversation('33600000004', {});
    // Une archivée, tenue et affectée : elle ne doit compter QUE dans « Archivé ».
    await conversation('33600000005', { archivee: true, tenu: true, affectee: jean });
    // Une dont le contact est BLOQUÉ : elle ne doit compter nulle part.
    convBloquee = await conversation('33600000006', { tenu: true, bloque: true });
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  /**
   * 🔴 « À TRAITER » VEUT DIRE « LA BALLE EST DANS NOTRE CAMP », et il ne le voulait pas dire.
   *
   * Le dossier valait `control_owner <> 'app_workflow'`, c'est-à-dire « le scénario ne gère plus ce fil ».
   * Un opérateur prenait donc la main, RÉPONDAIT au client, et la conversation restait dans le dossier alors
   * qu'on attend désormais le CLIENT. Constaté par Julien le 2026-09-10.
   *
   * ⚠️ CES TESTS PASSENT PAR LE VRAI CODE (`recordInbound`, `recordOutbound`) et pas par un `insert`
   * recopié : ce qui se casserait, c'est justement un des trois chemins d'écriture qui oublierait le sens du
   * message. Un test qui écrirait `last_direction` lui-même vérifierait sa propre fixture.
   *
   * 🔴 ET DANS SON PROPRE ESPACE. Écrits d'abord dans le tenant partagé, ils ont fait exploser les compteurs
   * des tests voisins, qui portent sur TOUTE la base de leur espace (« 10 au lieu de 4 »). Un test qui ajoute
   * des lignes à une fixture partagée casse ses voisins, et le rapport accuse alors le mauvais test.
   */
  describe('🔴 « À traiter » suit QUI A PARLÉ EN DERNIER', () => {
    let espace = '';

    beforeAll(async () => {
      espace = (await pool.query<{ id: string }>(
        `insert into tenants (name) values ('itest-inbox-a-traiter') returning id`,
      )).rows[0]!.id;
    });
    afterAll(async () => {
      if (espace) await pool.query('delete from tenants where id = $1', [espace]);
    });

    /**
     * Une conversation de CET espace, avec son contact, son détenteur et le SENS de son dernier message.
     *
     * ⚠️ `sens` VAUT `'in'` PAR DÉFAUT parce que c'est l'état de toute conversation réelle : elle naît d'un
     * message, entrant ou sortant. `null` reste possible et se demande explicitement, pour le seul état qui
     * le produit vraiment : un fil qu'un opérateur vient d'OUVRIR depuis la fiche d'un contact, sur lequel
     * personne n'a encore parlé (lot 6, 2026-09-23).
     */
    async function conv(waId: string, owner: 'app_workflow' | 'app_human' | 'mba', sens: 'in' | 'out' | null = 'in'): Promise<string> {
      const contact = (await pool.query<{ id: string }>(
        `insert into contacts (tenant_id, phone_e164) values ($1, $2) returning id`,
        [espace, `+${waId}`],
      )).rows[0]!.id;
      return (await pool.query<{ id: string }>(
        `insert into conversations (tenant_id, wa_id, contact_id, last_message_at, control_owner, last_direction)
         values ($1, $2, $3, now(), $4, $5) returning id`,
        [espace, waId, contact, owner, sens],
      )).rows[0]!.id;
    }

    /** Un fil tenu par un humain, sur lequel le CONTACT vient d'écrire. */
    async function filTenu(waId: string): Promise<string> {
      const id = await conv(waId, 'app_human');
      await store.recordInbound(espace, {
        phoneNumberId: 'pn', waId, messageId: `m-${waId}-in`, type: 'text',
        body: 'bonjour', buttonPayload: null, profileName: null, field: 'messages',
      });
      return id;
    }
    const dansLeDossier = async (id: string): Promise<boolean> =>
      (await store.listConversations(espace, { aTraiter: true })).some((c) => c.id === id);

    it('un fil tenu où le CONTACT a parlé en dernier est à traiter', async () => {
      expect(await dansLeDossier(await filTenu('33610000001'))).toBe(true);
    });

    it('🔴 dès que l’HUMAIN répond, le fil SORT du dossier (mais reste dans Tout)', async () => {
      const id = await filTenu('33610000002');
      const avant = await store.compterConversations(espace);
      expect(await dansLeDossier(id)).toBe(true);

      await store.recordOutbound(id, 'je regarde ça', 'm-out-1', 'humain');

      expect(await dansLeDossier(id)).toBe(false);
      const apres = await store.compterConversations(espace);
      expect(apres.aTraiter).toBe(avant.aTraiter - 1);
      // ⚠️ ET IL RESTE DANS « TOUT » : on ne le range pas, on cesse seulement de le RÉCLAMER.
      expect(apres.tout).toBe(avant.tout);
      expect((await store.listConversations(espace, {})).some((c) => c.id === id)).toBe(true);
    });

    it('🔴 et il REVIENT dès que le contact réécrit', async () => {
      // Sans ce sens-là, le dossier se viderait pour de bon et un client qui relance ne serait jamais repris.
      const id = await filTenu('33610000003');
      await store.recordOutbound(id, 'je regarde ça', 'm-out-2', 'humain');
      expect(await dansLeDossier(id)).toBe(false);

      await store.recordInbound(espace, {
        phoneNumberId: 'pn', waId: '33610000003', messageId: 'm-in-2', type: 'text',
        body: 'alors ?', buttonPayload: null, profileName: null, field: 'messages',
      });
      expect(await dansLeDossier(id)).toBe(true);
    });

    it('⚠️ un envoi AUTOMATISÉ compte aussi comme « nous avons parlé »', async () => {
      // `recordOutboundByWaId` sert les campagnes, les scénarios et l'agent de Meta. Quel que soit le
      // détenteur du fil, c'est bien nous qui avons parlé en dernier : la balle est chez le contact.
      const id = await filTenu('33610000004');
      await store.recordOutboundByWaId(espace, '33610000004', {
        body: 'votre commande est partie', messageId: 'm-auto-1', origine: 'scenario',
      });
      expect(await dansLeDossier(id)).toBe(false);
    });

    it('🔴 un fil tenu par l’AGENT DE META en SORT aussi des que le robot a répondu', async () => {
      // MÊME CAS, VERDICT INVERSÉ, tranché par Julien le 2026-09-11. La première version gardait les fils du
      // robot dans le dossier pour les SURVEILLER. Mais « À traiter » ne veut pas dire « à surveiller », il
      // veut dire « quelqu'un attend quelque chose de nous » : un fil où le robot vient de répondre n'attend
      // rien. Pour voir ce que le robot mène, on ouvre « Tout ».
      const id = await conv('33610000006', 'mba');
      await store.recordInbound(espace, {
        phoneNumberId: 'pn', waId: '33610000006', messageId: 'm-mba-in', type: 'text',
        body: 'bonjour', buttonPayload: null, profileName: null, field: 'standby',
      });
      // Le contact a parlé, le robot n'a pas encore répondu : c'est bien à traiter.
      expect(await dansLeDossier(id)).toBe(true);

      await store.recordOutboundByWaId(espace, '33610000006', {
        body: 'je vous explique', messageId: 'm-mba-out', type: 'mba', origine: 'mba',
      });
      expect(await dansLeDossier(id)).toBe(false);
      // ⚠️ Mais il reste dans « Tout » : on ne le range pas, on cesse seulement de le RÉCLAMER.
      expect((await store.listConversations(espace, {})).some((c) => c.id === id)).toBe(true);

      // Et il REVIENT dès que le contact réécrit : c'est ce qui empêche un fil mené par le robot de
      // disparaître pour de bon si le client relance.
      await store.recordInbound(espace, {
        phoneNumberId: 'pn', waId: '33610000006', messageId: 'm-mba-in-2', type: 'text',
        body: 'et sinon ?', buttonPayload: null, profileName: null, field: 'standby',
      });
      expect(await dansLeDossier(id)).toBe(true);
    });

    it('🔴 la réponse d’un HUMAIN repousse le dégel automatique', async () => {
      // Le balayage rend la main au bout de deux heures comptées depuis `control_changed_at`, qui n'était
      // écrite qu'au CHANGEMENT de détenteur. Un opérateur qui prenait un fil à 10 h et discutait encore à
      // 11 h 55 se le faisait reprendre à 12 h, EN PLEINE CONVERSATION. C'est la règle telle que Julien
      // l'énonce : deux heures après sa DERNIÈRE RÉPONSE.
      const id = await filTenu('33610000007');
      await pool.query(`update conversations set control_changed_at = now() - interval '90 minutes' where id = $1`, [id]);
      const avant = (await pool.query<{ d: Date }>('select control_changed_at as d from conversations where id = $1', [id])).rows[0]!.d;

      await store.recordOutbound(id, 'je vous réponds', 'm-out-3', 'humain');

      const apres = (await pool.query<{ d: Date }>('select control_changed_at as d from conversations where id = $1', [id])).rows[0]!.d;
      expect(apres.getTime()).toBeGreaterThan(avant.getTime());
    });

    it('⚠️ une réponse d’AUTOMATE ne prolonge PAS un gel humain', async () => {
      // Sinon un fil resterait gelé par le seul fait qu'un scénario ou un agent IA parle dedans, et le
      // garde-fou des deux heures ne servirait plus à rien.
      const id = await filTenu('33610000008');
      await pool.query(`update conversations set control_changed_at = now() - interval '90 minutes' where id = $1`, [id]);
      const avant = (await pool.query<{ d: Date }>('select control_changed_at as d from conversations where id = $1', [id])).rows[0]!.d;

      await store.recordOutbound(id, 'message du scenario', 'm-out-4', 'scenario');

      const apres = (await pool.query<{ d: Date }>('select control_changed_at as d from conversations where id = $1', [id])).rows[0]!.d;
      expect(apres.getTime()).toBe(avant.getTime());
    });

    it('🔴 la règle ne se réécrit pas en logique à TROIS valeurs, qui ferait disparaître des fils', async () => {
      // 🔴 CE TEST A TROUVÉ UNE VRAIE FAUTE, et c'est la raison d'être des tests d'intégration ici. La règle
      // s'écrivait `not (owner = 'app_human' and last_direction = 'out')`, qui vaut NULL quand la colonne est
      // NULL (logique à TROIS valeurs), et un prédicat NULL EXCLUT la ligne : toutes les conversations
      // tenues par un humain auraient DISPARU du dossier au déploiement. Aucun test unitaire ne peut voir
      // ça, la faute est dans le SQL. Le cas reste donc gardé, sur un fil qui a bien un sens.
      const id = await conv('33610000005', 'app_human', 'in');
      expect(await dansLeDossier(id)).toBe(true);
    });

    it('🔴 un fil SANS AUCUN MESSAGE n entre PAS dans le dossier (2026-09-23)', async () => {
      // ⚠️ CE TEST AFFIRMAIT L'INVERSE JUSQU'AU 2026-09-23, et le renversement est un ARBITRAGE, pas une
      // correction de bug. En 2026-09-11, un `last_direction` nul voulait dire « on ne sait pas encore » :
      // faire disparaître ces fils au déploiement aurait été la pire façon d'introduire le filtre, et le
      // test gardait ce choix. La reprise de 0130 les a tous renseignés (mesuré en production le
      // 2026-09-23 : ZÉRO conversation porte encore un sens nul), et un sens nul ne décrit plus qu'un état
      // NEUF : un fil qu'un opérateur vient d'ouvrir depuis la fiche d'un contact. Personne n'y attend de
      // réponse, donc il n'a rien à faire dans une file de travail.
      const id = await conv('33610000091', 'app_human', null);
      const sens = await pool.query<{ last_direction: string | null }>(
        'select last_direction from conversations where id = $1', [id],
      );
      expect(sens.rows[0]!.last_direction).toBeNull();
      expect(await dansLeDossier(id)).toBe(false);
    });
  });

  it('🔴 les compteurs portent sur TOUTE la base, et s’accordent entre eux', async () => {
    const c = await store.compterConversations(tenantId);
    expect(c.tout).toBe(4);
    expect(c.aTraiter).toBe(2);
    expect(c.signalees).toBe(1);
    expect(c.archivees).toBe(1);
    // Aucune conversation marquée « Traité » dans ce décor (migration 0160) : le compteur existe et vaut zéro.
    // Son comportement propre est tenu par `inbox-traite.integration.test.ts`.
    expect(c.traitees).toBe(0);
    expect(c.nonAffectees).toBe(2);
  });

  it('🔴 « Tout » EXCLUT les archivées : sinon deux dossiers compteraient la même conversation', async () => {
    const c = await store.compterConversations(tenantId);
    // Cinq conversations visibles en tout (la bloquée ne compte pas), réparties SANS recouvrement.
    expect(c.tout + c.archivees).toBe(5);
  });

  it('🔴 un contact BLOQUÉ ne compte NULLE PART, comme il n’apparaît nulle part', async () => {
    // C'est la correction : l'ancien `countATraiter` comptait cette conversation (elle est `app_human`)
    // alors que la liste ne la montre pas. Le compteur dépassait donc le nombre de lignes affichées.
    const c = await store.compterConversations(tenantId);
    const vues = (await store.listConversations(tenantId)).map((x) => x.id);
    expect(vues).not.toContain(convBloquee);
    expect(c.aTraiter).toBe(2); // et non 3
    expect(c.parMembre.every((m) => m.n <= 2)).toBe(true);
  });

  it('🔴 la charge par membre liste TOUS les membres, y compris ceux à ZÉRO', async () => {
    // C'est ce qui répond à la question du manager : un collaborateur sans conversation est une
    // information, et ne le montrer que lorsqu'il en a le rendrait invisible au moment où on le cherche.
    const c = await store.compterConversations(tenantId);
    expect(c.parMembre).toEqual([
      { userId: jean, nom: 'Jean', n: 2 },
      { userId: marie, nom: 'Marie', n: 0 },
    ]);
  });

  it('une conversation ARCHIVÉE ne compte pas dans la charge de son affectataire', async () => {
    // Jean en a trois affectées, dont une archivée : sa charge est de deux. Une charge qui compterait le
    // rangé annoncerait du travail qui n'existe plus.
    const c = await store.compterConversations(tenantId);
    expect(c.parMembre.find((m) => m.userId === jean)?.n).toBe(2);
  });

  /**
   * 🔴 LA PASTILLE DE NON-LUS COMPTE CE QUE L'ÉCRAN MONTRE, relevé à la revue du 2026-09-08.
   *
   * `countUnread` ne retirait NI les archivées (défaut introduit par ce lot) NI les contacts bloqués
   * (défaut antérieur, même famille que celui de `countATraiter`). Une pastille qui annonce des messages
   * que l'Inbox ne montre plus est un compteur qui ment : on clique, on cherche, on ne trouve pas, et
   * ranger une conversation non lue la laissait annoncée pour toujours sans moyen de faire descendre le
   * chiffre.
   */
  it('🔴 la pastille de non-lus exclut les ARCHIVÉES et les BLOQUÉS', async () => {
    // Une conversation neuve, non lue, dans un espace à part pour ne pas déranger les compteurs ci-dessus.
    const t2 = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-inbox-unread') returning id`,
    )).rows[0]!.id;
    try {
      const store2 = new PgInboxStore(pool);
      const poser = async (waId: string, opts: { archivee?: boolean; bloque?: boolean }): Promise<void> => {
        const ct = (await pool.query<{ id: string }>(
          `insert into contacts (tenant_id, phone_e164, blocked_at) values ($1, $2, ${opts.bloque ? 'now()' : 'null'}) returning id`,
          [t2, `+${waId}`],
        )).rows[0]!.id;
        const conv = (await pool.query<{ id: string }>(
          `insert into conversations (tenant_id, wa_id, contact_id, last_message_at, archived_at)
           values ($1, $2, $3, now(), ${opts.archivee ? 'now()' : 'null'}) returning id`,
          [t2, waId, ct],
        )).rows[0]!.id;
        // Un message ENTRANT jamais lu (`last_read_at` reste null) : c'est ce que compte la pastille.
        await pool.query(
          `insert into conversation_messages (conversation_id, direction, type, body) values ($1, 'in', 'text', 'coucou')`,
          [conv],
        );
      };
      await poser('33700000001', {});                  // visible et non lue -> compte
      await poser('33700000002', { archivee: true });  // rangée -> ne compte pas
      await poser('33700000003', { bloque: true });    // bloquée -> ne compte pas

      expect(await store2.countUnread(t2, { userId: null, role: 'admin' })).toBe(1);
    } finally {
      await pool.query('delete from tenants where id = $1', [t2]);
    }
  });

  it('🔴 un AUTRE espace ne voit rien de celui-ci', async () => {
    // Le pooler est superuser, la RLS est contournée : le `tenant_id` de chaque requête est LE contrôle.
    const autre = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-inbox-compteurs-autre') returning id`,
    )).rows[0]!.id;
    try {
      const c = await store.compterConversations(autre);
      expect(c).toEqual({ tout: 0, aTraiter: 0, signalees: 0, archivees: 0, traitees: 0, nonAffectees: 0, parMembre: [] });
    } finally {
      await pool.query('delete from tenants where id = $1', [autre]);
    }
  });
});

/**
 * LE SIGNALEMENT MANUEL, ET SON UNION AVEC LE CONSTAT DE L'ANALYSE (migration 0123, 2026-09-09).
 *
 * 🔴 CE QUI NE SE VÉRIFIE QU'EN BASE. Le dossier « Signalé » lit désormais DEUX sources : la colonne écrite
 * par un opérateur, et le constat posé par l'analyse. Une union mal écrite ne lève aucune erreur, elle
 * COMPTE MAL : soit elle rate les signalements humains, soit elle double ceux qui portent les deux marques.
 * Un faux store ne peut rien en dire, c'est du SQL.
 *
 * 🔴 ET LE POINT LE PLUS COÛTEUX : une RÉ-ANALYSE ne doit pas effacer un signalement humain. C'est la raison
 * d'être de la colonne séparée, et c'est le cas qui se vérifie ici plutôt que se raisonne.
 */
describe.skipIf(!url)('signalement manuel : deux sources, une union', () => {
  let pool: Pool;
  let store: PgInboxStore;
  let tenantId = '';
  let operateur = '';
  let parIA = '';
  let parHumain = '';
  let parLesDeux = '';

  async function conv(waId: string): Promise<string> {
    const contact = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164) values ($1, $2) returning id`, [tenantId, `+${waId}`],
    )).rows[0]!.id;
    return (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, contact_id, last_message_at)
       values ($1, $2, $3, now()) returning id`, [tenantId, waId, contact],
    )).rows[0]!.id;
  }
  async function analyseAbusive(conversationId: string, abusive: boolean): Promise<void> {
    await pool.query(
      `insert into conversation_analysis
         (conversation_id, tenant_id, sentiment, intent, topic, resolved, abusive, handled_by,
          exchanges_count, entities, action_suggestion, confidence, justification, llm_provider, llm_model)
       values ($1, $2, 'negatif', 'reclamation', 'insultes', false, $3, 'humain',
               2, '{}'::jsonb, 'escalader', 0.9, 'insultes', 'itest', 'itest')
       on conflict (conversation_id) do update set abusive = excluded.abusive, created_at = now()`,
      [conversationId, tenantId, abusive],
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    store = new PgInboxStore(pool);
    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-inbox-signalement') returning id`,
    )).rows[0]!.id;
    operateur = (await pool.query<{ id: string }>(
      `insert into users (tenant_id, email, name, password_hash, role) values ($1, 'op@itest.test', 'Op', 'x', 'agent') returning id`,
      [tenantId],
    )).rows[0]!.id;

    parIA = await conv('33610000001');
    await analyseAbusive(parIA, true);
    parHumain = await conv('33610000002');
    await store.signalerConversation(tenantId, parHumain, true, operateur);
    parLesDeux = await conv('33610000003');
    await analyseAbusive(parLesDeux, true);
    await store.signalerConversation(tenantId, parLesDeux, true, operateur);
    await conv('33610000004'); // ni l'un ni l'autre
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  it('🔴 le dossier montre l’UNION, et ne compte personne deux fois', async () => {
    const c = await store.compterConversations(tenantId);
    expect(c.signalees).toBe(3); // IA seule + humain seul + les deux, JAMAIS 4
    const liste = await store.listConversations(tenantId, { signalees: true });
    expect(liste.map((x) => x.id).sort()).toEqual([parIA, parHumain, parLesDeux].sort());
  });

  it('🔴 la liste DIT laquelle est signalée à la main : l’écran en a besoin pour savoir quoi proposer', async () => {
    // Sur une conversation signalée par le MODÈLE, un bouton « ne plus signaler » n'aurait aucun effet
    // visible, et l'opérateur cliquerait deux fois avant de conclure que l'écran est cassé.
    const par = new Map((await store.listConversations(tenantId, { signalees: true })).map((x) => [x.id, x.signaleeMain]));
    expect(par.get(parIA)).toBe(false);
    expect(par.get(parHumain)).toBe(true);
    expect(par.get(parLesDeux)).toBe(true);
  });

  it('🔴 une RÉ-ANALYSE n’efface PAS un signalement humain', async () => {
    // La raison d'être de la colonne séparée. Écrit dans `abusive`, le signalement disparaîtrait ici.
    await analyseAbusive(parLesDeux, false); // le modèle change d'avis
    const liste = await store.listConversations(tenantId, { signalees: true });
    expect(liste.map((x) => x.id)).toContain(parLesDeux);
    await analyseAbusive(parLesDeux, true); // on remet la fixture d'aplomb
  });

  it('désignaler retire du dossier ET efface l’auteur', async () => {
    // Garder le nom de celui qui avait signalé une conversation qui ne l'est plus laisserait croire à un
    // signalement toujours actif.
    expect(await store.signalerConversation(tenantId, parHumain, false, null)).toBe(true);
    const r = await pool.query<{ signalee_le: Date | null; signalee_par: string | null }>(
      'select signalee_le, signalee_par from conversations where id = $1', [parHumain],
    );
    expect(r.rows[0]).toEqual({ signalee_le: null, signalee_par: null });
    expect((await store.compterConversations(tenantId)).signalees).toBe(2);
    await store.signalerConversation(tenantId, parHumain, true, operateur); // fixture remise d'aplomb
  });

  it('une conversation d’un AUTRE espace ne se signale pas', async () => {
    expect(await store.signalerConversation('00000000-0000-4000-8000-000000000000', parHumain, true, operateur)).toBe(false);
  });
});
