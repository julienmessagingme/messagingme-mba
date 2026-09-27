/**
 * D'où peut venir la valeur d'une variable de connecteur, et comment on la calcule.
 *
 * 🔴 Catalogue fermé, c'est la garde : un chemin libre ferait dériver une variable de n'importe quelle clé
 * future de la projection. Les origines possibles :
 *  - `modele`   : le modèle décide de la valeur ;
 *  - `contact`  : un attribut de la fiche, dans la liste fermée de `champs-contact.ts` ;
 *  - `champ`    : un champ personnalisé du contact, désigné par sa clé ;
 *  - `systeme`  : une valeur calculée par la plateforme, liste fermée ci-dessous ;
 *  - `fixe`     : une constante écrite dans la configuration du connecteur.
 *
 * `champ` prend une clé libre, mais dans l'espace des champs que le client a lui-même déclarés : il ne peut
 * pas atteindre une donnée que le client n'a pas créée. La route vérifie que la clé existe.
 */

import { CHAMPS_CONTACT_AUTORISES, type ChampContact } from './champs-contact';

/**
 * Les valeurs système, liste fermée. `derniere_saisie` : le dernier message texte du contact, envoyé tel quel
 * sans demander au modèle de le recopier (donc de le reformuler). `maintenant` : l'instant courant en ISO
 * 8601 avec le décalage du fuseau de l'espace (`formatMaintenant`).
 */
export const CLES_SYSTEME = ['derniere_saisie', 'maintenant'] as const;
export type CleSysteme = (typeof CLES_SYSTEME)[number];

export type OrigineVariable =
  | { type: 'modele' }
  | { type: 'contact'; cle: ChampContact }
  | { type: 'champ'; cle: string }
  | { type: 'systeme'; cle: CleSysteme }
  | { type: 'fixe'; valeur: string | number | boolean };

export type ValeurResolue = string | number | boolean | null;

/**
 * Ce qu'il faut pour résoudre les variables d'un appel, tout fourni par l'appelant : ce module ne lit ni la
 * base ni l'horloge.
 */
export interface ContexteVariables {
  /**
   * 🔴 Le numéro vient du tour, authentifié par la signature du webhook Meta, jamais des arguments du modèle :
   * sinon un connecteur offrirait la commande du voisin au premier qui la demande.
   */
  waId: string;
  /** La projection du contact (bornée par l'appelant), ou `null` si le contact est inconnu. */
  contact: Record<string, unknown> | null;
  /** Les champs personnalisés du contact. Séparés de la projection : celle-ci part chez le fournisseur de
   *  modèle, ceux-là ne partent que dans la requête du client. */
  champs: Record<string, unknown> | null;
  /** Le dernier message texte écrit par le contact, ou `null` s'il n'y en a pas encore. */
  derniereSaisie: string | null;
  /** Instant de référence. Injecté pour que le test ne dépende pas de l'horloge. */
  maintenant: Date;
  /** Fuseau IANA de l'espace (`tenant_settings.timezone`). */
  fuseau: string;
}

/**
 * L'instant courant en ISO 8601 avec le décalage du fuseau de l'espace : `2026-09-02T11:45:00+02:00`.
 * Pas `toISOString()`, qui rend de l'UTC : un système client qui affiche la valeur telle quelle montrerait
 * 09:45 quand il est 11:45 à Paris. Le décalage explicite garde un instant comparable et triable.
 */
export function formatMaintenant(instant: Date, fuseau: string): string {
  // `Intl` donne les composants dans le fuseau, le décalage se déduit ensuite (`Date` n'en expose aucun).
  // `hourCycle: 'h23'` et non `hour12: false`, qui laisse le moteur choisir h24 et rendre minuit « 24:00 »,
  // ce qui n'est pas un ISO 8601 valide.
  const parties = new Intl.DateTimeFormat('en-CA', {
    timeZone: fuseau,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const p = (t: string): string => parties.find((x) => x.type === t)?.value ?? '00';
  const local = `${p('year')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}:${p('second')}`;
  // Le décalage : on relit la même heure locale comme si elle était en UTC, la différence est le décalage.
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
 * Résout une variable. Rend `null` quand la valeur n'existe pas (contact inconnu, champ jamais rempli) :
 * c'est l'appelant qui décide si l'absence est acceptable. Jamais de valeur par défaut inventée, sinon le
 * système du client répondrait faux et l'agent le répéterait avec assurance.
 */
export function resoudreVariable(origine: OrigineVariable, ctx: ContexteVariables): ValeurResolue {
  switch (origine.type) {
    case 'fixe':
      return origine.valeur;
    case 'contact':
      // `wa_id` ne vient pas de la projection : voir `ContexteVariables.waId`.
      if (origine.cle === 'wa_id') return ctx.waId;
      return normaliser(ctx.contact ? ctx.contact[origine.cle] : null);
    case 'champ':
      return normaliser(ctx.champs ? ctx.champs[origine.cle] : null);
    case 'systeme':
      if (origine.cle === 'maintenant') return formatMaintenant(ctx.maintenant, ctx.fuseau);
      return ctx.derniereSaisie;
    case 'modele':
      // La valeur vient des arguments du modèle, déjà validés par l'exécuteur. Ce cas rend le catalogue
      // exhaustif, pour que le compilateur refuse une origine oubliée.
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
 * Le libellé d'une origine, tel que la console l'affiche. Ici, à côté de la définition, parce que la
 * confirmation de ce qui part dans la requête doit dire ce qui part réellement.
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
