import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { AgentsRouteDeps } from '../src/http/agents';
import type { AgentComplet, AgentResume, PatchAgent } from '../src/agent/agent-store';
import { avertissements, manquesAvantActivation, type EtatPourLint } from '../src/agent/setup/lint';
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
  outilsMcpDebranches: [],
});

describe('un outil que le rafraichissement MCP a DEBRANCHE', () => {
  /**
   * 🔴 LA PERTE ETAIT MUETTE, et c est tout le sujet. Quand le schema d un outil MCP change, le
   * consentement TOMBE (0127 : il porte sur un outil PRECIS) ; c est la bonne decision, mais elle se
   * prenait sans que personne en soit informe. L agent perdait du jour au lendemain une capacite que
   * quelqu un avait explicitement autorisee, et aucun ecran ne portait la cause.
   */
  it('produit un avertissement qui NOMME l outil', () => {
    const a = avertissements({ ...COMPLET_LINT(), outilsMcpDebranches: ['notion_search'] });
    expect(a).toHaveLength(1);
    expect(a[0]!.onglet).toBe('outils');
    expect(a[0]!.message).toContain('notion_search');
    expect(a[0]!.message).toContain('réautoriser');
  });

  it('les nomme TOUS quand il y en a plusieurs : « un outil » enverrait chercher lequel', () => {
    const a = avertissements({ ...COMPLET_LINT(), outilsMcpDebranches: ['a_un', 'b_deux'] });
    expect(a[0]!.message).toContain('a_un');
    expect(a[0]!.message).toContain('b_deux');
  });

  it('🔴 NE BLOQUE PAS l activation : un serveur tiers n a pas de droit de veto sur l agent d un client', () => {
    // La separation est MECANIQUE, pas cosmetique : `manquesAvantActivation` est AUSSI la garde dure de
    // `status = 'active'` (`src/http/agents.ts`), donc tout ce qu on y verse bloque. Un serveur distant
    // qui change son schema pourrait alors empecher un client d activer son agent.
    const etat = { ...COMPLET_LINT(), outilsMcpDebranches: ['notion_search'] };
    expect(manquesAvantActivation(etat)).toEqual([]);
    expect(avertissements(etat)).toHaveLength(1);
  });

  it('ne dit rien quand il n y a rien a dire', () => {
    expect(avertissements(COMPLET_LINT())).toEqual([]);
  });
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
    expect(manquesAvantActivation({ fiche: ficheVide(), fichesConnaissance: 0, outilsActifs: 0, handlersActifs: [], outilsMcpDebranches: [] })).toHaveLength(5);
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

function app(etat: EtatPourLint | null, modeles?: AgentsRouteDeps['modelesProposes']) {
  const cap = { patches: [] as PatchAgent[] };
  const deps: AgentsRouteDeps = {
    ...(modeles ? { modelesProposes: modeles } : {}),
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
    const { cap, srv } = app({ fiche: ficheVide(), fichesConnaissance: 0, outilsActifs: 0, handlersActifs: [], outilsMcpDebranches: [] });
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
    const { cap, srv } = app({ fiche: ficheVide(), fichesConnaissance: 0, outilsActifs: 0, handlersActifs: [], outilsMcpDebranches: [] });
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

describe('les manques se LISENT, sans rien tenter', () => {
  /**
   * 🔴 LE DÉFAUT QUE CETTE ROUTE FERME (2026-09-08). Le lint existait, mais il ne parlait que dans le corps
   * d'un 422, donc seulement si on cliquait « activer ». L'agent de Julien était en BROUILLON, avec dix
   * fiches de connaissance et l'outil de recherche désactivé : il l'essayait dans le bac à sable, rien ne
   * trouvait rien, et la réponse était déjà calculée quelque part sans que personne ne la lui dise.
   */
  it('🔴 GET /manques rend la MÊME liste que la garde d’activation', async () => {
    // La même fonction des deux côtés : deux inventaires de ce qui manque finiraient par diverger, et le
    // client croirait avoir fini sur un écran et pas sur l'autre.
    const etat = { ...COMPLET_LINT(), fichesConnaissance: 10, outilsActifs: 2, handlersActifs: ['terminer'] };
    const { srv } = app(etat);
    const res = await srv.inject({ method: 'GET', url: `/tenants/t1/agents/${AG}/manques`, ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    const manques = res.json<{ manques: Array<{ onglet: string; message: string }> }>().manques;
    expect(manques.map((m) => m.onglet)).toEqual(['outils']);
    expect(manques[0]!.message).toContain('Chercher dans la base de connaissance');
    expect(manques).toEqual(manquesAvantActivation(etat));
  });

  it('un agent complet ne manque de rien', async () => {
    // Preuve inverse : sans elle, une route qui rendrait toujours une liste passerait le cas ci-dessus.
    const { srv } = app(COMPLET_LINT());
    const res = await srv.inject({ method: 'GET', url: `/tenants/t1/agents/${AG}/manques`, ...h(adminTok) });
    expect(res.json().manques).toEqual([]);
  });

  it('🔴 elle NE MODIFIE RIEN : aucun patch n’est écrit', async () => {
    // Une route de lecture qui écrirait serait le pire des deux mondes : l'écran l'appelle à chaque
    // ouverture de fiche.
    const { cap, srv } = app({ fiche: ficheVide(), fichesConnaissance: 0, outilsActifs: 0, handlersActifs: [], outilsMcpDebranches: [] });
    await srv.inject({ method: 'GET', url: `/tenants/t1/agents/${AG}/manques`, ...h(adminTok) });
    expect(cap.patches).toHaveLength(0);
  });

  it('agent inconnu -> 404, câblage absent -> 503, jamais une liste vide qui dirait « tout va bien »', async () => {
    const { srv } = app(null);
    expect((await srv.inject({ method: 'GET', url: `/tenants/t1/agents/${AG}/manques`, ...h(adminTok) })).statusCode).toBe(404);

    const sansLint = buildServer({
      queue: new FakeQueue(),
      auth: { users: noUsers, secret: SECRET },
      agents: {
        listActifs: async (): Promise<AgentResume[]> => [], listToutes: async (): Promise<AgentResume[]> => [],
        complet: async () => COMPLET, create: async () => COMPLET, patch: async () => COMPLET, remove: async () => true,
        modeleParDefaut: 'modele-config',
      },
    });
    expect((await sansLint.inject({ method: 'GET', url: `/tenants/t1/agents/${AG}/manques`, ...h(adminTok) })).statusCode).toBe(503);
  });

  it('tenant croisé -> 403', async () => {
    const { srv } = app(COMPLET_LINT());
    expect((await srv.inject({ method: 'GET', url: `/tenants/AUTRE/agents/${AG}/manques`, ...h(adminTok) })).statusCode).toBe(403);
  });
});

/**
 * LA LISTE DÉROULANTE DES MODÈLES (2026-09-09, demande de Julien).
 *
 * 🔴 CE QUE CES CAS FERMENT. Le champ « Modèle » était une saisie libre bornée à 120 caractères : un
 * identifiant mal tapé passait l'enregistrement sans un mot, et ne se voyait qu'au premier message d'un
 * client, quand le Gateway rendait un 404 sur un modèle inconnu. La liste rend le geste impossible depuis
 * l'écran ; la garde ci-dessous le rend impossible tout court, y compris par l'API.
 */
describe('les modèles se choisissent dans une LISTE', () => {
  const propose = async () => [
    { id: 'zai/glm-4.7-flash', nom: 'GLM 4.7 Flash', prixEntree: 0.07, prixSortie: 0.4 },
    { id: 'anthropic/claude-haiku-4.5', nom: 'Claude Haiku 4.5', prixEntree: 1.01, prixSortie: 5.06 },
  ];

  it('la route rend la liste et ses tarifs', async () => {
    const { srv } = app(COMPLET_LINT(), propose);
    const res = await srv.inject({ method: 'GET', url: '/tenants/t1/agents/modeles', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json().modeles).toEqual(await propose());
  });

  it('🔴 SANS câblage de tarification, la route rend quand même nos modèles, sans prix', async () => {
    // Un 503 viderait le menu, donc interdirait de changer de modèle : une panne de tarification n'a pas à
    // empêcher un réglage.
    const { srv } = app(COMPLET_LINT());
    const res = await srv.inject({ method: 'GET', url: '/tenants/t1/agents/modeles', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    const modeles = res.json<{ modeles: Array<{ id: string; prixEntree: number | null }> }>().modeles;
    expect(modeles).toHaveLength(10);
    expect(modeles.every((m) => m.prixEntree === null)).toBe(true);
  });

  it('🔴 `modeles` ne se fait PAS prendre pour un identifiant d’agent', async () => {
    // Les deux routes partagent le préfixe `/agents/`. Si le segment fixe perdait sa priorité, cette adresse
    // tomberait sur `/agents/:agentId` et rendrait un 404 « agent introuvable » que personne ne saurait lire.
    const { srv } = app(COMPLET_LINT(), propose);
    expect((await srv.inject({ method: 'GET', url: '/tenants/t1/agents/modeles', ...h(adminTok) })).statusCode).toBe(200);
  });

  it('tenant croisé -> 403, comme toute lecture', async () => {
    const { srv } = app(COMPLET_LINT(), propose);
    expect((await srv.inject({ method: 'GET', url: '/tenants/AUTRE/agents/modeles', ...h(adminTok) })).statusCode).toBe(403);
  });

  it('🔴 un modèle HORS LISTE est refusé en 400, avec le nom fautif', async () => {
    const { cap, srv } = app(COMPLET_LINT(), propose);
    const res = await srv.inject({
      method: 'PATCH', url: `/tenants/t1/agents/${AG}`, ...h(adminTok),
      payload: { modele: 'anthropic/claude-haiku-45' }, // le point manquant : la faute de frappe typique
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('anthropic/claude-haiku-45');
    expect(cap.patches).toHaveLength(0); // et rien n'a été écrit
  });

  it('un modèle DE LA LISTE passe', async () => {
    // La preuve inverse : sans elle, une garde qui refuserait tout passerait le cas ci-dessus.
    const { cap, srv } = app(COMPLET_LINT(), propose);
    const res = await srv.inject({
      method: 'PATCH', url: `/tenants/t1/agents/${AG}`, ...h(adminTok),
      payload: { modele: 'anthropic/claude-haiku-4.5' },
    });
    expect(res.statusCode).toBe(200);
    expect(cap.patches).toEqual([{ modele: 'anthropic/claude-haiku-4.5' }]);
  });

  it('🔴 le DÉFAUT du serveur passe même hors liste, sinon changer `AGENT_MODEL` casserait l’onglet', async () => {
    const { srv } = app(COMPLET_LINT(), propose);
    const res = await srv.inject({
      method: 'PATCH', url: `/tenants/t1/agents/${AG}`, ...h(adminTok),
      payload: { modele: 'modele-config' }, // `modeleParDefaut` du câblage de test
    });
    expect(res.statusCode).toBe(200);
  });

  it('la garde ne touche QUE le modèle : les autres champs passent comme avant', async () => {
    const { srv } = app(COMPLET_LINT(), propose);
    const res = await srv.inject({
      method: 'PATCH', url: `/tenants/t1/agents/${AG}`, ...h(adminTok), payload: { maxTours: 5 },
    });
    expect(res.statusCode).toBe(200);
  });
});
