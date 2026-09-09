/**
 * LES MODÈLES PROPOSÉS AU CLIENT, et ce qu'ils lui coûtent.
 *
 * 🔴 POURQUOI UNE LISTE CHOISIE PLUTÔT QUE LES 373 DU GATEWAY (2026-09-09, demande de Julien). Le champ
 * « Modèle » était une saisie libre : on tapait un identifiant à la main, et rien ne le vérifiait, ni ici ni
 * chez le Gateway avant le message suivant. Une faute de frappe passait l'enregistrement et ne se voyait
 * qu'à la première réponse ratée d'un client.
 *
 * Mais tout lister serait pire. Trois raisons, dans cet ordre :
 *  1. **les outils**. L'agent de ce produit APPELLE des outils (chercher dans la base de connaissance,
 *     escalader vers un humain). Un modèle qui ne les gère pas ne rend pas une réponse dégradée, il rend une
 *     réponse INVENTÉE, sur des contrats d'assurance. Le Gateway le dit dans `supported_parameters` ;
 *  2. **le français**. C'est la plainte d'origine de Julien le 2026-09-08 (« comment puis-je faire pour
 *     vous ? »). Aucune API ne mesure ça : il faut choisir ;
 *  3. **un menu de 373 lignes n'est pas un choix**, c'est un formulaire de saisie déguisé.
 *
 * ⚠️ LA LISTE EST UNE INTENTION, PAS UNE VÉRITÉ. Elle est INTERSECTÉE avec ce que le Gateway propose
 * réellement (cf. `modelesProposables`) : un modèle retiré du catalogue disparaît du menu au lieu d'y rester
 * et de casser l'agent au premier message.
 */

/** Un modèle du catalogue Gateway, tel que la liste `/v1/models` le décrit (les champs qu'on lit). */
export interface ModeleGateway {
  id: string;
  /** Prix en DOLLARS PAR JETON (`"0.00000007"`). Absent = le Gateway ne l'annonce pas. */
  pricing?: { input?: string | number; output?: string | number };
  supported_parameters?: string[];
  type?: string;
}

/** Ce que la console affiche pour un modèle. Les prix sont en EUROS PAR MILLION de jetons, commission incluse. */
export interface ModeleProposable {
  id: string;
  /** Le nom lisible, le nôtre : celui du Gateway est parfois un identifiant technique de plus. */
  nom: string;
  /** En euros par million de jetons, commission comprise. `null` = le Gateway n'annonce pas de prix. */
  prixEntree: number | null;
  prixSortie: number | null;
}

/**
 * LES DIX, du moins cher au plus cher. L'ordre du menu vient des PRIX RÉELS (cf. `modelesProposables`), pas
 * de cet ordre-ci : deux sources d'ordre auraient divergé au premier changement de tarif chez un fournisseur.
 *
 * Chaque ligne a une raison d'être là, et c'est ce qui empêche la liste de gonfler :
 */
export const MODELES_CHOISIS: ReadonlyArray<{ id: string; nom: string }> = [
  // Celui qui tourne aujourd'hui chez tous les agents. Le retirer casserait le menu de l'existant.
  { id: 'zai/glm-4.7-flash', nom: 'GLM 4.7 Flash' },
  // Européen et francophone de naissance, au prix du moins cher : le repli naturel si le français gêne.
  { id: 'mistral/mistral-small', nom: 'Mistral Small' },
  { id: 'google/gemini-2.5-flash-lite', nom: 'Gemini 2.5 Flash Lite' },
  { id: 'openai/gpt-5-mini', nom: 'GPT-5 mini' },
  { id: 'google/gemini-2.5-flash', nom: 'Gemini 2.5 Flash' },
  { id: 'openai/gpt-4.1-mini', nom: 'GPT-4.1 mini' },
  // Le grand frère du modèle par défaut : même famille, meilleur en sortie structurée (il sert déjà à la
  // CONSTRUCTION d'un agent, cf. `AGENT_SETUP_MODEL`).
  { id: 'zai/glm-4.7', nom: 'GLM 4.7' },
  // La recommandation faite à Julien le 2026-09-08 quand le français du modèle par défaut l'a gêné.
  { id: 'anthropic/claude-haiku-4.5', nom: 'Claude Haiku 4.5' },
  { id: 'google/gemini-2.5-pro', nom: 'Gemini 2.5 Pro' },
  { id: 'anthropic/claude-sonnet-4.5', nom: 'Claude Sonnet 4.5' },
];

/** Les identifiants seuls, pour la garde d'écriture. */
export const IDS_MODELES_CHOISIS: ReadonlySet<string> = new Set(MODELES_CHOISIS.map((m) => m.id));

const JETONS_PAR_MILLION = 1_000_000;

/**
 * Le prix client d'un modèle, en euros par million de jetons.
 *
 * Trois multiplications, et chacune a sa source : le Gateway facture en DOLLARS PAR JETON, `EUR_PER_USD` est
 * le taux commercial du dépôt (celui-là même qui convertit déjà la consommation réelle, cf. `devise.ts`), et
 * la commission est notre marge.
 *
 * 🔴 CE PRIX EST UN AFFICHAGE, PAS UNE FACTURATION (choix de Julien du 2026-09-09). Ce qui est réellement
 * décompté du crédit reste le coût BRUT rendu par le Gateway (`microEurosDepuisDollars`, chemin inchangé) :
 * l'onglet Consommation montre donc environ 10 % de moins que le tarif annoncé ici. C'est assumé le temps
 * que la facturation Stripe existe ; le jour où elle arrivera, c'est `run-turn` qu'il faudra majorer, pas
 * cette fonction, sinon les deux écrans se remettront à mentir dans l'autre sens.
 *
 * Une valeur absente, illisible ou négative rend `null` et JAMAIS zéro : « gratuit » est une affirmation, et
 * elle serait fausse.
 */
export function prixParMillion(brutDollarsParJeton: string | number | undefined, tauxEurParDollar: number, commissionPct: number): number | null {
  const n = typeof brutDollarsParJeton === 'string' ? Number(brutDollarsParJeton) : brutDollarsParJeton;
  if (n === undefined || !Number.isFinite(n) || n <= 0) return null;
  const taux = Number.isFinite(tauxEurParDollar) && tauxEurParDollar > 0 ? tauxEurParDollar : 1;
  const marge = Number.isFinite(commissionPct) && commissionPct >= 0 ? commissionPct : 0;
  return n * JETONS_PAR_MILLION * taux * (1 + marge / 100);
}

/**
 * La liste à proposer : l'INTERSECTION de nos dix avec le catalogue réel du Gateway, triée par prix d'entrée
 * croissant. Fonction PURE : l'appel réseau est fait par l'appelant, et se teste donc sans lui.
 *
 * ⚠️ `catalogue` VIDE (lecture en échec, clé absente) ne vide PAS le menu : on rend les dix sans prix. Un
 * menu vide empêcherait de changer de modèle, c'est-à-dire exactement le geste que ce lot vient d'ouvrir, et
 * une panne de tarification n'a pas à interdire un réglage. Le front dit alors que le tarif est indisponible.
 *
 * ⚠️ Un modèle du catalogue SANS gestion des outils est écarté comme s'il était absent : le proposer serait
 * proposer un agent qui invente ses réponses au lieu de chercher dans la base de connaissance.
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
  // Tri par prix d'ENTRÉE : c'est le poste dominant d'un agent (le contexte, la base de connaissance et
  // l'historique repartent à chaque tour, la réponse fait quelques centaines de jetons). Un prix inconnu va
  // en fin de liste plutôt qu'en tête, où il passerait pour le moins cher.
  return sortis.sort((a, b) => (a.prixEntree ?? Infinity) - (b.prixEntree ?? Infinity));
}
