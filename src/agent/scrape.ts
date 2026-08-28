/**
 * Une page HTML transformée en fiches de connaissance. PURE : pas de réseau ici, la lecture est faite par
 * `src/lib/page-distante.ts` et la garde SSRF avec elle.
 *
 * 🔴 POURQUOI DÉCOUPER PLUTÔT QUE TOUT AVALER. La recherche de la tâche 16bis mesure « combien de termes de
 * la question se retrouvent dans la fiche ». Une page entière stockée en une fiche unique contient à peu près
 * tous les mots du site : elle deviendrait pertinente pour n'importe quelle question, et rendrait la garde
 * anti-hallucination inopérante sans qu'aucun test ne le voie. Le découpage par titre est donc une décision
 * de justesse, pas de confort de lecture.
 *
 * On ne cherche pas à faire un lecteur HTML : pas de dépendance nouvelle, pas d'arbre DOM. Une page mal
 * découpée se corrige à la main dans l'écran, ce qui est précisément la promesse faite au client (cadrage
 * §5.3 : « vous les voyez, vous les corrigez »).
 */

export interface FicheExtraite {
  titre: string;
  corps: string;
}

/** Au-delà, ce n'est plus une page de contenu mais un plan de site ou un catalogue : on refuse d'en faire
 *  trois cents fiches que personne ne relira. */
export const MAX_FICHES_PAR_PAGE = 40;
/** Un corps plus long qu'un article n'est plus une réponse : il sature le contexte du modèle au moment où il
 *  répond. Coupé, jamais rejeté, sinon la fiche entière serait perdue pour un paragraphe de trop. */
export const MAX_CORPS = 4000;
/** Un titre de fiche tient sur une ligne de l'écran ; au-delà c'est une phrase mal balisée. Exporté, et
 *  importé par le schéma de la route : deux plafonds différents feraient qu'un titre produit par l'import ne
 *  serait plus modifiable tel quel, exactement le piège déjà fermé pour le corps. */
export const MAX_TITRE = 200;
/** Sous ce seuil, la section n'a que son titre et une bribe : elle ferait du bruit dans la recherche sans
 *  jamais répondre à quoi que ce soit. */
const MIN_CORPS = 40;

/** Balises dont le CONTENU n'est pas du texte de page. Retirées avec leur contenu, pas seulement démarquées :
 *  un `<script>` laissé nu injecterait du JavaScript dans la base de connaissance, donc dans le prompt. */
const BLOCS_A_JETER = /<(script|style|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi;
/** Chrome de page : présent sur CHAQUE page d'un site, donc mot commun à toutes les fiches, donc bruit pur
 *  pour une recherche qui compte les mots partagés. */
const CHROME = /<(nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi;
const COMMENTAIRES = /<!--[\s\S]*?-->/g;
const TITRES = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi;

/** Entités nommées qu'on rencontre vraiment sur un site français. Le reste devient une espace : une entité
 *  inconnue laissée telle quelle mettrait « &hearts; » dans une réponse au contact. */
const NOMMEES: Record<string, string> = {
  nbsp: ' ', quot: '"', apos: "'", lt: '<', gt: '>', amp: '&',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', agrave: 'à', acirc: 'â', ccedil: 'ç',
  ugrave: 'ù', ucirc: 'û', ocirc: 'ô', icirc: 'î', iuml: 'ï', ntilde: 'ñ',
  euro: '€', laquo: '«', raquo: '»', hellip: '…', rsquo: '’', lsquo: '‘', deg: '°', middot: '·',
};

/**
 * Décodage des entités HTML, EN UNE SEULE PASSE.
 *
 * ⚠️ Une passe, et c'est la seule chose qui compte ici : une suite de `replace` traiterait `&amp;` avant ou
 * après les autres, et `&amp;lt;` finirait par rendre `<`. Le site aurait alors écrit du texte, et la base de
 * connaissance contiendrait une balise.
 */
function decoder(s: string): string {
  return s.replace(/&(#\d{1,6}|#x[0-9a-f]{1,5}|[a-z]{2,8});/gi, (_brut, corps: string) => {
    const c = corps.toLowerCase();
    if (c.startsWith('#')) {
      const point = c[1] === 'x' ? Number.parseInt(c.slice(2), 16) : Number(c.slice(1));
      // Les points de code de substitution feraient LEVER `fromCodePoint` : une page mal encodée ne doit pas
      // faire échouer tout un import.
      if (!Number.isFinite(point) || point <= 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return ' ';
      return String.fromCodePoint(point);
    }
    return NOMMEES[c] ?? ' ';
  });
}

/** Texte d'un fragment HTML : balises retirées, espaces resserrés, sauts de ligne préservés aux frontières de
 *  blocs pour qu'un corps reste lisible dans l'écran d'édition. */
function texte(html: string): string {
  return decoder(
    html
      .replace(/<(p|div|li|tr|br|h[1-6])\b[^>]*>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n[ \n]*/g, '\n')
    .trim();
}

function titreDuDocument(html: string, url: string): string {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const t = m ? texte(m[1] ?? '').replace(/\n/g, ' ').trim() : '';
  if (t !== '') return t.slice(0, MAX_TITRE);
  // Repli sur le chemin de l'adresse : « /tarifs-2026 » dit déjà quelque chose, « page » ne dit rien.
  try {
    const chemin = new URL(url).pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop();
    if (chemin) return decodeURIComponent(chemin).replace(/[-_]+/g, ' ').slice(0, MAX_TITRE);
  } catch { /* URL déjà validée en amont ; un repli reste dû si elle ne l'était pas. */ }
  return 'Page importée';
}

/**
 * Découpe une page en fiches, une par titre de niveau 1 à 3.
 *
 * Le texte qui PRÉCÈDE le premier titre (chapeau, introduction) n'est pas jeté : il devient une fiche portant
 * le titre du document. Sans ça, une page dont la réponse est dans son chapeau n'aurait aucune source.
 */
export function pageEnFiches(html: string, url: string): FicheExtraite[] {
  const propre = html.replace(COMMENTAIRES, ' ').replace(BLOCS_A_JETER, ' ').replace(CHROME, ' ');
  const titreDoc = titreDuDocument(html, url);

  // `ouverture` est l'endroit où la balise de titre commence, `debut` celui où son contenu commence : la
  // section précédente s'arrête à l'une, la suivante démarre à l'autre.
  const decoupes: Array<{ titre: string; ouverture: number; debut: number; fin: number }> = [];
  for (const m of propre.matchAll(TITRES)) {
    const brut = texte(m[2] ?? '').replace(/\n/g, ' ').trim();
    if (brut === '') continue;
    const ouverture = m.index ?? 0;
    if (decoupes.length > 0) decoupes[decoupes.length - 1]!.fin = ouverture;
    decoupes.push({ titre: brut.slice(0, MAX_TITRE), ouverture, debut: ouverture + m[0].length, fin: propre.length });
  }

  const fiches: FicheExtraite[] = [];
  // Le chapeau : tout ce qui précède le premier titre, ou la page entière quand elle n'en a aucun.
  const chapeau = texte(propre.slice(0, decoupes[0]?.ouverture ?? propre.length));
  if (chapeau.length >= MIN_CORPS) fiches.push({ titre: titreDoc, corps: chapeau.slice(0, MAX_CORPS) });

  for (const d of decoupes) {
    if (fiches.length >= MAX_FICHES_PAR_PAGE) break;
    const corps = texte(propre.slice(d.debut, d.fin));
    if (corps.length < MIN_CORPS) continue;
    fiches.push({ titre: d.titre, corps: corps.slice(0, MAX_CORPS) });
  }
  return fiches;
}
