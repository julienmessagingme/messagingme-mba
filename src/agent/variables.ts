/**
 * D'où peut venir la valeur d'une variable de connecteur, et comment on la calcule.
 *
 * 🔴 Catalogue fermé, c'est la garde : un chemin libre ferait dériver une variable de n'importe quelle clé
 * future de la fiche. Les origines possibles :
 *  - `modele`   : le modèle décide de la valeur ;
 *  - `fiche`    : un champ fixe de la fiche, dans la liste unique `src/crm/champs-fiche.ts` (numéro, nom,
 *                 identifiant externe, date de création, dernière analyse, risque de départ) ;
 *  - `champ`    : un champ personnalisé du contact, désigné par sa clé ;
 *  - `systeme`  : une valeur calculée par la plateforme (dernier message, instant courant) ;
 *  - `fixe`     : une constante écrite dans la configuration du connecteur.
 *
 * `champ` prend une clé libre, mais dans l'espace des champs que le client a lui-même déclarés : il ne peut
 * pas atteindre une donnée que le client n'a pas créée. La route vérifie que la clé existe.
 *
 * ⚠️ DEUX FORMES ANCIENNES SONT LUES ET RÉÉCRITES, jamais refusées (`normaliserOrigine`) : `contact:wa_id` et
 * `contact:nom`, et les valeurs d'analyse `systeme:analyse_*` / `systeme:risque_depart` du 2026-09-30 matin.
 * Des requêtes enregistrées les portent : les refuser ferait perdre une variable en silence à la relecture.
 */

import { champFiche, CLES_FICHE_SORTIE, type CleFicheFixe } from '../crm/champs-fiche';

/**
 * Les valeurs système, liste fermée. `derniere_saisie` : le dernier message texte du contact, envoyé tel quel
 * sans demander au modèle de le recopier (donc de le reformuler). `maintenant` : l'instant courant en ISO
 * 8601 avec le décalage du fuseau de l'espace (`formatMaintenant`). Ce que la dernière analyse dit du contact
 * est un champ de la FICHE depuis le lot 2 (origine `fiche`), plus une valeur système.
 */
export const CLES_SYSTEME = ['derniere_saisie', 'maintenant'] as const;
export type CleSysteme = (typeof CLES_SYSTEME)[number];

export type OrigineVariable =
  | { type: 'modele' }
  | { type: 'fiche'; cle: CleFicheFixe }
  | { type: 'champ'; cle: string }
  | { type: 'systeme'; cle: CleSysteme }
  | { type: 'fixe'; valeur: string | number | boolean };

/** Les anciennes clés système d'analyse, et le champ de fiche qu'elles désignent désormais. */
const ANCIENNES_CLES_ANALYSE: Readonly<Record<string, CleFicheFixe>> = {
  analyse_intention: 'analyse_intention',
  analyse_sentiment: 'analyse_sentiment',
  analyse_satisfaction: 'analyse_satisfaction',
  analyse_urgence: 'analyse_urgence',
  analyse_resolue: 'analyse_resolue',
  risque_depart: 'risque_depart',
};

/**
 * Une origine lue (en base ou dans un corps de requête), ramenée à la forme actuelle ; `null` si elle n'est
 * reconnue par aucune forme, actuelle ou ancienne. Ne valide que la FORME : les valeurs (`fixe`, clé de `champ`)
 * restent à la charge du schéma de la route.
 */
export function normaliserOrigine(o: unknown): OrigineVariable | null {
  if (o === null || typeof o !== 'object') return null;
  const { type, cle, valeur } = o as { type?: unknown; cle?: unknown; valeur?: unknown };
  if (type === 'modele') return { type: 'modele' };
  if (type === 'fixe' && (typeof valeur === 'string' || typeof valeur === 'number' || typeof valeur === 'boolean')) {
    return { type: 'fixe', valeur };
  }
  if (typeof cle !== 'string') return null;
  if (type === 'champ') return { type: 'champ', cle };
  if (type === 'fiche') return (CLES_FICHE_SORTIE as readonly string[]).includes(cle) ? { type: 'fiche', cle: cle as CleFicheFixe } : null;
  if (type === 'contact') return cle === 'wa_id' || cle === 'nom' ? { type: 'fiche', cle } : null;
  if (type === 'systeme') {
    if ((CLES_SYSTEME as readonly string[]).includes(cle)) return { type: 'systeme', cle: cle as CleSysteme };
    // `hasOwn` et pas un simple accès : `constructor` ou `__proto__` rendraient une propriété héritée d'Object.
    return Object.hasOwn(ANCIENNES_CLES_ANALYSE, cle) ? { type: 'fiche', cle: ANCIENNES_CLES_ANALYSE[cle]! } : null;
  }
  return null;
}

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
  /** Les champs personnalisés du contact, lus dans la projection que l'appelant a bornée. */
  champs: Record<string, unknown> | null;
  /** Le dernier message texte écrit par le contact, ou `null` s'il n'y en a pas encore. */
  derniereSaisie: string | null;
  /**
   * Les champs fixes de la fiche (`PgContactStore.ficheDuContact`), ou `null` si rien n'a été lu (aucune variable
   * ne les réclame, ou contact inconnu). `wa_id` n'y est jamais lu : il vient de `waId`.
   */
  fiche: Partial<Record<CleFicheFixe, ValeurResolue>> | null;
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
    case 'fiche':
      // `wa_id` ne vient pas de la base : voir `ContexteVariables.waId`.
      if (origine.cle === 'wa_id') return ctx.waId;
      return normaliser(ctx.fiche ? ctx.fiche[origine.cle] : null);
    case 'champ':
      return normaliser(ctx.champs ? ctx.champs[origine.cle] : null);
    case 'systeme': {
      const cle = origine.cle;
      switch (cle) {
        case 'maintenant': return formatMaintenant(ctx.maintenant, ctx.fuseau);
        case 'derniere_saisie': return ctx.derniereSaisie;
        default: {
          // Exhaustivité : une clé système ajoutée sans son cas ici ne compile pas. À l'exécution, `null` et
          // non la clé : `lireVariables` ne relit que le type de l'origine, donc une clé inconnue lue en base
          // (retour arrière depuis une version qui l'aurait ajoutée) partirait sinon comme valeur.
          const _jamais: never = cle;
          return null;
        }
      }
    }
    case 'modele':
      // La valeur vient des arguments du modèle, déjà validés par l'exécuteur. Ce cas rend le catalogue
      // exhaustif, pour que le compilateur refuse une origine oubliée.
      return null;
    default: {
      // Exhaustivité vérifiée à la compilation : ajouter une origine sans la traiter ici ne compile pas. À
      // l'exécution, `null` et JAMAIS l'origine elle-même : une forme non réécrite (une requête construite hors de
      // `lireVariables`) partirait sinon comme valeur, l'objet entier dans le corps envoyé au client.
      const _jamais: never = origine;
      return null;
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
};

/**
 * Le libellé d'une origine, tel que la console l'affiche. Ici, à côté de la définition, parce que la
 * confirmation de ce qui part dans la requête doit dire ce qui part réellement. Le libellé d'un champ de fiche
 * vient de la liste unique, jamais d'une copie.
 */
export function libelleOrigine(origine: OrigineVariable): string {
  switch (origine.type) {
    case 'modele': return 'décidée par l’agent';
    case 'fiche': return champFiche(origine.cle)?.libelle[0] ?? origine.cle;
    case 'champ': return `champ « ${origine.cle} » du contact`;
    case 'systeme': return LIBELLES_SYSTEME[origine.cle];
    case 'fixe': return `valeur fixe « ${String(origine.valeur)} »`;
    default: {
      // Exhaustivité à la compilation ; à l'exécution, un texte et jamais l'objet (même raison que `resoudreVariable`).
      const _jamais: never = origine;
      return 'origine inconnue';
    }
  }
}
