import { CORPS_MAX } from './resolvers/connaissance';

/**
 * Une page HTML transformée en fiches de connaissance. Pure : la lecture et la garde SSRF sont dans
 * `src/lib/page-distante.ts`.
 *
 * Découpée par titre plutôt qu'avalée : une page entière en une fiche contient presque tous les mots du site,
 * serait pertinente pour n'importe quelle question, et rendrait la garde anti-hallucination inopérante. Pas
 * de lecteur HTML (ni dépendance ni DOM) : une page mal découpée se corrige à la main dans l'écran.
 */

export interface FicheExtraite {
  titre: string;
  corps: string;
}

/** Au-delà, ce n'est plus une page de contenu mais un plan de site ou un catalogue : on refuse d'en faire
 *  trois cents fiches que personne ne relira. */
export const MAX_FICHES_PAR_PAGE = 40;
/**
 * Le corps d'une fiche, au plus : ce que l'agent en lit, et pas un caractère de plus. La recherche lit la fiche
 * entière, donc une fiche plus longue serait trouvée pour une phrase que l'agent ne reçoit pas. Dérivé et non
 * recopié : deux nombres écrits à la main ont divergé une fois, c'est le défaut du 2026-09-29.
 */
export const MAX_CORPS = CORPS_MAX;
/** Un titre de fiche tient sur une ligne de l'écran. Exporté pour le schéma de la route : deux plafonds
 *  différents rendraient un titre importé impossible à modifier tel quel. */
export const MAX_TITRE = 200;
/** Sous ce seuil, la section n'a que son titre et une bribe : elle ferait du bruit dans la recherche sans
 *  jamais répondre à quoi que ce soit. */
const MIN_CORPS = 40;

/** Balises dont le contenu n'est pas du texte de page, retirées avec leur contenu : un `<script>` laissé nu
 *  injecterait du JavaScript dans la base de connaissance, donc dans le prompt. */
const BLOCS_A_JETER = /<(script|style|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi;
/**
 * Chrome de page : présent sur chaque page d'un site, donc bruit pur pour une recherche qui compte les mots
 * partagés. Pas `form` : un formulaire est un conteneur, et certains sites (ASP.NET WebForms) y enveloppent
 * tout le corps de page.
 */
const CHROME = /<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi;

/**
 * Part du texte qu'il faut au minimum conserver après retrait du chrome. Si le retrait emporte l'essentiel
 * de la page, ce n'était pas du chrome : on garde la page entière. Une fiche bruyante se corrige à l'écran,
 * une page perdue ne se voit pas.
 */
const PART_MIN_APRES_CHROME = 0.2;

/** Longueur du texte nu, pour comparer deux états du même document. */
function longueurTexte(html: string): number {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
}

/** Retire le chrome, sauf quand ce retrait emporte l'essentiel de la page. */
function retirerChrome(html: string): string {
  const avant = longueurTexte(html);
  const apres = html.replace(CHROME, ' ');
  if (avant === 0) return apres;
  return longueurTexte(apres) < avant * PART_MIN_APRES_CHROME ? html : apres;
}
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
 * Décodage des entités HTML, en une seule passe : une suite de `replace` finirait par rendre `<` à partir
 * de `&amp;lt;`, et la base de connaissance contiendrait une balise.
 */
function decoder(s: string): string {
  return s.replace(/&(#\d{1,6}|#x[0-9a-f]{1,5}|[a-z]{2,8});/gi, (_brut, corps: string) => {
    const c = corps.toLowerCase();
    if (c.startsWith('#')) {
      const point = c[1] === 'x' ? Number.parseInt(c.slice(2), 16) : Number(c.slice(1));
      // Les points de code de substitution feraient lever `fromCodePoint` : une page mal encodée ne doit pas
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
 * Un texte en fiches de `MAX_CORPS` au plus, ajoutées à `fiches` tant que le plafond le permet ; la suite prend
 * « (suite N) ». Coupé sur une frontière de ligne ou de mot quand il y en a une dans le dernier quart, jamais
 * entre les deux moitiés d'un emoji (une moitié seule ne passe pas en base), et jamais tronqué : le reste
 * serait perdu en silence, et le client croirait sa page ou son document importé.
 */
export function empilerEnFiches(fiches: FicheExtraite[], titre: string, contenu: string): void {
  let reste = contenu.trim();
  let tranche = 0;
  while (reste.length > 0 && fiches.length < MAX_FICHES_PAR_PAGE) {
    let coupe = Math.min(MAX_CORPS, reste.length);
    if (coupe < reste.length) {
      const frontiere = Math.max(reste.lastIndexOf('\n', coupe), reste.lastIndexOf(' ', coupe));
      if (frontiere > coupe * 0.75) coupe = frontiere;
      const avant = reste.charCodeAt(coupe - 1);
      if (avant >= 0xd800 && avant <= 0xdbff) coupe -= 1;
    }
    const corps = reste.slice(0, coupe).trim();
    reste = reste.slice(coupe).trim();
    if (corps.length === 0) break;
    tranche += 1;
    // Le suffixe est réservé avant de couper le titre : coupé après, il disparaîtrait d'un titre long.
    const suite = tranche === 1 ? '' : ` (suite ${tranche})`;
    fiches.push({ titre: titre.slice(0, MAX_TITRE - suite.length).replace(/[\ud800-\udbff]$/, '') + suite, corps });
  }
}

/**
 * Découpe une page en fiches, une par titre de niveau 1 à 3. Le texte qui précède le premier titre devient
 * une fiche au titre du document : la réponse est parfois dans le chapeau.
 */
export function pageEnFiches(html: string, url: string): FicheExtraite[] {
  const propre = retirerChrome(html.replace(COMMENTAIRES, ' ').replace(BLOCS_A_JETER, ' '));
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
  if (chapeau.length >= MIN_CORPS) empilerEnFiches(fiches, titreDoc, chapeau);

  for (const d of decoupes) {
    if (fiches.length >= MAX_FICHES_PAR_PAGE) break;
    const corps = texte(propre.slice(d.debut, d.fin));
    if (corps.length < MIN_CORPS) continue;
    empilerEnFiches(fiches, d.titre, corps);
  }
  return fiches;
}
