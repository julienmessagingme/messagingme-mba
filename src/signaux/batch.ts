import { z } from 'zod';
import { parseRetryAfter, withRetry, type HttpTransport, type RetryOpts } from '../meta/http';
import {
  CHAMP_ID_EVENEMENT, MORCEAUX_RESUME, borneTexte, identifiantPoussable, morceauxDuResume,
  type ChampEvenement, type ContenuSignal, type NomEvenement, type SignalComplet,
} from './types';

/**
 * L'adaptateur Batch : le dictionnaire des signaux traduit pour l'API Profils de Batch.
 *
 * C'est le seul fichier (avec son travail de file et son réglage) où Batch existe : le dictionnaire (`types.ts`)
 * et l'émetteur ne le nomment pas, un second outil se branche par un second adaptateur. Il ne choisit aucun nom :
 * ceux des événements, attributs et champs viennent du dictionnaire, promis identiques pour tous les outils.
 * Batch est un hôte fixe, pas une adresse saisie par un client : la garde d'adresse publique ne s'applique pas.
 */

/** La file pg-boss de cet adaptateur (déclarée dans `BASE_QUEUES`). */
export const FILE_SIGNAUX_BATCH = 'signaux-batch';

/** La version de l'API Profils vit ici et nulle part ailleurs. */
export const BATCH_URL_PROFILS = 'https://api.batch.com/2.13/profiles/update';
export const BATCH_MAX_PROFILS = 200;
export const BATCH_MAX_EVENEMENTS = 15;
/**
 * Un attribut texte chez Batch fait de 1 à 300 caractères, de fiche comme d'événement. Un texte vide ou plus
 * long y est rejeté seul, en 202 `SUCCESS_WITH_PARTIAL_ERRORS` : la poussée « réussit » et la donnée disparaît.
 * D'où le résumé en morceaux (`morceauxDuResume`), et `propre`, qui écarte le vide.
 */
export const BATCH_MAX_TEXTE = 300;
/**
 * Batch n'accepte que les événements des dernières 24 heures, et aucun dans le futur ; un plus vieux est refusé
 * seul, en 202 `SUCCESS_WITH_PARTIAL_ERRORS`. La marge de cinq minutes couvre la durée d'un appel et de ses
 * rejeux (`withRetry`).
 */
export const BATCH_FENETRE_EVENEMENT_MS = 24 * 60 * 60_000 - 5 * 60_000;

export type ValeurBatch = string | number | boolean;
export interface EvenementBatch {
  name: string;
  time: string;
  attributes: Record<string, ValeurBatch>;
}
/**
 * Un attribut de fiche à `null` est effacé chez l'outil. Seul le risque de désengagement s'en sert
 * (`attributsEffaces`) : ailleurs une absence ne s'écrit pas (`propre`), une analyse sans note n'efface pas la
 * précédente. Un attribut d'événement n'est jamais `null`.
 */
export type AttributsProfil = Record<string, ValeurBatch | null>;
export interface ProfilBatch {
  identifiers: { custom_id: string };
  attributes?: AttributsProfil;
  events?: EvenementBatch[];
}
export interface OptionsBatch {
  /** L'espace a coché « Envoyer le résumé des conversations ». */
  resume: boolean;
  /**
   * Instant (ISO) avant lequel un événement n'est plus envoyé, l'outil le refuserait (`BATCH_FENETRE_EVENEMENT_MS`).
   * Il est compté (`tropVieux`), et seul l'état relu de sa fiche part (`attributsRelus`). Absent = aucun filtre.
   * Calculé par l'appelant, pour que la traduction reste pure.
   */
  evenementsDepuis?: string;
}

type Brut = Record<string, ValeurBatch | null | undefined>;
/** Les champs d'un événement, nommés par le dictionnaire : un nom qui n'y figure pas ne compile pas (`satisfies`). */
type Champs<N extends NomEvenement> = Partial<Record<ChampEvenement<N>, ValeurBatch | null>>;

const borne = (v: string): string => borneTexte(v, BATCH_MAX_TEXTE);

/**
 * 🔴 Une adresse ne se coupe pas : coupée, elle mène ailleurs ou nulle part. Au-delà de la borne des textes, le
 * champ est omis (`propre` écarte `null`).
 */
const adresseEntiere = (v: string | null): string | null => (v !== null && v.length <= BATCH_MAX_TEXTE ? v : null);

/**
 * Retire ce qui ne s'écrit pas chez l'outil et borne les textes. L'absence (`null`) et le texte vide sont écartés
 * tous les deux : Batch refuserait un texte vide attribut par attribut, en « succès partiel » dans le journal.
 */
function propre(o: Brut): Record<string, ValeurBatch> {
  const out: Record<string, ValeurBatch> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string') {
      if (v.trim() === '') continue;
      out[k] = borne(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * L'état de la fiche relu au moment de pousser (`completerSignal`) : identifiant et consentement courants, justes
 * quel que soit l'âge du signal, donc envoyés toujours. `em_contact_id` part à chaque poussée : réécrire la même
 * valeur ne coûte rien, et se souvenir de « déjà envoyé » serait un état de plus qui peut mentir.
 */
function attributsRelus(s: SignalComplet): Brut {
  return {
    em_contact_id: s.contact.contactId,
    em_whatsapp_optout: s.contact.optOutWhatsapp,
    em_rcs_optout: s.contact.optOutRcs,
  };
}

/**
 * Ce que le signal lui-même apprend de la fiche (dernière réponse, joignabilité RCS, dernière analyse) : vrai à la
 * date du signal, pas forcément aujourd'hui. `versBatch` ne l'écrit donc pas pour un signal trop vieux : un échec
 * RCS rejoué tard écraserait un « délivré » plus récent.
 */
function attributsDuSignal(s: SignalComplet): Brut {
  const c = s.contenu;
  const a: Brut = {};
  if (c.nom === 'em_replied') a['date(em_last_reply_at)'] = s.le;
  if ((c.nom === 'em_message_delivered' || c.nom === 'em_message_read') && c.canal === 'rcs') a.em_rcs_reachable = true;
  if (c.nom === 'em_message_failed' && c.canal === 'rcs') a.em_rcs_reachable = false;
  if (c.nom === 'em_conversation_analyzed') {
    a.em_last_intent = c.analyse.intent;
    a.em_last_sentiment = c.analyse.sentiment;
    a.em_last_resolved = c.analyse.resolved;
    // `null` n'est pas 0 : une analyse sans note ne l'écrase pas (`propre` retire la clé).
    a.em_satisfaction = c.analyse.satisfaction;
    a.em_urgency = c.analyse.urgence;
  }
  if (c.nom === 'em_risk_changed') {
    a.em_risk_level = c.niveau;
    a.em_risk_score = c.score;
    // Des codes courts, séparés par des virgules : trois au plus, donc loin des 300 caractères.
    a.em_risk_reasons = c.raisons.join(',');
  }
  return a;
}

/**
 * Ce que le signal efface chez l'outil, et seul le risque le demande : ses attributs décrivent l'état courant, et
 * ne rien écrire laisserait le score et les raisons d'avant à côté du niveau neuf. Même règle d'âge que
 * `attributsDuSignal` : un signal trop vieux n'efface rien.
 */
function attributsEffaces(s: SignalComplet): Record<string, null> {
  const c = s.contenu;
  if (c.nom !== 'em_risk_changed') return {};
  const out: Record<string, null> = {};
  if (c.score === null) out.em_risk_score = null;
  if (c.raisons.length === 0) out.em_risk_reasons = null;
  return out;
}

/**
 * Les champs d'un événement, sous les noms du dictionnaire : un champ renommé ou inventé ne compile pas
 * (`satisfies`), et `tests/signaux-batch.test.ts` vérifie qu'il n'en manque aucun.
 */
function attributsDEvenement(c: ContenuSignal): Brut {
  switch (c.nom) {
    case 'em_message_delivered':
      return { canal: c.canal, origine: c.origine, send_id: c.sendId } satisfies Champs<'em_message_delivered'>;
    case 'em_message_read':
      return { canal: c.canal, origine: c.origine, send_id: c.sendId } satisfies Champs<'em_message_read'>;
    case 'em_message_failed':
      return { canal: c.canal, origine: c.origine, send_id: c.sendId, motif: c.motif, code_meta: c.codeMeta } satisfies Champs<'em_message_failed'>;
    case 'em_replied':
      return { canal: c.canal, bouton: c.bouton } satisfies Champs<'em_replied'>;
    case 'em_link_clicked':
      return { lien: c.lien, template: c.template, destination: adresseEntiere(c.destination) } satisfies Champs<'em_link_clicked'>;
    case 'em_opted_out':
      return { canal: c.canal, source: c.source } satisfies Champs<'em_opted_out'>;
    case 'em_conversation_analyzed':
      return {
        intent: c.analyse.intent,
        sentiment: c.analyse.sentiment,
        satisfaction: c.analyse.satisfaction,
        urgence: c.analyse.urgence,
        resolved: c.analyse.resolved,
        topic: c.analyse.topic,
        action_suggestion: c.analyse.actionSuggestion,
        handled_by: c.analyse.handledBy,
        exchanges_count: c.analyse.exchangesCount,
      } satisfies Champs<'em_conversation_analyzed'>;
    case 'em_risk_changed':
      return {
        niveau: c.niveau,
        ancien_niveau: c.ancienNiveau,
        score: c.score,
        raisons: c.raisons.join(','),
      } satisfies Champs<'em_risk_changed'>;
  }
}

/**
 * `time` est la date du signal. La traduction reste pure : c'est l'option `evenementsDepuis`, calculée par le
 * travail de la file, qui écarte un événement trop vieux (`versBatch`).
 */
function evenement(s: SignalComplet, o: OptionsBatch): EvenementBatch {
  const c = s.contenu;
  const brut: Brut = { [CHAMP_ID_EVENEMENT]: s.id, ...attributsDEvenement(c) };
  // 🔴 Le résumé contient des propos du client : il ne part que si l'espace l'a demandé. En morceaux de 300
  // caractères au plus (`summary_1` à `summary_3`), le résumé pouvant atteindre 800.
  if (c.nom === 'em_conversation_analyzed' && o.resume && c.analyse.summary) {
    morceauxDuResume(c.analyse.summary).forEach((m, i) => {
      const cle = MORCEAUX_RESUME[i];
      if (cle !== undefined) brut[cle] = m;
    });
  }
  return { name: c.nom, time: s.le, attributes: propre(brut) };
}

/**
 * Traduit des signaux complets en corps d'appels à `POST /profiles/update`. Pure : aucune lecture, aucune date.
 *
 * - Une fiche sans `externalId` n'est pas poussée, elle est comptée (`sansIdentifiant`) et l'écran le montre.
 * - Une même fiche = un profil par appel ; ses événements restent dans l'ordre ; son état est celui du dernier
 *   signal.
 * - Au-delà de `BATCH_MAX_PROFILS` profils par appel ou `BATCH_MAX_EVENEMENTS` événements par profil, la fiche
 *   repasse dans l'appel suivant (jamais deux fois dans le même), et son état part avec sa dernière tranche.
 * - Un événement antérieur à `evenementsDepuis` est compté (`tropVieux`) sans être envoyé ; seul l'état relu de
 *   la fiche part alors, sans `events` si plus aucun ne reste.
 */
export function versBatch(
  signaux: readonly SignalComplet[],
  options: OptionsBatch,
): { requetes: ProfilBatch[][]; sansIdentifiant: number; tropVieux: number } {
  let sansIdentifiant = 0;
  let tropVieux = 0;
  const depuis = options.evenementsDepuis === undefined ? Number.NEGATIVE_INFINITY : Date.parse(options.evenementsDepuis);
  const parProfil = new Map<string, { attributes: AttributsProfil; events: EvenementBatch[] }>();
  for (const s of signaux) {
    const customId = identifiantPoussable(s.contact);
    if (customId === null) {
      sansIdentifiant += 1;
      continue;
    }
    const p = parProfil.get(customId) ?? { attributes: {}, events: [] };
    const vieux = Date.parse(s.le) < depuis;
    // Dans l'ordre des signaux : le dernier état d'une fiche gagne, qu'il écrive une valeur ou qu'il l'efface.
    Object.assign(p.attributes, propre({ ...attributsRelus(s), ...(vieux ? {} : attributsDuSignal(s)) }), vieux ? {} : attributsEffaces(s));
    if (vieux) tropVieux += 1;
    else p.events.push(evenement(s, options));
    parProfil.set(customId, p);
  }

  const requetes: ProfilBatch[][] = [];
  for (const [customId, p] of parProfil) {
    const tranches: EvenementBatch[][] = [];
    for (let i = 0; i < p.events.length; i += BATCH_MAX_EVENEMENTS) tranches.push(p.events.slice(i, i + BATCH_MAX_EVENEMENTS));
    // Tous ses événements étaient trop vieux : l'état relu de la fiche part seul, dans une tranche sans événement.
    if (tranches.length === 0) tranches.push([]);
    let depart = 0;
    tranches.forEach((events, i) => {
      let r = depart;
      while ((requetes[r]?.length ?? 0) >= BATCH_MAX_PROFILS) r += 1;
      const derniere = i === tranches.length - 1;
      (requetes[r] ??= []).push({
        identifiers: { custom_id: customId },
        ...(derniere ? { attributes: p.attributes } : {}),
        ...(events.length > 0 ? { events } : {}),
      });
      depart = r + 1;
    });
  }
  return { requetes, sansIdentifiant, tropVieux };
}

/**
 * Une réponse de Batch en erreur. `retryable` (429, 5xx) : `withRetry` rejoue, puis la file. Sinon terminal.
 * Son message part dans le journal des erreurs du client : il ne nomme pas l'outil (comme `NOM_APPEL_SIGNAUX`).
 */
export class BatchApiError extends Error {
  readonly retryAfterMs: number | undefined;
  constructor(readonly status: number, readonly retryable: boolean, readonly detail: string | null, retryAfterMs?: number) {
    super(`l’outil branché a répondu ${status}${detail ? ` : ${detail}` : ''}`);
    this.name = 'BatchApiError';
    this.retryAfterMs = retryAfterMs;
  }
}

export interface ClesBatch {
  cleRest: string;
  cleProjet: string;
}

/** La réponse de Batch, lue comme une entrée externe : `safeParse`, jamais `as`. */
const reponseBatch = z.object({
  code: z.string().optional(),
  errors: z.array(z.object({ attribute: z.string().optional(), reason: z.string().optional() }).passthrough()).optional(),
  error_message: z.string().optional(),
}).passthrough();

/**
 * Pousse un appel. Rejoue sur 429, 5xx et panne réseau (backoff borné de `withRetry`) ; un 4xx est terminal.
 * Un succès partiel (202 `SUCCESS_WITH_PARTIAL_ERRORS`) est rendu : l'appelant l'écrit dans le journal, sans quoi
 * un attribut refusé disparaîtrait en silence.
 */
export async function pousserVersBatch(
  requete: ProfilBatch[],
  cles: ClesBatch,
  transport: HttpTransport,
  retry: RetryOpts = {},
): Promise<{ partiel: string | null }> {
  return withRetry(async () => {
    const res = await transport.post(BATCH_URL_PROFILS, requete, {
      authorization: `Bearer ${cles.cleRest}`,
      'x-batch-project': cles.cleProjet,
    });
    const lu = reponseBatch.safeParse(res.json);
    const corps = lu.success ? lu.data : null;
    if (res.status >= 200 && res.status < 300) {
      if (corps?.code !== 'SUCCESS_WITH_PARTIAL_ERRORS') return { partiel: null };
      const e = corps.errors?.[0];
      const raison = [e?.attribute, e?.reason].filter((x): x is string => typeof x === 'string' && x !== '').join(' : ');
      return { partiel: borne(raison === '' ? 'erreurs partielles' : raison) };
    }
    const retryable = res.status === 429 || res.status >= 500;
    throw new BatchApiError(
      res.status,
      retryable,
      corps?.error_message ? borne(corps.error_message) : null,
      retryable ? parseRetryAfter(res.headers) : undefined,
    );
  }, retry);
}
