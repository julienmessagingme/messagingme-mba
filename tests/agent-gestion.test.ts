import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { AgentsRouteDeps } from '../src/http/agents';
import type { AgentComplet, AgentResume, PatchAgent, StatutAgent } from '../src/agent/agent-store';
import { ficheVide } from '../src/agent/fiche';
import { changerStatut, modifierAgent, type AuteurModification } from '../src/agent/gestion';
import type { LigneHistorique } from '../src/reglages/historique';
import { agentsInertes } from './routes-inertes';
import { capturerJournal } from './journal';
import type { AuditSink } from '../src/audit/journal';
import { IDS_MODELES_CHOISIS } from '../src/agent/modeles';

/**
 * LA GESTION D'UN AGENT IA (lot 8a) : les deux changements voulus de la spec, section 3.
 *
 *  1. 🔴 Le contrôle de complétude se relance quand on modifie la FICHE d'un agent ACTIF. Vider l'objectif d'un agent
 *     actif passait sans rien dire, et partait en production aussitôt (la fiche n'a pas de version publiée).
 *  2. 🔴 Chaque modification laisse sa ligne `fiche_agent` dans l'historique des réglages, avec l'auteur et la porte
 *     (`formulaire` depuis la console, `mcp` depuis Claude).
 *
 * Testés par la fonction ET par la route : la route n'est qu'une traduction, mais c'est elle que la console appelle.
 */
const AG = '11111111-1111-4111-8111-111111111111';
const SECRET = 'test-secret';
let adminTok = '';
beforeAll(async () => { adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET); });
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

const FICHE_COMPLETE = {
  ...ficheVide(),
  objectif: 'Cerner le besoin puis proposer un essai.',
  reglesTransfert: 'Dès qu’on parle de remboursement.',
  sorties: [{ code: 'besoin_cerne', label: 'Besoin cerné' }],
};

/**
 * Un agent en mémoire, que le patch fusionne comme le SQL (colonnes remplacées, fiche clé par clé), et dont l'état de
 * lint se relit : le contrôle doit voir ce que la base verrait.
 */
function monter(o: { statut: StatutAgent; fichesConnaissance?: number; historiqueCasse?: boolean }) {
  let agent: AgentComplet = {
    id: AG, label: 'Conseiller', status: o.statut,
    mentionIa: 'Vous échangez avec un assistant automatique.', modele: 'modele-config',
    maxTours: 8, maxAppelsOutils: 12, budgetMicroEur: 30_000, inactiviteMinutes: 30,
    contactInconnu: 'lecture_seule', contenu: FICHE_COMPLETE, ficheVersion: 1,
  };
  const cap = { patches: [] as PatchAgent[], lignes: [] as LigneHistorique[], audits: [] as Array<{ tenant: string; acteur: { userId: string | null; email: string | null }; action: string; cible: { kind: string; id: string }; detail: Record<string, unknown> | undefined }> };
  const audits = cap.audits;
  const audit: AuditSink = async (tenant, acteur, action, cible, detail) => { audits.push({ tenant, acteur, action, cible, detail }); };
  const deps: AgentsRouteDeps = {
    ...agentsInertes,
    audit,
    agents: {
      listActifs: async (): Promise<AgentResume[]> => [],
      listToutes: async (): Promise<AgentResume[]> => [],
      complet: async (_t, id) => (id === AG ? agent : null),
      create: async () => agent,
      patch: async (_t, id, patch) => {
        if (id !== AG) return null;
        cap.patches.push(patch);
        const { contenu, ficheVersionAttendue: _v, ...colonnes } = patch;
        agent = { ...agent, ...colonnes, contenu: { ...agent.contenu, ...(contenu ?? {}) }, ficheVersion: agent.ficheVersion + (contenu ? 1 : 0) };
        return agent;
      },
      remove: async () => true,
    },
    modeleParDefaut: 'modele-config',
    etatPourLint: async (_t, id) => (id === AG ? {
      fiche: agent.contenu, fichesConnaissance: o.fichesConnaissance ?? 3,
      outilsActifs: 2, handlersActifs: ['chercher_connaissance', 'terminer'], outilsMcpDebranches: [],
    } : null),
    historique: {
      ecrire: async (_t, l) => {
        if (o.historiqueCasse) throw new Error('base indisponible');
        cap.lignes.push(l);
      },
    },
  };
  return { cap, deps, srv: () => buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, agents: deps }) };
}

const CONSOLE: AuteurModification = { userId: 'u1', origine: 'formulaire' };
const CLAUDE: AuteurModification = { userId: 'u9', origine: 'mcp' };

describe('🔴 le contrôle de complétude, sur un agent ACTIF qu’on modifie', () => {
  it('vider l’objectif d’un agent actif est REFUSÉ avec le manque, et rien n’est écrit (fonction)', async () => {
    const m = monter({ statut: 'active' });
    const r = await modifierAgent(m.deps, 't1', AG, { contenu: { objectif: '' } }, CONSOLE);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.statut).toBe(422);
    expect(r.details?.manques).toEqual([expect.objectContaining({ onglet: 'objectif' })]);
    expect(m.cap.patches).toHaveLength(0);
    expect(m.cap.lignes).toHaveLength(0);
  });

  it('…et par la route de la console : 422, la liste des manques dans le corps', async () => {
    const m = monter({ statut: 'active' });
    const res = await m.srv().inject({
      method: 'PATCH', url: `/tenants/t1/agents/${AG}`, ...h(adminTok), payload: { contenu: { sorties: [] } },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toContain('agent actif');
    expect(res.json().manques.map((x: { message: string }) => x.message).join(' ')).toContain('règle d’arrêt');
    expect(m.cap.patches).toHaveLength(0);
  });

  it('un BROUILLON se remplit dans le désordre : vider son objectif passe', async () => {
    const m = monter({ statut: 'draft' });
    const r = await modifierAgent(m.deps, 't1', AG, { contenu: { objectif: '' } }, CONSOLE);
    expect(r.ok).toBe(true);
    expect(m.cap.patches).toHaveLength(1);
  });

  it('⚠️ un manque DÉJÀ LÀ ne bloque pas une retouche de la fiche : on ne refuse que ce que la modification introduit', async () => {
    // La connaissance s'est vidée après l'activation (aucune route ne l'interdit). Refuser alors toute retouche de la
    // fiche enfermerait le client : il ne pourrait plus ni corriger le ton, ni avancer pas à pas.
    const m = monter({ statut: 'active', fichesConnaissance: 0 });
    const r = await modifierAgent(m.deps, 't1', AG, { contenu: { ton: 'Chaleureux.' } }, CONSOLE);
    expect(r.ok).toBe(true);
    // Mais vider l'objectif, lui, reste refusé, et seul CE manque est rendu.
    const vide = await modifierAgent(m.deps, 't1', AG, { contenu: { objectif: '   ' } }, CONSOLE);
    expect(vide.ok).toBe(false);
    if (!vide.ok) expect((vide.details?.manques as unknown[]).length).toBe(1);
  });

  it('une colonne (le libellé, un plafond) ne crée aucun manque : elle passe sur un agent actif', async () => {
    const m = monter({ statut: 'active', fichesConnaissance: 0 });
    expect((await modifierAgent(m.deps, 't1', AG, { label: 'Nouveau', maxTours: 4 }, CONSOLE)).ok).toBe(true);
  });

  it('désactiver un agent actif passe toujours : c’est la sortie pour le remanier', async () => {
    const m = monter({ statut: 'active', fichesConnaissance: 0 });
    expect((await changerStatut(m.deps, 't1', AG, 'disabled', CONSOLE)).ok).toBe(true);
  });

  it('activer un agent incomplet est refusé avec TOUS ses manques, comme avant (changerStatut)', async () => {
    const m = monter({ statut: 'draft', fichesConnaissance: 0 });
    const r = await changerStatut(m.deps, 't1', AG, 'active', CLAUDE);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.statut).toBe(422);
    expect(r.erreur).toBe('agent incomplet');
    expect(r.details?.manques).toEqual([expect.objectContaining({ onglet: 'connaissance' })]);
  });
});

describe('🔴 chaque modification laisse sa ligne `fiche_agent` dans l’historique', () => {
  it('par la route : origine `formulaire`, l’auteur du JETON, et seulement les champs nommés, avant et après', async () => {
    const m = monter({ statut: 'draft' });
    const res = await m.srv().inject({
      method: 'PATCH', url: `/tenants/t1/agents/${AG}`, ...h(adminTok),
      payload: { label: 'Conseiller séjours', contenu: { ton: 'Chaleureux.' }, ficheVersionAttendue: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(m.cap.lignes).toHaveLength(1);
    expect(m.cap.lignes[0]).toMatchObject({
      surface: 'agent', surfaceId: AG, element: 'fiche_agent', operation: 'modification',
      origine: 'formulaire', acteurId: 'u1',
      avant: { label: 'Conseiller', contenu: { ton: '' } },
      apres: { label: 'Conseiller séjours', contenu: { ton: 'Chaleureux.' } },
    });
    // Ni la version (elle accompagne un patch, elle n'en est pas un), ni les champs que personne n'a touchés.
    expect(Object.keys(m.cap.lignes[0]!.apres as object).sort()).toEqual(['contenu', 'label']);
    expect(m.cap.lignes[0]!.libelle).toContain('ton');
  });

  it('🔴 la console renvoie la fiche ENTIÈRE : la ligne ne cite que le champ qui a changé', async () => {
    const m = monter({ statut: 'active' });
    const r = await modifierAgent(m.deps, 't1', AG, { contenu: { ...FICHE_COMPLETE, ton: 'Chaleureux.' } }, CONSOLE);
    expect(r.ok).toBe(true);
    expect(m.cap.lignes).toHaveLength(1);
    expect(m.cap.lignes[0]!.libelle).toBe('Fiche de l’agent : ton');
    expect(m.cap.lignes[0]!.avant).toEqual({ contenu: { ton: FICHE_COMPLETE.ton } });
    expect(m.cap.lignes[0]!.apres).toEqual({ contenu: { ton: 'Chaleureux.' } });
  });

  it('par le MCP : origine `mcp` et la personne du jeton', async () => {
    const m = monter({ statut: 'draft' });
    await modifierAgent(m.deps, 't1', AG, { contenu: { objectif: 'Renseigner.' } }, CLAUDE);
    expect(m.cap.lignes[0]).toMatchObject({ origine: 'mcp', acteurId: 'u9' });
  });

  it('un enregistrement À L’IDENTIQUE n’écrit aucune ligne : ce n’est pas une modification', async () => {
    const m = monter({ statut: 'draft' });
    expect((await modifierAgent(m.deps, 't1', AG, { label: 'Conseiller' }, CONSOLE)).ok).toBe(true);
    expect(m.cap.lignes).toHaveLength(0);
  });

  it('🔴 un journal en panne ne fait pas échouer la modification, déjà écrite : il est journalisé', async () => {
    const m = monter({ statut: 'draft', historiqueCasse: true });
    const { resultat, lignes } = await capturerJournal(() => modifierAgent(m.deps, 't1', AG, { label: 'Autre' }, CONSOLE));
    expect(resultat.ok).toBe(true);
    expect(lignes.find((l) => l.msg === 'fiche_agent_non_journalisee')).toMatchObject({ lvl: 'error', tenantId: 't1' });
  });

  it('un refus n’écrit rien dans l’historique', async () => {
    const m = monter({ statut: 'draft' });
    expect((await modifierAgent(m.deps, 't1', AG, { maxTours: 99 }, CONSOLE)).ok).toBe(false);
    expect(m.cap.lignes).toHaveLength(0);
  });
});

describe('le modèle et la phrase de mention d’un agent au journal des actions (lot 5)', () => {
  const AUTRE_MODELE = [...IDS_MODELES_CHOISIS].find((m) => m !== 'modele-config')!;

  it('🔴 changer le modèle se trace, avant et après, avec son auteur, par la console comme par Claude', async () => {
    const m = monter({ statut: 'active' });
    expect((await modifierAgent(m.deps, 't1', AG, { modele: AUTRE_MODELE }, CLAUDE)).ok).toBe(true);
    expect(m.cap.audits).toEqual([expect.objectContaining({
      tenant: 't1', acteur: { userId: 'u9', email: null }, action: 'agent.modele_change', cible: { kind: 'agent', id: AG },
      detail: { modele: AUTRE_MODELE, modeleAvant: 'modele-config' },
    })]);
  });

  it('changer la phrase de mention se trace ; un enregistrement à l’identique n’écrit rien', async () => {
    const m = monter({ statut: 'active' });
    await modifierAgent(m.deps, 't1', AG, { mentionIa: 'Je suis un assistant automatique.' }, CONSOLE);
    await modifierAgent(m.deps, 't1', AG, { mentionIa: 'Je suis un assistant automatique.' }, CONSOLE);
    expect(m.cap.audits.map((a) => a.action)).toEqual(['agent.mention_modifiee']);
    expect(m.cap.audits[0]!.detail).toEqual({
      phrase: 'Je suis un assistant automatique.', phraseAvant: 'Vous échangez avec un assistant automatique.',
    });
  });

  it('modifier un autre champ (le ton) ne touche pas au journal des actions', async () => {
    const m = monter({ statut: 'active' });
    await modifierAgent(m.deps, 't1', AG, { contenu: { ton: 'Chaleureux.' } }, CONSOLE);
    expect(m.cap.audits).toEqual([]);
  });
});
