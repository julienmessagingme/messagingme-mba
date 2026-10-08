import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { retentionEffective } from '../src/inbox/retention';
import { DROITS, GRACE_RETOUR_BASE_JOURS } from '../src/offres/offres';

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
describe('🔴 la conservation de la Base (lot 6, C) : 30 jours, mais seulement 30 jours apres l’entree en Base', () => {
  const MAINTENANT = new Date('2026-12-01T00:00:00Z');
  const ilYa = (jours: number) => new Date(MAINTENANT.getTime() - jours * 24 * 3_600_000);

  it('la grace passee, la Base garde 30 jours (la grille), quel que soit le reglage ou le defaut', () => {
    expect(retentionEffective(90, null, { depuis: ilYa(31) }, MAINTENANT)).toBe(DROITS.base.limites.conservationJours);
    expect(retentionEffective(90, 365, { depuis: ilYa(31) }, MAINTENANT)).toBe(30);
  });

  it('🔴 pendant la grace, rien ne change : la regle d’avant (le reglage, sinon le defaut) ; changer d’offre ne purge pas', () => {
    expect(retentionEffective(90, null, { depuis: ilYa(29) }, MAINTENANT)).toBe(90);
    expect(retentionEffective(90, 365, { depuis: ilYa(29) }, MAINTENANT)).toBe(365);
    expect(GRACE_RETOUR_BASE_JOURS).toBe(30);
  });

  it('🔴 le levier d’urgence gagne aussi sur la Base', () => {
    expect(retentionEffective(0, null, { depuis: ilYa(400) }, MAINTENANT)).toBe(0);
  });
});

describe('retentionEffective', () => {
  it('un espace qui n a rien regle prend le defaut de l instance', () => {
    expect(retentionEffective(90, null, null)).toBe(90);
  });

  it('un espace qui a regle sa duree impose la SIENNE', () => {
    // Le responsable de traitement est le client : c'est a lui de dire combien de temps ses conversations
    // se gardent. 30 chez lui gagne sur 90 chez nous, dans les deux sens (plus court comme plus long).
    expect(retentionEffective(90, 30, null)).toBe(30);
    expect(retentionEffective(90, 365, null)).toBe(365);
  });

  /**
   * 🔴 LES DEUX ZEROS NE DISENT PAS LA MEME CHOSE, ET LES INVERSER CASSERAIT L'UN DES DEUX.
   */
  it('zero chez l ESPACE ne desactive que cet espace', () => {
    expect(retentionEffective(90, 0, null)).toBe(0);
  });

  it('🔴 zero chez l INSTANCE arrete tout, MEME un espace qui a choisi une duree', () => {
    // C'est le levier d'urgence de la seule operation irreversible du depot. Un levier qui laisserait
    // continuer les espaces ayant un reglage ne serait pas un levier.
    expect(retentionEffective(0, 30, null)).toBe(0);
    expect(retentionEffective(0, null, null)).toBe(0);
    expect(retentionEffective(-1, 30, null)).toBe(0);
  });

  it('une valeur aberrante ne produit jamais une duree negative a l ecran', () => {
    // Le CHECK de la migration 0155 l'interdit en base ; si quelqu'un le retirait, l'ecran ne doit pas
    // pour autant afficher « conservees -5 jours ».
    expect(retentionEffective(90, -5, null)).toBe(0);
    expect(retentionEffective(90.7, null, null)).toBe(90);
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

  it('🔴 la duree est calculee UNE fois par espace, et lue dans les DEUX moities de la condition', () => {
    // Filtrer sur une duree et calculer l'age sur une autre effacerait selon une duree que personne n'a choisie, sans
    // aucune erreur. Depuis le lot 6, la duree est la colonne `jours` de chaque espace.
    expect(PURGE).toContain('where d.jours > 0');
    expect(PURGE).toContain('cv.last_message_at < now() - make_interval(days => d.jours)');
    expect(PURGE.match(/coalesce\(ts\.conversation_retention_days, \$1::int\)/g) ?? []).toHaveLength(1);
  });

  it('🔴 lot 6 : la purge lit l’offre, la date d’entree en Base, et les nombres de la GRILLE, jamais en dur', () => {
    expect(PURGE).toContain("offre_de_l_espace(t.id) = 'base'");
    expect(PURGE).toContain('${BASE_DEPUIS_SQL}');
    expect(PURGE).toMatch(/GRACE_RETOUR_BASE_JOURS, DROITS\.base\.limites\.conservationJours/);
  });

  it('🔴 la synthese ne remonte plus la duree d instance telle quelle', () => {
    // La faute qu'on attrape : revenir a `retentionDays: this.retentionDays`, qui vaut pour tout le monde.
    expect(STATS.includes('retentionDays: this.retentionDays'),
      'la duree annoncee doit passer par retentionEffective, pas par la constante de process').toBe(false);
    expect(STATS).toContain('retentionEffective(this.retentionDays,');
  });
});
