import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, AuthUser } from '../src/auth/store';
import type { ContactsRouteDeps } from '../src/http/contacts';
import type { ContactRow, BulkTarget, BulkEdits } from '../src/crm/contact-store.pg';
import type { UserFieldDef } from '../src/crm/types';

const SECRET = 'test-secret';
let adminTok = '';
let agentTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findByEmail: async (): Promise<AuthUser | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

const CONTACT: ContactRow = {
  id: 'c1', phoneE164: '+33611', bsuid: null, profileName: 'Marc', optInStatus: 'opted_in',
  fields: { prenom: 'Marc' }, tags: ['vip'], createdAt: '2026-07-10T00:00:00.000Z',
};
const FIELDS: UserFieldDef[] = [
  { key: 'prenom', label: 'Prénom', type: 'text' },
  { key: 'age', label: 'Âge', type: 'number' },
  { key: 'date_rdv', label: 'Date RDV', type: 'date' },
  { key: 'consent', label: 'Consentement', type: 'boolean' },
];

interface Cap {
  merged: Array<Record<string, string>>; added: string[][]; removed: string[][]; removedFields: string[][]; names: Array<string | null>;
  bulk: Array<{ target: BulkTarget; edits: BulkEdits }>; deleted: BulkTarget[];
  /** Émissions « tag ajouté » vers la file d'automation (E.2) : doit rester VIDE sur les chemins de masse. */
  emitted: string[][];
}

function app(over: Partial<ContactsRouteDeps> = {}, opts: { contact?: ContactRow | null } = {}) {
  const cap: Cap = { merged: [], added: [], removed: [], removedFields: [], names: [], bulk: [], deleted: [], emitted: [] };
  const deps: ContactsRouteDeps = {
    applyEdits: async (_t, _id, edits) => {
      const result = opts.contact === undefined ? CONTACT : opts.contact;
      if (result === null) return null; // contact inconnu -> transaction rollback, aucune écriture
      if (Object.keys(edits.fields).length) cap.merged.push(edits.fields);
      if (edits.addTags.length) cap.added.push(edits.addTags);
      if (edits.removeTags.length) cap.removed.push(edits.removeTags);
      if (edits.removeFields && edits.removeFields.length) cap.removedFields.push(edits.removeFields);
      if (edits.profileName !== undefined) cap.names.push(edits.profileName);
      // Le store ne renvoie que les tags RÉELLEMENT nouveaux : ici, ceux qui ne sont pas déjà sur la fiche.
      return { contact: result, addedTags: edits.addTags.filter((t) => !result.tags.includes(t)) };
    },
    applyEditsMany: async (_t, target, edits) => { cap.bulk.push({ target, edits }); return 3; },
    listUserFields: async () => FIELDS,
    getContactHistory: async () => ({ sends: [], conversations: [] }),
    listSendsForExport: async () => [],
    emitTagAdded: async (_t, _id, tags) => { cap.emitted.push(tags); },
    ...over,
  };
  return { server: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, contacts: deps }), cap };
}

describe('routes contacts — édition fiche', () => {
  it('PATCH champ connu + valeur valide -> 200, mergeFields appelé, renvoie le contact', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(adminTok), payload: { fields: { age: '42' } } });
    expect(res.statusCode).toBe(200);
    expect(cap.merged).toEqual([{ age: '42' }]);
    expect(res.json<{ contact: { id: string } }>().contact.id).toBe('c1');
    await server.close();
  });

  it('PATCH champ INCONNU -> 400', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(adminTok), payload: { fields: { inexistant: 'x' } } });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('PATCH valeur invalide pour le type (age=abc) -> 400', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(adminTok), payload: { fields: { age: 'abc' } } });
    expect(res.statusCode).toBe(400);
    expect(cap.merged).toHaveLength(0); // rien écrit
    await server.close();
  });

  it('PATCH date mal formée -> 400', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(adminTok), payload: { fields: { date_rdv: '01/08/2026' } } });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('PATCH champ booléen : « oui » -> stocké canonique « true » (pas la saisie brute)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(adminTok), payload: { fields: { consent: 'oui' } } });
    expect(res.statusCode).toBe(200);
    expect(cap.merged).toEqual([{ consent: 'true' }]);
    await server.close();
  });

  it('PATCH champ booléen : « 0 » -> canonique « false » ; valeur non booléenne -> 400', async () => {
    const ok = app();
    const rOk = await ok.server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(adminTok), payload: { fields: { consent: '0' } } });
    expect(rOk.statusCode).toBe(200);
    expect(ok.cap.merged).toEqual([{ consent: 'false' }]);
    await ok.server.close();
    const ko = app();
    const rKo = await ko.server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(adminTok), payload: { fields: { consent: 'peut-être' } } });
    expect(rKo.statusCode).toBe(400);
    expect(ko.cap.merged).toHaveLength(0);
    await ko.server.close();
  });

  it('PATCH addTags + removeTags -> 200, les deux appelés', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(adminTok), payload: { addTags: ['prospect'], removeTags: ['vip'] } });
    expect(res.statusCode).toBe(200);
    expect(cap.added).toEqual([['prospect']]);
    expect(cap.removed).toEqual([['vip']]);
    await server.close();
  });

  it('PATCH vide (rien à modifier) -> 400', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(adminTok), payload: {} });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('PATCH removeFields (clé connue) -> 200, suppression transmise', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(adminTok), payload: { removeFields: ['prenom'] } });
    expect(res.statusCode).toBe(200);
    expect(cap.removedFields).toEqual([['prenom']]);
    await server.close();
  });

  it('PATCH removeFields accepte une clé SANS définition (champ orphelin, doit rester supprimable)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(adminTok), payload: { removeFields: ['metier_orphelin'] } });
    expect(res.statusCode).toBe(200);
    expect(cap.removedFields).toEqual([['metier_orphelin']]);
    await server.close();
  });

  it('PATCH removeFields vide (que des espaces) -> 400 (rien à modifier)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(adminTok), payload: { removeFields: ['  ', ''] } });
    expect(res.statusCode).toBe(400);
    expect(cap.removedFields).toHaveLength(0);
    await server.close();
  });

  it('PATCH profileName (Nom) -> 200, transmis', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(adminTok), payload: { profileName: 'Marc Dupont' } });
    expect(res.statusCode).toBe(200);
    expect(cap.names).toEqual(['Marc Dupont']);
    await server.close();
  });

  it('PATCH profileName vide -> null (on vide le Nom)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(adminTok), payload: { profileName: '   ' } });
    expect(res.statusCode).toBe(200);
    expect(cap.names).toEqual([null]);
    await server.close();
  });

  it('PATCH mise à jour en place d\'un champ déjà rempli (prenom) -> 200, merge écrase', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(adminTok), payload: { fields: { prenom: 'Marco' } } });
    expect(res.statusCode).toBe(200);
    expect(cap.merged).toEqual([{ prenom: 'Marco' }]);
    await server.close();
  });

  it('PATCH contact hors tenant (getContact null) -> 404, aucune écriture', async () => {
    const { server, cap } = app({}, { contact: null });
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/ghost', ...h(adminTok), payload: { fields: { age: '30' } } });
    expect(res.statusCode).toBe(404);
    expect(cap.merged).toHaveLength(0);
    await server.close();
  });

  it('PATCH tenant != token -> 403', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/AUTRE/contacts/c1', ...h(adminTok), payload: { addTags: ['x'] } });
    expect(res.statusCode).toBe(403);
    await server.close();
  });

  it('PATCH agent -> 403 (admin-only)', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(agentTok), payload: { addTags: ['x'] } });
    expect(res.statusCode).toBe(403);
    await server.close();
  });

  it('sans token -> 401', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', headers: { 'content-type': 'application/json' }, payload: { addTags: ['x'] } });
    expect(res.statusCode).toBe(401);
    await server.close();
  });
});

describe('POST /tenants/:t/contacts/bulk — action en masse', () => {
  it('add_tag par ids -> 200, applyEditsMany reçoit la cible ids + addTags, renvoie affected', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/contacts/bulk', ...h(adminTok), payload: { target: { ids: ['a', 'b', 'a'] }, action: { type: 'add_tag', tags: ['vip', 'vip'] } } });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ affected: number }>().affected).toBe(3);
    expect(cap.bulk).toHaveLength(1);
    expect(cap.bulk[0]!.target).toEqual({ ids: ['a', 'b'] }); // parse dédup les ids
    expect(cap.bulk[0]!.edits).toEqual({ addTags: ['vip'] });   // et les tags
    await server.close();
  });

  it('remove_tag par filtres + excludeIds -> 200, la cible passe filters + excludeIds', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/contacts/bulk', ...h(adminTok), payload: { target: { filters: { tags: ['vip'] }, excludeIds: ['x'] }, action: { type: 'remove_tag', tags: ['vip'] } } });
    expect(res.statusCode).toBe(200);
    expect(cap.bulk[0]!.target).toEqual({ filters: { tags: ['vip'] }, excludeIds: ['x'] });
    expect(cap.bulk[0]!.edits).toEqual({ removeTags: ['vip'] });
    await server.close();
  });

  it('set_field valide -> 200, la valeur booléenne est CANONICALISÉE (oui -> true)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/contacts/bulk', ...h(adminTok), payload: { target: { ids: ['a'] }, action: { type: 'set_field', key: 'consent', value: 'oui' } } });
    expect(res.statusCode).toBe(200);
    expect(cap.bulk[0]!.edits).toEqual({ setField: { key: 'consent', value: 'true' } });
    await server.close();
  });

  it('set_field clé inconnue -> 400, aucune action', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/contacts/bulk', ...h(adminTok), payload: { target: { ids: ['a'] }, action: { type: 'set_field', key: 'inconnu', value: 'x' } } });
    expect(res.statusCode).toBe(400);
    expect(cap.bulk).toHaveLength(0);
    await server.close();
  });

  it('set_field valeur invalide pour le type -> 400, aucune action', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/contacts/bulk', ...h(adminTok), payload: { target: { ids: ['a'] }, action: { type: 'set_field', key: 'age', value: 'pas-un-nombre' } } });
    expect(res.statusCode).toBe(400);
    expect(cap.bulk).toHaveLength(0);
    await server.close();
  });

  it('action inconnue -> 400', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/contacts/bulk', ...h(adminTok), payload: { target: { ids: ['a'] }, action: { type: 'boom' } } });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('cible absente -> 400 (jamais d\'UPDATE global)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/contacts/bulk', ...h(adminTok), payload: { action: { type: 'add_tag', tags: ['vip'] } } });
    expect(res.statusCode).toBe(400);
    expect(cap.bulk).toHaveLength(0);
    await server.close();
  });

  it('cible ids vide -> 400', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/contacts/bulk', ...h(adminTok), payload: { target: { ids: [] }, action: { type: 'add_tag', tags: ['vip'] } } });
    expect(res.statusCode).toBe(400);
    expect(cap.bulk).toHaveLength(0);
    await server.close();
  });

  it('agent -> 403 (admin-only)', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/contacts/bulk', ...h(agentTok), payload: { target: { ids: ['a'] }, action: { type: 'add_tag', tags: ['vip'] } } });
    expect(res.statusCode).toBe(403);
    expect(cap.bulk).toHaveLength(0);
    await server.close();
  });

  it('tenant != token -> 403', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/AUTRE/contacts/bulk', ...h(adminTok), payload: { target: { ids: ['a'] }, action: { type: 'add_tag', tags: ['vip'] } } });
    expect(res.statusCode).toBe(403);
    await server.close();
  });

  it('sans token -> 401', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/contacts/bulk', headers: { 'content-type': 'application/json' }, payload: { target: { ids: ['a'] }, action: { type: 'add_tag', tags: ['vip'] } } });
    expect(res.statusCode).toBe(401);
    await server.close();
  });
});

/**
 * Émission « tag ajouté » vers les automations (E.2).
 *
 * L'invariant que ces tests verrouillent est CELUI QUI COÛTE DE L'ARGENT : un tag posé en MASSE ne doit
 * jamais émettre, sinon poser un tag sur 5 000 contacts démarre 5 000 scénarios et facture 5 000 messages
 * que personne n'a demandés. Sans ce test, un contributeur ajouterait l'appel à la route en masse « par
 * symétrie » et toute la suite resterait verte.
 */
describe('routes contacts — émission « tag ajouté » (automations)', () => {
  it('édition d’UNE fiche avec un tag NOUVEAU -> émet ce tag', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(adminTok), payload: { addTags: ['rappeler'] } });
    expect(res.statusCode).toBe(200);
    expect(cap.emitted).toEqual([['rappeler']]);
    await server.close();
  });

  it('tag DÉJÀ présent sur la fiche -> aucune émission (reposer un tag n’est pas un événement)', async () => {
    // CONTACT porte déjà 'vip' : la base ne change pas, le scénario ne doit donc pas repartir.
    const { server, cap } = app();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(adminTok), payload: { addTags: ['vip'] } });
    expect(res.statusCode).toBe(200);
    expect(cap.emitted).toEqual([]);
    await server.close();
  });

  it('action EN MASSE -> AUCUNE émission (garde anti-envoi de masse)', async () => {
    const { server, cap } = app();
    const res = await server.inject({
      method: 'POST', url: '/tenants/t1/contacts/bulk', ...h(adminTok),
      payload: { target: { filters: {} }, action: { type: 'add_tag', tags: ['rappeler'] } },
    });
    expect(res.statusCode).toBe(200);
    expect(cap.bulk).toHaveLength(1);  // l'action en masse a bien eu lieu…
    expect(cap.emitted).toEqual([]);   // …mais sans déclencher la moindre automation
    await server.close();
  });

  it('une file indisponible ne fait PAS échouer l’édition de fiche', async () => {
    const { server } = app({ emitTagAdded: async () => { throw new Error('file indisponible'); } });
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(adminTok), payload: { addTags: ['rappeler'] } });
    expect(res.statusCode).toBe(200);
    await server.close();
  });
});

/**
 * 🔴 Espace NEUF : les champs socles (`prenom`/`email`) n'existent en base par AUCUN chemin d'inscription. Ils
 * n'apparaissaient que par effet de bord d'un import CSV. Saisir un prénom sur un compte neuf rendait donc
 * « champ inconnu : prenom » alors que l'écran le propose, sans aucun moyen de s'en sortir. Vécu sur un vrai
 * compte client le 2026-08-17.
 */
describe('champ socle absent de la base : materialise a la premiere ecriture', () => {
  /** Espace neuf : aucun user field, et on observe ce qui se fait creer. */
  function neuf(over: Partial<ContactsRouteDeps> = {}) {
    const crees: Array<{ key: string; label: string; type: string }> = [];
    let champs: UserFieldDef[] = [];
    const { server, cap } = app({
      listUserFields: async () => champs,
      ensureSocleField: async (_t, key, label, type) => {
        crees.push({ key, label, type });
        champs = [...champs, { key, label, type } as UserFieldDef];
      },
      ...over,
    });
    return { server, cap, crees };
  }

  it('PATCH fiche avec `prenom` -> 200, champ cree une fois, valeur ecrite', async () => {
    const { server, cap, crees } = neuf();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(adminTok), payload: JSON.stringify({ fields: { prenom: 'Julien' } }) });
    expect(res.statusCode).toBe(200);
    expect(crees).toEqual([{ key: 'prenom', label: 'Prénom', type: 'text' }]);
    expect(cap.merged).toEqual([{ prenom: 'Julien' }]);
    await server.close();
  });

  it('`email` aussi (l’autre champ socle)', async () => {
    const { server, crees } = neuf();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(adminTok), payload: JSON.stringify({ fields: { email: 'a@b.fr' } }) });
    expect(res.statusCode).toBe(200);
    expect(crees.map((c) => c.key)).toEqual(['email']);
    await server.close();
  });

  it('🔴 un champ inconnu qui n’est PAS socle reste REFUSE (la garde anti-faute de frappe tient)', async () => {
    const { server, crees } = neuf();
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(adminTok), payload: JSON.stringify({ fields: { prnom: 'faute' } }) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('champ inconnu');
    expect(crees).toEqual([]); // rien ne se cree sur une faute de frappe
    await server.close();
  });

  it('sans la dep de materialisation -> comportement historique (refus)', async () => {
    const { server } = app({ listUserFields: async () => [] });
    const res = await server.inject({ method: 'PATCH', url: '/tenants/t1/contacts/c1', ...h(adminTok), payload: JSON.stringify({ fields: { prenom: 'Julien' } }) });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('action en MASSE `set_field` sur un champ socle absent -> materialise aussi', async () => {
    // Le second site de validation : il refusait pareil, et il fallait le corriger avec le MÊME helper.
    const { server, crees } = neuf();
    const res = await server.inject({
      method: 'POST', url: '/tenants/t1/contacts/bulk', ...h(adminTok),
      payload: JSON.stringify({ target: { ids: ['c1'] }, action: { type: 'set_field', key: 'prenom', value: 'Ju' } }),
    });
    expect(res.statusCode).toBe(200);
    expect(crees.map((c) => c.key)).toEqual(['prenom']);
    await server.close();
  });
});

/**
 * Création d'UN contact à la main (le mini-CRM ne savait créer que par import CSV : fabriquer un fichier pour
 * un seul numéro). La route délègue au MÊME upsert que l'import et l'API publique, pour ne pas créer un second
 * chemin qui divergerait sur la normalisation du numéro, l'opt-in ou les champs.
 */
describe('POST /tenants/:t/contacts (ajout a la main)', () => {
  function avecCreation(over: Partial<ContactsRouteDeps> = {}) {
    const recus: Array<Record<string, unknown>> = [];
    const { server } = app({
      createOneContact: async (_t, input) => { recus.push(input as Record<string, unknown>); return { status: 'created', contactId: 'c-neuf' }; },
      ...over,
    });
    return { server, recus };
  }

  it('🔴 numero seul -> 201, et le contact est OPT-IN par defaut', async () => {
    // Saisir un numéro à la main suppose qu'on l'a obtenu de la personne. Le créer muet en ferait un contact
    // que les campagnes ignorent sans que rien ne le dise à l'écran, ce qui se découvre au premier envoi qui
    // ne part pas. L'import CSV et l'API publique gardent la règle inverse.
    const { server, recus } = avecCreation();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/contacts', ...h(adminTok), payload: JSON.stringify({ phone: '06 12 34 56 78' }) });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: 'created', contactId: 'c-neuf' });
    expect(recus[0]).toMatchObject({ phone: '06 12 34 56 78', optIn: true });
    await server.close();
  });

  it('🔴 BSUID et plusieurs tags arrivent a l’upsert, et restent OPTIONNELS', async () => {
    // Le BSUID identifie un client qui n'a pas partage son numero. Il ne doit pas devenir une seconde identite
    // obligatoire : le numero reste la cle de ce chemin, et une saisie sans BSUID marche comme avant.
    const { server, recus } = avecCreation();
    await server.inject({
      method: 'POST', url: '/tenants/t1/contacts', ...h(adminTok),
      payload: JSON.stringify({ phone: '0612345678', tags: ['salon', 'vip'], bsuid: '  wa-abc123  ' }),
    });
    expect(recus[0]).toMatchObject({ tags: ['salon', 'vip'], bsuid: 'wa-abc123' });

    await server.inject({ method: 'POST', url: '/tenants/t1/contacts', ...h(adminTok), payload: JSON.stringify({ phone: '0612345679' }) });
    expect(recus[1]).not.toHaveProperty('bsuid'); // absent, pas une chaine vide
    await server.close();
  });

  it('un BSUID vide ou non textuel est IGNORE, pas transmis a blanc', async () => {
    const { server, recus } = avecCreation();
    for (const bsuid of ['', '   ', 42, null]) {
      await server.inject({ method: 'POST', url: '/tenants/t1/contacts', ...h(adminTok), payload: JSON.stringify({ phone: '0612345678', bsuid }) });
    }
    expect(recus.every((r) => !('bsuid' in r))).toBe(true);
    await server.close();
  });

  it('🔴 une case DECOCHEE reste respectee : le defaut ne l’ecrase pas', async () => {
    const { server, recus } = avecCreation();
    await server.inject({ method: 'POST', url: '/tenants/t1/contacts', ...h(adminTok), payload: JSON.stringify({ phone: '0612345678', optIn: false }) });
    expect(recus[0]).toMatchObject({ optIn: false });
    await server.close();
  });

  it('numero DEJA connu -> 200 `updated` : l’ecran ne doit pas annoncer une creation', async () => {
    const { server } = avecCreation({ createOneContact: async () => ({ status: 'updated', contactId: 'c1' }) });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/contacts', ...h(adminTok), payload: JSON.stringify({ phone: '+33612345678' }) });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('updated');
    await server.close();
  });

  it('telephone manquant -> 400 ; numero refuse par l’upsert -> 400 avec SA raison', async () => {
    const { server } = avecCreation();
    expect((await server.inject({ method: 'POST', url: '/tenants/t1/contacts', ...h(adminTok), payload: JSON.stringify({ name: 'Sans numero' }) })).statusCode).toBe(400);
    await server.close();

    const { server: s2 } = avecCreation({ createOneContact: async () => ({ status: 'error', reason: 'téléphone invalide' }) });
    const res = await s2.inject({ method: 'POST', url: '/tenants/t1/contacts', ...h(adminTok), payload: JSON.stringify({ phone: 'pas-un-numero' }) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('téléphone invalide');
    await s2.close();
  });

  it('🔴 un champ INCONNU est refuse : une saisie a la main ne doit pas inventer un champ pour tout l’espace', async () => {
    // L'upsert partagé auto-crée toute clé inconnue (c'est voulu pour l'API et l'import). Ici on valide AVANT,
    // sinon une faute de frappe dans l'écran créerait un champ fantôme visible par tous.
    const { server, recus } = avecCreation();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/contacts', ...h(adminTok), payload: JSON.stringify({ phone: '+33612345678', fields: { prnom: 'faute' } }) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('champ inconnu');
    expect(recus).toHaveLength(0); // rien n'atteint l'upsert
    await server.close();
  });

  it('valeur invalide pour le TYPE du champ -> 400 (meme regle que la fiche)', async () => {
    const { server } = avecCreation();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/contacts', ...h(adminTok), payload: JSON.stringify({ phone: '+33612345678', fields: { age: 'douze' } }) });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('agent -> 403 ; tenant d’autrui -> 403 ; dep absente -> 503', async () => {
    const { server } = avecCreation();
    expect((await server.inject({ method: 'POST', url: '/tenants/t1/contacts', ...h(agentTok), payload: JSON.stringify({ phone: '+33612345678' }) })).statusCode).toBe(403);
    expect((await server.inject({ method: 'POST', url: '/tenants/t2/contacts', ...h(adminTok), payload: JSON.stringify({ phone: '+33612345678' }) })).statusCode).toBe(403);
    await server.close();

    const { server: sans } = app();
    expect((await sans.inject({ method: 'POST', url: '/tenants/t1/contacts', ...h(adminTok), payload: JSON.stringify({ phone: '+33612345678' }) })).statusCode).toBe(503);
    await sans.close();
  });
});
