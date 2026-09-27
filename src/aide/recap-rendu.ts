import { z } from 'zod';
import { parse as secureJsonParse } from 'secure-json-parse';
import type { ChatMessage, OutilExpose, ReponseChat } from '../agent/llm/chat-client';
import { STATS_TZ } from '../stats/range';
import type { Recap } from './recap.pg';

/**
 * Le rendu du récap : un gabarit déterministe, et un modèle les jours où il achète quelque chose.
 *
 * Le modèle ne compte jamais, et c'est une garde, pas une consigne : tout nombre qu'il a le droit de citer est
 * dans son entrée, et `nombresInventes` refuse sa réponse si elle en contient un autre. Il n'est appelé que
 * quand le SQL a trouvé quelque chose de remarquable (un volume qui double, un sujet nouveau) : reformuler
 * une liste ne vaut pas la dépense, qui est la nôtre.
 */

/** Ce qui sort d'ici : le texte, et s'il a coûté un appel de modèle. */
export interface RecapTexte {
  texte: string;
  /** `false` = gabarit. Utile pour savoir, en exploitation, ce que le récap nous coûte réellement. */
  redigeParModele: boolean;
}

/**
 * L'écart à partir duquel un volume mérite une phrase, relatif et avec un plancher : sans plancher, passer de
 * 1 à 3 conversations ferait payer un appel de modèle pour commenter le bruit d'un petit espace.
 */
const ECART_NOTABLE = 0.5;
const PLANCHER_VOLUME = 5;

/** Un écart de volume digne d'être commenté, entre le jour et le même jour de la semaine précédente. */
function ecartNotable(jour: number, semaineAvant: number): boolean {
  if (Math.max(jour, semaineAvant) < PLANCHER_VOLUME) return false;
  if (semaineAvant === 0) return jour >= PLANCHER_VOLUME;
  return Math.abs(jour - semaineAvant) / semaineAvant >= ECART_NOTABLE;
}

/**
 * Un sujet qui n'existait pas le même jour de la semaine précédente. Rien quand la semaine d'avant n'a aucun
 * sujet : tout serait « nouveau », et un espace qui vient d'activer l'analyse paierait un appel par jour.
 */
function sujetNouveau(r: Recap): boolean {
  if (r.semainePrecedente.themes.length === 0) return false;
  return r.themes.some((t) => !r.semainePrecedente.themes.includes(t.topic));
}

/** Y a-t-il quelque chose à signaler, c'est-à-dire quelque chose qu'un gabarit ne dirait pas ? */
export function meriteUnModele(r: Recap): boolean {
  if (r.conversations === 0) return false;
  return ecartNotable(r.conversations, r.semainePrecedente.conversations)
    || ecartNotable(r.messagesEntrants, r.semainePrecedente.messagesEntrants)
    || sujetNouveau(r);
}

/** Le jour, écrit en toutes lettres dans la langue de la personne (« vendredi 12 septembre »). */
function jourEnToutesLettres(jour: string, langue: 'fr' | 'en'): string {
  // Midi UTC : quelle que soit la zone de rendu, on reste le bon jour civil.
  const d = new Date(`${jour}T12:00:00Z`);
  return d.toLocaleDateString(langue === 'en' ? 'en-GB' : 'fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: STATS_TZ,
  });
}

/**
 * Le texte déterministe, instantané et gratuit. C'est lui qui part les jours ordinaires, et c'est lui qui
 * rattrape une panne du modèle : un récap n'a jamais de raison d'échouer, les chiffres sont déjà calculés.
 */
export function gabarit(r: Recap, langue: 'fr' | 'en'): string {
  const quand = jourEnToutesLettres(r.jour, langue);
  if (r.conversations === 0) {
    return langue === 'en'
      ? `No conversation on ${quand}. Nothing came in that day.`
      : `Aucune conversation le ${quand}. Rien n'est arrivé ce jour-là.`;
  }

  const phrases: string[] = [];
  const nouvelles = r.conversationsNouvelles > 0
    ? (langue === 'en'
      ? ` (${r.conversationsNouvelles} new)`
      : ` (dont ${r.conversationsNouvelles} ${r.conversationsNouvelles > 1 ? 'nouvelles' : 'nouvelle'})`)
    : '';
  phrases.push(langue === 'en'
    ? `On ${quand}: ${r.conversations} conversation${r.conversations > 1 ? 's' : ''}${nouvelles}, `
      + `${r.messagesEntrants} message${r.messagesEntrants > 1 ? 's' : ''} received and ${r.messagesSortants} sent.`
    : `Le ${quand} : ${r.conversations} conversation${r.conversations > 1 ? 's' : ''}${nouvelles}, `
      + `${r.messagesEntrants} message${r.messagesEntrants > 1 ? 's' : ''} reçu${r.messagesEntrants > 1 ? 's' : ''} `
      + `et ${r.messagesSortants} envoyé${r.messagesSortants > 1 ? 's' : ''}.`);

  if (r.themes.length > 0) {
    const liste = r.themes.map((t) => `${t.topic} (${t.n})`).join(', ');
    phrases.push(langue === 'en' ? `Main topics: ${liste}.` : `Sujets dominants : ${liste}.`);
  }

  /**
   * La phrase qui dit ce qu'on ne sait pas : l'analyse ne tourne qu'à l'inactivité, et sans elle le récap
   * sous-déclarerait en silence.
   */
  const enAttente = r.conversations - r.conversationsAnalysees;
  if (enAttente > 0) {
    phrases.push(langue === 'en'
      ? `${enAttente} conversation${enAttente > 1 ? 's are' : ' is'} not analysed yet, so their topic is missing here.`
      : `${enAttente} conversation${enAttente > 1 ? 's ne sont' : ' n’est'} pas encore analysée${enAttente > 1 ? 's' : ''}, `
        + 'leur sujet n’apparaît donc pas ici.');
  }
  return phrases.join(' ');
}

/**
 * Tout nombre que le modèle a le droit d'écrire. La date n'en fait pas partie : le jour et le mois (1 à 31)
 * recouvrent la plage des pourcentages qu'un modèle invente le plus volontiers, et un « +20 % » passerait le
 * 20 du mois. Le modèle reçoit la date écrite en toutes lettres. L'écart entre conversations et conversations
 * analysées en fait partie : le gabarit le cite déjà.
 */
export function nombresDuRecap(r: Recap): Set<number> {
  return new Set<number>([
    0,
    r.conversations,
    r.conversationsNouvelles,
    r.conversationsAnalysees,
    r.conversations - r.conversationsAnalysees,
    r.messagesEntrants,
    r.messagesSortants,
    r.themes.length,
    ...r.themes.map((t) => t.n),
    r.semainePrecedente.conversations,
    r.semainePrecedente.messagesEntrants,
  ]);
}

/**
 * Les nombres du texte qui ne sont pas dans l'entrée du modèle : un seul, et le texte est jeté.
 *
 * Les séparateurs de milliers sont retirés avant lecture (« 1 234 » est un nombre), espaces insécable et fine
 * comprises, mais pas le retour à la ligne : « 42 » en fin de ligne suivi de « 128 » se lirait 42128. Un petit
 * nombre déjà présent dans l'entrée pour une autre raison passe même employé à tort : la garde arrête les
 * ordres de grandeur inventés.
 */
export function nombresInventes(texte: string, autorises: Set<number>): number[] {
  const trouves = texte.match(/\d+(?:[   ]\d{3})*/g) ?? [];
  return trouves
    .map((s) => Number(s.replace(/[   ]/g, '')))
    .filter((n) => Number.isFinite(n) && !autorises.has(n));
}

export interface DepsRedacteurRecap {
  completer(input: {
    modele: string;
    messages: ChatMessage[];
    outils: OutilExpose[];
    toolChoice: string;
    signal: AbortSignal;
  }): Promise<ReponseChat>;
  modele: string;
  /** Plafond de temps d'un appel. Au-delà, gabarit : le récap ne fait jamais attendre. */
  delaiMs?: number;
}

const OUTIL_RECAP = 'rediger_recap';
const DELAI_DEFAUT_MS = 20_000;
/** Un récap tient en trois phrases ; au-delà, personne ne le lit et on paie la différence. */
const TEXTE_MAX = 700;

const SCHEMA_RECAP = {
  type: 'object',
  properties: {
    texte: {
      type: 'string',
      description: 'Le récap, deux ou trois phrases, dans la langue demandée.',
    },
  },
  required: ['texte'],
};

const texteSchema = z.object({ texte: z.string() });

function consigne(langue: 'fr' | 'en'): string {
  return [
    'Tu rédiges le récap quotidien de la console Engage Me, qui sert à parler aux clients par WhatsApp.',
    `RÉDIGE EN ${langue === 'en' ? 'ANGLAIS' : 'FRANÇAIS'}, en deux ou trois phrases, sans titre ni liste à puces.`,
    '',
    'RÈGLE ABSOLUE : tu ne calcules RIEN. Tu ne cites que des nombres présents tels quels dans les données',
    'fournies. Pas de pourcentage, pas de moyenne, pas de différence que tu aurais calculée. Pour comparer,',
    'écris-le en mots (« deux fois plus », « nettement moins »), jamais en chiffres inventés.',
    '',
    'La date t’est donnée EN TOUTES LETTRES : recopie-la telle quelle, n’écris jamais une date en chiffres.',
    '',
    'Dis ce qui est REMARQUABLE : un volume qui s’écarte du même jour la semaine précédente, un sujet qui',
    'n’était pas là la semaine d’avant. Si des conversations ne sont pas encore analysées, dis-le.',
    'N’invente aucun fait, aucune cause, aucune recommandation.',
  ].join('\n');
}

/**
 * Le rédacteur. Il ne lève jamais : panne, délai dépassé, sortie illisible ou nombre inventé, tout retombe
 * sur le gabarit.
 */
export function creerRedacteurRecap(deps: DepsRedacteurRecap): (r: Recap, langue: 'fr' | 'en') => Promise<RecapTexte> {
  return async (r, langue) => {
    const repli: RecapTexte = { texte: gabarit(r, langue), redigeParModele: false };
    if (!meriteUnModele(r)) return repli;

    const abandon = new AbortController();
    const minuteur = setTimeout(() => abandon.abort(), deps.delaiMs ?? DELAI_DEFAUT_MS);
    let brut: ReponseChat;
    try {
      brut = await deps.completer({
        modele: deps.modele,
        messages: [
          { role: 'system', content: consigne(langue) },
          // Données dans un bloc délimité, jamais concaténées à la consigne. `jour` part en toutes lettres : des
          // chiffres de date obligeraient à rouvrir `nombresDuRecap` sur la plage 1-31, celle des pourcentages.
          {
            role: 'user',
            content: `<<<DONNEES>>>\n${JSON.stringify({ ...r, jour: jourEnToutesLettres(r.jour, langue) })}`
              + '\n<<<FIN DONNEES>>>',
          },
        ],
        outils: [{ name: OUTIL_RECAP, description: 'Rends le récap rédigé.', parameters: SCHEMA_RECAP }],
        toolChoice: OUTIL_RECAP,
        signal: abandon.signal,
      });
    } catch {
      return repli;
    } finally {
      clearTimeout(minuteur);
    }

    const appel = brut.appelsOutils.find((a) => a.nom === OUTIL_RECAP);
    if (!appel) return repli;
    let lu: unknown;
    try {
      lu = secureJsonParse(appel.argumentsJson);
    } catch {
      return repli;
    }
    // `safeParse`, jamais `parse` : la sortie d'un modèle est une entrée non fiable comme une autre.
    const valide = texteSchema.safeParse(lu);
    if (!valide.success) return repli;
    const texte = valide.data.texte.trim().slice(0, TEXTE_MAX);
    if (texte === '') return repli;
    // La garde : un seul nombre étranger à l'entrée et on rend le gabarit.
    if (nombresInventes(texte, nombresDuRecap(r)).length > 0) return repli;
    return { texte, redigeParModele: true };
  };
}

/**
 * Assemble le récap complet : le SQL compte, le rendu formule. Aucune fiche d'aide n'est consultée : branché
 * comme une question ordinaire, le récap tomberait dans « aucune fiche pertinente = je ne sais pas ».
 */
export function creerRecapRedige(deps: {
  recap(tenantId: string, jour: string): Promise<Recap>;
  rediger(r: Recap, langue: 'fr' | 'en'): Promise<RecapTexte>;
}): (tenantId: string, jour: string, langue: 'fr' | 'en') => Promise<RecapTexte> {
  return async (tenantId, jour, langue) => deps.rediger(await deps.recap(tenantId, jour), langue);
}
