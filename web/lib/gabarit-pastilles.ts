/**
 * LES PASTILLES `{{nom}}` DANS UN GABARIT DE CORPS JSON : celles qui sont mal placées, et celles qui ne
 * désignent rien.
 *
 * 🔴 CE QUE ÇA RÉPARE EST UN MESSAGE D'ERREUR QUI NE DIT PAS CE QUI NE VA PAS. L'écran annonçait « Ce n'est
 * pas du JSON valide » pendant que le client regardait `"user_ns": {{user_ns}}`, c'est-à-dire pendant qu'il
 * regardait la cause sans pouvoir la reconnaître. Vécu par Julien le 2026-09-15. Une pastille se met DANS une
 * chaîne (`"{{user_ns}}"`), sinon le gabarit n'est plus du JSON.
 *
 * ⚠️ ET LES GUILLEMETS NE FORCENT PAS UNE CHAÎNE, c'est ce qui rend la règle acceptable : le serveur remplace
 * une chaîne qui vaut EXACTEMENT `"{{x}}"` par la valeur AVEC SON TYPE déclaré (`src/agent/requete-http.ts`).
 * Une variable déclarée « nombre » part donc en `42`, pas en `"42"`. Les guillemets ne servent qu'à garder le
 * gabarit lisible comme JSON.
 *
 * 🔴 ON NE REMPLACE PAS À L'AVEUGLE : la lecture suit l'état « dans une chaîne / hors d'une chaîne », en
 * tenant compte des échappements. Une pastille DÉJÀ entre guillemets ne doit pas être re-guillemetée, et une
 * accolade qui vit à l'intérieur d'un texte (`"Bonjour {{prenom}}"`) est parfaitement légitime.
 */

/** Le MÊME motif que le serveur (`VARIABLE` dans `src/agent/requete-http.ts`) et que l'éditeur de messages
 *  (`NAMED_VAR_RE`). Leur égalité est tenue par `tests/connecteur-pastilles-parite.test.ts`. */
export const PASTILLE = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** Version ancrée, pour lire le gabarit caractère par caractère sans recopier le motif. */
const PASTILLE_ANCREE = /\{\{\s*([\w.-]+)\s*\}\}/y;

/** Tous les noms de pastilles d'un texte, sans doublon et dans l'ordre d'apparition. */
export function pastillesDe(texte: string): string[] {
  const vus = new Set<string>();
  PASTILLE.lastIndex = 0;
  let m = PASTILLE.exec(texte);
  while (m !== null) {
    vus.add(m[1]!);
    m = PASTILLE.exec(texte);
  }
  return [...vus];
}

export interface LectureGabarit {
  /** Les pastilles écrites HORS d'une chaîne JSON : ce sont elles qui cassent le gabarit. */
  horsGuillemets: string[];
  /** Le même gabarit, ces pastilles-là mises entre guillemets. Identique à l'entrée s'il n'y en a aucune. */
  repare: string;
}

/**
 * Lit un gabarit JSON et dit quelles pastilles sont hors d'une chaîne, en proposant le gabarit réparé.
 *
 * ⚠️ Ne garantit PAS que le résultat est du JSON valide : une accolade manquante ailleurs le laisse invalide,
 * et c'est `JSON.parse` qui tranche. Cette fonction ne répond qu'à UNE question, celle qu'on sait nommer.
 */
export function lireGabarit(gabarit: string): LectureGabarit {
  const horsGuillemets: string[] = [];
  let repare = '';
  let dansChaine = false;
  let i = 0;
  while (i < gabarit.length) {
    const c = gabarit[i]!;
    if (dansChaine) {
      // Un échappement emporte le caractère suivant : sans ça, `"il dit \"bonjour\""` se lirait comme deux
      // chaînes séparées par du texte, et tout ce qui suit serait analysé à l'envers.
      if (c === '\\' && i + 1 < gabarit.length) { repare += gabarit.slice(i, i + 2); i += 2; continue; }
      if (c === '"') dansChaine = false;
      repare += c; i += 1; continue;
    }
    if (c === '"') { dansChaine = true; repare += c; i += 1; continue; }
    PASTILLE_ANCREE.lastIndex = i;
    const m = PASTILLE_ANCREE.exec(gabarit);
    if (m) {
      horsGuillemets.push(m[1]!);
      repare += `"${m[0]}"`;
      i += m[0].length;
      continue;
    }
    repare += c; i += 1;
  }
  return { horsGuillemets: [...new Set(horsGuillemets)], repare };
}
