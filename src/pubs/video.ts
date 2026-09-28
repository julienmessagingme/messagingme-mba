/**
 * La vidéo d'une publicité, lue sans être décodée : ce qu'on vérifie des octets qui passent, et le flux qui
 * les porte du navigateur à Meta. Module pur, sans réseau.
 *
 * 🔴 Les octets d'une vidéo ne s'arrêtent jamais chez nous : ils traversent l'API morceau par morceau (le
 * navigateur découpe comme Meta le demande, `src/meta/pubs-creation.ts` relaie chaque morceau en flux) et ne
 * sont gardés ni en base ni en entier en mémoire. Ce qu'on en lit se limite à la TÊTE du fichier, bornée.
 */

/** Les types acceptés : MP4 et MOV, deux habillages du même format de boîtes (ISO BMFF). */
export const TYPES_VIDEO_PUB = ['video/mp4', 'video/quicktime'] as const;

/** Décision de Julien (2026-09-28) : 100 Mo au plus. Meta en accepte bien plus, c'est notre choix produit. */
export const TAILLE_VIDEO_PUB_MAX = 100 * 1024 * 1024;

/** Décision de Julien (2026-09-28) : 60 secondes au plus. */
export const DUREE_VIDEO_PUB_MAX_S = 60;

/**
 * Ce qu'on lit de la tête d'un fichier avant de relayer quoi que ce soit : de quoi voir la signature, et la
 * durée quand le fichier la porte au début. Borné, pour que la vérification ne devienne pas un tampon.
 */
export const TETE_VIDEO_OCTETS = 64 * 1024;

/**
 * Une durée dépasse-t-elle la borne ? Arrondie à la seconde : un téléphone qui filme « 60 secondes » produit
 * souvent 60,03 s, et le refuser serait refuser la vidéo que la règle voulait autoriser. Une seule fonction pour
 * le serveur ; l'écran porte la même règle (`web/lib/pub-video.ts`), tenue par un test de parité.
 */
export function dureeTropLongue(secondes: number): boolean {
  return Math.round(secondes) > DUREE_VIDEO_PUB_MAX_S;
}

/**
 * Ces octets commencent-ils comme un MP4 ou un MOV ? La première boîte d'un fichier ISO BMFF moderne est `ftyp`,
 * posée à l'octet 4 (les 4 premiers portent sa taille). 🔴 Le type se lit dans les octets, pas dans ce que le
 * navigateur déclare : ce fichier part chez un tiers sous l'identité du client. Pas un décodeur : Meta refusera un
 * fichier corrompu (erreurs 351, 6000) ; la garde ferme l'envoi d'autre chose sous une étiquette vidéo.
 * ⚠️ Un très vieux MOV qui commencerait par `moov` ou `wide` est refusé : c'est assumé, et l'écran conseille
 * d'exporter en MP4.
 */
export function estVideoMp4OuMov(tete: Uint8Array): boolean {
  return tete.length >= 8 && tete[4] === 0x66 && tete[5] === 0x74 && tete[6] === 0x79 && tete[7] === 0x70; // « ftyp »
}

/** Lit un entier non signé de 32 bits, gros-boutiste. */
function u32(o: Uint8Array, i: number): number {
  return ((o[i] ?? 0) * 0x1000000) + (((o[i + 1] ?? 0) << 16) | ((o[i + 2] ?? 0) << 8) | (o[i + 3] ?? 0));
}

/** Lit un entier de 64 bits en nombre : exact jusqu'à 2^53, ce qui couvre toute taille et toute durée réelles. */
function u64(o: Uint8Array, i: number): number {
  return u32(o, i) * 0x100000000 + u32(o, i + 4);
}

/** Le nom d'une boîte, quatre caractères ASCII. */
function nomDe(o: Uint8Array, i: number): string {
  return String.fromCharCode(o[i] ?? 0, o[i + 1] ?? 0, o[i + 2] ?? 0, o[i + 3] ?? 0);
}

/**
 * La durée d'une vidéo en secondes, lue dans la tête du fichier SANS la décoder, ou `null` quand la tête ne la
 * porte pas.
 *
 * On parcourt les boîtes de premier niveau (`ftyp`, `free`, `moov`...) ; la durée vit dans `mvhd`, la première
 * boîte de `moov`. 🔴 Elle n'est lisible que quand `moov` est AU DÉBUT (« fast start », le cas des exports web et
 * de la plupart des téléphones) : quand il est à la fin, derrière `mdat`, la tête ne le contient pas et on rend
 * `null`, jamais une durée devinée. Le contrôle du navigateur, qui lit la durée avant l'envoi, reste alors le seul.
 * ⚠️ Ce parseur a une COPIE EXACTE dans la console (`web/lib/pub-video.ts`), qui l'applique à `moov` où qu'il soit
 * dans le fichier : `tests/web-pubs-parity.test.ts` les fait tourner côte à côte, toute correction va des deux côtés.
 */
export function dureeDeLaTete(tete: Uint8Array): number | null {
  let i = 0;
  while (i + 8 <= tete.length) {
    let taille = u32(tete, i);
    const nom = nomDe(tete, i + 4);
    let entete = 8;
    if (taille === 1) {
      if (i + 16 > tete.length) return null;
      taille = u64(tete, i + 8);
      entete = 16;
    }
    // `0` veut dire « jusqu'à la fin du fichier » : rien ne peut suivre, et ce n'est pas `moov`.
    if (taille === 0 && nom !== 'moov') return null;
    if (nom === 'moov') return dureeDuMvhd(tete, i + entete);
    if (taille < entete) return null; // boîte incohérente : on ne devine pas
    i += taille;
  }
  return null;
}

/** La durée portée par une boîte `mvhd` qui commence à `p`, ou `null` si elle n'y est pas ou pas entière. */
function dureeDuMvhd(o: Uint8Array, p: number): number | null {
  if (p + 8 > o.length || nomDe(o, p + 4) !== 'mvhd') return null;
  const version = o[p + 8];
  // Version 0 : dates sur 32 bits ; version 1 : sur 64 bits. L'échelle (unités par seconde) est sur 32 bits
  // dans les deux cas, la durée suit la taille des dates.
  const [echelleA, dureeA, dureeSur64] = version === 1 ? [p + 28, p + 32, true] : [p + 20, p + 24, false];
  if (dureeA + (dureeSur64 ? 8 : 4) > o.length) return null;
  const echelle = u32(o, echelleA);
  const duree = dureeSur64 ? u64(o, dureeA) : u32(o, dureeA);
  // Une durée « tout à un » veut dire « inconnue » dans la norme : ce n'est pas une durée.
  const inconnue = dureeSur64 ? u32(o, dureeA) === 0xffffffff && u32(o, dureeA + 4) === 0xffffffff : duree === 0xffffffff;
  if (echelle === 0 || inconnue) return null;
  return duree / echelle;
}

/**
 * Lit la tête d'un flux : au moins `n` octets, ou tout ce qu'il porte s'il est plus court. Le reste n'est PAS lu,
 * et l'itérateur reprend exactement là où la tête s'arrête : c'est ce qui permet de vérifier la tête AVANT de
 * relayer quoi que ce soit, puis de relayer la suite sans la tamponner.
 */
export async function lireTete(source: AsyncIterator<Uint8Array>, n: number): Promise<{ tete: Uint8Array; fini: boolean }> {
  const morceaux: Uint8Array[] = [];
  let lus = 0;
  while (lus < n) {
    const r = await source.next();
    if (r.done) return { tete: concatener(morceaux, lus), fini: true };
    morceaux.push(r.value);
    lus += r.value.byteLength;
  }
  return { tete: concatener(morceaux, lus), fini: false };
}

function concatener(morceaux: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let i = 0;
  for (const m of morceaux) { out.set(m, i); i += m.byteLength; }
  return out;
}

/** Le flux relayé a porté plus ou moins d'octets que le morceau annoncé : on n'envoie pas un morceau faux. */
export class MorceauDeTailleInattendue extends Error {
  constructor(readonly attendu: number, readonly recu: number) {
    super(`le morceau porte ${recu} octet(s) au lieu de ${attendu}`);
    this.name = 'MorceauDeTailleInattendue';
  }
}

/**
 * La tête déjà lue, puis la suite du flux, en comptant : lève `MorceauDeTailleInattendue` dès que le compte
 * dépasse `attendu` (sans lire plus loin), ou à la fin s'il n'est pas atteint. C'est la borne qui remplace la
 * limite de corps de Fastify, que cette route ne peut pas porter (le corps n'y est jamais tamponné).
 */
export async function* suiteBornee(
  tete: Uint8Array,
  reste: AsyncIterator<Uint8Array>,
  fini: boolean,
  attendu: number,
): AsyncGenerator<Uint8Array> {
  let recus = tete.byteLength;
  if (recus > attendu) throw new MorceauDeTailleInattendue(attendu, recus);
  if (recus > 0) yield tete;
  if (!fini) {
    for (;;) {
      const r = await reste.next();
      if (r.done) break;
      recus += r.value.byteLength;
      if (recus > attendu) throw new MorceauDeTailleInattendue(attendu, recus);
      yield r.value;
    }
  }
  if (recus !== attendu) throw new MorceauDeTailleInattendue(attendu, recus);
}
