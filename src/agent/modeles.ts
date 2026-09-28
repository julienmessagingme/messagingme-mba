/**
 * Les modèles proposés au client, et ce qu'ils lui coûtent.
 *
 * Une liste choisie plutôt que tout le catalogue du Gateway : un modèle sans gestion des outils n'appelle pas
 * la base de connaissance et invente ses réponses, le français ne se mesure par aucune API, et un menu de
 * plusieurs centaines de lignes n'est pas un choix. La liste est intersectée avec le catalogue réel
 * (`modelesProposables`) : un modèle retiré disparaît du menu au lieu de casser l'agent.
 */
import { facteurCommission } from './devise';

/** Un modèle du catalogue Gateway, tel que la liste `/v1/models` le décrit (les champs qu'on lit). */
export interface ModeleGateway {
  id: string;
  /** Prix en dollars par jeton (`"0.00000007"`). Absent = le Gateway ne l'annonce pas. */
  pricing?: { input?: string | number; output?: string | number };
  supported_parameters?: string[];
  type?: string;
}

/** Ce que la console affiche pour un modèle. Les prix sont en euros par million de jetons, commission incluse. */
export interface ModeleProposable {
  id: string;
  /** Le nom lisible, le nôtre : celui du Gateway est parfois un identifiant technique de plus. */
  nom: string;
  /** En euros par million de jetons, commission comprise. `null` = le Gateway n'annonce pas de prix. */
  prixEntree: number | null;
  prixSortie: number | null;
}

/**
 * Les dix, du moins cher au plus cher. L'ordre du menu vient des prix réels (`modelesProposables`), pas de
 * cet ordre-ci : deux sources d'ordre divergeraient au premier changement de tarif.
 */
export const MODELES_CHOISIS: ReadonlyArray<{ id: string; nom: string }> = [
  // Le modèle par défaut des agents existants : le retirer casserait leur menu.
  { id: 'zai/glm-4.7-flash', nom: 'GLM 4.7 Flash' },
  // Européen et francophone de naissance, au prix du moins cher : le repli naturel si le français gêne.
  { id: 'mistral/mistral-small', nom: 'Mistral Small' },
  { id: 'google/gemini-2.5-flash-lite', nom: 'Gemini 2.5 Flash Lite' },
  { id: 'openai/gpt-5-mini', nom: 'GPT-5 mini' },
  { id: 'google/gemini-2.5-flash', nom: 'Gemini 2.5 Flash' },
  { id: 'openai/gpt-4.1-mini', nom: 'GPT-4.1 mini' },
  // Le grand frère du modèle par défaut, meilleur en sortie structurée (sert à la construction d'un agent).
  { id: 'zai/glm-4.7', nom: 'GLM 4.7' },
  // La recommandation quand le français du modèle par défaut gêne.
  { id: 'anthropic/claude-haiku-4.5', nom: 'Claude Haiku 4.5' },
  { id: 'google/gemini-2.5-pro', nom: 'Gemini 2.5 Pro' },
  { id: 'anthropic/claude-sonnet-4.5', nom: 'Claude Sonnet 4.5' },
];

/** Les identifiants seuls, pour la garde d'écriture. */
export const IDS_MODELES_CHOISIS: ReadonlySet<string> = new Set(MODELES_CHOISIS.map((m) => m.id));

const JETONS_PAR_MILLION = 1_000_000;

/**
 * Le prix client d'un modèle, en euros par million de jetons : prix du Gateway en dollars par jeton, taux
 * commercial `EUR_PER_USD` (celui de `devise.ts`), puis notre commission.
 *
 * 🔴 Le tarif annoncé est celui que le crédit paie : chaque appel est débité par `prixClientMicroEur`, avec la
 * même commission et le même facteur (`facteurCommission`). Une valeur absente, illisible ou négative rend
 * `null`, jamais zéro (« gratuit » serait faux).
 */
export function prixParMillion(brutDollarsParJeton: string | number | undefined, tauxEurParDollar: number, commissionPct: number): number | null {
  const n = typeof brutDollarsParJeton === 'string' ? Number(brutDollarsParJeton) : brutDollarsParJeton;
  if (n === undefined || !Number.isFinite(n) || n <= 0) return null;
  const taux = Number.isFinite(tauxEurParDollar) && tauxEurParDollar > 0 ? tauxEurParDollar : 1;
  return n * JETONS_PAR_MILLION * taux * facteurCommission(commissionPct);
}

/**
 * La liste à proposer : l'intersection de nos dix avec le catalogue réel du Gateway, triée par prix d'entrée
 * croissant. Fonction pure, l'appel réseau est fait par l'appelant.
 *
 * Un catalogue vide (lecture en échec, clé absente) rend les dix sans prix plutôt qu'un menu vide : une panne
 * de tarification n'interdit pas de changer de modèle. Un modèle sans gestion des outils est écarté.
 */
export function modelesProposables(catalogue: ReadonlyArray<ModeleGateway>, tauxEurParDollar: number, commissionPct: number): ModeleProposable[] {
  const parId = new Map(catalogue.map((m) => [m.id, m]));
  const vide = catalogue.length === 0;
  const sortis = MODELES_CHOISIS.flatMap(({ id, nom }) => {
    const m = parId.get(id);
    if (!vide) {
      if (!m) return [];
      if (!(m.supported_parameters ?? []).includes('tools')) return [];
    }
    return [{
      id,
      nom,
      prixEntree: prixParMillion(m?.pricing?.input, tauxEurParDollar, commissionPct),
      prixSortie: prixParMillion(m?.pricing?.output, tauxEurParDollar, commissionPct),
    }];
  });
  // Tri par prix d'entrée, le poste dominant d'un agent (contexte et historique repartent à chaque tour).
  // Un prix inconnu va en fin de liste, pas en tête où il passerait pour le moins cher.
  return sortis.sort((a, b) => (a.prixEntree ?? Infinity) - (b.prixEntree ?? Infinity));
}
