/**
 * D'OÙ peut venir la valeur d'une variable de connecteur, et comment on la calcule.
 *
 * 🔴 CATALOGUE FERMÉ, ET C'EST LA GARDE. `src/agent/champs-contact.ts` porte déjà la même doctrine pour les
 * attributs de la fiche : un chemin LIBRE ferait dériver une variable de n'importe quelle clé de la
 * projection, y compris d'une qu'on y ajouterait un jour pour tout autre chose. On l'étend ici sans
 * l'affaiblir : les nouvelles origines sont des CAS EXPLICITES, pas un chemin libre de plus.
 *
 * Ce que le client peut envoyer dans une requête, et rien d'autre :
 *  - `modele`   : le modèle décide de la valeur (c'est le paramètre d'un outil au sens classique) ;
 *  - `contact`  : un attribut de la fiche, dans la liste fermée de `champs-contact.ts` ;
 *  - `champ`    : un CHAMP PERSONNALISÉ du contact, désigné par sa clé. Ce cas manquait, et c'était le plus
 *                 demandé : dix champs personnalisés sont déclarés en production et aucun n'était atteignable ;
 *  - `systeme`  : une valeur calculée par la plateforme, liste fermée ci-dessous ;
 *  - `fixe`     : une constante écrite dans la configuration du connecteur.
 *
 * ⚠️ `champ` est désigné par une CLÉ, donc par une chaîne libre, ce qui ressemble au chemin libre qu'on
 * refuse juste au-dessus. La différence tient en un mot : l'espace des clés de `user_fields` est déclaré PAR
 * LE CLIENT, pour ses contacts, et ne contient par construction rien d'autre. Lire un champ personnalisé ne
 * peut donc pas atteindre une donnée que le client n'a pas lui-même créée. La route valide en plus que la clé
 * existe, pour que la faute de frappe se voie à la configuration et pas à l'exécution.
 */

import { CHAMPS_CONTACT_AUTORISES, type ChampContact } from './champs-contact';

/**
 * Les valeurs SYSTÈME. Fermée, courte, et chacune répond à un besoin nommé.
 *
 * `derniere_saisie` : le dernier message TEXTE écrit par le contact. Julien : « il faut qu'on ait un champ
 * système genre last text input, que systématiquement la dernière chose que le client ait dit soit un champ
 * mis à jour constamment ». C'est ce qui permet d'envoyer au système du client ce que la personne vient
 * d'écrire, sans demander au modèle de le recopier (et donc sans risquer qu'il le reformule).
 *
 * `maintenant` : l'instant courant, en ISO 8601 AVEC LE DÉCALAGE du fuseau de l'espace. Voir `formatMaintenant`.
 */
export const CLES_SYSTEME = ['derniere_saisie', 'maintenant'] as const;
export type CleSysteme = (typeof CLES_SYSTEME)[number];

export function estCleSysteme(v: unknown): v is CleSysteme {
  return typeof v === 'string' && (CLES_SYSTEME as readonly string[]).includes(v);
}

export type OrigineVariable =
  | { type: 'modele' }
  | { type: 'contact'; cle: ChampContact }
  | { type: 'champ'; cle: string }
  | { type: 'systeme'; cle: CleSysteme }
  | { type: 'fixe'; valeur: string | number | boolean };

export type ValeurResolue = string | number | boolean | null;

/**
 * Ce qu'il faut sous la main pour résoudre les variables d'UN appel. Tout est fourni par l'appelant : ce
 * module ne lit ni la base ni l'horloge, donc il se teste entièrement.
 */
export interface ContexteVariables {
  /**
   * 🔴 Le numéro vient du TOUR, pas de la projection, et c'est la clé de voûte anti-IDOR d'un connecteur.
   * Un connecteur sert d'abord à répondre « où en est MA commande » : la ressource est désignée par le
   * contact lui-même. `waId` est authentifié par la signature du webhook Meta ; le laisser venir des
   * arguments du modèle offrirait la commande du voisin au premier qui la demande.
   */
  waId: string;
  /** La PROJECTION du contact (bornée par l'appelant), ou `null` si le contact est inconnu. */
  contact: Record<string, unknown> | null;
  /** Les champs personnalisés du contact. Séparés de la projection : celle-ci part chez le fournisseur de
   *  modèle, ceux-là ne partent que dans la requête du client. */
  champs: Record<string, unknown> | null;
  /** Le dernier message TEXTE écrit par le contact, ou `null` s'il n'y en a pas encore. */
  derniereSaisie: string | null;
  /** Instant de référence. Injecté pour que le test ne dépende pas de l'horloge. */
  maintenant: Date;
  /** Fuseau IANA de l'espace (`tenant_settings.timezone`). */
  fuseau: string;
}

/**
 * L'instant courant en ISO 8601 AVEC le décalage du fuseau de l'espace : `2026-09-02T11:45:00+02:00`.
 *
 * 🔴 Pourquoi pas `toISOString()`, qui est ce que faisait le bloc « poser un champ = maintenant ». Cette
 * méthode rend toujours de l'UTC (`...T09:45:00.000Z`). Ce n'est pas faux, l'instant est le même et la
 * notation est internationale, mais elle a perdu l'heure LOCALE : un système client qui affiche la valeur
 * telle quelle montre 09:45 alors qu'il est 11:45 à Paris, et personne ne comprend d'où vient l'écart.
 * Avec le décalage explicite, l'instant reste le même, l'heure lue est la bonne, et la valeur reste
 * comparable et triable comme n'importe quel ISO 8601.
 *
 * Julien, le 2026-09-02 : « il faut que ça soit la valeur au format international qui prenne bien en compte
 * le GMT ». Les deux à la fois, donc, et c'est exactement ce que cette forme permet.
 */
export function formatMaintenant(instant: Date, fuseau: string): string {
  // `Intl` donne les composants DANS le fuseau ; le décalage se déduit de l'écart entre l'instant reconstruit
  // et l'instant réel. C'est la façon portable de le faire : `Date` n'expose aucun décalage arbitraire.
  // ⚠️ `hourCycle: 'h23'` et NON `hour12: false`. Les deux disent « format 24 h », mais le second laisse le
  // moteur choisir le cycle h24, où minuit se rend « 24:00 » : la chaîne produite ne serait alors pas un
  // ISO 8601 valide, une nuit sur deux, selon le moteur. On demande donc explicitement 00 à 23.
  const parties = new Intl.DateTimeFormat('en-CA', {
    timeZone: fuseau,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const p = (t: string): string => parties.find((x) => x.type === t)?.value ?? '00';
  const local = `${p('year')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}:${p('second')}`;
  // Le décalage : on relit la même heure locale comme si elle était en UTC, la différence EST le décalage.
  const commeUtc = Date.UTC(
    Number(p('year')), Number(p('month')) - 1, Number(p('day')),
    Number(p('hour')), Number(p('minute')), Number(p('second')),
  );
  const minutes = Math.round((commeUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
  const signe = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${local}${signe}${hh}:${mm}`;
}

/**
 * Résout UNE variable. Rend `null` quand la valeur n'existe pas (contact inconnu, champ jamais rempli) :
 * l'absence est une information, et c'est l'appelant qui décide si elle est acceptable.
 *
 * Une valeur absente n'est JAMAIS remplacée par une valeur par défaut inventée. Envoyer au système du client
 * une ville qu'on ne connaît pas serait pire que ne rien envoyer : sa réponse serait fausse, et l'agent la
 * répéterait au contact avec assurance.
 */
export function resoudreVariable(origine: OrigineVariable, ctx: ContexteVariables): ValeurResolue {
  switch (origine.type) {
    case 'fixe':
      return origine.valeur;
    case 'contact':
      // `wa_id` ne vient PAS de la projection : voir le commentaire de `ContexteVariables.waId`.
      if (origine.cle === 'wa_id') return ctx.waId;
      return normaliser(ctx.contact ? ctx.contact[origine.cle] : null);
    case 'champ':
      return normaliser(ctx.champs ? ctx.champs[origine.cle] : null);
    case 'systeme':
      if (origine.cle === 'maintenant') return formatMaintenant(ctx.maintenant, ctx.fuseau);
      return ctx.derniereSaisie;
    case 'modele':
      // La valeur vient des arguments du modèle, que l'exécuteur a déjà validés : rien à calculer ici. Ce cas
      // existe pour que le catalogue soit EXHAUSTIF, donc pour que le compilateur refuse une origine oubliée.
      return null;
    default: {
      // Exhaustivité vérifiée à la compilation : ajouter une origine sans la traiter ici ne compile pas.
      const jamais: never = origine;
      return jamais;
    }
  }
}

/**
 * Ramène une valeur de la base à ce qu'une requête sait transporter. Un objet ou un tableau devient `null`
 * plutôt que `[object Object]` : un appel silencieusement faux est pire qu'une valeur manquante, qui elle se
 * voit et se corrige.
 */
function normaliser(v: unknown): ValeurResolue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v === '' ? null : v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  return null;
}

/**
 * Le libellé d'une origine, tel que la console et la fenêtre de création d'agent l'affichent.
 *
 * 🔴 IL VIT ICI, à côté de la définition, et pas dans l'écran. La fenêtre de création d'agent doit annoncer
 * au client ce qui partira dans la requête (« on envoie Ville et Dernière saisie, c'est bien ça ? ») : deux
 * listes de libellés tenues séparément finiraient par ne plus dire la même chose que ce qui part réellement,
 * et ce serait une confirmation qui ment.
 */
export function libelleOrigine(origine: OrigineVariable): string {
  switch (origine.type) {
    case 'modele': return 'décidée par l’agent';
    case 'contact': return origine.cle === 'wa_id' ? 'numéro WhatsApp du contact' : 'nom du contact';
    case 'champ': return `champ « ${origine.cle} » du contact`;
    case 'systeme': return origine.cle === 'maintenant' ? 'date et heure courantes' : 'dernier message du contact';
    case 'fixe': return `valeur fixe « ${String(origine.valeur)} »`;
    default: {
      const jamais: never = origine;
      return jamais;
    }
  }
}

/** Les attributs de fiche proposés par la console. Ré-exporté pour que l'écran n'ait qu'un import. */
export { CHAMPS_CONTACT_AUTORISES };
