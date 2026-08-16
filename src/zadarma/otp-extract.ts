/**
 * Extraction du code de vérification à 6 chiffres depuis la TRANSCRIPTION d'un appel Meta.
 *
 * Module PUR (aucune IO) : c'est le maillon dont dépend toute l'automatisation de l'OTP, donc celui qui doit
 * être éprouvé sans réseau, sans Zadarma et sans Meta.
 *
 * Ce qu'il faut savoir sur la matière première. Meta appelle le numéro et énonce le code, deux fois. Une
 * reconnaissance vocale française peut rendre la même suite de chiffres d'au moins trois façons :
 *   « 123456 » · « 1 2 3 4 5 6 » · « douze trente-quatre cinquante-six »
 * La dernière n'est pas un cas d'école : un moteur français regroupe spontanément les chiffres par deux. Ne
 * traiter que les chiffres écrits, c'est n'attraper qu'un cas sur trois.
 *
 * 🔴 RÈGLE DE SÛRETÉ : unanimité ou rien. Meta plafonne à 10 demandes par numéro sur 72 h ; un code faux
 * consomme une tentative et rapproche du blocage. Si la transcription contient deux suites de six chiffres
 * DIFFÉRENTES, on ne devine pas : on rend `null` et l'humain lit la transcription. Mieux vaut un repli manuel
 * qu'une tentative brûlée.
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
 * Lit UN nombre français à partir de `tokens[i]`. Rend sa valeur et le nombre de jetons consommés, ou null si
 * `tokens[i]` n'ouvre pas un nombre. Couvre 0..99, y compris les formes composées qui piègent :
 * « vingt et un », « soixante-douze », « quatre-vingts », « quatre-vingt-dix-sept ».
 */
function lireNombre(tokens: string[], i: number): { valeur: number; longueur: number } | null {
  const t = tokens[i];
  if (t === undefined) return null;

  // « dix-sept/huit/neuf » : ces trois-là se composent, alors que dix à seize sont des mots pleins. Sans ce cas,
  // « quatre-vingt-dix-sept » se lisait 90 puis 7, et le compte de chiffres partait de travers.
  const apresDix = tokens[i + 1];
  if (t === 'dix' && (apresDix === 'sept' || apresDix === 'huit' || apresDix === 'neuf')) {
    return { valeur: 10 + UNITES[apresDix]!, longueur: 2 };
  }

  // « quatre-vingt(s) ... » : « quatre » est AUSSI une unité, seul le jeton suivant tranche. La fusion est
  // inconditionnelle, donc un « 4 » suivi d'un « 20 » se lit 80 : l'ambiguïté est inhérente à un texte sans
  // ponctuation fiable, et on l'assume parce qu'elle échoue du bon côté (le compte de chiffres ne tombe plus
  // sur 6, donc `extraireCodeOtp` rend null et le repli manuel prend la main, au lieu d'un code faux).
  const suivantEstVingt = tokens[i + 1] === 'vingt' || tokens[i + 1] === 'vingts';
  if (t === 'quatre' && suivantEstVingt) {
    const reste = lireNombre(tokens, i + 2);
    // 80 + 0..19 (« quatre-vingt-dix-neuf » = 80 + 19). Au-delà, le jeton suivant est un autre nombre.
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
 * Suites de chiffres contiguës de la transcription. Un mot qui n'est pas un nombre COUPE la suite : c'est ce
 * qui empêche de recoller le code avec un numéro de téléphone cité juste après.
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
      // Un nombre à deux chiffres apporte DEUX chiffres (« douze » -> « 12 »), un nombre à un chiffre en
      // apporte un. C'est ce qui rend « douze trente-quatre cinquante-six » égal à « 1 2 3 4 5 6 ».
      courante += String(nombre.valeur);
      i += nombre.longueur;
      continue;
    }
    // Jeton non numérique : il ferme la suite en cours. « et » ne coupe pas (déjà consommé par lireNombre
    // quand il lie deux nombres ; isolé, il reste un mot ordinaire et coupe, ce qui est le bon comportement).
    if (courante !== '') suites.push(courante);
    courante = '';
    i += 1;
  }
  if (courante !== '') suites.push(courante);
  return suites;
}

/**
 * Codes candidats d'une suite de chiffres : la suite elle-même si elle fait exactement 6 chiffres, ou le code
 * répété deux fois d'affilée sans respiration (Meta énonce le code deux fois ; une transcription peut coller
 * les deux, « 123456123456 »). Toute autre longueur est ambiguë, donc écartée.
 */
function candidatsDe(suite: string): string[] {
  if (suite.length === CODE_LEN) return [suite];
  if (suite.length === 2 * CODE_LEN && suite.slice(0, CODE_LEN) === suite.slice(CODE_LEN)) return [suite.slice(0, CODE_LEN)];
  return [];
}

/**
 * Le code à 6 chiffres de la transcription, ou `null` si la transcription n'en contient aucun ou en contient
 * plusieurs DIFFÉRENTS (cf. la règle d'unanimité en tête de fichier : on ne devine jamais).
 */
export function extraireCodeOtp(transcription: string): string | null {
  const candidats = suitesDeChiffres(transcription).flatMap(candidatsDe);
  if (candidats.length === 0) return null;
  return candidats.every((c) => c === candidats[0]) ? candidats[0]! : null;
}
