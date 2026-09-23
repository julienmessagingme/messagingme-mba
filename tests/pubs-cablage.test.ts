import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * LE CÂBLAGE DES PUBLICITÉS, LU DANS LA SOURCE (revue du lot 2, 2026-09-23).
 *
 * 🔴 POURQUOI CE TEST NE PEUT PAS ÊTRE UN TEST ORDINAIRE, et c'est la leçon n°4 des pièges de `/revue` :
 * les tests de la route montent un FAUX câblage. Ils prouvent que la route ne voit jamais le jeton, et rien
 * du câblage RÉEL. Or le chiffrement au repos vit ENTIÈREMENT dans `src/index.ts` : remplacer
 * `encryptSecret(jeton, ...)` par `jeton` garderait les 16 tests de route et les 7 d'intégration au vert, et
 * le jeton d'un client dormirait en clair dans la base. Une garde qu'on peut débrancher sans qu'aucun test
 * ne tombe n'est pas une garde.
 *
 * Même motif que `tests/campagne-cablage.test.ts` : on lit le fichier, sans ses commentaires, pour qu'une
 * explication qui CITE le bon code ne fasse pas passer un câblage fautif.
 */
const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const sansCommentaires = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('câblage des publicités : le jeton ne touche jamais la base en clair', () => {
  it('🔴 le jeton échangé est CHIFFRÉ avant d’être rangé', () => {
    expect(sansCommentaires, 'poserJeton doit recevoir encryptSecret(jeton, ENCRYPTION_KEY)')
      .toMatch(/connexions\.poserJeton\(\s*t,\s*encryptSecret\(jeton, config\.ENCRYPTION_KEY\),\s*userId\s*\)/);
  });

  it('🔴 la forme fautive n’existe pas : aucun `poserJeton` ne reçoit un jeton nu', () => {
    // Le cas qu'on interdit, et qui compilerait parfaitement : `poserJeton(t, jeton, userId)`.
    expect(sansCommentaires).not.toMatch(/poserJeton\(\s*t,\s*jeton\s*,/);
  });

  it('🔴 le jeton relu est DÉCHIFFRÉ, il ne part pas chiffré chez Meta', () => {
    // Sans cette ligne, chaque appel partirait avec le cryptogramme en guise de jeton : Meta répondrait 401,
    // et la connexion se marquerait « refusée » toute seule, pour une cause qui n'est pas la sienne.
    expect(sansCommentaires).toMatch(/return decryptSecret\(chiffre, config\.ENCRYPTION_KEY\);/);
  });

  it('🔴 la déconnexion RÉVOQUE chez Meta AVANT d’effacer la ligne, et pas l’inverse', () => {
    // Notre ligne est le seul endroit où ce jeton existe chez nous, et il n expire jamais : effacer
    // d abord laisserait un acces vivant que plus personne, de notre cote, ne pourrait fermer.
    const bloc = sansCommentaires.slice(sansCommentaires.indexOf('deconnecter: async'));
    const deconnexion = bloc.slice(0, bloc.indexOf('};'));
    expect(deconnexion).toMatch(/revoquerAcces/);
    expect(deconnexion.indexOf('revoquerAcces')).toBeLessThan(deconnexion.indexOf('connexions.supprimer'));
  });

  it('⚠️ les routes sont câblées avec la configuration « publicités », pas celle de l’inscription', () => {
    // Deux configurations Facebook Login for Business coexistent. Les confondre enverrait le client dans le
    // parcours WhatsApp au moment où il croit connecter ses publicités, et ne rapporterait aucun compte.
    const bloc = sansCommentaires.slice(sansCommentaires.indexOf('pubs: (() =>'));
    expect(bloc.slice(0, 2000)).toMatch(/configId: config\.META_ADS_CONFIG_ID/);
  });
});
