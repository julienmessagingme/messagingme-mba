import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgInboxStore } from '../../src/inbox/store.pg';
import { PgTraductionStore } from '../../src/traduction/traduire.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * LE STOCKAGE DE LA TRADUCTION (migration 0137), contre une vraie base.
 *
 * 🔴 CE QUE CE FICHIER PROUVE, ET POURQUOI IL EST EN INTEGRATION. Le sujet n'est pas du TypeScript :
 * c'est le SENS de deux colonnes qui s'inverse selon la direction du message, plus une contrainte
 * `check` que seul Postgres applique. Un faux store rendrait ce qu'on lui fait rendre et ne pourrait
 * par construction rien prouver de tout ca.
 *
 * ⚠️ Jamais joue en local (le `DATABASE_URL` local pointe la PRODUCTION), joue par le job
 * `integration` sur un Postgres jetable.
 */
describe.skipIf(!url)('traduction : ce qu\'on garde, et de quel cote (Postgres)', () => {
  let pool: Pool;
  let tenantId = '';
  let contactId = '';
  let conversationId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 3 });
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-traduction') returning id`)).rows[0]!.id;
    contactId = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164) values ($1, '+33600009137') returning id`,
      [tenantId],
    )).rows[0]!.id;
    conversationId = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, contact_id, last_message_at)
       values ($1, '33600009137', $2, now()) returning id`,
      [tenantId, contactId],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]).catch(() => {});
    await pool.end().catch(() => {});
  });

  it('un entrant garde l original dans body et la lecture dans traduction', async () => {
    const id = (await pool.query<{ id: string }>(
      `insert into conversation_messages (conversation_id, direction, type, body, traduction, traduction_langue)
       values ($1, 'in', 'text', 'Hola, tengo un problema', 'Bonjour, j ai un probleme', 'fr') returning id`,
      [conversationId],
    )).rows[0]!.id;
    const r = (await pool.query<{ body: string; traduction: string; traduction_langue: string; redaction_origine: string | null }>(
      `select body, traduction, traduction_langue, redaction_origine from conversation_messages where id = $1`,
      [id],
    )).rows[0]!;
    // Ce que le client a ECRIT : c'est lui qui fait foi, et il n'est jamais remplace.
    expect(r.body).toBe('Hola, tengo un problema');
    // Notre lecture, A COTE, avec la langue dans laquelle elle est.
    expect(r.traduction).toBe('Bonjour, j ai un probleme');
    expect(r.traduction_langue).toBe('fr');
    // ⚠️ Le sens INVERSE dans la meme ligne : un entrant n'a AUCUNE redaction d'operateur.
    expect(r.redaction_origine).toBeNull();
  });

  // 🔴 LE CAS INVERSE, celui qu'on oublie : en sortie, body porte le TRADUIT.
  it('un sortant garde le traduit dans body et l original de l operateur a part', async () => {
    const id = (await pool.query<{ id: string }>(
      `insert into conversation_messages (conversation_id, direction, type, body, redaction_origine, origin)
       values ($1, 'out', 'text', 'Hello, how can I help?', 'Bonjour, comment puis-je aider ?', 'humain') returning id`,
      [conversationId],
    )).rows[0]!.id;
    const r = (await pool.query<{ body: string; redaction_origine: string; traduction: string | null }>(
      `select body, redaction_origine, traduction from conversation_messages where id = $1`,
      [id],
    )).rows[0]!;
    // Ce qui est PARTI. Notre trace doit correspondre a ce que le client a recu, le jour d'un litige.
    expect(r.body).toBe('Hello, how can I help?');
    // Ce que l'operateur a ECRIT, sans quoi il ne peut plus se relire.
    expect(r.redaction_origine).toBe('Bonjour, comment puis-je aider ?');
    // ⚠️ `traduction` reste VIDE sur un sortant : sa traduction est deja dans `body`. L'y recopier
    // ferait deux verites pour la meme phrase, et rien ne dirait laquelle relire.
    expect(r.traduction).toBeNull();
  });

  it('🔴 la langue de traduction est BORNEE a nos deux langues de console', async () => {
    // Le sens qui fait mordre la contrainte : 'es' est une langue parfaitement valide pour un
    // CONTACT, et c'est exactement pour ca qu'il faut verifier qu'elle est refusee ICI. Une
    // traduction rangee en 'es' ne serait jamais reconnue comme « deja traduit » par le fil, qui
    // demande 'fr' ou 'en' : on repaierait la meme traduction a chaque ouverture, en silence.
    await expect(pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, traduction, traduction_langue)
       values ($1, 'in', 'text', 'Hola', 'Hello', 'es')`,
      [conversationId],
    )).rejects.toThrow(/traduction_langue/);
  });

  it('la langue d une transcription, elle, n est PAS bornee', async () => {
    // Le miroir du test precedent, et sans lui on croirait la regle uniforme : ce sont NOS langues
    // qui sont bornees, pas celles du contact. Un vocal en espagnol se transcrit en espagnol.
    const id = (await pool.query<{ id: string }>(
      `insert into conversation_messages (conversation_id, direction, type, body, transcription, transcription_langue, traduction, traduction_langue)
       values ($1, 'in', 'audio', '[audio]', 'Hola, tengo un problema', 'es', 'Bonjour, j ai un probleme', 'fr') returning id`,
      [conversationId],
    )).rows[0]!.id;
    const r = (await pool.query<{ body: string; transcription: string; transcription_langue: string; traduction: string }>(
      `select body, transcription, transcription_langue, traduction from conversation_messages where id = $1`,
      [id],
    )).rows[0]!;
    // Les TROIS coexistent, et chacune dit autre chose : le libelle du media, ce qui a ete DIT, et
    // notre lecture de ce qui a ete dit.
    expect(r.body).toBe('[audio]');
    expect(r.transcription).toBe('Hola, tengo un problema');
    expect(r.transcription_langue).toBe('es');
    expect(r.traduction).toBe('Bonjour, j ai un probleme');
  });

  it('la langue du contact s ecrit avec sa DATE, et part avec l espace', async () => {
    await pool.query(
      `update contacts set langue_detectee = 'es', langue_detectee_le = now() where tenant_id = $1 and id = $2`,
      [tenantId, contactId],
    );
    const r = (await pool.query<{ langue_detectee: string; langue_detectee_le: Date }>(
      `select langue_detectee, langue_detectee_le from contacts where id = $1`,
      [contactId],
    )).rows[0]!;
    expect(r.langue_detectee).toBe('es');
    // ⚠️ La date n'est pas decorative : le cadrage previent que cette langue peut etre FAUSSE une
    // fois (un francophone qui repond « ok »). Une mesure sans age ne se corrige pas, elle se subit.
    expect(r.langue_detectee_le).toBeInstanceOf(Date);
  });
});

/**
 * LE MEME STOCKAGE, MAIS PAR LE VRAI CODE.
 *
 * ⚠️ Le bloc du dessus prouve la MIGRATION avec du SQL ecrit a la main : il ne dit rien de ce que le
 * produit lit reellement. Un `select` qui oublierait une des colonnes rendrait `undefined` la ou
 * l'ecran attend une valeur, et tous les tests ci-dessus resteraient verts. Ce bloc-ci execute donc
 * les requetes du CHEMIN CHAUD (`PgInboxStore.getMessages`, `getConversationContext`) et les deux
 * ecritures de `PgTraductionStore`.
 */
describe.skipIf(!url)('traduction : le chemin chaud, par le vrai code (Postgres)', () => {
  let pool: Pool;
  let store: PgInboxStore;
  let traductions: PgTraductionStore;
  let tenantId = '';
  let autreTenantId = '';
  let contactId = '';
  let conversationId = '';
  let entrantId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 3 });
    store = new PgInboxStore(pool);
    traductions = new PgTraductionStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-traduction-code') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-traduction-voisin') returning id`)).rows[0]!.id;
    contactId = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164) values ($1, '+33600009138') returning id`,
      [tenantId],
    )).rows[0]!.id;
    conversationId = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, contact_id, last_message_at)
       values ($1, '33600009138', $2, now()) returning id`,
      [tenantId, contactId],
    )).rows[0]!.id;
    entrantId = (await pool.query<{ id: string }>(
      `insert into conversation_messages (conversation_id, direction, type, body, created_at)
       values ($1, 'in', 'text', 'Hola, tengo un problema', now()) returning id`,
      [conversationId],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    for (const id of [tenantId, autreTenantId]) {
      if (id) await pool.query('delete from tenants where id = $1', [id]).catch(() => {});
    }
    await pool.end().catch(() => {});
  });

  it('le fil rend les quatre colonnes, a null plutot qu absentes', async () => {
    const [m] = await store.getMessages(conversationId);
    expect(m).toBeDefined();
    // `null`, PAS `undefined` : la nuance decide de tout cote ecran, ou `undefined` se lit « champ
    // inconnu de ce serveur » et `null` se lit « rien de range ».
    expect(m!.traduction).toBeNull();
    expect(m!.traductionLangue).toBeNull();
    expect(m!.redactionOrigine).toBeNull();
    expect(m!.transcriptionLangue).toBeNull();
  });

  it('ranger une traduction la fait ressortir par le fil', async () => {
    await traductions.ranger(tenantId, conversationId, [
      { messageId: entrantId, texte: 'Bonjour, j ai un probleme', langue: 'fr' },
    ]);
    const [m] = await store.getMessages(conversationId);
    expect(m!.body).toBe('Hola, tengo un problema');
    expect(m!.traduction).toBe('Bonjour, j ai un probleme');
    expect(m!.traductionLangue).toBe('fr');
  });

  it('🔴 un AUTRE espace n ecrit rien, et c est le seul controle d isolation qu il y ait', async () => {
    // `conversation_messages` ne porte pas de `tenant_id` : sans la jointure sur `conversations`, un
    // identifiant de message devine permettrait d ecrire dans le fil d un autre client. La RLS est
    // contournee (pooler superuser), donc ce filtre est le seul controle.
    await traductions.ranger(autreTenantId, conversationId, [
      { messageId: entrantId, texte: 'TEXTE DU VOISIN', langue: 'en' },
    ]);
    const [m] = await store.getMessages(conversationId);
    expect(m!.traduction).toBe('Bonjour, j ai un probleme');
    expect(m!.traductionLangue).toBe('fr');
  });

  it('la langue du contact s apprend, et le contexte de conversation la rend', async () => {
    await traductions.apprendreLangueContact(tenantId, conversationId, 'es');
    const ctx = await store.getConversationContext(conversationId, tenantId);
    expect(ctx?.langueContact).toBe('es');
  });

  it('🔴 et un AUTRE espace ne peut pas la reecrire', async () => {
    await traductions.apprendreLangueContact(autreTenantId, conversationId, 'de');
    const r = (await pool.query<{ langue_detectee: string }>(
      'select langue_detectee from contacts where id = $1', [contactId],
    )).rows[0]!;
    expect(r.langue_detectee).toBe('es');
  });

  it('un contexte de conversation SANS contact rend null, pas undefined', async () => {
    // Le cas d un fil cree avant que le contact ne soit rattache : l ecran doit pouvoir distinguer
    // « on ne sait pas encore » d un champ que ce serveur ignore.
    const orpheline = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, last_message_at) values ($1, '33600009139', now()) returning id`,
      [tenantId],
    )).rows[0]!.id;
    const ctx = await store.getConversationContext(orpheline, tenantId);
    expect(ctx).not.toBeNull();
    expect(ctx!.langueContact).toBeNull();
  });
});
