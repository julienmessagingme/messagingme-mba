/**
 * La vidéo d'une publicité, lue sans être décodée : ce qu'on vérifie des octets qui passent, et le flux qui
 * les porte du navigateur à Meta. Module pur, sans réseau.
 *
 * 🔴 Les octets d'une vidéo ne s'arrêtent jamais chez nous : ils traversent l'API morceau par morceau (le
 * navigateur découpe comme Meta le demande, `src/meta/pubs-creation.ts` relaie chaque morceau en flux) et ne
 * sont gardés ni en base ni en entier en mémoire. Ce qu'on en lit se limite à la TÊTE du fichier, bornée.
 */
// Partagés avec la console (`web/lib/partage/pub-video.ts`) : les bornes, la règle d'arrondi, le parseur de durée.
export {
  TYPES_VIDEO_PUB, TAILLE_VIDEO_PUB_MAX, DUREE_VIDEO_PUB_MAX_S, dureeTropLongue, dureeDeLaTete,
} from '../../web/lib/partage/pub-video';

/**
 * Ce qu'on lit de la tête d'un fichier avant de relayer quoi que ce soit : de quoi voir la signature, et la
 * durée quand le fichier la porte au début. Borné, pour que la vérification ne devienne pas un tampon.
 */
export const TETE_VIDEO_OCTETS = 64 * 1024;

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
