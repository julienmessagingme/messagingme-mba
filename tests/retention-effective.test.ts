import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { retentionEffective } from '../src/inbox/retention';

const RACINE = resolve(__dirname, '..');
// Fins de ligne normalisees : les fichiers du depot sont en CRLF, un litteral gabarit est en LF. Meme piege
// que dans `tests/agregats-jour.test.ts`, qui a rendu un faux positif pour cette seule raison.
const PURGE = readFileSync(join(RACINE, 'src', 'inbox', 'store.pg.ts'), 'utf8').split('\r\n').join('\n');
const STATS = readFileSync(join(RACINE, 'src', 'stats', 'conversation-stats.pg.ts'), 'utf8').split('\r\n').join('\n');

/**
 * LA DUREE QU'ON ANNONCE DOIT ETRE CELLE QU'ON APPLIQUE.
 *
 * 🔴 CE QUE CES TESTS PROTEGENT, ET QUI N'ETAIT VISIBLE DANS AUCUN DES DEUX FICHIERS. La purge lit la
 * retention de l'ESPACE (migration 0155) ; l'ecran de synthese, lui, annoncait celle de l'INSTANCE, figee au
 * demarrage du process et servie a tout le monde. Tant que personne ne reglait sa propre duree, les deux
 * disaient la meme chose. Le jour ou un espace se met a 30 jours, l'ecran continuait d'ecrire « conservees
 * 90 jours » pendant que ses donnees disparaissaient a 30, et la phrase qui rassure devenait la phrase qui
 * ment. Releve en revue le 2026-09-17, alors que le defaut etait ARME et pas encore atteignable.
 */
describe('retentionEffective', () => {
  it('un espace qui n a rien regle prend le defaut de l instance', () => {
    expect(retentionEffective(90, null)).toBe(90);
  });

  it('un espace qui a regle sa duree impose la SIENNE', () => {
    // Le responsable de traitement est le client : c'est a lui de dire combien de temps ses conversations
    // se gardent. 30 chez lui gagne sur 90 chez nous, dans les deux sens (plus court comme plus long).
    expect(retentionEffective(90, 30)).toBe(30);
    expect(retentionEffective(90, 365)).toBe(365);
  });

  /**
   * 🔴 LES DEUX ZEROS NE DISENT PAS LA MEME CHOSE, ET LES INVERSER CASSERAIT L'UN DES DEUX.
   */
  it('zero chez l ESPACE ne desactive que cet espace', () => {
    expect(retentionEffective(90, 0)).toBe(0);
  });

  it('🔴 zero chez l INSTANCE arrete tout, MEME un espace qui a choisi une duree', () => {
    // C'est le levier d'urgence de la seule operation irreversible du depot. Un levier qui laisserait
    // continuer les espaces ayant un reglage ne serait pas un levier.
    expect(retentionEffective(0, 30)).toBe(0);
    expect(retentionEffective(0, null)).toBe(0);
    expect(retentionEffective(-1, 30)).toBe(0);
  });

  it('une valeur aberrante ne produit jamais une duree negative a l ecran', () => {
    // Le CHECK de la migration 0155 l'interdit en base ; si quelqu'un le retirait, l'ecran ne doit pas
    // pour autant afficher « conservees -5 jours ».
    expect(retentionEffective(90, -5)).toBe(0);
    expect(retentionEffective(90.7, null)).toBe(90);
  });
});

/**
 * 🔴 LA PURGE NE PEUT PAS APPELER CETTE FONCTION : elle est UNE SEULE instruction SQL qui balaie tous les
 * espaces d'un coup. Elle porte donc la meme regle sous une autre forme, et c'est exactement le genre de
 * paire qui derive. Ces deux tests tiennent les deux ecritures cote a cote.
 */
describe('la purge porte la MEME regle que retentionEffective', () => {
  it('🔴 le retour anticipe du levier d urgence est toujours la', () => {
    // Une premiere version l'avait retire au profit du seul `coalesce` : un espace regle sur 90 jours aurait
    // continue a etre purge alors que l'exploitation venait de tout couper.
    expect(PURGE).toContain('if (days <= 0) return 0;');
  });

  it('🔴 le coalesce est dans les DEUX moities de la condition', () => {
    // Filtrer sur la retention de l'espace mais calculer l'age sur celle de l'instance effacerait selon une
    // duree que personne n'a choisie, sans aucune erreur.
    const occurrences = PURGE.match(/coalesce\(ts\.conversation_retention_days, \$1::int\)/g) ?? [];
    expect(occurrences, 'le `where` ET le `make_interval` doivent lire la meme duree').toHaveLength(2);
  });

  it('🔴 la synthese ne remonte plus la duree d instance telle quelle', () => {
    // La faute qu'on attrape : revenir a `retentionDays: this.retentionDays`, qui vaut pour tout le monde.
    expect(STATS.includes('retentionDays: this.retentionDays'),
      'la duree annoncee doit passer par retentionEffective, pas par la constante de process').toBe(false);
    expect(STATS).toContain('retentionEffective(this.retentionDays,');
  });
});
