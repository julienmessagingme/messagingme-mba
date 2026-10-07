import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { signSession } from '../src/auth/token';
import { accesOps, ADRESSE_OPS, SECRET_OPS } from './acces-ops';
import { FakeQueue } from './fake-queue';
import { capturerJournal } from './journal';
import { verrousEnMemoire } from './verrous';
import type { OpsSuppressionDeps } from '../src/http/ops-suppression';
import type { BilanSuppression, DepsSuppression } from '../src/ops/suppression-espace';

/**
 * LA SUPPRESSION D'UN ESPACE DEPUIS /ops (RC8), PAR LE VRAI CÂBLAGE (`buildServer`) : la garde d'exploitation, la saisie
 * du nom, une seule suppression à la fois, et la trace signée de l'exploitant. L'ordre des étapes :
 * `tests/ops-suppression-espace.test.ts` ; la purge réelle : `tests/integration/suppression-espace.integration.test.ts`.
 */
const T1 = '4169c753-311a-43bb-a334-d8a2cb7caf6f';
const INCONNU = '11111111-2222-4333-8444-555555555555';

const BILAN: BilanSuppression = {
  tenantId: T1, nom: 'Essai Dupont', creeLe: '2026-10-01T00:00:00.000Z', statut: 'trial',
  comptes: { utilisateurs: 1, contacts: 0, conversations: 0, scenarios: 0 },
  soldeMicroEur: 0,
  stripe: {
    clients: [{ customerId: 'cus_1', livemode: true, lien: 'https://dashboard.stripe.com/customers/cus_1' }],
    abonnements: [{ id: 'sub_1', produit: 'numero', statut: 'actif', livemode: true, vivant: true, lien: 'https://dashboard.stripe.com/subscriptions/sub_1' }],
  },
  numeroFourni: null,
  meta: { phoneNumberId: null, wabaId: null, partage: false, mbaAllume: false, contactsSurLaListe: 0 },
  salesforce: false,
  cleVercel: false,
  adresses: { effacees: ['essai@exemple.test'], gardees: [] },
};

function monter(o: { verrous?: ReturnType<typeof verrousEnMemoire> } = {}) {
  const gestes: string[] = [];
  const purges: Array<{ par: string }> = [];
  const note = (g: string) => async () => { gestes.push(g); };
  const d: DepsSuppression = {
    verrouiller: async () => { gestes.push('verrou'); return true; },
    revoquerCleVercel: async () => { gestes.push('cle_vercel'); return false; },
    eteindreMba: note('mba_eteint'),
    viderListeMba: async () => { gestes.push('mba_liste'); return { retires: 0, refuses: 0 }; },
    desabonnerWaba: note('waba_desabonne'),
    deconnecterSalesforce: async () => { gestes.push('salesforce'); return 'non_relie'; },
    deconnecterHubspot: note('hubspot'),
    sortirNumeroFourni: async () => { gestes.push('numero_fourni'); return { fait: 'aucun' }; },
    purger: async (_t, trace) => {
      gestes.push('purge');
      purges.push({ par: trace.par });
      return { fait: true, comptes: { utilisateurs: 1, contacts: 0, conversations: 0, messages: 0, scenarios: 0, identitesEffacees: 1, identitesGardees: 0 } };
    },
  };
  let lectures = 0;
  const deps: OpsSuppressionDeps = {
    bilan: async (t) => { lectures += 1; return t === T1 ? BILAN : null; },
    contexte: async () => ({ meta: { jeton: 'global', wabaId: null }, hubspot: false, configures: { vercel: true, salesforce: true, hubspot: true } }),
    gestes: d,
    verrous: o.verrous ?? verrousEnMemoire(),
  };
  const server = buildServer({ queue: new FakeQueue(), auth: acces.auth, opsSuppression: deps });
  return { server, gestes, purges, lus: () => lectures };
}

const acces = accesOps();
const ops: Record<string, string> = { 'content-type': 'application/json' };
beforeAll(async () => {
  const s = buildServer({ queue: new FakeQueue(), auth: acces.auth });
  ops.authorization = `Bearer ${await acces.jeton(s)}`;
  await s.close();
});

describe('la suppression d’un espace depuis /ops', () => {
  it('🔴 sans session d’exploitation, avec une fausse, ou avec une session d’ADMIN d’espace : 401, rien n’est lu ni fait', async () => {
    const { server, gestes, lus } = monter();
    const admin = await signSession({ userId: 'u1', tenantId: T1, role: 'admin' }, SECRET_OPS);
    for (const entetes of [{}, { authorization: 'Bearer pas-une-session' }, { authorization: `Bearer ${admin}` }]) {
      expect((await server.inject({ method: 'GET', url: `/ops/espaces/${T1}/suppression`, headers: entetes })).statusCode).toBe(401);
      expect((await server.inject({
        method: 'DELETE', url: `/ops/espaces/${T1}`, headers: { ...entetes, 'content-type': 'application/json' }, payload: { nom: 'Essai Dupont' },
      })).statusCode).toBe(401);
    }
    expect(gestes).toEqual([]);
    expect(lus()).toBe(0);
    await server.close();
  });

  it('GET rend le bilan, les liens Stripe et les étapes prévues ; 404 sur un espace inconnu ou mal formé', async () => {
    const { server, gestes } = monter();
    const res = await server.inject({ method: 'GET', url: `/ops/espaces/${T1}/suppression`, headers: ops });
    expect(res.statusCode).toBe(200);
    const corps = res.json<{ bilan: BilanSuppression; etapes: Array<{ etape: string; etat: string }> }>();
    expect(corps.bilan.stripe.abonnements[0]!.lien).toBe('https://dashboard.stripe.com/subscriptions/sub_1');
    expect(corps.etapes.map((e) => e.etape)).toContain('purge');
    // Le jeton global : les trois étapes chez Meta sont annoncées sautées.
    expect(corps.etapes.find((e) => e.etape === 'waba_desabonne')).toMatchObject({ etat: 'sautee' });
    expect((await server.inject({ method: 'GET', url: `/ops/espaces/${INCONNU}/suppression`, headers: ops })).statusCode).toBe(404);
    expect((await server.inject({ method: 'GET', url: '/ops/espaces/pas-un-uuid/suppression', headers: ops })).statusCode).toBe(404);
    expect(gestes).toEqual([]);
    await server.close();
  });

  it('🔴 un nom qui ne correspond pas, ou absent : 400, et RIEN n’est fait (pas même le verrou)', async () => {
    const { server, gestes } = monter();
    for (const payload of [{ nom: 'essai dupont' }, { nom: 'Essai' }, { nom: '  ' }, {}]) {
      const res = await server.inject({ method: 'DELETE', url: `/ops/espaces/${T1}`, headers: ops, payload });
      expect(res.statusCode).toBe(400);
    }
    expect(gestes).toEqual([]);
    await server.close();
  });

  it('🔴 le bon nom : la suppression tourne, rend son déroulé et les liens Stripe, et la trace porte l’exploitant', async () => {
    const { server, gestes, purges } = monter();
    const { resultat: res, lignes } = await capturerJournal(() => server.inject({
      method: 'DELETE', url: `/ops/espaces/${T1}`, headers: ops, payload: { nom: ' Essai Dupont ' },
    }));
    expect(res.statusCode).toBe(200);
    const corps = res.json<{ supprime: boolean; etapes: Array<{ etape: string; etat: string }>; stripe: BilanSuppression['stripe'] }>();
    expect(corps.supprime).toBe(true);
    expect(corps.stripe.clients[0]!.lien).toBe('https://dashboard.stripe.com/customers/cus_1');
    expect(gestes[0]).toBe('verrou');
    expect(gestes.at(-1)).toBe('purge');
    expect(purges).toEqual([{ par: ADRESSE_OPS }]);
    expect(lignes).toContainEqual(expect.objectContaining({ msg: 'ops_suppression_espace', tenantId: T1, par: ADRESSE_OPS, supprime: true }));
    await server.close();
  });

  it('🔴 une suppression du même espace déjà en cours (double clic, autre copie) : 409, rien n’est fait', async () => {
    const verrous = verrousEnMemoire();
    await verrous.prendre([[`suppression-espace:${T1}`, 60_000]]);
    const { server, gestes } = monter({ verrous });
    const res = await server.inject({ method: 'DELETE', url: `/ops/espaces/${T1}`, headers: ops, payload: { nom: 'Essai Dupont' } });
    expect(res.statusCode).toBe(409);
    expect(gestes).toEqual([]);
    await server.close();
  });

  it('🔴 le verrou de la suppression ne se prend pas (base en panne) : 422 lisible, jamais 5xx, rien n’est fait', async () => {
    const verrous = verrousEnMemoire();
    const enPanne = { ...verrous, prendre: async () => { throw new Error('base indisponible'); } } as unknown as ReturnType<typeof verrousEnMemoire>;
    const { server, gestes } = monter({ verrous: enPanne });
    const res = await server.inject({ method: 'DELETE', url: `/ops/espaces/${T1}`, headers: ops, payload: { nom: 'Essai Dupont' } });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: string }>().error).toMatch(/n’a pas pu commencer/);
    expect(gestes).toEqual([]);
    await server.close();
  });

  it('le verrou de la suppression est relâché à la fin : on peut relancer', async () => {
    const verrous = verrousEnMemoire();
    const { server } = monter({ verrous });
    await server.inject({ method: 'DELETE', url: `/ops/espaces/${T1}`, headers: ops, payload: { nom: 'Faux nom' } });
    expect(verrous.tenues()).toEqual([]);
    await server.close();
  });

  it('espace inconnu : 404', async () => {
    const { server, gestes } = monter();
    expect((await server.inject({ method: 'DELETE', url: `/ops/espaces/${INCONNU}`, headers: ops, payload: { nom: 'x' } })).statusCode).toBe(404);
    expect((await server.inject({ method: 'DELETE', url: '/ops/espaces/pas-un-uuid', headers: ops, payload: { nom: 'x' } })).statusCode).toBe(404);
    expect(gestes).toEqual([]);
    await server.close();
  });
});
