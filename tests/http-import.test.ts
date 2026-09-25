import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { ContactStore, ContactUpsert, LotContacts } from '../src/crm/import';
import type { UserFieldStore } from '../src/crm/fields';
import type { UserFieldDef } from '../src/crm/types';

const SECRET = 'test-secret';
let token = '';
let agentToken = '';
beforeAll(async () => {
  token = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentToken = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const auth = () => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });
const asAgent = () => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${agentToken}` } });

class FakeContacts implements ContactStore {
  readonly upserts: ContactUpsert[] = [];
  /** Nombre de lots recus : un import ne doit plus faire une requete par ligne (R9). */
  lots = 0;
  async upsertManyByPhone(lot: LotContacts): Promise<Array<'created' | 'updated'>> {
    this.lots += 1;
    for (const c of lot.contacts) {
      this.upserts.push({
        tenantId: lot.tenantId,
        phoneE164: c.phoneE164,
        profileName: c.profileName,
        fields: c.fields,
        optInStatus: lot.optInStatus,
        ...(lot.optInSource ? { optInSource: lot.optInSource } : {}),
        ...(lot.tags ? { tags: lot.tags } : {}),
      });
    }
    return lot.contacts.map(() => 'created');
  }
}
class FakeFields implements UserFieldStore {
  readonly defs: UserFieldDef[] = [];
  async list(): Promise<UserFieldDef[]> {
    return this.defs;
  }
  async upsert(_tenantId: string, def: UserFieldDef): Promise<void> {
    this.defs.push(def);
  }
}

// Capture des appels de requête filtrée (pour asserter le parsing des query params -> ContactFilters + le
// routage query vs list). Partagé par les tests qui en ont besoin via un objet passé à inject.
type QueryCapture = { queryFilters: unknown[]; countFilters: unknown[]; idsFilters: unknown[] };

/** Trace d'audit telle que la route l'écrit. `journal` est fourni par les tests qui l'observent. */
interface Trace { action: string; target: { kind: string; id: string }; detail: Record<string, unknown>; actor: { userId: string | null } }

function inject(contacts: ContactStore, userFields: UserFieldStore, cap?: QueryCapture, journal?: Trace[]) {
  return buildServer({
    queue: new FakeQueue(),
    auth: { users: noUsers, secret: SECRET },
    import: {
      contacts,
      userFields,
      listContacts: async () => [
        { id: 'c1', phoneE164: '+33611111111', bsuid: null, externalId: null, profileName: 'Julie', optInStatus: 'opted_in', fields: { ville: 'Lyon' }, tags: ['salon-2026'], createdAt: '2026-07-05T00:00:00.000Z', blockedAt: null, whatsappJoignable: null, whatsappJoignableLe: null, risque: null },
      ],
      queryContacts: async (_t, filters) => { cap?.queryFilters.push(filters); return [
        { id: 'c2', phoneE164: '+33612345678', bsuid: null, externalId: null, profileName: 'Marc', optInStatus: 'opted_in', fields: { ville: 'Paris' }, tags: ['vip'], createdAt: '2026-07-06T00:00:00.000Z', blockedAt: null, whatsappJoignable: null, whatsappJoignableLe: null, risque: null },
      ]; },
      countContacts: async (_t, filters) => { cap?.countFilters.push(filters); return 3; },
      contactIdsForFilters: async (_t, filters) => { cap?.idsFilters.push(filters); return ['c2', 'c3']; },
      ...(journal ? { audit: async (_t: string, actor: { userId: string | null }, action: string, target: { kind: string; id: string }, detail: Record<string, unknown> = {}) => { journal.push({ action, target, detail, actor }); } } : {}),
    },
  });
}

describe('POST /tenants/:tenantId/contacts/import', () => {
  it('parse le CSV, reconnaît les colonnes, upsert les contacts opt-in', async () => {
    const contacts = new FakeContacts();
    const app = inject(contacts, new FakeFields());
    const res = await app.inject({
      method: 'POST',
      url: '/tenants/t1/contacts/import',
      ...auth(),
      payload: { csv: 'Nom,Téléphone,Ville\nJulie,+33611111111,Lyon\nMarc,0622222222,Paris', optIn: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ created: number; skipped: number }>();
    expect(body.created).toBe(2);
    expect(contacts.upserts).toHaveLength(2);
    expect(contacts.upserts[0]?.optInStatus).toBe('opted_in');
    expect(contacts.upserts[0]?.phoneE164).toBe('+33611111111');
    expect(contacts.upserts[1]?.phoneE164).toBe('+33622222222'); // normalisé FR
    expect(contacts.upserts[0]?.fields).toMatchObject({ ville: 'Lyon' }); // colonne custom
    await app.close();
  });

  it('POST /import/preview -> colonnes + mapping suggéré (sans écrire)', async () => {
    const contacts = new FakeContacts();
    const app = inject(contacts, new FakeFields());
    const res = await app.inject({
      method: 'POST',
      url: '/tenants/t1/contacts/import/preview',
      ...auth(),
      payload: { csv: 'Nom,Téléphone,Ville\nJulie,+33611111111,Lyon' },
    });
    expect(res.statusCode).toBe(200);
    const b = res.json<{ headers: string[]; rowCount: number; mapping: { columns: Record<string, { target: string }> } }>();
    expect(b.headers).toEqual(['Nom', 'Téléphone', 'Ville']);
    expect(b.rowCount).toBe(1);
    expect(b.mapping.columns['Téléphone']?.target).toBe('phone');
    expect(b.mapping.columns['Nom']?.target).toBe('name');
    expect(b.mapping.columns['Ville']?.target).toBe('custom');
    expect(contacts.upserts).toHaveLength(0); // aperçu = zéro écriture
    await app.close();
  });

  it('mapping explicite respecté (une colonne forcée en Ignorer)', async () => {
    const contacts = new FakeContacts();
    const app = inject(contacts, new FakeFields());
    const res = await app.inject({
      method: 'POST',
      url: '/tenants/t1/contacts/import',
      ...auth(),
      payload: {
        csv: 'A,B,C\nJulie,+33611111111,secret',
        optIn: true,
        mapping: { columns: { A: { target: 'name' }, B: { target: 'phone' }, C: { target: 'ignore' } } },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(contacts.upserts[0]?.profileName).toBe('Julie');
    expect(contacts.upserts[0]?.phoneE164).toBe('+33611111111');
    expect(contacts.upserts[0]?.fields).toEqual({}); // C ignorée
    await app.close();
  });

  it('sans token -> 401', async () => {
    const app = inject(new FakeContacts(), new FakeFields());
    const res = await app.inject({
      method: 'POST',
      url: '/tenants/t1/contacts/import',
      headers: { 'content-type': 'application/json' },
      payload: { csv: 'Tel\n+33611111111' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('GET liste des contacts du tenant -> 200', async () => {
    const app = inject(new FakeContacts(), new FakeFields());
    const res = await app.inject({ method: 'GET', url: '/tenants/t1/contacts', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ contacts: Array<{ profileName: string }> }>();
    expect(body.contacts[0]?.profileName).toBe('Julie');
    await app.close();
  });

  it('GET contacts sans token -> 401', async () => {
    const app = inject(new FakeContacts(), new FakeFields());
    const res = await app.inject({ method: 'GET', url: '/tenants/t1/contacts' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('GET contacts AVEC filtres -> route sur queryContacts (+ total), pas listContacts', async () => {
    const cap: QueryCapture = { queryFilters: [], countFilters: [], idsFilters: [] };
    const app = inject(new FakeContacts(), new FakeFields(), cap);
    const res = await app.inject({
      method: 'GET',
      url: '/tenants/t1/contacts?tags=vip,pro&tagMode=or&optIn=opted_in&phonePrefix=%2B336&phoneContains=12%2034&nameSearch=mar&fields=' + encodeURIComponent('[{"key":"ville","op":"contains","value":"par"}]'),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ contacts: Array<{ profileName: string }>; total: number }>();
    expect(body.contacts[0]?.profileName).toBe('Marc'); // vient de queryContacts, pas de listContacts (Julie)
    expect(body.total).toBe(3);
    expect(cap.queryFilters).toHaveLength(1);
    // Le parsing des query params -> ContactFilters typés.
    expect(cap.queryFilters[0]).toEqual({
      tags: ['vip', 'pro'], tagMode: 'or', optIn: 'opted_in', phonePrefix: '+336', phoneContains: '12 34', nameSearch: 'mar',
      fieldFilters: [{ key: 'ville', op: 'contains', value: 'par' }],
    });
    await app.close();
  });

  it('GET /contacts/count et /contacts/ids -> compteur + ids résolus par filtres', async () => {
    const cap: QueryCapture = { queryFilters: [], countFilters: [], idsFilters: [] };
    const app = inject(new FakeContacts(), new FakeFields(), cap);
    const count = await app.inject({ method: 'GET', url: '/tenants/t1/contacts/count?tags=vip', headers: { authorization: `Bearer ${token}` } });
    expect(count.statusCode).toBe(200);
    expect(count.json<{ total: number }>().total).toBe(3);
    expect(cap.countFilters[0]).toEqual({ tags: ['vip'] });
    const ids = await app.inject({ method: 'GET', url: '/tenants/t1/contacts/ids?optIn=opted_out', headers: { authorization: `Bearer ${token}` } });
    expect(ids.statusCode).toBe(200);
    expect(ids.json<{ ids: string[] }>().ids).toEqual(['c2', 'c3']);
    expect(cap.idsFilters[0]).toEqual({ optIn: 'opted_out' });
    await app.close();
  });

  it('GET contacts?risque=eleve -> chemin requêtable, avec le niveau (un critère oublié dans hasFilters ne filtrerait RIEN)', async () => {
    const cap: QueryCapture = { queryFilters: [], countFilters: [], idsFilters: [] };
    const app = inject(new FakeContacts(), new FakeFields(), cap);
    const res = await app.inject({ method: 'GET', url: '/tenants/t1/contacts?risque=eleve', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ contacts: Array<{ profileName: string }> }>().contacts[0]?.profileName).toBe('Marc');
    expect(cap.queryFilters).toEqual([{ risque: 'eleve' }]);
    expect(cap.countFilters).toEqual([{ risque: 'eleve' }]);
    await app.close();
  });

  it('🔴 un niveau de risque INCONNU est REFUSÉ en 400 sur la liste, le compte et les identifiants, jamais ignoré', async () => {
    // Ignoré, il ne poserait aucune clause : « élevé » mal écrit rendrait TOUT l'espace, et le compteur
    // annoncerait tout l'espace comme audience d'une campagne « risque élevé ».
    const cap: QueryCapture = { queryFilters: [], countFilters: [], idsFilters: [] };
    const app = inject(new FakeContacts(), new FakeFields(), cap);
    for (const url of ['/tenants/t1/contacts?risque=%C3%A9lev%C3%A9', '/tenants/t1/contacts/count?risque=high', '/tenants/t1/contacts/ids?risque=critique']) {
      const res = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode, url).toBe(400);
      expect(res.json<{ error: string }>().error, url).toMatch(/risque/);
    }
    expect(cap).toEqual({ queryFilters: [], countFilters: [], idsFilters: [] });
    await app.close();
  });

  it('GET contacts filtre de champ ILLISIBLE -> ignoré (pas de 500), retombe sur listContacts', async () => {
    const cap: QueryCapture = { queryFilters: [], countFilters: [], idsFilters: [] };
    const app = inject(new FakeContacts(), new FakeFields(), cap);
    const res = await app.inject({ method: 'GET', url: '/tenants/t1/contacts?fields=pas-du-json', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    // Aucun filtre valide -> chemin historique listContacts (Julie), queryContacts jamais appelé.
    expect(res.json<{ contacts: Array<{ profileName: string }> }>().contacts[0]?.profileName).toBe('Julie');
    expect(cap.queryFilters).toHaveLength(0);
    await app.close();
  });

  it('GET contacts/count d un autre tenant -> 403', async () => {
    const app = inject(new FakeContacts(), new FakeFields());
    const res = await app.inject({ method: 'GET', url: '/tenants/AUTRE/contacts/count', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('token d un autre tenant -> 403', async () => {
    const contacts = new FakeContacts();
    const app = inject(contacts, new FakeFields());
    const res = await app.inject({
      method: 'POST',
      url: '/tenants/AUTRE/contacts/import',
      ...auth(),
      payload: { csv: 'Tel\n+33611111111' },
    });
    expect(res.statusCode).toBe(403);
    expect(contacts.upserts).toHaveLength(0);
    await app.close();
  });

  it('csv absent -> 400', async () => {
    const app = inject(new FakeContacts(), new FakeFields());
    const res = await app.inject({ method: 'POST', url: '/tenants/t1/contacts/import', ...auth(), payload: {} });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('mapping malformé (sans columns) -> 400, pas de 500', async () => {
    const app = inject(new FakeContacts(), new FakeFields());
    const res = await app.inject({
      method: 'POST',
      url: '/tenants/t1/contacts/import',
      ...auth(),
      payload: { csv: 'Tel\n+33611111111', mapping: { foo: 'bar' } },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('optIn: false explicite -> statut unknown (le defaut opt-in de la route ne l’ecrase pas)', async () => {
    const contacts = new FakeContacts();
    const app = inject(contacts, new FakeFields());
    const res = await app.inject({
      method: 'POST',
      url: '/tenants/t1/contacts/import',
      ...auth(),
      payload: { csv: 'Téléphone\n+33611111111', optIn: false },
    });
    expect(res.statusCode).toBe(200);
    expect(contacts.upserts[0]?.optInStatus).toBe('unknown');
    await app.close();
  });

  // RBAC (Feature 2) : les contacts (PII : téléphones E164, opt-in) sont réservés aux admins.
  // L'agent (inbox uniquement) doit être refusé (403) AVANT tout accès au store.
  describe('RBAC — agent refusé sur contacts/import', () => {
    it('GET /contacts agent -> 403', async () => {
      const app = inject(new FakeContacts(), new FakeFields());
      const res = await app.inject({ method: 'GET', url: '/tenants/t1/contacts', ...asAgent() });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it('POST /import agent -> 403 (aucune écriture)', async () => {
      const contacts = new FakeContacts();
      const app = inject(contacts, new FakeFields());
      const res = await app.inject({ method: 'POST', url: '/tenants/t1/contacts/import', ...asAgent(), payload: { csv: 'Tel\n+33611111111', optIn: true } });
      expect(res.statusCode).toBe(403);
      expect(contacts.upserts).toHaveLength(0); // court-circuit au preHandler, store intact
      await app.close();
    });

    it('POST /import/preview agent -> 403', async () => {
      const app = inject(new FakeContacts(), new FakeFields());
      const res = await app.inject({ method: 'POST', url: '/tenants/t1/contacts/import/preview', ...asAgent(), payload: { csv: 'Tel\n+33611111111' } });
      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });
});

describe('journal d’audit de l’import', () => {
  // Littéral multi-ligne : le CSV porte de vrais sauts de ligne, comme le corps réel de la requête.
  const csv = `Nom,Téléphone
Julie,+33611111111
Marc,0622222222`;

  it('🔴 un import laisse UNE trace pour le LOT, jamais une par contact', async () => {
    // Un import de 50 000 lignes écrirait 50 000 entrées et noierait l'historique qu'on cherche à rendre
    // lisible. C'est aussi la principale façon dont des personnes entrent dans la base : sans trace, personne
    // ne peut dire d'où vient un contact ni qui l'a chargé.
    const journal: Trace[] = [];
    const app = inject(new FakeContacts(), new FakeFields(), undefined, journal);
    const res = await app.inject({ method: 'POST', url: '/tenants/t1/contacts/import', ...auth(), payload: { csv, optIn: true, tags: 'salon' } });
    expect(res.statusCode).toBe(200);
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({
      action: 'contact.imported',
      target: { kind: 'contact', id: 'lot' },
      detail: { created: 2, updated: 0, skipped: 0, optIn: true, tags: 1 },
      actor: { userId: 'u1' },
    });
    await app.close();
  });

  it('🔴 la trace ne porte AUCUN numéro ni nom, seulement des compteurs', async () => {
    const journal: Trace[] = [];
    const app = inject(new FakeContacts(), new FakeFields(), undefined, journal);
    await app.inject({ method: 'POST', url: '/tenants/t1/contacts/import', ...auth(), payload: { csv, optIn: true } });
    const serialise = JSON.stringify(journal);
    expect(serialise).not.toMatch(/[0-9]{9,}/); // aucun numéro, sous aucune forme
    expect(serialise.toLowerCase()).not.toContain('julie');
    await app.close();
  });

  it('🔴 corps SANS `optIn` -> import OPT-IN, et le journal le dit', async () => {
    // L'écran d'import a sa case pré-cochée et envoie toujours le booléen, donc ce défaut ne se voit pas
    // depuis l'interface. Il compte quand même : un appel qui omet le champ chargerait sinon une liste entière
    // que le garde-fou de campagne écarte ensuite du marketing (il exige un opt-in EXPLICITE), en silence.
    const journal: Trace[] = [];
    const contacts = new FakeContacts();
    const app = inject(contacts, new FakeFields(), undefined, journal);
    await app.inject({ method: 'POST', url: '/tenants/t1/contacts/import', ...auth(), payload: { csv } });
    expect(contacts.upserts.every((c) => c.optInStatus === 'opted_in')).toBe(true);
    expect(journal[0]?.detail).toMatchObject({ optIn: true });
    await app.close();
  });

  it('🔴 `optIn: false` explicite reste respecté : le défaut ne l’écrase pas', async () => {
    const journal: Trace[] = [];
    const contacts = new FakeContacts();
    const app = inject(contacts, new FakeFields(), undefined, journal);
    await app.inject({ method: 'POST', url: '/tenants/t1/contacts/import', ...auth(), payload: { csv, optIn: false } });
    expect(contacts.upserts.every((c) => c.optInStatus === 'unknown')).toBe(true);
    expect(journal[0]?.detail).toMatchObject({ optIn: false });
    await app.close();
  });

  it('un CSV REFUSÉ ne laisse aucune trace', async () => {
    const journal: Trace[] = [];
    const app = inject(new FakeContacts(), new FakeFields(), undefined, journal);
    expect((await app.inject({ method: 'POST', url: '/tenants/t1/contacts/import', ...auth(), payload: { csv: '' } })).statusCode).toBe(400);
    expect(journal).toEqual([]);
    await app.close();
  });
});

/**
 * Le mur du volume (AUDIT-SCALE-2026-08-25.md, R9). Le plafond de corps GLOBAL est de 1 Mo et la route
 * d'import ne le relevait pas : au-delà d'environ 14 000 lignes, l'opérateur recevait un 413 au message
 * anglais brut de Fastify, sans savoir quoi faire. Deux garanties ici : la route d'import accepte
 * beaucoup plus que le plafond global, et le refus, quand il tombe, est en français et dit l'issue.
 */
describe('import : plafond de corps dédié et refus lisible', () => {
  /** CSV synthétique d'environ `mo` mégaoctets (en-tête + lignes de ~40 caractères). */
  function gros(mo: number): string {
    const lignes = ['Nom,Telephone'];
    for (let i = 0; lignes.length * 26 < mo * 1024 * 1024; i += 1) {
      lignes.push(`Nom${String(i).padStart(7, '0')},+336${String(i).padStart(8, '0')}`);
    }
    return lignes.join('\n');
  }

  it('CSV de 2 Mo -> importé (le plafond global de 1 Mo ne s\'applique plus à cette route)', async () => {
    const contacts = new FakeContacts();
    const app = inject(contacts, new FakeFields());
    const res = await app.inject({
      method: 'POST',
      url: '/tenants/t1/contacts/import',
      ...auth(),
      payload: { csv: gros(2), optIn: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ created: number }>().created).toBeGreaterThan(50_000);
    // Et l'écriture reste groupée : des dizaines de milliers de lignes, quelques centaines de requêtes.
    expect(contacts.lots).toBeLessThan(200);
    await app.close();
  });

  it('corps qui dépasse le plafond de l\'aperçu -> 413 avec un message EN FRANÇAIS qui dit quoi faire', async () => {
    const app = inject(new FakeContacts(), new FakeFields());
    const res = await app.inject({
      method: 'POST',
      url: '/tenants/t1/contacts/import/preview',
      ...auth(),
      payload: { csv: gros(3) },
    });
    expect(res.statusCode).toBe(413);
    const message = res.json<{ error: string }>().error;
    expect(message).toContain('trop volumineux');
    expect(message).toContain('Découpe');
    expect(message).not.toContain('body'); // plus le « Request body is too large » de Fastify
    await app.close();
  });
});
