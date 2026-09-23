import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { AgentsRouteDeps } from '../src/http/agents';
import { CreditInsuffisantPourCle } from '../src/agent/provisionner-cle';
import { capturerJournal } from './journal';
import type { AgentComplet, AgentResume, PatchAgent } from '../src/agent/agent-store';
import { FicheAgentPerimee, LabelAgentDejaPris } from '../src/agent/agent-store';
import { ficheVide } from '../src/agent/fiche';

/**
 * Routes des agents IA. Un agent ACTIF est proposable dans un scénario, donc il finira par écrire à de vrais
 * clients : ces routes sont un pouvoir d'envoi, comme les campagnes ou les automations.
 *
 * Ce qu'elles verrouillent :
 *  1. l'isolation tenant (la cible vient du JETON, jamais de l'URL) ;
 *  2. un agent naît en BROUILLON, quoi que dise le corps de la requête ;
 *  3. les plafonds et le modèle sont BORNÉS : une saisie ne relève pas un budget au-delà de ce que la base
 *     accepte, et n'efface pas la mention légale d'IA ;
 *  4. un PATCH partiel n'efface pas ce qu'il ne mentionne pas.
 */
/** Identifiants en forme d uuid : les routes refusent en 404 tout ce qui n en a pas la forme,
 *  parce qu un identifiant mal forme ferait LEVER Postgres sur une colonne `uuid`. */
const AG1 = '11111111-1111-4111-8111-111111111111';
const AG2 = '22222222-2222-4222-8222-222222222222';
const CONFLIT = '33333333-3333-4333-8333-333333333333';
/** Bien formé mais absent du store : c'est ce cas-là qui exerce le `if (!agent) return 404` des routes. Une
 *  chaîne quelconque, elle, serait arrêtée plus tôt par la garde de FORME et ne prouverait plus rien. */
const INCONNU = '99999999-9999-4999-8999-999999999999';

const SECRET = 'test-secret';
let adminTok = '';
let agentTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

const COMPLET: AgentComplet = {
  id: AG1, label: 'Conseiller séjours', status: 'draft',
  mentionIa: 'Vous échangez avec un assistant automatique.', modele: 'modele-test',
  maxTours: 8, maxAppelsOutils: 12, budgetMicroEur: 30_000, inactiviteMinutes: 30,
  contactInconnu: 'lecture_seule', contenu: ficheVide(), ficheVersion: 1,
};

const ACTIFS: AgentResume[] = [{ id: AG1, label: 'Conseiller séjours', status: 'active', sorties: [{ code: 'besoin_cerne', label: 'Besoin cerné' }], modele: 'anthropic/claude-haiku-4.5' }];
const TOUTES: AgentResume[] = [...ACTIFS, { id: AG2, label: 'Brouillon', status: 'draft', sorties: [], modele: 'anthropic/claude-haiku-4.5' }];

function app(cleModele?: (tenant: string) => Promise<unknown>, extra?: Partial<AgentsRouteDeps>) {
  const cap = {
    listes: [] as string[],
    ordre: [] as string[],
    crees: [] as Array<{ tenant: string; label: string; mention: string; modele: string }>,
    supprimes: [] as Array<{ tenant: string; id: string }>,
    patches: [] as Array<{ tenant: string; id: string; patch: PatchAgent }>,
  };
  const deps: AgentsRouteDeps = {
    listActifs: async (t) => { cap.listes.push(`actifs:${t}`); return ACTIFS; },
    listToutes: async (t) => { cap.listes.push(`toutes:${t}`); return TOUTES; },
    complet: async (_t, id) => (id === AG1 ? COMPLET : null),
    create: async (tenant, label, mention, modele) => {
      cap.ordre.push('create');
      cap.crees.push({ tenant, label, mention, modele });
      if (label === 'pris') throw new LabelAgentDejaPris();
      return { ...COMPLET, label };
    },
    patch: async (tenant, id, patch) => {
      cap.patches.push({ tenant, id, patch });
      if (id === CONFLIT) throw new FicheAgentPerimee();
      if (patch.label === 'pris') throw new LabelAgentDejaPris();
      return id === AG1 ? { ...COMPLET, ...patch } as AgentComplet : null;
    },
    remove: async (tenant, id) => { cap.supprimes.push({ tenant, id }); return id === AG1; },
    modeleParDefaut: 'modele-config',
    ...(cleModele ? { assurerCleModele: async (t: string) => { cap.ordre.push('cle'); return cleModele(t); } } : {}),
    ...extra,
  };
  return { cap, srv: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, agents: deps }) };
}

describe('routes agents : lecture', () => {
  it('la liste rend les agents ACTIFS par défaut, et TOUS sur demande', async () => {
    // Le défaut est le plus restrictif : un appelant distrait ne doit pas proposer un brouillon dans un
    // scénario. C'est l'écran de réglage qui demande explicitement à voir ses brouillons.
    const { cap, srv } = app();
    expect((await srv.inject({ method: 'GET', url: '/tenants/t1/agents', ...h(adminTok) })).json()).toEqual({ agents: ACTIFS });
    expect((await srv.inject({ method: 'GET', url: '/tenants/t1/agents?statut=tous', ...h(adminTok) })).json()).toEqual({ agents: TOUTES });
    expect(cap.listes).toEqual(['actifs:t1', 'toutes:t1']);
  });

  it('la fiche entière se lit par son identifiant, et 404 sinon', async () => {
    const { srv } = app();
    expect((await srv.inject({ method: 'GET', url: `/tenants/t1/agents/${AG1}`, ...h(adminTok) })).json()).toEqual({ agent: COMPLET });
    expect((await srv.inject({ method: 'GET', url: `/tenants/t1/agents/${INCONNU}`, ...h(adminTok) })).statusCode).toBe(404);
  });

  it('🔴 le tenant vient du JETON, jamais de l URL', async () => {
    const { cap, srv } = app();
    expect((await srv.inject({ method: 'GET', url: '/tenants/t2/agents', ...h(adminTok) })).statusCode).toBe(403);
    expect((await srv.inject({ method: 'GET', url: `/tenants/t2/agents/${AG1}`, ...h(adminTok) })).statusCode).toBe(403);
    expect(cap.listes).toEqual([]);
  });

  it('🔴 réservée aux ADMINISTRATEURS, comme le builder qu elle sert', async () => {
    const { srv } = app();
    expect((await srv.inject({ method: 'GET', url: '/tenants/t1/agents', ...h(agentTok) })).statusCode).toBe(403);
    expect((await srv.inject({ method: 'POST', url: '/tenants/t1/agents', ...h(agentTok), payload: { label: 'X' } })).statusCode).toBe(403);
  });

  it('sans jeton, tout est refusé', async () => {
    const { srv } = app();
    expect((await srv.inject({ method: 'GET', url: '/tenants/t1/agents' })).statusCode).toBe(401);
  });
});

describe('routes agents : création', () => {
  it('🔴 un agent naît en BROUILLON, et le corps ne peut PAS en décider', async () => {
    // Un agent créé actif serait proposable dans un scénario avant que quiconque ait relu ce qu'il dira.
    // Le statut n'est même pas transmis au store : c'est le défaut de la colonne qui décide.
    const { cap, srv } = app();
    const res = await srv.inject({ method: 'POST', url: '/tenants/t1/agents', ...h(adminTok), payload: { label: 'Conseiller', status: 'active' } });
    expect(res.statusCode).toBe(201);
    expect(res.json().agent.status).toBe('draft');
    expect(cap.crees[0]).toMatchObject({ tenant: 't1', label: 'Conseiller' });
  });

  it('la mention d IA et le modèle viennent du SERVEUR, pas du corps', async () => {
    // La mention est une obligation légale (AI Act, article 50) : la laisser au client créerait des agents
    // muets sur leur nature que personne ne penserait à compléter.
    const { cap, srv } = app();
    await srv.inject({ method: 'POST', url: '/tenants/t1/agents', ...h(adminTok), payload: { label: 'X', mentionIa: '', mentionIaFrequence: 'session' as const, modele: 'gpt-pirate' } });
    expect(cap.crees[0]?.mention.length).toBeGreaterThan(10);
    expect(cap.crees[0]?.modele).toBe('modele-config');
  });

  /**
   * 🔴 LE RÉGIME D'ANNONCE A DÉMÉNAGÉ VERS L'ESPACE (migration 0140), ET CE CAS GARDE LE DÉMÉNAGEMENT.
   * Le test d'avant vérifiait qu'on pouvait le régler ICI ; son remplaçant vit dans
   * `tests/http-securite-ia.test.ts`, qui vérifie qu'on le règle LÀ-BAS, pour tout l'espace.
   *
   * 🔴 CE QUI EST VÉRIFIÉ ICI EST L'AUTRE MOITIÉ, et elle n'est pas cosmétique : `z.object()` retire une
   * clé inconnue EN SILENCE. Sans refus explicite, un onglet resté ouvert sur l'ancienne console enverrait
   * encore ce champ, recevrait 200, et le choix du client serait perdu sans que personne ne l'apprenne.
   */
  it('🔴 le régime d’annonce d’IA n’est plus un champ d’agent, et le refus DIT où il est parti', async () => {
    const { cap, srv } = app();
    const res = await srv.inject({ method: 'PATCH', url: `/tenants/t1/agents/${AG1}`, ...h(adminTok), payload: { mentionIaFrequence: 'jamais' } });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('settings/mention-ia');
    expect(cap.patches, 'rien n’a été écrit sur l’agent').toHaveLength(0);
  });

  it('un label vide est refusé', async () => {
    const { srv } = app();
    expect((await srv.inject({ method: 'POST', url: '/tenants/t1/agents', ...h(adminTok), payload: { label: '  ' } })).statusCode).toBe(400);
  });

  /**
   * LA CLÉ DE MODÈLE DE L'ESPACE (2026-09-09, demande de Julien).
   *
   * 🔴 Le bac à sable appelle VRAIMENT le modèle : un agent né sans clé propre se mettrait au point sur
   * notre argent, et sa dépense ne serait attribuée à personne. D'où le refus, choisi par Julien.
   */
  it('🔴 la clé est provisionnée AVANT l’agent, jamais après', async () => {
    // L'ordre EST le contrôle : créer d'abord et provisionner ensuite laisserait, à chaque panne de Vercel,
    // exactement l'agent sans clé que le refus existe pour empêcher.
    const { cap, srv } = app(async () => ({ cleId: 'key_x' }));
    const res = await srv.inject({ method: 'POST', url: '/tenants/t1/agents', ...h(adminTok), payload: { label: 'A' } });
    expect(res.statusCode).toBe(201);
    expect(cap.ordre).toEqual(['cle', 'create']);
  });

  it('🔴 provisionnement en échec -> 422 et AUCUN agent créé', async () => {
    // 422 et non 5xx : Cloudflare remplace le corps de toute réponse 5xx par sa page d'erreur, donc le
    // message se perdrait exactement quand il sert.
    const { cap, srv } = app(async () => { throw new Error('vercel indisponible'); });
    const res = await srv.inject({ method: 'POST', url: '/tenants/t1/agents', ...h(adminTok), payload: { label: 'A' } });
    expect(res.statusCode).toBe(422);
    expect(cap.crees).toHaveLength(0);
    expect(cap.ordre).toEqual(['cle']);
  });

  it('🔴 crédit insuffisant -> 422 qui dit de RECHARGER, pas « réessayez »', async () => {
    // Les deux échecs se ressemblent et n'appellent pas la même action : l'un se résout en attendant, l'autre
    // en payant. Un message unique enverrait la moitié des clients réessayer indéfiniment.
    const { srv } = app(async () => { throw new CreditInsuffisantPourCle(0); });
    const { resultat: res, lignes } = await capturerJournal(() => srv.inject({ method: 'POST', url: '/tenants/t1/agents', ...h(adminTok), payload: { label: 'A' } }));
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/crédit|Rechargez/i);
    // Journalisé côté serveur en plus, comme le promet la route : ce 422 est la seule trace côté client.
    expect(lignes.find((l) => l.msg === 'cle_modele_non_provisionnee')).toMatchObject({ lvl: 'error', tenantId: 't1' });
  });

  it('🔴 dépendance ABSENTE : la création se comporte comme avant', async () => {
    // La preuve inverse, et elle protège le déploiement : tant que le jeton Vercel n'est pas posé, ce lot ne
    // doit rien changer. Sans ce cas, un refus inconditionnel passerait les trois tests ci-dessus.
    const { cap, srv } = app();
    const res = await srv.inject({ method: 'POST', url: '/tenants/t1/agents', ...h(adminTok), payload: { label: 'A' } });
    expect(res.statusCode).toBe(201);
    expect(cap.ordre).toEqual(['create']);
  });
});

describe('routes agents : modification', () => {
  it('un patch partiel ne transmet QUE ce qu il mentionne', async () => {
    const { cap, srv } = app();
    const res = await srv.inject({ method: 'PATCH', url: `/tenants/t1/agents/${AG1}`, ...h(adminTok), payload: { label: 'Nouveau nom' } });
    expect(res.statusCode).toBe(200);
    expect(cap.patches[0]?.patch).toEqual({ label: 'Nouveau nom' });
  });

  it('la fiche passe par son schéma, et une sortie mal formée est REFUSÉE', async () => {
    // Le code d'une règle d'arrêt devient un handle d'arête `sortie:<code>` : un caractère exotique y
    // produirait des écarts silencieux entre ce que le builder dessine et ce que le moteur route.
    const { srv } = app();
    const bon = await srv.inject({
      method: 'PATCH', url: `/tenants/t1/agents/${AG1}`, ...h(adminTok),
      payload: { contenu: { nom: 'Léa', objectif: 'Renseigner', ton: '', personnalite: '', reglesTransfert: '', sorties: [{ code: 'besoin_cerne', label: 'Besoin cerné' }] } },
    });
    expect(bon.statusCode).toBe(200);

    const mauvais = await srv.inject({
      method: 'PATCH', url: `/tenants/t1/agents/${AG1}`, ...h(adminTok),
      payload: { contenu: { sorties: [{ code: 'Besoin Cerné', label: 'x' }] } },
    });
    expect(mauvais.statusCode).toBe(400);
    expect(mauvais.json().error).toContain('sorties');
  });

  it('🔴 les plafonds sont BORNÉS : une saisie ne relève pas le budget au-delà de la base', async () => {
    // Les mêmes bornes qu'en base (migration 0086). Sans elles, la base refuserait de toute façon, mais en
    // 500, dont Cloudflare remplace le corps : le client ne saurait pas quel champ corriger.
    const { srv } = app();
    for (const payload of [
      { maxTours: 0 }, { maxTours: 21 }, { maxAppelsOutils: -1 }, { maxAppelsOutils: 61 },
      { budgetMicroEur: 0 }, { inactiviteMinutes: 0 }, { inactiviteMinutes: 1441 },
      { contactInconnu: 'tout_ouvert' }, { status: 'super_actif' }, { mentionIa: '' }, { mentionIa: '   ' },
    ]) {
      const res = await srv.inject({ method: 'PATCH', url: `/tenants/t1/agents/${AG1}`, ...h(adminTok), payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('un patch vide est refusé plutôt que d écrire un tour pour rien', async () => {
    const { cap, srv } = app();
    expect((await srv.inject({ method: 'PATCH', url: `/tenants/t1/agents/${AG1}`, ...h(adminTok), payload: {} })).statusCode).toBe(400);
    expect(cap.patches).toEqual([]);
  });

  it('🔴 un patch de fiche ne transmet QUE les clés mentionnées', async () => {
    // La fusion jsonb du store ne protège que les clés ABSENTES du patch. Si la route en ajoutait (c'est ce
    // que faisait `ficheAgentSchema.partial()`, dont le `.default()` survit au `.partial()`), la fusion
    // n'aurait plus rien à protéger et enregistrer l'objectif effacerait le ton et toutes les règles d'arrêt.
    const { cap, srv } = app();
    await srv.inject({
      method: 'PATCH', url: `/tenants/t1/agents/${AG1}`, ...h(adminTok),
      payload: { contenu: { objectif: 'Cerner le besoin.' }, ficheVersionAttendue: 1 },
    });
    expect(Object.keys(cap.patches[0]!.patch.contenu ?? {})).toEqual(['objectif']);
  });

  it('un agent inconnu rend 404, pas une écriture silencieuse', async () => {
    const { srv } = app();
    expect((await srv.inject({ method: 'PATCH', url: `/tenants/t1/agents/${INCONNU}`, ...h(adminTok), payload: { label: 'X' } })).statusCode).toBe(404);
  });

  it('🔴 activer un agent est possible, c est le seul geste qui le rend proposable', async () => {
    const { cap, srv } = app();
    const res = await srv.inject({ method: 'PATCH', url: `/tenants/t1/agents/${AG1}`, ...h(adminTok), payload: { status: 'active' } });
    expect(res.statusCode).toBe(200);
    expect(cap.patches[0]?.patch).toEqual({ status: 'active' });
  });

  it('🔴 un label DÉJÀ PRIS rend 409, pas une page d erreur Cloudflare', async () => {
    // L'index unique de la migration 0086 remontait en 500, dont Cloudflare remplace le corps : le client
    // voyait une panne là où il avait simplement choisi un nom déjà utilisé.
    const { srv } = app();
    expect((await srv.inject({ method: 'POST', url: '/tenants/t1/agents', ...h(adminTok), payload: { label: 'pris' } })).statusCode).toBe(409);
    expect((await srv.inject({ method: 'PATCH', url: `/tenants/t1/agents/${AG1}`, ...h(adminTok), payload: { label: 'pris' } })).statusCode).toBe(409);
  });

  it('🔴 une fiche PÉRIMÉE rend 409 : deux surfaces ne s écrasent pas en silence', async () => {
    const { srv } = app();
    const res = await srv.inject({
      method: 'PATCH', url: `/tenants/t1/agents/${CONFLIT}`, ...h(adminTok),
      payload: { contenu: { objectif: 'x' }, ficheVersionAttendue: 3 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('changé');
  });

  it('une version SEULE ne modifie rien : ce n est pas un patch', async () => {
    const { cap, srv } = app();
    expect((await srv.inject({ method: 'PATCH', url: `/tenants/t1/agents/${AG1}`, ...h(adminTok), payload: { ficheVersionAttendue: 2 } })).statusCode).toBe(400);
    expect(cap.patches).toEqual([]);
  });

  it('les écritures sont admin-only, PATCH et DELETE compris', async () => {
    const { srv } = app();
    expect((await srv.inject({ method: 'PATCH', url: `/tenants/t1/agents/${AG1}`, ...h(agentTok), payload: { label: 'X' } })).statusCode).toBe(403);
    expect((await srv.inject({ method: 'DELETE', url: `/tenants/t1/agents/${AG1}`, ...h(agentTok) })).statusCode).toBe(403);
    expect((await srv.inject({ method: 'GET', url: `/tenants/t1/agents/${AG1}`, ...h(agentTok) })).statusCode).toBe(403);
  });
});

describe('routes agents : suppression', () => {
  it('supprime, et 404 sur un agent inconnu', async () => {
    // Sans cette route, un agent créé avec un nom malheureux ne pouvait être ni renommé vers un nom occupé,
    // ni retiré : le workspace gardait une ligne morte pour toujours.
    const { cap, srv } = app();
    expect((await srv.inject({ method: 'DELETE', url: `/tenants/t1/agents/${AG1}`, ...h(adminTok) })).statusCode).toBe(204);
    expect(cap.supprimes[0]).toEqual({ tenant: 't1', id: AG1 });
    expect((await srv.inject({ method: 'DELETE', url: `/tenants/t1/agents/${INCONNU}`, ...h(adminTok) })).statusCode).toBe(404);
  });

  it('🔴 un identifiant qui n’a pas la forme d’un uuid rend 404, pas une erreur de base', async () => {
    // Sans ce contrôle, la valeur part telle quelle dans un `where id = $1` sur une colonne `uuid`, Postgres
    // LÈVE (22P02) et la console rend un 500, dont Cloudflare remplace le corps par sa page d'erreur.
    const { cap, srv } = app();
    for (const [method, payload] of [['GET', undefined], ['PATCH', { label: 'X' }], ['DELETE', undefined]] as const) {
      const res = await srv.inject({ method, url: '/tenants/t1/agents/pas-un-uuid', ...h(adminTok), ...(payload ? { payload } : {}) });
      expect(res.statusCode, method).toBe(404);
    }
    expect(cap.patches).toHaveLength(0);
    expect(cap.supprimes).toHaveLength(0);
  });

  it('🔴 la cible vient du JETON, jamais de l URL', async () => {
    const { cap, srv } = app();
    expect((await srv.inject({ method: 'DELETE', url: `/tenants/t2/agents/${AG1}`, ...h(adminTok) })).statusCode).toBe(403);
    expect(cap.supprimes).toEqual([]);
  });
});

describe('routes agents : le modèle par défaut', () => {
  it('🔴 sans modèle configuré côté serveur, la création est REFUSÉE', async () => {
    // Un agent sans modèle serait activable et muet au premier tour, et personne ne saurait pourquoi.
    const srv = buildServer({
      queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET },
      agents: {
        listActifs: async () => [], listToutes: async () => [], complet: async () => null,
        create: async () => COMPLET, patch: async () => null, remove: async () => false,
        modeleParDefaut: '',
      },
    });
    const res = await srv.inject({ method: 'POST', url: '/tenants/t1/agents', ...h(adminTok), payload: { label: 'X' } });
    expect(res.statusCode).toBe(422);
  });
});

describe('GET /tenants/:tenantId/agents/:agentId/messages', () => {
  it('rend le compte et la fenêtre', async () => {
    const { srv } = app(undefined, { messagesAgent: async () => 412 });
    const res = await srv.inject({ method: 'GET', url: `/tenants/t1/agents/${AG1}/messages`, ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ messages: 412, jours: 30 });
  });

  it('🔴 rend null, PAS zéro, quand la dépendance est absente', async () => {
    // Même convention que `/consommation` juste à côté : un zéro se lirait « cet agent n a parlé à
    // personne », alors que la vérité est « cette instance ne sait pas compter ».
    const { srv } = app();
    const res = await srv.inject({ method: 'GET', url: `/tenants/t1/agents/${AG1}/messages`, ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ messages: null, jours: 30 });
  });

  it('🔴 refuse un identifiant d agent mal formé AVANT de toucher au store', async () => {
    // Un identifiant non-uuid dans un `where` sur une colonne uuid fait LEVER Postgres (500), il ne rend
    // pas zéro. L'ordre des gardes n'est pas décoratif.
    let appele = false;
    const { srv } = app(undefined, { messagesAgent: async () => { appele = true; return 1; } });
    const res = await srv.inject({ method: 'GET', url: '/tenants/t1/agents/pas-un-uuid/messages', ...h(adminTok) });
    expect(res.statusCode).toBe(404);
    expect(appele).toBe(false);
  });
});
