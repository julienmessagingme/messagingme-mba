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

/** Le corps d'une entrée de câblage, depuis son nom jusqu'à la fermeture de sa clé. */
function blocDe(entree: string): string {
  const deb = sansCommentaires.indexOf(entree);
  if (deb === -1) throw new Error(`entrée de câblage introuvable : ${entree}`);
  const reste = sansCommentaires.slice(deb);
  const fin = reste.search(/\n      },/);
  return fin === -1 ? reste : reste.slice(0, fin);
}

describe('câblage des publicités : le jeton ne touche jamais la base en clair', () => {
  /**
   * 🔴 LA GARDE SE DÉRIVE DES APPELS RÉELS, ELLE NE CITE PLUS UN NOM DE VARIABLE.
   *
   * Elle s'ancrait sur `connexions.poserJeton(t, encryptSecret(...), userId)`. Un SECOND point
   * d'écriture est arrivé le 2026-09-23 (le dépôt par `/ops`), écrit `connexionsPub.remplacer(tenantId,
   * ...)` : aucun des motifs ne l'atteignait. Muté par la relecture à froid, en remplaçant le
   * chiffrement par le jeton nu à cet endroit, les deux gardes restaient VERTES. Un jeton Meta pouvait
   * donc dormir en clair en base sans qu'aucun test ne tombe, sur le seul chemin que ce fichier existe
   * pour protéger.
   *
   * D'où la forme ci-dessous : on ÉNUMÈRE les appels par leur NOM DE MÉTHODE, quel que soit le
   * receveur, et chacun doit rendre des comptes. Un troisième point d'écriture ajouté demain sera
   * couvert sans que personne ait à y penser.
   */
  const ECRITURES = [...sansCommentaires.matchAll(/(?:poserJeton|remplacer)\(([^;]*?)\)/g)]
    .map((m) => m[1] ?? '');

  it('🔴 CHAQUE écriture du jeton reçoit un CHIFFRÉ, jamais le jeton nu', () => {
    // Deux points d'écriture aujourd'hui : l'échange par l'écran et le dépôt par `/ops`. Le compte
    // n'est pas écrit ici (il dériverait), mais il ne doit pas tomber à zéro : une garde qui ne trouve
    // plus rien à garder passe en silence.
    expect(ECRITURES.length).toBeGreaterThanOrEqual(2);
    for (const args of ECRITURES) {
      // Le deuxième argument porte le jeton. Il est soit `encryptSecret(...)` écrit sur place, soit une
      // variable, et cette variable doit avoir été affectée depuis `encryptSecret`.
      const deuxieme = (args.split(',')[1] ?? '').trim();
      const chiffreSurPlace = deuxieme.startsWith('encryptSecret(');
      const viaVariable = /^[A-Za-z_$][\w$]*$/.test(deuxieme)
        && sansCommentaires.includes(`const ${deuxieme} = encryptSecret(`);
      expect(chiffreSurPlace || viaVariable, `argument non chiffré : "${deuxieme}" dans (${args})`).toBe(true);
    }
  });

  it('🔴 la forme fautive n’existe nulle part : aucune écriture ne reçoit `jeton`', () => {
    // Le cas qu'on interdit, et qui compilerait parfaitement, quel que soit le nom du receveur et
    // celui de la variable d'espace.
    expect(sansCommentaires).not.toMatch(/(?:poserJeton|remplacer)\(\s*[A-Za-z_$][\w$]*\s*,\s*jeton\s*[,)]/);
  });

  it('🔴 le dépôt par `/ops` CHIFFRE avant de toucher à la base, pas après', () => {
    // `encryptSecret` lève sur une clé absente ou mal formée. Chiffrer APRÈS avoir effacé laisserait
    // l'espace sans connexion et l'ancien jeton perdu, sur une route qui répond « jeton refusé ».
    const bloc = blocDe('deposerJetonPub: async');
    expect(bloc.indexOf('encryptSecret(')).toBeGreaterThan(-1);
    expect(bloc.indexOf('encryptSecret(')).toBeLessThan(bloc.indexOf('connexionsPub.remplacer'));
  });

  it('🔴 le dépôt COMPARE LES IDENTITÉS avant de révoquer, sinon il désarme le jeton NEUF', () => {
    // `DELETE /me/permissions/<perm>` porte sur le couple (application, ENTITÉ), pas sur LE jeton.
    // Remplacer le jeton d'un utilisateur système par un autre du MÊME portefeuille, c'est-à-dire
    // l'usage normal de cette route, donne deux jetons de la MÊME entité : révoquer l'ancien retire
    // alors les permissions du neuf, et la route répond 200 sur une connexion morte. La première
    // version de ce dépôt le faisait, alors que la bretelle de `connecter` énonce déjà le piege.
    const bloc = blocDe('deposerJetonPub: async');
    expect(bloc).toMatch(/clientPubs\.identite\(/);
    expect(bloc.indexOf('clientPubs.identite(')).toBeLessThan(bloc.indexOf('revoquerAcces'));
    // Et le retrait est SOUS une condition, jamais inconditionnel : c'est la condition qui protège.
    expect(bloc).toMatch(/idAncien === idNeuf/);
  });

  it('🔴 le dépôt par `/ops` RÉVOQUE l’ancien jeton AVANT de l’écraser', () => {
    // L'écran REFUSE quand une connexion existe ; `/ops` REMPLACE. Écraser sans jamais tenter le
    // retrait laisse un accès vivant chez Meta dont on vient de perdre le seul exemplaire.
    const bloc = blocDe('deposerJetonPub: async');
    expect(bloc).toMatch(/revoquerAcces/);
    expect(bloc.indexOf('revoquerAcces')).toBeLessThan(bloc.indexOf('connexionsPub.remplacer'));
  });

  it('🔴 le jeton relu est DÉCHIFFRÉ, il ne part pas chiffré chez Meta', () => {
    // Sans cette ligne, chaque appel partirait avec le cryptogramme en guise de jeton : Meta répondrait 401,
    // et la connexion se marquerait « refusée » toute seule, pour une cause qui n'est pas la sienne.
    expect(sansCommentaires).toMatch(/return decryptSecret\(chiffre, config\.ENCRYPTION_KEY\);/);
  });

  it('🔴 la connexion REFUSE avant d’échanger le code quand une connexion existe déjà', () => {
    // Sans cette bretelle, chaque appel hors séquence fait émettre par Meta un jeton SANS EXPIRATION
    // que la base refusera ensuite d’enregistrer : un orphelin à chaque fois. La supprimer ne fait
    // tomber aucun autre test, d’où ce cas-ci (le fichier existe pour ça).
    const bloc = sansCommentaires.slice(sansCommentaires.indexOf('connecter: async'));
    const connexion = bloc.slice(0, bloc.indexOf('actifsAccordes:'));
    expect(connexion).toMatch(/lireJetonChiffre\(t\) !== null\) throw new DejaConnectePub/);
    expect(connexion.indexOf('lireJetonChiffre')).toBeLessThan(connexion.indexOf('exchangeCode'));
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
