/**
 * Normalise une date venue d'un tiers vers l'ISO 8601, ou la refuse quand elle est ambiguë. Module pur, qui sert
 * tous les chemins d'écriture d'un champ (`validateFieldValue`, `canonicalizeFieldValue`).
 *
 * On normalise ce qui est non ambigu et on refuse le reste en le disant : `03/04/2026` peut être le 3 avril ou
 * le 4 mars, et deviner produirait des rappels décalés d'un mois sans que personne le voie. Le refus ne vaut que
 * parce que l'appelant remonte la raison.
 */

/** Ce qu'on sait faire d'une valeur reçue. */
export type NormalisationDate =
  | { ok: true; iso: string }
  /** La forme est reconnaissable mais ne désigne pas une date (jour et mois interchangeables). */
  | { ok: false; raison: 'ambigu' }
  /** Un jour sans heure, là où un instant est attendu. */
  | { ok: false; raison: 'sans_heure' }
  /** Rien d'exploitable. */
  | { ok: false; raison: 'illisible' };

/** ISO 8601 complet : `2026-08-23T15:40`, avec secondes, fraction et fuseau optionnels. */
const ISO_COMPLET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
/** Même chose, séparée par une espace : la forme que sortent la plupart des bases et des tableurs. */
const ISO_ESPACE = /^(\d{4}-\d{2}-\d{2})[ ]+(\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)$/;
/** Jour seul. */
const JOUR_SEUL = /^(\d{4})-(\d{2})-(\d{2})$/;
/**
 * Horodatage epoch : seulement 10 chiffres (secondes) ou 13 (millisecondes), pour ne pas confondre avec une
 * date compacte comme `20260823`.
 */
const EPOCH = /^\d{10}$|^\d{13}$/;
/**
 * Formes où le jour et le mois sont interchangeables : `03/04/2026`, `03-04-2026`, `3.4.26`. L'année doit être
 * en dernier (deux premiers groupes de 1 à 2 chiffres), sinon les dates ISO tomberaient dans « ambigu ».
 */
const AMBIGU = /^\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}([ T].*)?$/;

/** La date existe-t-elle vraiment ? Écarte `2026-02-30` et `2026-13-01`, que `Date.parse` accepterait en dérivant. */
function jourReel(annee: number, mois: number, jour: number): boolean {
  if (mois < 1 || mois > 12 || jour < 1 || jour > 31) return false;
  const d = new Date(Date.UTC(annee, mois - 1, jour));
  return d.getUTCFullYear() === annee && d.getUTCMonth() === mois - 1 && d.getUTCDate() === jour;
}

/**
 * Normalise vers l'ISO 8601, pour un champ `date` (jour seul) ou `datetime` (jour + heure). Une valeur sans
 * fuseau reste sans fuseau : une heure murale, lue dans le fuseau de l'espace ; lui coller un `Z` la décalerait.
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

  // Testé avant les formes ISO : sinon `03/04/2026` tomberait dans « illisible », et le message ne dirait plus
  // qu'il faut envoyer de l'ISO.
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
    // Un jour seul n'est pas un instant, et on ne lui invente pas minuit : un rappel réglé « 2 h avant »
    // partirait à 22 h la veille. On refuse, en disant ce qui manque.
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
