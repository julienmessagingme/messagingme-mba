import { describe, expect, it, vi } from 'vitest';
import { creerTourEntretien, type TourEntretienDeps } from '../src/agent/setup/tour-entretien';
import type { ReponseChat } from '../src/agent/llm/chat-client';
import { AGENDA } from '../src/agent/setup/couverture';
import type { EntretienComplet, EntretienStore } from '../src/agent/setup/entretien-store';
import { ficheVide } from '../src/agent/fiche';

const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const POINTS = AGENDA.map((point) => point.code);
const reponsesCompletes = () => POINTS.map((point) => ({ point, valeur: 'réponse du client' }));
const entretienFini = (): EntretienComplet => ({
  messages: [], auteurs: [], poses: [...POINTS], reponses: reponsesCompletes(), bascules: [],
});

function reponse(argumentsJson: string): ReponseChat {
  return {
    texte: null,
    appelsOutils: [{ id: 'c1', nom: 'proposer', argumentsJson }],
    finish: 'tool_calls',
    usage: { tokensIn: 100, tokensOut: 20, tokensCaches: 0, coutDollars: 0.0001 },
    generationId: 'gen_1',
  };
}

class EntretiensMemoire implements EntretienStore {
  constructor(private etat: EntretienComplet | null, private readonly evenements: string[] = []) {}
  async lire(_tenant: string, _agent: string): Promise<EntretienComplet | null> {
    this.evenements.push('lire_entretien');
    return this.etat;
  }
  async ecrire(_tenant: string, _agent: string, etat: EntretienComplet): Promise<void> {
    this.evenements.push('ecrire');
    this.etat = etat;
  }
  async effacer(_tenant: string, _agent: string): Promise<void> { this.etat = null; }
}

function dependances(options: {
  entretien?: EntretienComplet;
  evenements?: string[];
  reponses?: ReponseChat[];
  depenseMicroEuros?: number;
  ecrire?: () => Promise<void>;
  ajouter?: (rang: number) => Promise<void>;
} = {}): TourEntretienDeps {
  const evenements = options.evenements ?? [];
  const store = new EntretiensMemoire(options.entretien ?? entretienFini(), evenements);
  let rangModele = 0;
  let rangDepense = 0;
  return {
    entretiens: options.ecrire ? {
      lire: (...args) => store.lire(...args),
      ecrire: async () => { evenements.push('ecrire'); await options.ecrire!(); },
    } : store,
    scenariosEnLigne: async () => { evenements.push('lire_scenarios'); return []; },
    importerSiteDeLEntretien: async () => {
      evenements.push('importer');
      return { issue: 'importe', ecrites: 1, pages: 1 };
    },
    depenses: {
      lire: async () => { evenements.push('lire_budget'); return options.depenseMicroEuros ?? 0; },
      ajouter: async () => {
        evenements.push('noter_depense');
        rangDepense += 1;
        await options.ajouter?.(rangDepense);
      },
    },
    plafondEuros: 10,
    tauxEurParDollar: 1,
    modele: 'modele-entretien',
    completer: async () => {
      evenements.push('modele');
      const rendues = options.reponses ?? [reponse(JSON.stringify({ message: 'Voici.', fiche: { objectif: 'Qualifier.' } }))];
      const rendue = rendues[Math.min(rangModele, rendues.length - 1)]!;
      rangModele += 1;
      return rendue;
    },
  };
}

const commande = {
  tenantId: 't1',
  agentId: AGENT_ID,
  auteurId: 'u1',
  message: 'Je souhaite ajuster cet agent.',
  contexte: {
    label: 'Conseiller',
    mentionIaFrequence: 'session' as const,
    inactiviteMinutes: 30,
    fiche: { ...ficheVide(), objectif: 'Aider.' },
    outils: [],
    titresConnaissance: [],
  },
};

describe('un tour d’entretien', () => {
  it('rend une réponse produit complète et persiste le tour derrière une seule interface', async () => {
    const evenements: string[] = [];
    const resultat = await creerTourEntretien(dependances({ evenements })).executer(commande);

    expect(resultat.issue).toBe('repondu');
    if (resultat.issue !== 'repondu') return;
    expect(resultat.reponse.message).toBe('Voici.');
    expect(resultat.reponse.changements).toContainEqual(expect.objectContaining({
      champ: 'fiche.objectif', avant: 'Aider.', apres: 'Qualifier.',
    }));
    expect(evenements.at(-1)).toBe('ecrire');
  });

  it('rend lui-même le résultat complet du plafond sans appeler le modèle ni écrire', async () => {
    const completer = vi.fn(async () => reponse('{}'));
    const ecrire = vi.fn(async () => {});
    const deps = dependances({ depenseMicroEuros: 10_000_000, ecrire });
    deps.completer = completer;

    const resultat = await creerTourEntretien(deps).executer(commande);

    expect(resultat).toMatchObject({
      issue: 'budget_epuise',
      reponse: {
        budgetEpuise: true,
        ongletsUtilisables: true,
        proposition: { fiche: {}, outils: [], connecteurs: [], outilsBranches: [], outilsDebranches: [] },
        changements: [],
        usage: { tokensIn: 0, tokensOut: 0 },
      },
    });
    expect(completer).not.toHaveBeenCalled();
    expect(ecrire).not.toHaveBeenCalled();
  });

  it('persiste avant de lancer l’import du site', async () => {
    const evenements: string[] = [];
    const deps = dependances({
      evenements,
      reponses: [reponse(JSON.stringify({
        message: 'Je lance l’import.', connaissanceUrl: 'https://exemple.fr/',
      }))],
    });

    await creerTourEntretien(deps).executer(commande);

    expect(evenements).toEqual([
      'lire_scenarios', 'lire_entretien', 'lire_budget', 'modele', 'noter_depense', 'ecrire', 'importer',
    ]);
  });

  it('ne lance aucun import quand la persistance échoue', async () => {
    const evenements: string[] = [];
    const deps = dependances({
      evenements,
      ecrire: async () => { throw new Error('base indisponible'); },
      reponses: [reponse(JSON.stringify({
        message: 'Je lance l’import.', connaissanceUrl: 'https://exemple.fr/',
      }))],
    });

    await expect(creerTourEntretien(deps).executer(commande)).rejects.toThrow('base indisponible');
    expect(evenements).toEqual([
      'lire_scenarios', 'lire_entretien', 'lire_budget', 'modele', 'noter_depense', 'ecrire',
    ]);
  });

  it('fait remonter une panne interne de comptabilisation pendant la synthèse', async () => {
    const dernier = POINTS[POINTS.length - 1]!;
    const presqueFini: EntretienComplet = {
      messages: [], auteurs: [], poses: [...POINTS], bascules: [],
      reponses: reponsesCompletes().filter((item) => item.point !== dernier),
    };
    const deps = dependances({
      entretien: presqueFini,
      reponses: [
        reponse(JSON.stringify({ message: 'Parfait.', reponses: [{ point: dernier, valeur: 'bref' }] })),
        reponse(JSON.stringify({ message: 'Voici la synthèse.', fiche: { ton: 'Bref.' } })),
      ],
      ajouter: async (rang) => { if (rang === 2) throw new Error('compteur indisponible'); },
    });

    await expect(creerTourEntretien(deps).executer(commande)).rejects.toThrow('compteur indisponible');
  });
});
