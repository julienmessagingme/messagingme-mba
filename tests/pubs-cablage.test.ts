import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * LE CÂBLAGE DES PUBLICITÉS, LU DANS LA SOURCE (revue du lot 2, 2026-09-23).
 *
 * 🔴 CE QUI RESTE ICI EST UN INVENTAIRE, et c'est ce qui le garde en test de source. Les tests de la route
 * montent un FAUX câblage ; les tests de `src/pubs/connexion.ts` (`tests/pubs-connexion.test.ts`) exécutent
 * les points d'écriture qu'on connaît. Aucun des deux ne voit un TROISIÈME point d'écriture du jeton ajouté
 * demain ailleurs dans `src/` : c'est ce que cet inventaire attrape, en énumérant les appels par leur NOM DE
 * MÉTHODE, quel que soit le receveur et quel que soit le fichier.
 *
 * ⚠️ Les gardes d'ORDRE qui vivaient ici (chiffrer avant de remplacer, retirer l'ancien avant le remplacement,
 * révoquer avant d'effacer, refuser avant l'échange, déchiffrer le jeton relu) sont parties avec le code
 * qu'elles lisaient, le 2026-09-27 (lot 2 de `docs/superpowers/plans/2026-09-27-approfondir-la-racine.md`).
 * Elles s'EXÉCUTENT désormais dans `tests/pubs-connexion.test.ts`, qui constate l'ordre des appels et ce qui
 * part en clair ou chiffré au lieu de relire l'ordre des lignes.
 *
 * On lit les fichiers sans leurs commentaires, pour qu'une explication qui CITE le bon code ne fasse pas passer
 * un câblage fautif.
 */
const sansCommentaires = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Tous les fichiers de `src/`, sans leurs commentaires. */
function sources(): Array<{ fichier: string; texte: string }> {
  const racine = fileURLToPath(new URL('../src', import.meta.url));
  const out: Array<{ fichier: string; texte: string }> = [];
  const visiter = (dossier: string): void => {
    for (const nom of readdirSync(dossier)) {
      const complet = join(dossier, nom);
      if (statSync(complet).isDirectory()) { visiter(complet); continue; }
      if (!nom.endsWith('.ts')) continue;
      out.push({ fichier: `src/${relative(racine, complet).split('\\').join('/')}`, texte: sansCommentaires(readFileSync(complet, 'utf8')) });
    }
  };
  visiter(racine);
  return out;
}

const SOURCES = sources();

describe('câblage des publicités : le jeton ne touche jamais la base en clair', () => {
  /**
   * 🔴 LA GARDE SE DÉRIVE DES APPELS RÉELS, ELLE NE CITE PAS UN NOM DE VARIABLE.
   *
   * Elle s'ancrait d'abord sur `connexions.poserJeton(t, encryptSecret(...), userId)`. Un SECOND point
   * d'écriture est arrivé le 2026-09-23 (le dépôt par `/ops`), écrit `connexionsPub.remplacer(tenantId, ...)` :
   * aucun des motifs ne l'atteignait, et une mutation qui y passait le jeton nu restait VERTE. D'où l'énumération
   * par NOM DE MÉTHODE appelée sur un receveur (`.poserJeton(`, `.remplacer(`), dans TOUT `src/` depuis que le
   * code a quitté la racine : une déclaration d'interface ou de classe n'a pas de point devant, elle n'est pas
   * un appel.
   */
  const ECRITURES = SOURCES.flatMap(({ fichier, texte }) =>
    [...texte.matchAll(/\.(?:poserJeton|remplacer)\(([^;]*?)\)/g)].map((m) => ({ fichier, args: m[1] ?? '', texte })));

  it('🔴 CHAQUE écriture du jeton reçoit un CHIFFRÉ, jamais le jeton nu', () => {
    // Deux points d'écriture aujourd'hui : l'échange par l'écran et le dépôt par `/ops`. Le compte n'est pas
    // écrit ici (il dériverait), mais il ne doit pas tomber à zéro : une garde qui ne trouve plus rien à garder
    // passe en silence.
    expect(ECRITURES.length).toBeGreaterThanOrEqual(2);
    for (const { fichier, args, texte } of ECRITURES) {
      // Le deuxième argument porte le jeton. Il est soit `encryptSecret(...)` écrit sur place, soit une
      // variable, et cette variable doit avoir été affectée depuis `encryptSecret` dans le même fichier.
      const deuxieme = (args.split(',')[1] ?? '').trim();
      const chiffreSurPlace = deuxieme.startsWith('encryptSecret(');
      const viaVariable = /^[A-Za-z_$][\w$]*$/.test(deuxieme) && texte.includes(`const ${deuxieme} = encryptSecret(`);
      expect(chiffreSurPlace || viaVariable, `argument non chiffré dans ${fichier} : "${deuxieme}" dans (${args})`).toBe(true);
    }
  });

  it('🔴 la forme fautive n’existe nulle part : aucune écriture ne reçoit `jeton`', () => {
    // Le cas qu'on interdit, et qui compilerait parfaitement, quel que soit le nom du receveur et celui de la
    // variable d'espace.
    for (const { fichier, texte } of SOURCES) {
      expect(texte, fichier).not.toMatch(/\.(?:poserJeton|remplacer)\(\s*[A-Za-z_$][\w$]*\s*,\s*jeton\s*[,)]/);
    }
  });

  it('⚠️ les routes sont câblées avec la configuration « publicités », pas celle de l’inscription', () => {
    // Deux configurations Facebook Login for Business coexistent. Les confondre enverrait le client dans le
    // parcours WhatsApp au moment où il croit connecter ses publicités, et ne rapporterait aucun compte.
    const racine = SOURCES.find((s) => s.fichier === 'src/index.ts')?.texte ?? '';
    const i = racine.indexOf('    pubs: {');
    expect(i, 'le bloc des publicités a disparu du câblage').toBeGreaterThan(-1);
    expect(racine.slice(i, i + 800)).toMatch(/configId: config\.META_ADS_CONFIG_ID/);
  });
});
