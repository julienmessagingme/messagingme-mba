import { parse as secureJsonParse } from 'secure-json-parse';
import { parseCsv } from '../crm/csv';
import type { Faq } from './client';

/**
 * Chargement en LOT d'un jeu de questions/réponses vers la FAQ de l'agent MBA.
 *
 * Pourquoi ce module existe : un client arrive avec ses Q/R déjà écrites ailleurs (Keolis Auxerre en avait
 * 78), et l'API MBA n'offre NI création en lot, NI déduplication, NI suppression en lot, NI corbeille. Un
 * import naïf rejoué deux fois double donc la base de connaissance, et il n'existe aucun moyen simple de
 * revenir en arrière. Tout est ici : extraire depuis la source, normaliser, puis COMPARER à l'existant pour
 * ne réécrire que ce qui change.
 *
 * ⚠️ Rien ici ne SUPPRIME. La doc Meta est explicite : le GET de la liste n'est pas paginé et rien ne garantit
 * qu'il reste exhaustif si Meta ajoute une pagination. Une réconciliation destructive (« tout ce qui n'est pas
 * dans mon fichier, je l'efface ») effacerait alors des entrées devenues invisibles.
 */

export interface FaqRow {
  question: string;
  answer: string;
}

/** Espaces réduits, bords coupés. `\s` couvre l'espace insécable, dont les exports Excel sont pleins. */
function texte(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.replace(/\s+/g, ' ').trim();
}

/**
 * Clé de comparaison d'une question : sans accent, sans casse, sans ponctuation de fin. C'est elle qui rend
 * un import REJOUABLE. « Les chiens sont-ils admis ? » et « les chiens sont ils admis » sont la même question
 * pour un humain ; sans cette normalisation, le second import créerait un doublon que personne ne verrait.
 */
export function cleQuestion(q: string): string {
  return texte(q)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// --- Extraction, une fonction par forme de source -------------------------------------------------

/** En-têtes reconnus, comparés via `cleQuestion` (donc accents et casse indifférents). */
const ENTETES_QUESTION = new Set(['question', 'questions', 'q', 'demande', 'intitule', 'titre']);
const ENTETES_REPONSE = new Set(['reponse', 'reponses', 'answer', 'answers', 'response', 'r', 'a', 'contenu']);

/**
 * CSV (et TSV, papaparse devine le séparateur). Les colonnes sont reconnues par leur nom ; à défaut, on
 * prend les DEUX PREMIÈRES colonnes. Ce repli est volontaire : la plupart des exports clients n'ont pas
 * d'en-tête normalisé, et l'écran d'import montre le résultat AVANT d'écrire quoi que ce soit chez Meta.
 */
export function extraireDepuisCsv(brut: string): FaqRow[] {
  const { headers, rows } = parseCsv(brut);
  if (headers.length === 0) return [];
  const trouve = (accepte: Set<string>): string | undefined => headers.find((h) => accepte.has(cleQuestion(h)));
  const colQ = trouve(ENTETES_QUESTION) ?? headers[0];
  const colA = trouve(ENTETES_REPONSE) ?? headers.find((h) => h !== colQ);
  if (colQ === undefined || colA === undefined) return [];
  return rows.map((r) => ({ question: texte(r[colQ]), answer: texte(r[colA]) }));
}

/** Reconnaît une paire Q/R dans un objet, quel que soit le nom des clés (question/q/demande, answer/reponse...). */
function paire(o: Record<string, unknown>): FaqRow | null {
  let question = '';
  let answer = '';
  for (const [k, v] of Object.entries(o)) {
    const cle = cleQuestion(k);
    if (question === '' && ENTETES_QUESTION.has(cle)) question = texte(v);
    else if (answer === '' && ENTETES_REPONSE.has(cle)) answer = texte(v);
  }
  return question === '' && answer === '' ? null : { question, answer };
}

/** JSON : un tableau d'objets `{question, answer}` (ou synonymes), ou un objet qui contient un tel tableau. */
export function extraireDepuisJson(valeur: unknown): FaqRow[] {
  if (Array.isArray(valeur)) {
    return valeur
      .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null && !Array.isArray(e))
      .map(paire)
      .filter((p): p is FaqRow => p !== null);
  }
  if (typeof valeur === 'object' && valeur !== null) {
    for (const v of Object.values(valeur as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        const lignes = extraireDepuisJson(v);
        if (lignes.length > 0) return lignes;
      }
    }
  }
  return [];
}

const ENTITES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', eacute: 'é', egrave: 'è',
};

function decoder(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (tout, corps: string) => {
    if (corps.startsWith('#')) {
      const n = corps[1] === 'x' || corps[1] === 'X' ? parseInt(corps.slice(2), 16) : parseInt(corps.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : tout;
    }
    return ENTITES[corps.toLowerCase()] ?? tout;
  });
}

/** Balises retirées, entités décodées, espaces réduits. Les blocs script/style sont ôtés AVANT (sinon leur code apparaît en réponse). */
function sansBalises(html: string): string {
  return texte(decoder(html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ')));
}

/**
 * HTML : trois stratégies STRUCTURELLES, dans l'ordre de fiabilité. Aucune heuristique sur les titres :
 * deviner « ce paragraphe répond à ce h3 » produit des réponses fausses avec l'aplomb d'une réponse juste,
 * et une FAQ fausse est pire que pas de FAQ. Si aucune structure n'est reconnue, on rend une liste vide et
 * l'appelant demande un CSV.
 *
 * 1. JSON-LD `FAQPage` (schema.org) : la forme que produisent WordPress, Shopify et la plupart des CMS.
 * 2. `<details><summary>` : l'accordéon natif.
 * 3. `<dl><dt><dd>` : la liste de définitions.
 */
export function extraireDepuisHtml(html: string): FaqRow[] {
  const parJsonLd = extraireJsonLd(html);
  if (parJsonLd.length > 0) return parJsonLd;

  const details: FaqRow[] = [];
  for (const m of html.matchAll(/<details\b[^>]*>([\s\S]*?)<\/details>/gi)) {
    const bloc = m[1] ?? '';
    const sum = /<summary\b[^>]*>([\s\S]*?)<\/summary>/i.exec(bloc);
    if (!sum) continue;
    details.push({ question: sansBalises(sum[1] ?? ''), answer: sansBalises(bloc.replace(sum[0], ' ')) });
  }
  if (details.length > 0) return details;

  const dl: FaqRow[] = [];
  for (const m of html.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi)) {
    dl.push({ question: sansBalises(m[1] ?? ''), answer: sansBalises(m[2] ?? '') });
  }
  return dl;
}

/** Parcourt les blocs `application/ld+json` et en tire les `Question`/`acceptedAnswer` de schema.org. */
function extraireJsonLd(html: string): FaqRow[] {
  const out: FaqRow[] = [];
  for (const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let doc: unknown;
    // JSON venu d'un site tiers : `secureJsonParse` neutralise __proto__/constructor (même règle que le webhook).
    try { doc = secureJsonParse(m[1] ?? ''); } catch { continue; }
    collecterQuestions(doc, out);
  }
  return out;
}

function collecterQuestions(noeud: unknown, out: FaqRow[], profondeur = 0): void {
  if (profondeur > 8 || noeud === null || typeof noeud !== 'object') return;
  if (Array.isArray(noeud)) {
    for (const e of noeud) collecterQuestions(e, out, profondeur + 1);
    return;
  }
  const o = noeud as Record<string, unknown>;
  const type = Array.isArray(o['@type']) ? o['@type'].map(String) : [String(o['@type'] ?? '')];
  if (type.includes('Question') && typeof o.name === 'string') {
    const rep = o.acceptedAnswer ?? o.suggestedAnswer;
    const corps = Array.isArray(rep) ? rep[0] : rep;
    const brut = corps && typeof corps === 'object' ? (corps as Record<string, unknown>).text : undefined;
    out.push({ question: sansBalises(o.name), answer: sansBalises(typeof brut === 'string' ? brut : '') });
    return;
  }
  for (const v of Object.values(o)) collecterQuestions(v, out, profondeur + 1);
}

// --- Normalisation et plan d'écriture -------------------------------------------------------------

/** Nettoie, jette les lignes incomplètes, dédoublonne DANS le lot (la 1re occurrence gagne). */
export function normaliser(lignes: FaqRow[]): FaqRow[] {
  const vues = new Set<string>();
  const out: FaqRow[] = [];
  for (const l of lignes) {
    const question = texte(l.question);
    const answer = texte(l.answer);
    if (question === '' || answer === '') continue;
    const cle = cleQuestion(question);
    if (cle === '' || vues.has(cle)) continue;
    vues.add(cle);
    out.push({ question, answer });
  }
  return out;
}

export interface PlanImport {
  aCreer: FaqRow[];
  /** `metadata` est repassé tel quel : le PUT de MBA est un remplacement complet, l'omettre l'effacerait. */
  aMettreAJour: Array<{ id: string; question: string; answer: string; metadata?: Record<string, string> }>;
  /** Déjà présentes avec la même réponse : aucun appel. C'est ce qui rend un ré-import gratuit. */
  inchangees: number;
}

/**
 * Compare le lot voulu à ce que Meta a déjà, et rend le plan d'écriture. L'appariement se fait sur la clé de
 * question : c'est la seule chose stable, l'`id` Meta n'existe pas encore côté client et ne survit d'ailleurs
 * pas à un cycle suppression/recréation.
 */
export function planifierImport(existantes: Faq[], voulues: FaqRow[]): PlanImport {
  const parCle = new Map<string, Faq>();
  for (const f of existantes) {
    const cle = cleQuestion(f.question ?? '');
    if (cle !== '' && !parCle.has(cle)) parCle.set(cle, f);
  }

  const plan: PlanImport = { aCreer: [], aMettreAJour: [], inchangees: 0 };
  for (const v of normaliser(voulues)) {
    const deja = parCle.get(cleQuestion(v.question));
    if (!deja || deja.id === undefined) { plan.aCreer.push(v); continue; }
    if (texte(deja.answer) === v.answer && texte(deja.question) === v.question) { plan.inchangees += 1; continue; }
    plan.aMettreAJour.push({
      id: deja.id,
      question: v.question,
      answer: v.answer,
      ...(deja.metadata ? { metadata: deja.metadata } : {}),
    });
  }
  return plan;
}
