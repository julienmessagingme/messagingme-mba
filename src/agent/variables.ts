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
 * Ce que la dernière analyse dit du contact, et son risque de départ. Les valeurs sont celles que reçoivent Batch
 * et Salesforce (`em_last_intent`, `em_last_sentiment`, `em_satisfaction`, `em_urgency`, `em_last_resolved`,
 * `em_risk_level`) : un même contact ne doit pas porter deux vérités selon l'outil qui les lit. `null` = pas de
 * mesure (conversation jamais analysée, note absente), jamais 0 ni une chaîne vide.
 */
export const CLES_ANALYSE = [
  'analyse_intention', 'analyse_sentiment', 'analyse_satisfaction', 'analyse_urgence', 'analyse_resolue', 'risque_depart',
] as const;
export type CleAnalyse = (typeof CLES_ANALYSE)[number];

export interface AnalyseDuContact {
  intention: string | null;
  sentiment: string | null;
  satisfaction: number | null;
  urgence: number | null;
  resolue: boolean | null;
  risque: string | null;
}

/**
 * Les valeurs système, liste fermée. `derniere_saisie` : le dernier message texte du contact, envoyé tel quel
 * sans demander au modèle de le recopier (donc de le reformuler). `maintenant` : l'instant courant en ISO
 * 8601 avec le décalage du fuseau de l'espace (`formatMaintenant`). Les clés `CLES_ANALYSE` : ce que la
 * dernière analyse de conversation dit du contact (renvoyer à un CRM « ce client est mécontent »).
 */
export const CLES_SYSTEME = ['derniere_saisie', 'maintenant', ...CLES_ANALYSE] as const;
export type CleSysteme = (typeof CLES_SYSTEME)[number];

/** Cette valeur système demande-t-elle la dernière analyse ? Sert au chargement paresseux du résolveur. */
export function estCleAnalyse(cle: string): cle is CleAnalyse {
  return (CLES_ANALYSE as readonly string[]).includes(cle);
}

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
  /** La dernière analyse du contact et son risque, ou `null` si rien n'a été lu (aucune variable ne la réclame,
   *  ou dépendance absente). */
  analyse: AnalyseDuContact | null;
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
    case 'systeme': {
      const cle = origine.cle;
      switch (cle) {
        case 'maintenant': return formatMaintenant(ctx.maintenant, ctx.fuseau);
        case 'derniere_saisie': return ctx.derniereSaisie;
        case 'analyse_intention': return ctx.analyse?.intention ?? null;
        case 'analyse_sentiment': return ctx.analyse?.sentiment ?? null;
        case 'analyse_satisfaction': return ctx.analyse?.satisfaction ?? null;
        case 'analyse_urgence': return ctx.analyse?.urgence ?? null;
        case 'analyse_resolue': return ctx.analyse?.resolue ?? null;
        case 'risque_depart': return ctx.analyse?.risque ?? null;
        default: {
          // Exhaustivité : une clé système ajoutée sans son cas ici ne compile pas.
          const jamais: never = cle;
          return jamais;
        }
      }
    }
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

/** Le libellé de chaque valeur système. Un `Record` sur la clé : une clé ajoutée sans libellé ne compile pas. */
export const LIBELLES_SYSTEME: Record<CleSysteme, string> = {
  derniere_saisie: 'dernier message du contact',
  maintenant: 'date et heure courantes',
  analyse_intention: 'intention de la dernière analyse',
  analyse_sentiment: 'sentiment de la dernière analyse',
  analyse_satisfaction: 'satisfaction de la dernière analyse (0 à 10)',
  analyse_urgence: 'urgence de la dernière analyse (0 à 10)',
  analyse_resolue: 'dernière conversation résolue (oui/non)',
  risque_depart: 'risque de départ du contact',
};

/**
 * Le libellé d'une origine, tel que la console l'affiche. Ici, à côté de la définition, parce que la
 * confirmation de ce qui part dans la requête doit dire ce qui part réellement.
 */
export function libelleOrigine(origine: OrigineVariable): string {
  switch (origine.type) {
    case 'modele': return 'décidée par l’agent';
    case 'contact': return origine.cle === 'wa_id' ? 'numéro WhatsApp du contact' : 'nom du contact';
    case 'champ': return `champ « ${origine.cle} » du contact`;
    case 'systeme': return LIBELLES_SYSTEME[origine.cle];
    case 'fixe': return `valeur fixe « ${String(origine.valeur)} »`;
    default: {
      const jamais: never = origine;
      return jamais;
    }
  }
}

/** Les attributs de fiche proposés par la console. Ré-exporté pour que l'écran n'ait qu'un import. */
export { CHAMPS_CONTACT_AUTORISES };
