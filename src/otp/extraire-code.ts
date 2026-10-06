/**
 * Extraction du code de vérification à 6 chiffres depuis la transcription d'un appel Meta. Module pur, partagé par
 * les deux ponts : le numéro Zadarma (français) et les numéros fournis de DIDWW (anglais, lot 3a).
 *
 * Meta énonce le code deux fois, et une reconnaissance vocale française rend la même suite d'au moins trois
 * façons : « 123456 », « 1 2 3 4 5 6 », « douze trente-quatre cinquante-six » (regroupement par deux spontané).
 * Sur un numéro britannique, Meta dicte en anglais, chiffre par chiffre (« your verification code is 8 6 3 8 0 1 »,
 * mesuré le 2026-10-05), que la transcription rend en chiffres ou en mots (« eight six three... », « oh » pour zéro).
 * Les homophones (« for », « to ») ne sont PAS lus comme des chiffres : la suite se coupe, et l'extraction échoue du
 * bon côté (aucun code plutôt qu'un code faux).
 *
 * Le SMS de Meta, LU À VOIX HAUTE par la ligne fixe (essai réel du 2026-10-06) : la fenêtre de Meta peut imposer le
 * SMS, qu'un numéro fixe britannique ne reçoit pas ; l'opérateur le lit par un appel, le code dit par centaines et son
 * tiret prononcé « to » (« your WhatsApp code nine hundred twenty seven to three hundred forty one »). Seule exception
 * à la règle des homophones, et étroite : juste après « code », trois chiffres, « to », trois chiffres se recollent. Un
 * « two » dicté et mal lu donnerait 3 + 1 + 3 = 7 chiffres, jamais un code de Meta : le recollage ne fabrique pas de
 * code faux.
 *
 * 🔴 Unanimité ou rien : Meta plafonne à 10 demandes par numéro sur 72 h et un code faux consomme une tentative.
 * Deux suites de six chiffres différentes : `null`, et l'humain lit la transcription.
 */

/** Longueur du code de vérification Meta. */
const CODE_LEN = 6;

const UNITES: Record<string, number> = {
  zero: 0, un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9,
  dix: 10, onze: 11, douze: 12, treize: 13, quatorze: 14, quinze: 15, seize: 16,
  // L'anglais de Meta, chiffre par chiffre : « zero » et « six » s'écrivent déjà comme en français.
  oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, seven: 7, eight: 8, nine: 9,
};
const DIZAINES: Record<string, number> = { vingt: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60 };

/** L'anglais par centaines du SMS lu à voix haute (« nine hundred and twenty seven »). */
const CHIFFRES_EN: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const ADOS_EN: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const DIZAINES_EN: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

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
 * Une centaine anglaise à partir de `tokens[i]` (« nine hundred », « nine hundred and seven », « nine hundred twenty
 * seven », « one hundred twelve »), ou null : 100..999, donc toujours trois chiffres. Seule la forme du SMS lu à voix
 * haute la porte ; Meta, au téléphone, dicte chiffre par chiffre et ne dit jamais « hundred ».
 */
function lireCentaine(tokens: string[], i: number): { valeur: number; longueur: number } | null {
  const centaine = CHIFFRES_EN[tokens[i] ?? ''];
  if (centaine === undefined || tokens[i + 1] !== 'hundred') return null;
  const base = centaine * 100;
  // « and » n'est qu'un liant : il n'est consommé que si un nombre le suit.
  const j = tokens[i + 2] === 'and' ? i + 3 : i + 2;
  const t = tokens[j] ?? '';
  const ado = ADOS_EN[t];
  if (ado !== undefined) return { valeur: base + ado, longueur: j + 1 - i };
  const dizaine = DIZAINES_EN[t];
  if (dizaine !== undefined) {
    const unite = CHIFFRES_EN[tokens[j + 1] ?? ''];
    return unite === undefined ? { valeur: base + dizaine, longueur: j + 1 - i } : { valeur: base + dizaine + unite, longueur: j + 2 - i };
  }
  const unite = CHIFFRES_EN[t];
  if (unite !== undefined) return { valeur: base + unite, longueur: j + 1 - i };
  return { valeur: base, longueur: 2 };
}

/** Une suite de chiffres contiguë, avec les jetons qu'elle couvre (`fin` exclu). */
interface Suite { chiffres: string; debut: number; fin: number }

/**
 * Suites de chiffres contiguës de la transcription. Un mot qui n'est pas un nombre coupe la suite, pour ne pas
 * recoller le code avec un numéro de téléphone cité juste après.
 */
function suitesDeChiffres(tokens: string[]): Suite[] {
  const suites: Suite[] = [];
  let courante = '';
  let debut = 0;
  const fermer = (fin: number) => {
    if (courante !== '') suites.push({ chiffres: courante, debut, fin });
    courante = '';
  };
  for (let i = 0; i < tokens.length; ) {
    const t = tokens[i]!;
    if (courante === '') debut = i;
    if (/^\d+$/.test(t)) {
      courante += t;
      i += 1;
      continue;
    }
    const nombre = lireCentaine(tokens, i) ?? lireNombre(tokens, i);
    if (nombre) {
      // Un nombre à deux chiffres en apporte deux : « douze trente-quatre cinquante-six » vaut « 1 2 3 4 5 6 ».
      courante += String(nombre.valeur);
      i += nombre.longueur;
      continue;
    }
    // Jeton non numérique : il ferme la suite (un « et » isolé aussi ; entre deux nombres, lireNombre l'a consommé).
    fermer(i);
    i += 1;
  }
  fermer(tokens.length);
  return suites;
}

/** La suite commence juste après « code » (ou « code is ») : la forme du SMS de Meta, « your WhatsApp code ... ». */
const apresCode = (tokens: string[], debut: number): boolean =>
  tokens[debut - 1] === 'code' || (tokens[debut - 1] === 'is' && tokens[debut - 2] === 'code');

/**
 * Les suites, avec le code du SMS lu à voix haute recollé : juste après « code », trois chiffres, le seul jeton « to »,
 * trois chiffres. Aucune autre suite ne se recolle.
 */
function suitesRecollees(texte: string): string[] {
  const tokens = normalise(texte).split(' ').filter((t) => t !== '');
  const suites = suitesDeChiffres(tokens);
  const sortie: string[] = [];
  for (let k = 0; k < suites.length; k += 1) {
    const a = suites[k]!;
    const b = suites[k + 1];
    const recollable = b !== undefined && a.chiffres.length === 3 && b.chiffres.length === 3
      && tokens[a.fin] === 'to' && b.debut === a.fin + 1 && apresCode(tokens, a.debut);
    if (recollable) {
      sortie.push(a.chiffres + b.chiffres);
      k += 1;
    } else {
      sortie.push(a.chiffres);
    }
  }
  return sortie;
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
  const candidats = suitesRecollees(transcription).flatMap(candidatsDe);
  if (candidats.length === 0) return null;
  return candidats.every((c) => c === candidats[0]) ? candidats[0]! : null;
}
