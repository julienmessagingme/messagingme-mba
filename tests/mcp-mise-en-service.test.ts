import { describe, it, expect } from 'vitest';
import {
  OUTILS_DE_L_ETAPE, etatMiseEnService, lireMiseEnService, type DepsMiseEnService, type LecturesMiseEnService,
} from '../src/mcp/mise-en-service';
import { CATALOGUE_MCP } from '../web/lib/partage/catalogue-mcp';
import { OUTILS, type DepsMcp } from '../src/mcp/outils';
import type { EtatConnexion } from '../src/otp/etat-connexion';
import type { ReglageDuRepondeur } from '../src/repondeur/mode';
import type { Fonction } from '../src/offres/offres';

/**
 * OÙ EN EST LA MISE EN SERVICE D'UN ESPACE (lot 10) : l'outil `get_setup_state`, que la skill de mise en service du
 * plugin appelle en premier, pour reprendre une session coupée. La règle de l'étape suivante est écrite UNE fois, ici
 * tenue cas par cas ; ce qu'on protège surtout : un espace déjà réglé n'est jamais poussé à défaire ce qui est voulu, et
 * une lecture qui échoue ne fait pas échouer l'outil.
 */

const NUMERO_CONNECTE: EtatConnexion = {
  fourni: null, code: null, connecte: { chiffres: '33612345678', aActiver: false }, abonnement: null, inclusDansLePro: false,
};
const SANS_NUMERO: EtatConnexion = { fourni: null, code: null, connecte: null, abonnement: null, inclusDansLePro: false };
const EQUIPE: ReglageDuRepondeur = {
  mbaEnabled: false, repondeurMode: 'equipe', repondeurAgentId: null, repondeurWorkflowId: null, repondeurAdresseId: null,
};
const AGENT_REPOND: ReglageDuRepondeur = { ...EQUIPE, repondeurMode: 'agent', repondeurAgentId: 'a1' };

/** Un espace prêt : numéro connecté, un agent actif qui répond, une bulle allumée, du crédit. */
const PRET: LecturesMiseEnService = {
  offre: { offre: 'free', fonctions: [] },
  soldeMicroEur: 1_000_000,
  numero: NUMERO_CONNECTE,
  agents: [{ id: 'a1', label: 'Accueil', status: 'active', nbManques: null }],
  reglages: AGENT_REPOND,
  widgets: [{ id: 'w1', nom: 'Site', actif: true }],
};

describe('l’étape suivante', () => {
  it('un espace prêt : pret, sans avertissement, et l’état lisible', () => {
    const e = etatMiseEnService(PRET);
    expect(e.etape_suivante).toBe('pret');
    expect(e.avertissements).toEqual([]);
    expect(e.offre).toBe('free');
    expect(e.credit_eur).toBe(1);
    expect(e.numero).toMatchObject({ connecte: true, a_activer: false, chiffres: '33612345678' });
    expect(e.agents?.actifs).toEqual([{ id: 'a1', label: 'Accueil' }]);
    expect(e.repondeur).toEqual({ mode: 'agent', mode_choisi: 'agent', agent_id: 'a1' });
    expect(e.bulles).toEqual({ actives: 1, total: 1 });
  });

  it('sans numéro : connecter_numero, avant tout le reste', () => {
    expect(etatMiseEnService({ ...PRET, numero: SANS_NUMERO, agents: [] }).etape_suivante).toBe('connecter_numero');
  });

  it('un numéro relié que Meta n’a pas encore activé : activer_numero, sans outil (start_whatsapp_connection le refuserait)', () => {
    const e = etatMiseEnService({ ...PRET, numero: { ...NUMERO_CONNECTE, connecte: { chiffres: '336', aActiver: true } } });
    expect(e.etape_suivante).toBe('activer_numero');
    expect(e.outils_suggeres).toEqual([]);
    expect(e.avertissements).toContain('numero_a_activer');
  });

  it('🔴 le code de vérification n’est jamais rendu : l’outil est ouvert aux clés d’API, le code est réservé à une personne', () => {
    const e = etatMiseEnService({ ...PRET, numero: { ...SANS_NUMERO, fourni: '+442071234567', code: { code: '493817', recuLe: '2026-10-12T10:00:00Z' } } });
    expect(JSON.stringify(e)).not.toContain('493817');
    expect(e.numero?.fourni).toBe('+442071234567');
  });

  it('aucun agent : creer_agent', () => {
    expect(etatMiseEnService({ ...PRET, agents: [], reglages: EQUIPE }).etape_suivante).toBe('creer_agent');
  });

  it('un brouillon à qui il manque des choses : completer_agent, et ses manques sont dits', () => {
    const e = etatMiseEnService({ ...PRET, agents: [{ id: 'a2', label: 'Brouillon', status: 'draft', nbManques: 3 }], reglages: EQUIPE });
    expect(e.etape_suivante).toBe('completer_agent');
    expect(e.agents?.a_completer).toEqual([{ id: 'a2', label: 'Brouillon', nb_manques: 3 }]);
  });

  it('un brouillon complet, ou un agent désactivé : activer_agent', () => {
    expect(etatMiseEnService({ ...PRET, agents: [{ id: 'a2', label: 'B', status: 'draft', nbManques: 0 }], reglages: EQUIPE }).etape_suivante)
      .toBe('activer_agent');
    expect(etatMiseEnService({ ...PRET, agents: [{ id: 'a3', label: 'D', status: 'disabled', nbManques: null }], reglages: EQUIPE }).etape_suivante)
      .toBe('activer_agent');
  });

  it('un agent actif, mais personne ne répond automatiquement : choisir_repondeur', () => {
    expect(etatMiseEnService({ ...PRET, reglages: EQUIPE }).etape_suivante).toBe('choisir_repondeur');
  });

  it('🔴 un répondeur CHOISI (agent de Meta, scénario, application) compte comme fait : jamais poussé à le défaire', () => {
    const fonctions: Fonction[] = ['agent_meta', 'scenarios'];
    const pro = { offre: 'pro' as const, fonctions };
    for (const reglages of [
      { ...EQUIPE, repondeurMode: 'mba' as const, mbaEnabled: true },
      { ...EQUIPE, repondeurMode: 'scenario' as const, repondeurWorkflowId: 'w' },
      { ...EQUIPE, repondeurMode: 'application' as const, repondeurAdresseId: 'ad' },
    ]) {
      const e = etatMiseEnService({ ...PRET, offre: pro, reglages });
      expect(e.etape_suivante, reglages.repondeurMode).toBe('pret');
    }
  });

  it('🔴 l’agent de Meta gelé par la Free : il se lit « equipe », reste un choix, et le gel est dit (jamais « choisir_repondeur »)', () => {
    const e = etatMiseEnService({ ...PRET, reglages: { ...EQUIPE, repondeurMode: 'mba', mbaEnabled: true } });
    expect(e.repondeur).toEqual({ mode: 'equipe', mode_choisi: 'mba', agent_id: null });
    expect(e.avertissements).toContain('repondeur_gele_par_l_offre');
    expect(e.etape_suivante).toBe('pret');
  });

  it('🔴 un répondeur choisi SANS agent IA : ni creer_agent ni choisir_repondeur, la bulle puis prêt', () => {
    const fonctions: Fonction[] = ['agent_meta', 'scenarios'];
    for (const reglages of [
      { ...EQUIPE, repondeurMode: 'mba' as const, mbaEnabled: true },
      { ...EQUIPE, repondeurMode: 'scenario' as const, repondeurWorkflowId: 'w' },
      { ...EQUIPE, repondeurMode: 'application' as const, repondeurAdresseId: 'ad' },
    ]) {
      const base = { ...PRET, offre: { offre: 'pro' as const, fonctions }, reglages, agents: [] };
      expect(etatMiseEnService({ ...base, widgets: [] }).etape_suivante, reglages.repondeurMode).toBe('poser_bulle');
      expect(etatMiseEnService(base).etape_suivante, reglages.repondeurMode).toBe('pret');
    }
  });

  it('une session reprise repart du brouillon en cours, pas de l’agent désactivé', () => {
    const e = etatMiseEnService({ ...PRET, reglages: EQUIPE, agents: [
      { id: 'v1', label: 'v1', status: 'disabled', nbManques: null },
      { id: 'v2', label: 'v2', status: 'draft', nbManques: 2 },
    ] });
    expect(e.etape_suivante).toBe('completer_agent');
  });

  it('aucune bulle allumée : poser_bulle', () => {
    expect(etatMiseEnService({ ...PRET, widgets: [] }).etape_suivante).toBe('poser_bulle');
    expect(etatMiseEnService({ ...PRET, widgets: [{ id: 'w', nom: 'x', actif: false }] }).etape_suivante).toBe('poser_bulle');
  });

  it('un crédit épuisé est dit, sans changer l’étape', () => {
    const e = etatMiseEnService({ ...PRET, soldeMicroEur: 0 });
    expect(e.etape_suivante).toBe('pret');
    expect(e.avertissements).toContain('credit_epuise');
  });

  it('🔴 une lecture manquée ne décide de rien : l’étape qu’elle aurait pu dire est sautée, et le manque est dit', () => {
    const e = etatMiseEnService({ ...PRET, numero: null, agents: null });
    expect(e.numero).toBeNull();
    expect(e.agents).toBeNull();
    expect(e.etape_suivante).toBe('pret');
    expect(e.avertissements).toEqual(expect.arrayContaining(['lecture_manquee:numero', 'lecture_manquee:agents']));
  });

  it('chaque étape suggère des outils qui existent au catalogue', () => {
    for (const [etape, outils] of Object.entries(OUTILS_DE_L_ETAPE)) {
      for (const o of outils) expect(Object.keys(CATALOGUE_MCP), `${etape} -> ${o}`).toContain(o);
    }
    expect(etatMiseEnService({ ...PRET, widgets: [] }).outils_suggeres).toEqual(['create_widget']);
  });
});

describe('la lecture, sur des faux', () => {
  function deps(o: { panne?: 'numero' | 'agents' | 'credit'; lus?: string[] } = {}): DepsMiseEnService {
    const casse = (quoi: string) => async () => { throw new Error(`panne ${quoi}`); };
    // Chaque source note l'espace qu'on lui demande : l'isolation se vérifie sur toutes.
    const lu = <T>(source: string, v: T) => async (t: string) => { o.lus?.push(`${source}:${t}`); return v; };
    return {
      offre: { vue: lu('offre', { offre: 'free' as const, fonctions: [] }) },
      numero: { etat: o.panne === 'numero' ? casse('numero') : lu('numero', NUMERO_CONNECTE) },
      agentIa: {
        gestion: {
          agents: {
            listToutes: o.panne === 'agents' ? casse('agents') : lu('agents', [
              { id: '0b8b2a3e-1c4d-4e5f-8a9b-0c1d2e3f4a5b', label: 'Accueil', status: 'draft' as const, sorties: [], modele: 'm' },
            ]),
          },
          credits: { solde: o.panne === 'credit' ? casse('credit') : lu('credit', 500_000) },
          etatPourLint: async (t: string) => { o.lus?.push(`manques:${t}`); return null; },
        },
        repondeur: { reglages: { get: lu('repondeur', { ...EQUIPE, repondeurDelaiScenarioS: 0 }) } },
      },
      widgets: { gestion: { widgets: { lister: lu('bulles', []) } } },
    };
  }

  it('🔴 chaque source est lue pour l’espace demandé, et lui seul', async () => {
    const lus: string[] = [];
    await lireMiseEnService(deps({ lus }), 't1');
    expect(lus.sort()).toEqual(['agents:t1', 'bulles:t1', 'credit:t1', 'manques:t1', 'numero:t1', 'offre:t1', 'repondeur:t1']);
  });

  it('assemble les lectures, une par source', async () => {
    const e = await lireMiseEnService(deps(), 't1');
    expect(e.offre).toBe('free');
    expect(e.credit_eur).toBe(0.5);
    expect(e.numero?.connecte).toBe(true);
    // Les manques d'un brouillon viennent de la lecture de la console ; illisibles, ils sont null et l'agent reste à compléter.
    expect(e.agents?.a_completer).toEqual([{ id: '0b8b2a3e-1c4d-4e5f-8a9b-0c1d2e3f4a5b', label: 'Accueil', nb_manques: null }]);
    expect(e.etape_suivante).toBe('completer_agent');
  });

  it('🔴 une source en panne ne fait pas échouer l’outil', async () => {
    for (const panne of ['numero', 'agents', 'credit'] as const) {
      const e = await lireMiseEnService(deps({ panne }), 't1');
      expect(e.avertissements.some((a) => a.startsWith('lecture_manquee:')), panne).toBe(true);
    }
  });
});

describe('l’outil get_setup_state', () => {
  const outil = OUTILS.find((o) => o.nom === 'get_setup_state');

  it('🔴 en lecture (mcp:read), sans argument, ouvert à une clé d’API comme à une personne, et dans toutes les offres', () => {
    expect(outil).toBeDefined();
    expect(outil!.scope).toBe('mcp:read');
    expect(outil!.exigePersonne).not.toBe(true);
    expect(outil!.fonction).toBeNull();
    expect(outil!.entree).toEqual({ type: 'object', properties: {} });
    expect(outil!.annotations.readOnlyHint).toBe(true);
  });

  it('il lit l’espace du jeton, et sa description nomme chaque étape et ses outils', async () => {
    const lus: string[] = [];
    const d = {
      offre: { vue: async (t: string) => { lus.push(t); return { offre: 'free' as const, fonctions: [] }; } },
      numero: { etat: async () => SANS_NUMERO },
      agentIa: {
        gestion: { agents: { listToutes: async () => [] }, credits: { solde: async () => 0 }, etatPourLint: async () => null },
        repondeur: { reglages: { get: async () => EQUIPE } },
      },
      widgets: { gestion: { widgets: { lister: async () => [] } } },
    } satisfies DepsMiseEnService;
    const r = await outil!.executer(d as unknown as DepsMcp, 't1', {}, null) as { etape_suivante: string };
    expect(lus).toEqual(['t1']);
    expect(r.etape_suivante).toBe('connecter_numero');
    for (const [etape, outils] of Object.entries(OUTILS_DE_L_ETAPE)) {
      expect(outil!.description, etape).toContain(etape);
      for (const o of outils) expect(outil!.description, o).toContain(o);
    }
  });
});
