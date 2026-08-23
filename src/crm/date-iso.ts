/**
 * Normalise une date venue d'un TIERS vers la forme ISO 8601, ou la refuse quand elle est AMBIGUË.
 *
 * Module PUR. Sert `validateFieldValue` et `canonicalizeFieldValue`, donc TOUS les chemins d'écriture d'un
 * champ (webhook entrant, API publique, import CSV, fiche contact, report de formulaire).
 *
 * 🔴 La règle de fond : on normalise ce qui est NON AMBIGU, on refuse le reste EN LE DISANT.
 *
 * `03/04/2026` peut être le 3 avril ou le 4 mars, et rien dans la valeur ne permet de trancher. Deviner
 * produirait des rappels envoyés un mois trop tôt ou trop tard, sans que personne ne s'en aperçoive : la
 * donnée aurait l'air juste. On refuse donc, avec un message qui dit quoi envoyer à la place.
 *
 * ⚠️ Un refus vaut mieux qu'une date fausse, mais UNIQUEMENT parce que l'appelant remonte la raison. Toute
 * évolution qui avalerait ce refus en silence rouvrirait le trou.
 */

/** Ce qu'on sait faire d'une valeur reçue. */
export type NormalisationDate =
  | { ok: true; iso: string }
  /** La forme est reconnaissable mais ne désigne pas UNE date (jour et mois interchangeables). */
  | { ok: false; raison: 'ambigu' }
  /** Un JOUR sans heure, là où un instant est attendu. */
  | { ok: false; raison: 'sans_heure' }
  /** Rien d'exploitable. */
  | { ok: false; raison: 'illisible' };

/** ISO 8601 complet : `2026-08-23T15:40`, avec secondes, fraction et fuseau optionnels. */
const ISO_COMPLET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
/** Même chose, mais séparée par une ESPACE : la forme que sortent la plupart des bases et des tableurs. */
const ISO_ESPACE = /^(\d{4}-\d{2}-\d{2})[ ]+(\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)$/;
/** Jour seul. */
const JOUR_SEUL = /^(\d{4})-(\d{2})-(\d{2})$/;
/**
 * Horodatage epoch. SEULEMENT 10 chiffres (secondes) ou 13 (millisecondes) : c'est ce qui permet de ne pas
 * confondre avec une date compacte du genre `20260823`, qui en fait 8 et n'est PAS un epoch.
 */
const EPOCH = /^\d{10}$|^\d{13}$/;
/**
 * Formes où le jour et le mois sont INTERCHANGEABLES : `03/04/2026`, `03-04-2026`, `3.4.26`.
 *
 * ⚠️ L'année doit être en DERNIER (deux premiers groupes de 1 à 2 chiffres). Une première version acceptait
 * 1 à 4 chiffres en tête, si bien que `2026-07-17` tombait dans « ambigu » : toutes les dates ISO, c'est-à-dire
 * exactement celles qu'on veut, auraient été refusées. Attrapé par la suite existante.
 */
const AMBIGU = /^\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}([ T].*)?$/;

/** La date existe-t-elle vraiment ? Écarte `2026-02-30` et `2026-13-01`, que `Date.parse` accepterait en dérivant. */
function jourReel(annee: number, mois: number, jour: number): boolean {
  if (mois < 1 || mois > 12 || jour < 1 || jour > 31) return false;
  const d = new Date(Date.UTC(annee, mois - 1, jour));
  return d.getUTCFullYear() === annee && d.getUTCMonth() === mois - 1 && d.getUTCDate() === jour;
}

/**
 * Normalise vers l'ISO 8601, pour un champ de type `date` (jour seul) ou `datetime` (jour + heure).
 *
 * ⚠️ Une valeur SANS fuseau est laissée SANS fuseau. C'est une heure murale, interprétée dans le fuseau de
 * l'espace au moment de l'évaluation (même convention que le `datetime-local` des écrans). Lui coller un
 * `Z` la décalerait de plusieurs heures, silencieusement.
 */
export function normaliserDate(valeur: string, type: 'date' | 'datetime'): NormalisationDate {
  const v = String(valeur ?? '').trim();
  if (v === '') return { ok: false, raison: 'illisible' };

  // Epoch : absolu par définition, donc rendu en UTC avec son `Z`. Aucune ambiguïté de fuseau ici.
  if (EPOCH.test(v)) {
    const ms = v.length === 10 ? Number(v) * 1000 : Number(v);
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return { ok: false, raison: 'illisible' };
    const iso = d.toISOString();
    return { ok: true, iso: type === 'date' ? iso.slice(0, 10) : iso };
  }

  // ⚠️ Testé AVANT les formes ISO : sinon `03/04/2026` tomberait dans « illisible », et le message perdrait
  // la seule information utile, à savoir qu'il faut envoyer du ISO.
  if (AMBIGU.test(v)) return { ok: false, raison: 'ambigu' };

  const espace = ISO_ESPACE.exec(v);
  const candidat = espace ? `${espace[1]}T${espace[2]}` : v;

  const complet = ISO_COMPLET.exec(candidat);
  if (complet) {
    if (!jourReel(Number(complet[1]), Number(complet[2]), Number(complet[3]))) return { ok: false, raison: 'illisible' };
    if (Number(complet[4]) > 23 || Number(complet[5]) > 59) return { ok: false, raison: 'illisible' };
    return { ok: true, iso: type === 'date' ? candidat.slice(0, 10) : candidat };
  }

  const jour = JOUR_SEUL.exec(candidat);
  if (jour) {
    if (!jourReel(Number(jour[1]), Number(jour[2]), Number(jour[3]))) return { ok: false, raison: 'illisible' };
    // 🔴 Un jour SEUL n'est pas un instant, et on ne lui invente pas minuit. C'est le contrat écrit depuis
    // toujours (« date nue = pas datetime ») et il compte encore plus depuis qu'un déclencheur peut partir
    // « X heures avant » cette valeur : un rappel réglé sur 2 h avant partirait à 22 h la VEILLE, et
    // personne ne verrait d'où vient le décalage. On refuse, en disant ce qui manque.
    if (type === 'datetime') return { ok: false, raison: 'sans_heure' };
    return { ok: true, iso: candidat };
  }

  return { ok: false, raison: 'illisible' };
}

/** Message rendu à l'appelant quand la normalisation échoue. Il doit dire quoi envoyer, pas seulement non. */
export function raisonDateLisible(raison: 'ambigu' | 'sans_heure' | 'illisible'): string {
  if (raison === 'ambigu') {
    return 'date ambiguë (jour et mois interchangeables) : envoyez la forme internationale, par exemple 2026-08-23T15:40:00Z';
  }
  if (raison === 'sans_heure') {
    return "il manque l'heure : un champ date et heure attend par exemple 2026-08-23T15:40:00Z, pas seulement 2026-08-23";
  }
  return 'date illisible : envoyez la forme internationale, par exemple 2026-08-23T15:40:00Z';
}
