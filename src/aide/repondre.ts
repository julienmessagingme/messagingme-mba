import { z } from 'zod';
import { parse as secureJsonParse } from 'secure-json-parse';
import { ficheEstPertinente } from '../agent/knowledge';
import type { RechercheSemantique } from '../agent/resolvers/connaissance';
import type { ChatMessage, OutilExpose, ReponseChat } from '../agent/llm/chat-client';
import { carteVisiblePar, resoudre, type EcranAide } from './carte';
import type { DepotAide, FicheAide } from './fiches';

/**
 * LE MOTEUR DU BOT D'AIDE : rappel, verdict, réponse, et validation des clés d'écran.
 *
 * 🔴 DEUX CHOSES COMPTENT ICI, ET AUCUNE N'EST « il répond bien ». La première : quand aucune fiche n'est
 * pertinente, il DIT qu'il ne sait pas SANS appeler le modèle. Appeler sans source, c'est demander
 * d'inventer, et ça coûte pour un résultat qu'on refuserait. La seconde : une clé d'écran que le modèle
 * aurait inventée ne produit AUCUN lien, parce que `resoudre` la cherche dans une liste fermée. Le reste est
 * de la formulation, qui n'est pas testable et n'a pas à l'être.
 */

/** Ce qu'on demande au bot. */
export interface QuestionAide {
  question: string;
  /** Le rôle de la personne, qui décide des écrans qu'on a le droit de lui montrer. */
  role: string;
  langue: 'fr' | 'en';
  /** La clé de l'écran où elle se trouve, pour que l'aide soit contextuelle sans qu'elle le demande. */
  ecranCourant: string | null;
}

export interface ReponseAide {
  /** `false` = aucune source pertinente. Le texte est alors vide et l'écran propose le recours humain. */
  sait: boolean;
  texte: string;
  /** Les TITRES des fiches utilisées, pour que le client voie d'où sort la réponse. */
  sources: string[];
  ecrans: EcranAide[];
}

export interface DepsAide {
  depot: DepotAide;
  /** Absente = rappel lexical seul, et verdict par la règle lexicale. C'est le comportement dégradé, pas une panne. */
  recherche: RechercheSemantique | null;
  completer(input: {
    modele: string;
    messages: ChatMessage[];
    outils: OutilExpose[];
    toolChoice: string;
    signal: AbortSignal;
  }): Promise<ReponseChat>;
  modele: string;
  /** Plafond de temps d'un appel. Au-delà, on rend « je ne sais pas » plutôt que de faire attendre. */
  delaiMs?: number;
}

/** Nom de l'outil par lequel le modèle rend sa réponse. Forcé à l'appel. */
export const OUTIL_REPONDRE = 'repondre';

/**
 * Le schéma envoyé au modèle.
 *
 * 🔴 `ecrans` PREND DES CLÉS, JAMAIS DES ADRESSES. C'est toute la garde anti-hallucination : le modèle
 * choisit dans une liste fermée qu'on lui donne, et `resoudre` refuse ce qui n'y est pas. Lui laisser écrire
 * une adresse rendrait l'invention possible, et aucune consigne ne la rattraperait.
 */
export const SCHEMA_REPONSE = {
  type: 'object',
  properties: {
    reponse: {
      type: 'string',
      description: 'Ta réponse au client, dans sa langue, en t’appuyant UNIQUEMENT sur les fiches fournies.',
    },
    ecrans: {
      type: 'array',
      items: { type: 'string' },
      description: 'Les CLÉS des écrans où envoyer la personne, dans l’ordre où elle doit s’y rendre. '
        + 'Uniquement des clés de la liste fournie. Laisse vide si la réponse n’envoie nulle part.',
    },
  },
  required: ['reponse'],
};

const reponseSchema = z.object({
  reponse: z.string(),
  ecrans: z.array(z.string()).optional(),
});

/** Au-delà, ce n'est plus une question mais un message recopié : on borne le coût du rappel. */
const QUESTION_MAX = 500;
/** Ce qu'on donne du corps d'une fiche au modèle. Assez pour répondre, borné pour que le prompt reste petit. */
const CORPS_MAX = 2_000;
/** Combien de fiches partent au modèle, au plus. Trois suffisent et gardent la réponse nette. */
const FICHES_RENDUES = 3;
const DELAI_DEFAUT_MS = 20_000;

/**
 * Fusionne le rappel lexical et le rappel vectoriel, sans doublon, en gardant la meilleure mesure de chacun.
 *
 * ⚠️ Une fiche trouvée des DEUX côtés garde ses mesures lexicales ET sa similarité : jeter l'une des deux
 * ferait perdre au reclassement une information qu'on a déjà payée.
 */
function fusionner(lexicales: FicheAide[], vectorielles: FicheAide[]): FicheAide[] {
  const parId = new Map(lexicales.map((f) => [f.id, { ...f }]));
  for (const v of vectorielles) {
    const deja = parId.get(v.id);
    if (deja) deja.similarite = v.similarite;
    else parId.set(v.id, { ...v });
  }
  return [...parId.values()];
}

/**
 * LE VERDICT quand la recherche sémantique est branchée : le reclassement, et lui seul.
 *
 * 🔴 AUCUN SEUIL N'EST POSABLE SUR UN COSINUS D'EMBEDDING, mesuré le 2026-09-02 : une question hors sujet y
 * remonte à 0,361 quand une vraie question descend à 0,299. C'est le reclasseur qui sépare, et c'est
 * pourquoi il porte la garde anti-hallucination une fois le vectoriel branché.
 *
 * Un échec du reclasseur fait retomber sur la règle LEXICALE plutôt que de tout refuser : une panne du
 * fournisseur ne doit pas rendre le bot muet, elle doit le rendre moins fin.
 */
async function verdict(
  candidates: FicheAide[],
  question: string,
  recherche: RechercheSemantique,
): Promise<FicheAide[]> {
  if (candidates.length === 0) return [];
  try {
    const scores = await recherche.reclasser(question, candidates.map((f) => ({ texte: `${f.titre}\n${f.corps}` })));
    return candidates
      .map((f, i) => ({ f, score: scores[i] ?? 0 }))
      .filter((x) => x.score >= recherche.seuil)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.f);
  } catch {
    return candidates.filter(ficheEstPertinente);
  }
}

/** Le bloc de données donné au modèle, délimité. */
function blocFiches(fiches: FicheAide[]): string {
  return fiches
    .map((f, i) => `<<<FICHE ${i + 1}>>>\nTITRE : ${f.titre}\nÉCRAN : ${f.ecran ?? 'aucun'}\n`
      + `${f.corps.length > CORPS_MAX ? `${f.corps.slice(0, CORPS_MAX)}...` : f.corps}\n<<<FIN FICHE ${i + 1}>>>`)
    .join('\n\n');
}

function consigne(q: QuestionAide, ecrans: EcranAide[]): string {
  const liste = ecrans.map((e) => `- ${e.cle} : ${q.langue === 'en' ? e.en : e.fr}`
    + (e.chemin.length ? ` (dans ${e.chemin.join(' > ')})` : '')).join('\n');
  const ici = q.ecranCourant ? `La personne est actuellement sur l'écran « ${q.ecranCourant} ».` : '';
  return [
    'Tu es l’aide en ligne de la console Engage Me, qui sert à parler aux clients par WhatsApp.',
    'Tu réponds à un utilisateur de la console qui ne sait pas comment faire quelque chose.',
    '',
    `RÉPONDS EN ${q.langue === 'en' ? 'ANGLAIS' : 'FRANÇAIS'}, brièvement, en expliquant les étapes dans l’ordre.`,
    'Appuie-toi UNIQUEMENT sur les fiches qui te sont données. Si elles ne répondent pas, dis-le simplement.',
    'N’invente aucune fonctionnalité, aucun bouton, aucun écran.',
    ici,
    '',
    'ÉCRANS où tu peux envoyer la personne. Rends leurs CLÉS dans `ecrans`, jamais leur nom ni une adresse :',
    liste,
  ].filter((l) => l !== '').join('\n');
}

/**
 * Construit le répondeur.
 *
 * ⚠️ LES FICHES ARRIVENT DANS UN MESSAGE À PART, entre délimiteurs, jamais concaténées à la consigne. Leur
 * contenu vient de notre dépôt aujourd'hui, donc le risque est faible ; la forme doit être juste dès
 * maintenant parce que la seconde moitié du programme fera passer par ce même moteur des textes écrits par
 * des inconnus (les messages des contacts).
 */
export function creerRepondeur(deps: DepsAide): (q: QuestionAide) => Promise<ReponseAide> {
  const rien: ReponseAide = { sait: false, texte: '', sources: [], ecrans: [] };
  return async (q) => {
    const question = q.question.trim().slice(0, QUESTION_MAX);
    if (question === '') return rien;

    const large = deps.recherche !== null;
    const lexicales = await deps.depot.chercher(question, large ? deps.recherche!.candidats : FICHES_RENDUES);
    let candidates = lexicales;
    if (deps.recherche && deps.depot.chercherParVecteur) {
      try {
        const [vecteur] = await deps.recherche.vectoriser([question]);
        if (vecteur) {
          candidates = fusionner(lexicales, await deps.depot.chercherParVecteur(vecteur, deps.recherche.candidats));
        }
      } catch {
        // Rappel vectoriel indisponible : on garde le lexical. C'est le comportement d'avant la migration
        // 0131, et il répond encore.
      }
    }

    const retenues = (deps.recherche ? await verdict(candidates, question, deps.recherche)
      : candidates.filter(ficheEstPertinente)).slice(0, FICHES_RENDUES);
    // 🔴 AUCUNE SOURCE : on ne va PAS voir le modèle. C'est la garde la moins chère et la plus efficace.
    if (retenues.length === 0) return rien;

    const permis = carteVisiblePar(q.role);
    const abandon = new AbortController();
    const minuteur = setTimeout(() => abandon.abort(), deps.delaiMs ?? DELAI_DEFAUT_MS);
    let brut: ReponseChat;
    try {
      brut = await deps.completer({
        modele: deps.modele,
        messages: [
          { role: 'system', content: consigne(q, permis) },
          { role: 'user', content: `FICHES DU MODE D’EMPLOI :\n\n${blocFiches(retenues)}` },
          { role: 'user', content: question },
        ],
        outils: [{ name: OUTIL_REPONDRE, description: 'Rends ta réponse et les écrans où aller.', parameters: SCHEMA_REPONSE }],
        toolChoice: OUTIL_REPONDRE,
        signal: abandon.signal,
      });
    } catch {
      // Panne ou délai dépassé : « je ne sais pas » plutôt qu'une erreur en travers de l'écran. La personne
      // se voit alors proposer le recours humain, qui est une issue, là où un message d'erreur n'en est pas une.
      return rien;
    } finally {
      clearTimeout(minuteur);
    }

    const appel = brut.appelsOutils.find((a) => a.nom === OUTIL_REPONDRE);
    if (!appel) return rien;
    let lu: unknown;
    try {
      lu = secureJsonParse(appel.argumentsJson);
    } catch {
      return rien;
    }
    // `safeParse`, jamais `parse` : la sortie d'un modèle est une entrée non fiable comme une autre.
    const valide = reponseSchema.safeParse(lu);
    if (!valide.success || valide.data.reponse.trim() === '') return rien;

    return {
      sait: true,
      texte: valide.data.reponse.trim(),
      sources: retenues.map((f) => f.titre),
      ecrans: resoudre(valide.data.ecrans ?? [], q.role),
    };
  };
}
