/**
 * Extraction du code de vérification à 6 chiffres depuis la transcription d'un appel Meta. Module pur.
 *
 * Meta énonce le code deux fois, et une reconnaissance vocale française rend la même suite d'au moins trois
 * façons : « 123456 », « 1 2 3 4 5 6 », « douze trente-quatre cinquante-six » (regroupement par deux spontané).
 *
 * 🔴 Unanimité ou rien : Meta plafonne à 10 demandes par numéro sur 72 h et un code faux consomme une tentative.
 * Deux suites de six chiffres différentes : `null`, et l'humain lit la transcription.
 */

/** Longueur du code de vérification Meta. */
const CODE_LEN = 6;

const UNITES: Record<string, number> = {
  zero: 0, un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9,
  dix: 10, onze: 11, douze: 12, treize: 13, quatorze: 14, quinze: 15, seize: 16,
};
const DIZAINES: Record<string, number> = { vingt: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60 };

/** Minuscules, sans accents, traits d'union et ponctuation ramenés à des espaces. */
function normalise(v: string): string {
  return v
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Lit un nombre français à partir de `tokens[i]`, avec le nombre de jetons consommés, ou null. Couvre 0..99, y
 * compris « vingt et un », « soixante-douze », « quatre-vingts », « quatre-vingt-dix-sept ».
 */
function lireNombre(tokens: string[], i: number): { valeur: number; longueur: number } | null {
  const t = tokens[i];
  if (t === undefined) return null;

  // « dix-sept/huit/neuf » se composent, alors que dix à seize sont des mots pleins.
  const apresDix = tokens[i + 1];
  if (t === 'dix' && (apresDix === 'sept' || apresDix === 'huit' || apresDix === 'neuf')) {
    return { valeur: 10 + UNITES[apresDix]!, longueur: 2 };
  }

  // « quatre » suivi de « vingt » se lit 80 : ambiguïté assumée, parce qu'elle échoue du bon côté (le compte de
  // chiffres ne tombe plus sur 6, donc null et repli manuel, jamais un code faux).
  const suivantEstVingt = tokens[i + 1] === 'vingt' || tokens[i + 1] === 'vingts';
  if (t === 'quatre' && suivantEstVingt) {
    const reste = lireNombre(tokens, i + 2);
    // 80 + 0..19 (« quatre-vingt-dix-neuf »). Au-delà, le jeton suivant est un autre nombre.
    if (reste && reste.valeur <= 19) return { valeur: 80 + reste.valeur, longueur: 2 + reste.longueur };
    return { valeur: 80, longueur: 2 };
  }

  const dizaine = DIZAINES[t];
  if (dizaine !== undefined) {
    // « et » est un simple liant : « soixante et onze ».
    const j = tokens[i + 1] === 'et' ? i + 2 : i + 1;
    const liant = j - i - 1;
    const reste = lireNombre(tokens, j);
    // Soixante accepte 0..19 (« soixante-dix-neuf ») ; les autres dizaines s'arrêtent à 9.
    const plafond = dizaine === 60 ? 19 : 9;
    if (reste && reste.valeur <= plafond && reste.valeur > 0) {
      return { valeur: dizaine + reste.valeur, longueur: 1 + liant + reste.longueur };
    }
    return { valeur: dizaine, longueur: 1 };
  }

  const unite = UNITES[t];
  return unite === undefined ? null : { valeur: unite, longueur: 1 };
}

/**
 * Suites de chiffres contiguës de la transcription. Un mot qui n'est pas un nombre coupe la suite, pour ne pas
 * recoller le code avec un numéro de téléphone cité juste après.
 */
function suitesDeChiffres(texte: string): string[] {
  const tokens = normalise(texte).split(' ').filter((t) => t !== '');
  const suites: string[] = [];
  let courante = '';
  for (let i = 0; i < tokens.length; ) {
    const t = tokens[i]!;
    if (/^\d+$/.test(t)) {
      courante += t;
      i += 1;
      continue;
    }
    const nombre = lireNombre(tokens, i);
    if (nombre) {
      // Un nombre à deux chiffres en apporte deux : « douze trente-quatre cinquante-six » vaut « 1 2 3 4 5 6 ».
      courante += String(nombre.valeur);
      i += nombre.longueur;
      continue;
    }
    // Jeton non numérique : il ferme la suite (un « et » isolé aussi ; entre deux nombres, lireNombre l'a consommé).
    if (courante !== '') suites.push(courante);
    courante = '';
    i += 1;
  }
  if (courante !== '') suites.push(courante);
  return suites;
}

/**
 * Codes candidats d'une suite : elle-même si elle fait 6 chiffres, ou le code répété deux fois collé
 * (« 123456123456 »). Toute autre longueur est ambiguë, donc écartée.
 */
function candidatsDe(suite: string): string[] {
  if (suite.length === CODE_LEN) return [suite];
  if (suite.length === 2 * CODE_LEN && suite.slice(0, CODE_LEN) === suite.slice(CODE_LEN)) return [suite.slice(0, CODE_LEN)];
  return [];
}

/** Le code à 6 chiffres de la transcription, ou `null` s'il n'y en a aucun ou plusieurs différents. */
export function extraireCodeOtp(transcription: string): string | null {
  const candidats = suitesDeChiffres(transcription).flatMap(candidatsDe);
  if (candidats.length === 0) return null;
  return candidats.every((c) => c === candidats[0]) ? candidats[0]! : null;
}
