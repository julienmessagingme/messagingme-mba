import { z } from 'zod';
import { parse as secureJsonParse } from 'secure-json-parse';
import { ficheEstPertinente } from '../agent/knowledge';
import type { RechercheSemantique } from '../agent/resolvers/connaissance';
import type { ChatMessage, OutilExpose, ReponseChat } from '../agent/llm/chat-client';
import { carteVisiblePar, resoudre, type EcranAide } from './carte';
import type { DepotAide, FicheAide } from './fiches';

/**
 * Le moteur du bot d'aide : rappel, verdict, réponse, et validation des clés d'écran.
 *
 * Deux garanties : sans fiche pertinente, il dit qu'il ne sait pas sans appeler le modèle (appeler sans
 * source, c'est demander d'inventer) ; une clé d'écran inventée ne produit aucun lien, `resoudre` la cherchant
 * dans une liste fermée. Le reste est de la formulation.
 */

/** Ce qu'on demande au bot. */
export interface QuestionAide {
  question: string;
  /** Le rôle de la personne, qui décide des écrans qu'on a le droit de lui montrer. */
  role: string;
  langue: 'fr' | 'en';
  /** La clé de l'écran où elle se trouve, pour que l'aide soit contextuelle sans qu'elle le demande. */
  ecranCourant: string | null;
  /**
   * Les échanges précédents de la même session, du plus ancien au plus récent. Ils donnent le fil au modèle
   * (« et ensuite ? » ne veut rien dire seul) et rattrapent le rappel quand la question seule ne ramène rien.
   */
  historique?: EchangeAide[];
}

/** Un échange déjà eu : ce que la personne a demandé, ce que le bot a répondu. */
export interface EchangeAide {
  question: string;
  reponse: string;
}

export interface ReponseAide {
  /** `false` = aucune source pertinente. Le texte est alors vide et l'écran propose le recours humain. */
  sait: boolean;
  texte: string;
  /** Les titres des fiches utilisées, pour que le client voie d'où sort la réponse. */
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
 * Le schéma envoyé au modèle. `ecrans` prend des clés, jamais des adresses : le modèle choisit dans une liste
 * fermée, et `resoudre` refuse ce qui n'y est pas.
 */
export const SCHEMA_REPONSE = {
  type: 'object',
  properties: {
    reponse: {
      type: 'string',
      description: 'Ta réponse au client, dans sa langue, en t’appuyant UNIQUEMENT sur les fiches fournies. '
        + 'Donne le contenu toi-même : ne renvoie jamais vers une fiche, un article ou un lien.',
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

/**
 * Au-delà, ce n'est plus une question mais un message recopié : on borne le coût du rappel. La route l'importe
 * (`src/http/aide.ts`) : si elle acceptait plus que le moteur, la question serait tronquée en silence.
 */
export const QUESTION_MAX_CARACTERES = 500;
/** Ce qu'on donne du corps d'une fiche au modèle. Assez pour répondre, borné pour que le prompt reste petit. */
const CORPS_MAX = 2_000;
/** Combien de fiches partent au modèle, au plus. Trois suffisent et gardent la réponse nette. */
const FICHES_RENDUES = 3;
const DELAI_DEFAUT_MS = 20_000;
/**
 * Combien d'échanges passés partent au modèle. Borné parce que chaque appel renvoie tout le fil : son coût
 * grossirait à chaque question. Quatre suffisent à une question de suite.
 */
const MAX_ECHANGES = 4;

/**
 * Fusionne le rappel lexical et le rappel vectoriel, sans doublon. Une fiche trouvée des deux côtés garde ses
 * mesures lexicales et sa similarité, que le reclassement exploite.
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
 * Le verdict quand la recherche sémantique est branchée : le reclassement, et lui seul (aucun seuil ne tient
 * sur un cosinus d'embedding). Un échec du reclasseur retombe sur la règle lexicale : une panne du fournisseur
 * doit rendre le bot moins fin, pas muet.
 */
async function verdict(
  candidates: FicheAide[],
  question: string,
  recherche: RechercheSemantique,
): Promise<FicheAide[]> {
  if (candidates.length === 0) return [];
  try {
    // Le coût est le nôtre (le bot d'aide est sur notre clé) : il n'est débité à personne.
    const { scores } = await recherche.reclasser(question, candidates.map((f) => ({ texte: `${f.titre}\n${f.corps}` })));
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
    'Tu es l’aide en ligne de la console Messaging Me, qui sert à parler aux clients par WhatsApp.',
    'Tu réponds à un utilisateur de la console qui ne sait pas comment faire quelque chose.',
    '',
    `RÉPONDS EN ${q.langue === 'en' ? 'ANGLAIS' : 'FRANÇAIS'}, brièvement, en expliquant les étapes dans l’ordre.`,
    'Appuie-toi UNIQUEMENT sur les fiches qui te sont données. Si elles ne répondent pas, dis-le simplement.',
    'N’invente aucune fonctionnalité, aucun bouton, aucun écran.',
    // Le 2026-09-29, le bot a répondu « je vous renvoie vers la fiche … (cliquez sur le lien) » : les fiches sont
    // ses sources, pas des pages que la personne peut ouvrir, et l'écran n'affiche aucun lien vers elles.
    'RÉPONDS TOI-MÊME avec le contenu des fiches. Ne renvoie JAMAIS vers une fiche, un article, une documentation '
      + 'ou un lien, et ne promets aucun lien : la personne ne peut pas les ouvrir. Les seuls liens qu’elle verra '
      + 'sont les boutons des écrans que tu rends dans `ecrans`.',
    ici,
    '',
    'ÉCRANS où tu peux envoyer la personne. Rends leurs CLÉS dans `ecrans`, jamais leur nom ni une adresse :',
    liste,
  ].filter((l) => l !== '').join('\n');
}

/**
 * Construit le répondeur. Les fiches arrivent dans un message à part, entre délimiteurs, jamais concaténées à
 * la consigne : ce moteur doit pouvoir recevoir aussi des textes écrits par des inconnus.
 */
export function creerRepondeur(deps: DepsAide): (q: QuestionAide) => Promise<ReponseAide> {
  const rien: ReponseAide = { sait: false, texte: '', sources: [], ecrans: [] };
  return async (q) => {
    const question = q.question.trim().slice(0, QUESTION_MAX_CARACTERES);
    if (question === '') return rien;

    const large = deps.recherche !== null;
    const lexicales = await deps.depot.chercher(question, large ? deps.recherche!.candidats : FICHES_RENDUES);
    let candidates = lexicales;
    if (deps.recherche && deps.depot.chercherParVecteur) {
      try {
        const [vecteur] = (await deps.recherche.vectoriser([question])).vecteurs;
        if (vecteur) {
          candidates = fusionner(lexicales, await deps.depot.chercherParVecteur(vecteur, deps.recherche.candidats));
        }
      } catch {
        // Rappel vectoriel indisponible : on garde le lexical.
      }
    }

    let retenues = (deps.recherche ? await verdict(candidates, question, deps.recherche)
      : candidates.filter(ficheEstPertinente)).slice(0, FICHES_RENDUES);

    /**
     * Le rattrapage des questions de suite : « et ensuite ? » ne ramène rien au rappel. On ne cherche avec la
     * question précédente que si la question seule a échoué : la concaténer toujours ferait ramener les fiches du
     * sujet d'avant à une nouvelle question.
     */
    const precedente = q.historique?.at(-1)?.question?.trim() ?? '';
    if (retenues.length === 0 && precedente !== '') {
      const elargie = `${precedente} ${question}`.slice(0, QUESTION_MAX_CARACTERES);
      const rattrapees = await deps.depot.chercher(elargie, large ? deps.recherche!.candidats : FICHES_RENDUES);
      retenues = (deps.recherche ? await verdict(rattrapees, elargie, deps.recherche)
        : rattrapees.filter(ficheEstPertinente)).slice(0, FICHES_RENDUES);
    }

    // Aucune source : on ne va pas voir le modèle.
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
          // Le fil de la conversation, borné, rejoué tel quel.
          ...(q.historique ?? []).slice(-MAX_ECHANGES).flatMap((e): ChatMessage[] => [
            { role: 'user', content: e.question },
            { role: 'assistant', content: e.reponse },
          ]),
          { role: 'user', content: question },
        ],
        outils: [{ name: OUTIL_REPONDRE, description: 'Rends ta réponse et les écrans où aller.', parameters: SCHEMA_REPONSE }],
        toolChoice: OUTIL_REPONDRE,
        signal: abandon.signal,
      });
    } catch {
      // Panne ou délai dépassé : « je ne sais pas », qui propose le recours humain, plutôt qu'une erreur.
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
