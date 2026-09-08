import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { AgentsRouteDeps } from '../src/http/agents';
import type { AgentComplet, AgentResume, PatchAgent } from '../src/agent/agent-store';
import { manquesAvantActivation, type EtatPourLint } from '../src/agent/setup/lint';
import { ficheVide } from '../src/agent/fiche';

/**
 * Le blocage dur avant activation.
 *
 * 🔴 SUR DES CHAMPS VIDES, JAMAIS SUR UNE QUALITÉ SÉMANTIQUE. Un détecteur qui refuserait un objectif « mal
 * écrit » serait un mur arbitraire que le client ne saurait pas franchir, et aucun produit du marché ne
 * bloque sur du flou. Ce qu'on bloque, ce sont des manques vérifiables, dont chacun rend l'agent incapable
 * de tenir sa promesse une fois posé dans un scénario.
 */
const COMPLET_LINT = (): EtatPourLint => ({
  fiche: {
    ...ficheVide(),
    objectif: 'Cerner le besoin puis proposer un essai.',
    reglesTransfert: 'Dès qu’on parle de remboursement.',
    sorties: [{ code: 'besoin_cerne', label: 'Besoin cerné' }],
  },
  fichesConnaissance: 3,
  outilsActifs: 2, handlersActifs: ['chercher_connaissance'],
});

describe('manquesAvantActivation', () => {
  it('une fiche complète ne bloque rien', () => {
    expect(manquesAvantActivation(COMPLET_LINT())).toEqual([]);
  });

  it('🔴 chaque manque est détecté SÉPARÉMENT, et pointe l’onglet où il se corrige', () => {
    const cas: Array<[Omit<Partial<EtatPourLint>, 'fiche'> & { fiche?: Partial<EtatPourLint['fiche']> }, string]> = [
      [{ fiche: { objectif: '   ' } }, 'objectif'],
      [{ fiche: { reglesTransfert: '' } }, 'objectif'],
      [{ fiche: { sorties: [] } }, 'objectif'],
      [{ fichesConnaissance: 0 }, 'connaissance'],
      [{ outilsActifs: 0, handlersActifs: [] }, 'outils'],
    ];
    for (const [patch, onglet] of cas) {
      const etat = { ...COMPLET_LINT(), ...patch, fiche: { ...COMPLET_LINT().fiche, ...(patch.fiche ?? {}) } };
      const manques = manquesAvantActivation(etat);
      expect(manques, JSON.stringify(patch)).toHaveLength(1);
      expect(manques[0]!.onglet).toBe(onglet);
      // Le message dit ce qui MANQUE et ce que ça coûte, jamais « champ invalide ».
      expect(manques[0]!.message.length).toBeGreaterThan(30);
    }
  });

  it('un agent tout neuf accumule les cinq manques', () => {
    expect(manquesAvantActivation({ fiche: ficheVide(), fichesConnaissance: 0, outilsActifs: 0, handlersActifs: [] })).toHaveLength(5);
  });

  it('🔴 un outil POSÉ mais inactif ne compte pas', () => {
    // Le modèle ne voit que les outils actifs : compter les autres promettrait un agent capable d'agir alors
    // qu'il ne peut rien faire, pas même terminer.
    expect(manquesAvantActivation({ ...COMPLET_LINT(), outilsActifs: 0, handlersActifs: [] }).map((m) => m.onglet)).toEqual(['outils']);
  });
});

// ---------- La garde, sur la route d'activation ----------

const SECRET = 'test-secret';
const AG = '11111111-1111-4111-8111-111111111111';
let adminTok = '';
beforeAll(async () => { adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET); });
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

const COMPLET: AgentComplet = {
  id: AG, label: 'Conseiller séjours', status: 'draft',
  mentionIa: 'Vous échangez avec un assistant automatique.', modele: 'modele-test',
  maxTours: 8, maxAppelsOutils: 12, budgetMicroEur: 30_000, inactiviteMinutes: 30,
  contactInconnu: 'lecture_seule', contenu: ficheVide(), ficheVersion: 1,
};

function app(etat: EtatPourLint | null) {
  const cap = { patches: [] as PatchAgent[] };
  const deps: AgentsRouteDeps = {
    listActifs: async (): Promise<AgentResume[]> => [],
    listToutes: async (): Promise<AgentResume[]> => [],
    complet: async () => COMPLET,
    create: async () => COMPLET,
    patch: async (_t, _id, patch) => { cap.patches.push(patch); return { ...COMPLET, ...patch } as AgentComplet; },
    remove: async () => true,
    modeleParDefaut: 'modele-config',
    etatPourLint: async () => etat,
  };
  return { cap, srv: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, agents: deps }) };
}

describe('le lint BLOQUE l activation', () => {
  it('🔴 un agent incomplet ne peut pas être activé, et rien n’est écrit', async () => {
    const { cap, srv } = app({ fiche: ficheVide(), fichesConnaissance: 0, outilsActifs: 0, handlersActifs: [] });
    const res = await srv.inject({ method: 'PATCH', url: `/tenants/t1/agents/${AG}`, ...h(adminTok), payload: { status: 'active' } });
    // 422 et non 500 : c'est une chose que le client doit lire et corriger, et Cloudflare remplace le corps
    // d'une 5xx par sa propre page d'erreur.
    expect(res.statusCode).toBe(422);
    expect(res.json().manques).toHaveLength(5);
    expect(cap.patches).toHaveLength(0);
  });

  it('un agent complet s’active', async () => {
    const { cap, srv } = app(COMPLET_LINT());
    const res = await srv.inject({ method: 'PATCH', url: `/tenants/t1/agents/${AG}`, ...h(adminTok), payload: { status: 'active' } });
    expect(res.statusCode).toBe(200);
    expect(cap.patches[0]).toEqual({ status: 'active' });
  });

  it('🔴 le lint se calcule sur l’état EFFECTIF : vider un champ ET activer dans la MÊME requête est refusé', async () => {
    // Le corps peut porter `contenu` et `status` ensemble, et le store applique les deux d'un coup. Linter
    // l'état d'AVANT laisserait vider l'objectif et activer dans le même geste, c'est-à-dire contourner la
    // garde en une requête. C'est la règle du CLAUDE.md : une garde se calcule sur `patch ?? courant`.
    const { cap, srv } = app(COMPLET_LINT());
    const res = await srv.inject({
      method: 'PATCH', url: `/tenants/t1/agents/${AG}`, ...h(adminTok),
      payload: { contenu: { objectif: '' }, status: 'active', ficheVersionAttendue: 1 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().manques.map((m: { onglet: string }) => m.onglet)).toEqual(['objectif']);
    expect(cap.patches).toHaveLength(0);
  });

  it('et dans l’autre sens : COMBLER un manque et activer dans la même requête PASSE', async () => {
    // La garde ne doit fermer que le mauvais sens. Refuser ici obligerait à deux allers-retours pour un
    // geste légitime, et c'est exactement ce que fait la conversation de construction quand elle applique
    // une proposition puis propose d'activer.
    const incomplet = { ...COMPLET_LINT(), fiche: { ...COMPLET_LINT().fiche, objectif: '' } };
    const { cap, srv } = app(incomplet);
    const res = await srv.inject({
      method: 'PATCH', url: `/tenants/t1/agents/${AG}`, ...h(adminTok),
      payload: { contenu: { objectif: 'Cerner le besoin.' }, status: 'active', ficheVersionAttendue: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(cap.patches).toHaveLength(1);
  });

  it('🔴 le lint ne bloque QUE l’activation, jamais l’écriture d’un champ', async () => {
    // Un brouillon se remplit dans n'importe quel ordre, et la conversation de construction procède par
    // petites touches : bloquer l'écriture ferait un formulaire impossible à remplir.
    const { cap, srv } = app({ fiche: ficheVide(), fichesConnaissance: 0, outilsActifs: 0, handlersActifs: [] });
    for (const payload of [
      { contenu: { objectif: 'Cerner le besoin.' }, ficheVersionAttendue: 1 },
      { label: 'Nouveau nom' },
      { status: 'disabled' as const },
      { maxTours: 12 },
    ]) {
      const res = await srv.inject({ method: 'PATCH', url: `/tenants/t1/agents/${AG}`, ...h(adminTok), payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(200);
    }
    expect(cap.patches).toHaveLength(4);
  });

  it('un agent introuvable au moment du lint rend 404', async () => {
    const { srv } = app(null);
    const res = await srv.inject({ method: 'PATCH', url: `/tenants/t1/agents/${AG}`, ...h(adminTok), payload: { status: 'active' } });
    expect(res.statusCode).toBe(404);
  });

  it('🔴 une base REMPLIE que l’agent ne peut pas LIRE est un manque, et l’écran doit le dire', () => {
    // Le defaut vecu le 2026-09-08 : l entretien avait bien note « les reponses viennent du site », Julien
    // avait rempli la base a la main, mais l outil de recherche n avait jamais ete ajoute. L agent
    // transferait TOUTES les questions de fond, avec une base bien remplie sous les yeux.
    const m = manquesAvantActivation({ ...COMPLET_LINT(), fichesConnaissance: 4, outilsActifs: 2, handlersActifs: ['escalader', 'terminer'] });
    expect(m.map((x) => x.onglet)).toEqual(['outils']);
    expect(m[0]!.message).toMatch(/ne peut pas la lire|n’est pas actif/);
  });

  it('preuve inverse : l’outil de recherche ACTIF ne produit aucun manque', () => {
    const m = manquesAvantActivation({ ...COMPLET_LINT(), fichesConnaissance: 4, outilsActifs: 2, handlersActifs: ['escalader', 'chercher_connaissance'] });
    expect(m).toEqual([]);
  });

  it('sans AUCUN outil, un seul message : « aucun outil actif » le dit déjà, et plus fondamentalement', () => {
    // Deux messages pour un meme geste transforment une liste utile en bruit.
    const m = manquesAvantActivation({ ...COMPLET_LINT(), fichesConnaissance: 4, outilsActifs: 0, handlersActifs: [] });
    expect(m.map((x) => x.onglet)).toEqual(['outils']);
    expect(m[0]!.message).toMatch(/Aucun outil actif/);
  });
});
