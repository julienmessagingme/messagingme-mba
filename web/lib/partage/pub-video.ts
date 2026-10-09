/**
 * La vidéo d'une publicité : ses bornes, la règle d'arrondi de sa durée et la lecture de sa durée dans la tête du
 * fichier (la boîte `mvhd`, sans décoder une image), PARTAGÉES par le serveur (`src/pubs/video.ts`, qui vérifie les
 * octets qui passent) et la console (`web/lib/pub-video.ts`, qui prévient avant l'envoi). Fonctions pures.
 */

/** Les types acceptés : MP4 et MOV, deux habillages du même format de boîtes (ISO BMFF). */
export const TYPES_VIDEO_PUB = ['video/mp4', 'video/quicktime'] as const;

/** Décision de Julien (2026-09-28) : 100 Mo au plus. Meta en accepte bien plus, c'est notre choix produit. */
export const TAILLE_VIDEO_PUB_MAX = 100 * 1024 * 1024;

/** Décision de Julien (2026-09-28) : 60 secondes au plus. */
export const DUREE_VIDEO_PUB_MAX_S = 60;

/**
 * Une durée dépasse-t-elle la borne ? Arrondie à la seconde : un téléphone qui filme « 60 secondes » produit
 * souvent 60,03 s, et le refuser serait refuser la vidéo que la règle voulait autoriser. Partagée
 * avec l'écran : une seule règle des deux côtés.
 */
export function dureeTropLongue(secondes: number): boolean {
  return Math.round(secondes) > DUREE_VIDEO_PUB_MAX_S;
}

/** Lit un entier non signé de 32 bits, gros-boutiste. */
export function u32(o: Uint8Array, i: number): number {
  return ((o[i] ?? 0) * 0x1000000) + (((o[i + 1] ?? 0) << 16) | ((o[i + 2] ?? 0) << 8) | (o[i + 3] ?? 0));
}

/** Lit un entier de 64 bits en nombre : exact jusqu'à 2^53, ce qui couvre toute taille et toute durée réelles. */
export function u64(o: Uint8Array, i: number): number {
  return u32(o, i) * 0x100000000 + u32(o, i + 4);
}

/** Le nom d'une boîte, quatre caractères ASCII. */
export function nomDe(o: Uint8Array, i: number): string {
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
 * La console l'applique à `moov` où qu'il soit dans le fichier (`web/lib/pub-video.ts`). Ses cas, avec leur résultat
 * attendu : `tests/partage-cas.test.ts`.
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
