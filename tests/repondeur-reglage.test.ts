import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import type { EmailIdentity, UserAuthStore } from '../src/auth/store';
import type { AgentsRouteDeps } from '../src/http/agents';
import { choisirRepondeur, type DepsReglageRepondeur } from '../src/repondeur/reglage';
import { EtatMetaIllisible, MetaARefuse } from '../src/mba/activation';
import { creerListeDeLAgent, PAQUET_LISTE } from '../src/mba/liste';
import { PgTenantSettingsStore } from '../src/settings/store.pg';
import { modifierAgent } from '../src/agent/gestion';
import type { AgentComplet, PatchAgent } from '../src/agent/agent-store';
import { ficheVide } from '../src/agent/fiche';
import type { LigneHistorique } from '../src/reglages/historique';
import { agentsInertes } from './routes-inertes';
import { bancDuFil, listeEnMemoire, metaFactice } from './banc-du-fil';

/**
 * LE RÉGLAGE DU RÉPONDEUR (lot 5, A2) : une seule voix, garantie par la base ET rendue vraie chez Meta.
 *
 * 🔴 CE QUE CES CAS GARDENT. Désigner un agent IA alors que l'agent de Meta est allumé doit, DANS CET ORDRE, éteindre
 * l'agent de Meta (le chemin de l'Accueil), retirer de sa liste tous les contacts qu'il tenait, PUIS écrire le réglage :
 * écrit avant, le CHECK d'une seule voix lèverait ; la liste laissée pleine, Meta rangerait encore leurs messages en
 * `standby`. Ce que la base fait des deux ordres du CHECK : `tests/integration/repondeur.integration.test.ts`, en CI.
 */

afterEach(() => { vi.restoreAllMocks(); });

const T = 't1';
const AG = '11111111-1111-4111-8111-111111111111';
const AUTRE = '22222222-2222-4222-8222-222222222222';
const AUTEUR = { userId: 'u1', origine: 'formulaire' as const };

/** Le réglage et ses dépendances en mémoire, chaque geste noté dans l'ordre. */
function monter(o: {
  mba?: boolean; repondeur?: string | null; statut?: AgentComplet['status'] | null; gateway?: boolean;
  extinction?: Error; ecriture?: Error; reprise?: Error;
} = {}) {
  const etat = { mbaEnabled: o.mba === true, repondeurAgentId: o.repondeur ?? null };
  const journal: string[] = [];
  const lignes: LigneHistorique[] = [];
  const deps: DepsReglageRepondeur = {
    agents: {
      complet: async (_t, id) => (o.statut === null || id !== AG ? null : { id: AG, label: 'Léa', status: o.statut ?? 'active' }),
    },
    reglages: {
      get: async () => ({ ...etat }),
      setRepondeur: async (_t, id) => {
        journal.push(`reglage:${id}`);
        if (o.ecriture) throw o.ecriture;
        etat.repondeurAgentId = id;
      },
    },
    gatewayDisponible: o.gateway ?? true,
    eteindreAgentDeMeta: async () => {
      journal.push('meta:eteint');
      if (o.extinction) throw o.extinction;
      etat.mbaEnabled = false;
      return { enabled: false, chezMeta: 'applique', phoneNumberId: 'pn1' };
    },
    liste: { toutRetirer: async () => { journal.push('liste:videe'); return { retires: 3, refuses: 1 }; } },
    historique: { ecrire: async (_t, l) => { lignes.push(l); } },
    fils: {
      reprendreLesFilsDeMeta: async () => {
        journal.push('fils:repris');
        if (o.reprise) throw o.reprise;
        return 2;
      },
    },
  };
  return { deps, etat, journal, lignes };
}

describe('choisirRepondeur : une seule voix', () => {
  it('🔴 agent de Meta allumé : il est ÉTEINT, sa liste VIDÉE, PUIS le réglage écrit, et le geste le dit', async () => {
    const m = monter({ mba: true });
    const r = await choisirRepondeur(m.deps, T, AG, AUTEUR);
    expect(r).toEqual({ ok: true, valeur: { repondeurAgentId: AG, agentDeMetaEteint: true, liste: { retires: 3, refuses: 1 } } });
    expect(m.journal).toEqual(['meta:eteint', 'liste:videe', `reglage:${AG}`, 'fils:repris']);
    expect(m.etat).toEqual({ mbaEnabled: false, repondeurAgentId: AG });
    expect(m.lignes).toMatchObject([{
      surface: 'agent', surfaceId: AG, element: 'repondeur', operation: 'modification', origine: 'formulaire', acteurId: 'u1',
      avant: { repondeurAgentId: null, mbaEnabled: true }, apres: { fils: 2 },
    }]);
  });

  it('🔴 les fils que notre colonne donnait à l’agent de Meta reviennent aux robots, APRÈS le réglage (essai réel du 2026-10-05)', async () => {
    // Laissé `mba`, un fil n'était plus tenu par personne : le parcours qui attendait le contact gelait, la remise
    // refusait l'agent IA, et le client n'avait plus aucune réponse. Repris AVANT le réglage, le fil trouverait
    // l'agent de Meta éteint et aucun répondeur, le même silence.
    const m = monter({ mba: true });
    expect((await choisirRepondeur(m.deps, T, AG, AUTEUR)).ok).toBe(true);
    expect(m.journal.indexOf('fils:repris')).toBeGreaterThan(m.journal.indexOf(`reglage:${AG}`));
  });

  it('🔴 une reprise des fils en échec ne défait pas le geste : réglage écrit, ligne d’historique écrite, `fils: null`', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = monter({ mba: true, reprise: new Error('pooler injoignable') });
    expect(await choisirRepondeur(m.deps, T, AG, AUTEUR)).toMatchObject({ ok: true, valeur: { repondeurAgentId: AG } });
    expect(m.etat.repondeurAgentId).toBe(AG);
    expect(m.lignes).toMatchObject([{ element: 'repondeur', apres: { fils: null } }]);
  });

  it('agent de Meta déjà éteint : rien chez Meta, mais la liste est vidée quand même (des contacts peuvent y rester)', async () => {
    const m = monter();
    expect((await choisirRepondeur(m.deps, T, AG, AUTEUR)).ok).toBe(true);
    expect(m.journal).toEqual(['liste:videe', `reglage:${AG}`, 'fils:repris']);
  });

  it('🔴 un agent en brouillon, désactivé, inconnu ou mal formé est refusé, sans RIEN éteindre ni écrire', async () => {
    for (const [o, agent, statut] of [
      [{ statut: 'draft' as const }, AG, 422], [{ statut: 'disabled' as const }, AG, 422], [{ statut: null }, AG, 404],
      [{}, AUTRE, 404], [{}, 'pas-un-uuid', 404],
    ] as const) {
      const m = monter({ mba: true, ...o });
      const r = await choisirRepondeur(m.deps, T, agent, AUTEUR);
      expect(r.ok ? 200 : r.statut, JSON.stringify(o)).toBe(statut);
      expect(m.journal, JSON.stringify(o)).toEqual([]);
    }
  });

  it('🔴 modèle absent sur l’instance : refusé (un répondeur désigné laisserait chaque contact muet)', async () => {
    const m = monter({ gateway: false });
    const r = await choisirRepondeur(m.deps, T, AG, AUTEUR);
    expect(r).toMatchObject({ ok: false, statut: 422 });
    expect(m.journal).toEqual([]);
  });

  it('🔴 Meta ne répond pas ou refuse d’éteindre son agent : 409, et RIEN n’est écrit', async () => {
    for (const extinction of [new EtatMetaIllisible('401'), new MetaARefuse('403')]) {
      const m = monter({ mba: true, extinction });
      const r = await choisirRepondeur(m.deps, T, AG, AUTEUR);
      expect(r).toMatchObject({ ok: false, statut: 409 });
      expect(m.journal).toEqual(['meta:eteint']);
      expect(m.etat.repondeurAgentId).toBeNull();
    }
  });

  it('🔴 l’agent de Meta rallumé entre-temps : le CHECK d’une seule voix tient, et le refus est lisible (409, pas 500)', async () => {
    const check = Object.assign(new Error('violates check constraint'), { code: '23514', constraint: 'tenant_settings_repondeur_une_voix_chk' });
    const m = monter({ ecriture: check });
    expect(await choisirRepondeur(m.deps, T, AG, AUTEUR)).toMatchObject({ ok: false, statut: 409 });
    // Une autre panne remonte telle quelle : ce n'est pas un refus explicable.
    const panne = monter({ ecriture: new Error('pooler injoignable') });
    await expect(choisirRepondeur(panne.deps, T, AG, AUTEUR)).rejects.toThrow('pooler injoignable');
  });

  it('null retire le répondeur, et la ligne d’historique nomme l’agent qui l’était', async () => {
    const m = monter({ repondeur: AG });
    expect(await choisirRepondeur(m.deps, T, null, AUTEUR)).toEqual({ ok: true, valeur: { repondeurAgentId: null, agentDeMetaEteint: false, liste: { retires: 0, refuses: 0 } } });
    expect(m.journal).toEqual(['reglage:null']);
    expect(m.lignes).toMatchObject([{ surfaceId: AG, element: 'repondeur', libelle: 'Répondeur de l’espace : retiré' }]);
  });

  it('déjà le répondeur, agent de Meta éteint : rien à faire, rien à journaliser', async () => {
    const m = monter({ repondeur: AG });
    expect((await choisirRepondeur(m.deps, T, AG, AUTEUR)).ok).toBe(true);
    expect(m.journal).toEqual([]);
    expect(m.lignes).toEqual([]);
  });
});

describe('🔴 les fils de l’agent de Meta reviennent aux robots, par le contrôle du fil réel (essai réel du 2026-10-05)', () => {
  it('chaque fil `mba` passe à `app_workflow`, par paquets, avec sa cause ; un fil d’opérateur ou de scénario n’est pas touché', async () => {
    const tenus = Array.from({ length: 205 }, (_, i) => `336${String(i).padStart(8, '0')}`);
    // Les lectures, notées : dans le faux comme en base, un fil repris sort de l'ensemble `mba`, donc sans les compter
    // un paquet unique sans curseur passerait aussi.
    const lectures: Array<{ apres: string | null; limite: number }> = [];
    let lire: ((t: string, apres: string | null, limite: number) => Promise<string[]>) | null = null;
    const banc = bancDuFil({
      depot: { filsDeLAgentDeMeta: (t, apres, limite) => { lectures.push({ apres, limite }); return lire!(t, apres, limite); } },
      mbaEnabled: false, repondeurAgentId: AG,
      conversations: {
        ...Object.fromEntries(tenus.map((w) => [w, { owner: 'mba' as const }])),
        '33700000001': { owner: 'app_human' },
        '33700000002': { owner: 'app_workflow' },
      },
    });
    // Fidèle à `PgInboxStore.filsDeLAgentDeMeta`, sur les lignes du banc.
    lire = async (_t, apres, limite) => [...banc.lignes]
      .filter(([waId, l]) => l.owner === 'mba' && (apres === null || waId > apres))
      .map(([waId]) => waId).sort().slice(0, limite);
    expect(await banc.fil.reprendreLesFilsDeMeta(T)).toBe(tenus.length);
    for (const w of tenus) expect(banc.etat(w)?.owner, w).toBe('app_workflow');
    expect(banc.etat('33700000001')?.owner).toBe('app_human');
    expect(lectures).toEqual([{ apres: null, limite: 200 }, { apres: tenus[199], limite: 200 }]);
    expect(banc.ecritures.map((e) => e.waId).sort()).toEqual(tenus);
    expect(banc.ecritures[0]?.opts).toMatchObject({ only: ['mba'], par: { cause: 'automatique : l’agent de Meta est éteint, le répondeur automatique prend la suite' } });
    // Aucun geste chez Meta : son agent est éteint, et ses contacts viennent d'être retirés de sa liste.
    expect(banc.appels).toEqual([]);
  });
});

describe('🔴 la liste de l’agent de Meta se vide entière, par paquets, un refus n’arrête pas les autres', () => {
  it(`${PAQUET_LISTE * 2 + 5} contacts : tous retirés, sauf celui que Meta refuse, qui reste sur la liste et se compte`, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const contacts = Array.from({ length: PAQUET_LISTE * 2 + 5 }, (_, i) => `336${String(i).padStart(8, '0')}`);
    const table = listeEnMemoire(contacts);
    const refuse = contacts[PAQUET_LISTE + 3]!;
    const faux = metaFactice({}, [], undefined, contacts);
    const client = { ...faux.client, removeFromAllowlist: async (pn: string, entree: string) => {
      if (entree === `entree-${refuse}`) throw new Error('refusé par Meta');
      return faux.client.removeFromAllowlist(pn, entree);
    } };
    const liste = creerListeDeLAgent({ store: table.store, clientMba: async () => client, attendre: async () => {} });
    expect(await liste.toutRetirer(T)).toEqual({ retires: contacts.length - 1, refuses: 1 });
    expect([...table.lignes.keys()]).toEqual([refuse]);
  });
});

describe('🔴 le seul écrivain de `mba_enabled` remet le répondeur à nul en ALLUMANT, dans la même instruction', () => {
  const sqlDe = async (enabled: boolean): Promise<string[]> => {
    const requetes: string[] = [];
    const pool = { query: async (sql: string) => { requetes.push(sql.replace(/\s+/g, ' ')); return { rows: [], rowCount: 1 }; } } as unknown as Pool;
    await new PgTenantSettingsStore(pool).setMbaEnabled(T, enabled);
    return requetes;
  };
  it('une seule requête, qui pose le drapeau et efface le répondeur quand il s’allume, et seulement alors', async () => {
    // Deux requêtes laisseraient une fenêtre où le CHECK verrait deux voix et lèverait : un 500 sur l'interrupteur.
    const [sql, ...autres] = await sqlDe(true);
    expect(autres).toEqual([]);
    expect(sql).toContain('mba_enabled = excluded.mba_enabled');
    expect(sql).toContain('repondeur_agent_id = case when excluded.mba_enabled then null else tenant_settings.repondeur_agent_id end');
  });
});

describe('🔴 cas 3 de la revue : l’agent répondeur désactivé ou remis en brouillon cesse d’être le répondeur', () => {
  function gestion(statut: AgentComplet['status']) {
    let agent: AgentComplet = {
      id: AG, label: 'Léa', status: statut, mentionIa: 'IA.', modele: 'modele-config', maxTours: 8, maxAppelsOutils: 12,
      budgetMicroEur: 30_000, inactiviteMinutes: 30, contactInconnu: 'tous', contenu: ficheVide(), ficheVersion: 1,
    };
    const oublis: string[] = [];
    const deps: AgentsRouteDeps = {
      ...agentsInertes,
      agents: {
        listActifs: async () => [], listToutes: async () => [], remove: async () => true,
        complet: async () => agent, create: async () => agent,
        patch: async (_t, _id, p: PatchAgent) => { agent = { ...agent, ...(p.status ? { status: p.status } : {}), ...(p.label ? { label: p.label } : {}) }; return agent; },
      },
      modeleParDefaut: 'modele-config',
      oublierRepondeur: async (_t, id) => { oublis.push(id); return true; },
    };
    return { deps, oublis };
  }

  it('désactiver (PATCH de la console ou activate_agent du MCP, la même fonction) : le répondeur est retiré', async () => {
    for (const statut of ['disabled', 'draft'] as const) {
      const g = gestion('active');
      expect((await modifierAgent(g.deps, T, AG, { status: statut }, AUTEUR)).ok).toBe(true);
      expect(g.oublis, statut).toEqual([AG]);
    }
  });

  it('une retouche qui ne touche pas au statut, ou une activation, ne touche pas au répondeur', async () => {
    const g = gestion('disabled');
    await modifierAgent(g.deps, T, AG, { label: 'Léo' }, AUTEUR);
    expect(g.oublis).toEqual([]);
  });
});

/** La route de la console : admins seulement, l'espace du jeton, un corps validé. */
describe('PUT /tenants/:tenantId/agents/repondeur', () => {
  const SECRET = 'secret-repondeur';
  let admin = '';
  let agent = '';
  beforeAll(async () => {
    admin = await signSession({ userId: 'u1', tenantId: T, role: 'admin' }, SECRET);
    agent = await signSession({ userId: 'u2', tenantId: T, role: 'agent' }, SECRET);
  });
  const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });
  const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
  function serveur() {
    const m = monter({ mba: true });
    const deps: AgentsRouteDeps = {
      ...agentsInertes,
      agents: { listActifs: async () => [], listToutes: async () => [], complet: async () => null, create: async () => { throw new Error('x'); }, patch: async () => null, remove: async () => false },
      modeleParDefaut: 'modele-config',
      repondeur: m.deps,
    };
    return { m, srv: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, agents: deps }) };
  }

  it('🔴 un admin désigne l’agent ; la réponse dit que l’agent de Meta est éteint ; la liste rend le répondeur', async () => {
    const { m, srv } = serveur();
    const res = await srv.inject({ method: 'PUT', url: `/tenants/${T}/agents/repondeur`, ...h(admin), payload: { agentId: AG } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ repondeurAgentId: AG, agentDeMetaEteint: true, liste: { retires: 3, refuses: 1 } });
    expect(m.lignes[0]).toMatchObject({ origine: 'formulaire', acteurId: 'u1' });
    expect((await srv.inject({ method: 'GET', url: `/tenants/${T}/agents`, ...h(admin) })).json()).toEqual({ agents: [], repondeurAgentId: AG });
  });

  it('🔴 refusé à un non-admin et à un autre espace, sans rien toucher', async () => {
    const { m, srv } = serveur();
    expect((await srv.inject({ method: 'PUT', url: `/tenants/${T}/agents/repondeur`, ...h(agent), payload: { agentId: AG } })).statusCode).toBe(403);
    expect((await srv.inject({ method: 'PUT', url: '/tenants/t2/agents/repondeur', ...h(admin), payload: { agentId: AG } })).statusCode).toBe(403);
    expect(m.journal).toEqual([]);
  });

  it('un corps illisible : 400 ; un agent refusé : la phrase de la fonction, avec son statut', async () => {
    const { srv } = serveur();
    expect((await srv.inject({ method: 'PUT', url: `/tenants/${T}/agents/repondeur`, ...h(admin), payload: { agentId: 12 } })).statusCode).toBe(400);
    expect((await srv.inject({ method: 'PUT', url: `/tenants/${T}/agents/repondeur`, ...h(admin), payload: {} })).statusCode).toBe(400);
    const r = await srv.inject({ method: 'PUT', url: `/tenants/${T}/agents/repondeur`, ...h(admin), payload: { agentId: AUTRE } });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: 'agent introuvable' });
  });
});
