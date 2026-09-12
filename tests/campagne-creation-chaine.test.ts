import { describe, expect, it } from 'vitest';
import {
  normaliserChaine,
  problemeDeChaine,
  RANG_MAX,
  type EtageEntrant,
} from '../src/campaign/etages';

/**
 * CE QUE LA CRÉATION FAIT D'UNE CHAÎNE PROPOSÉE PAR UN CLIENT, en fonctions PURES.
 *
 * 🔴 CES DEUX FONCTIONS SONT LE SEUL ENDROIT OÙ LES RANGS D'UN APPELANT SONT MIS EN DOUTE. La table
 * porte `check (rang between 1 and 3)` et une clé primaire `(campaign_id, rang)` : une chaîne qui
 * arrive avec des rangs 1 et 3, ou deux fois le rang 2, se heurterait à Postgres, c'est-à-dire à une
 * 5xx que Cloudflare remplace par sa page d'erreur. La règle du dépôt est qu'une erreur destinée à
 * l'utilisateur sort en 4xx ; ce qui suppose de la voir AVANT l'écriture.
 *
 * ⚠️ Elles sont éprouvées ICI, sans base, parce que ce sont des règles et pas des requêtes. Ce que
 * seule une base peut dire (les trois lignes écrites, dans leur ordre, dans la même transaction) vit
 * dans `tests/integration/campagne-chaine-creation.integration.test.ts`.
 */
describe('normaliserChaine', () => {
  // ⚠️ Les rangs viennent du client : ils se NORMALISENT, ils ne se croient pas.
  it('des rangs troues ou desordonnes sont renumerotes 1, 2, 3', () => {
    const entrants: EtageEntrant[] = [
      { rang: 3, canal: 'rcs' },
      { rang: 1, canal: 'whatsapp' },
    ];
    expect(normaliserChaine(entrants)).toEqual([
      { rang: 1, canal: 'whatsapp' },
      { rang: 2, canal: 'rcs' },
    ]);
  });

  /**
   * 🔴 LE CAS QUI SÉPARE LA BONNE IMPLÉMENTATION DE LA FAUSSE. Renuméroter SANS trier d'abord passe le
   * test du dessus dès que le tableau arrive déjà trié, et ne se voit qu'ici : le contenu doit voyager
   * AVEC son étage. Une version qui recopierait les contenus dans l'ordre du tableau d'entrée
   * poserait le template sur l'étage RCS et le message RCS sur l'étage WhatsApp, c'est-à-dire deux
   * étages dont aucun ne peut partir, sans qu'aucun compilateur ne le signale.
   */
  it('le contenu suit son etage, il ne glisse pas sur le voisin', () => {
    const entrants: EtageEntrant[] = [
      { rang: 2, canal: 'rcs', rcsMessage: { kind: 'text', text: 'coucou' } },
      { rang: 1, canal: 'whatsapp', templateName: 'promo', templateLanguage: 'fr' },
    ];
    expect(normaliserChaine(entrants)).toEqual([
      { rang: 1, canal: 'whatsapp', templateName: 'promo', templateLanguage: 'fr' },
      { rang: 2, canal: 'rcs', rcsMessage: { kind: 'text', text: 'coucou' } },
    ]);
  });

  // ⚠️ Une chaîne VIDE reste vide : c'est `problemeDeChaine` qui la REFUSE, pas cette fonction, qui ne
  // décide de rien. Lui faire inventer un étage ici rendrait le refus impossible à écrire.
  it('une chaine vide reste vide', () => {
    expect(normaliserChaine([])).toEqual([]);
  });
});

describe('problemeDeChaine', () => {
  const CHAINE_VALIDE: EtageEntrant[] = [
    { rang: 1, canal: 'whatsapp' },
    { rang: 2, canal: 'rcs' },
    { rang: 3, canal: 'email' },
  ];

  it('accepte une chaine dont le premier etage est le canal de la campagne', () => {
    expect(problemeDeChaine(CHAINE_VALIDE, 'whatsapp')).toBeNull();
  });

  /**
   * 🔴 LE PREMIER ÉTAGE EST LA CAMPAGNE, PAS UN ÉTAGE COMME LES AUTRES. Son contenu vient des COLONNES
   * de `campaigns`, jamais de sa ligne d'étage (`contenuDeLEtage`, `src/campaign/engine.ts`, vérifié),
   * et c'est l'invariant de la migration 0134. Laisser passer un rang 1 en RCS sur
   * une campagne déclarée WhatsApp ferait partir le contenu WhatsApp en journalisant « rcs » : le
   * message serait le bon, la ventilation par canal serait fausse, et personne ne le verrait.
   */
  it('refuse un premier etage qui contredit le canal de la campagne', () => {
    expect(problemeDeChaine(CHAINE_VALIDE, 'rcs')).toMatch(/premier étage/i);
  });

  it('refuse un canal que la table ne connait pas', () => {
    const chaine = [{ rang: 1, canal: 'whatsapp' }, { rang: 2, canal: 'sms' }] as unknown as EtageEntrant[];
    expect(problemeDeChaine(chaine, 'whatsapp')).toMatch(/canal/i);
  });

  /**
   * ⚠️ LE PLAFOND EST CELUI DU CHECK DE LA MIGRATION 0134 (`rang between 1 and 3`). Il est refusé ICI
   * plutôt que tronqué : tronquer supprimerait en silence un étage que l'opérateur a configuré, ce qui
   * est pire qu'un refus qu'il peut lire.
   */
  it('refuse une chaine plus longue que le nombre de rangs de la table', () => {
    const trop: EtageEntrant[] = [
      { rang: 1, canal: 'whatsapp' }, { rang: 2, canal: 'rcs' },
      { rang: 3, canal: 'email' }, { rang: 4, canal: 'whatsapp' },
    ];
    expect(trop.length).toBeGreaterThan(RANG_MAX);
    expect(problemeDeChaine(trop, 'whatsapp')).toMatch(new RegExp(`${RANG_MAX}`));
  });

  /**
   * 🔴 MÊME DOCTRINE QUE `contactIds: []`, ET POUR LA MÊME RAISON. Une liste explicitement vide n'est
   * pas « rien demandé » : l'appelant a DÉSIGNÉ une chaîne et n'y a mis aucun étage. La faire retomber
   * sur « une campagne à un seul étage » lui ferait croire que son repli est parti.
   */
  it('refuse une chaine explicitement vide', () => {
    expect(problemeDeChaine([], 'whatsapp')).toMatch(/vide|aucun/i);
  });

  /**
   * 🔴 DEUX ÉTAGES SUR LE MÊME CANAL NE SONT PAS UN REPLI, et la conséquence est mesurable : la
   * ventilation par canal du funnel groupe par `canal` (`funnelParCanal`, `src/stats/store.pg.ts`,
   * `group by e.canal`), donc les deux étages se confondraient en UNE ligne et l'écran ne pourrait
   * plus dire lequel des deux a échoué.
   */
  it('refuse deux etages sur le meme canal', () => {
    const doublon: EtageEntrant[] = [{ rang: 1, canal: 'whatsapp' }, { rang: 2, canal: 'whatsapp' }];
    expect(problemeDeChaine(doublon, 'whatsapp')).toMatch(/canal/i);
  });

  it('refuse un rang qui n est pas un entier', () => {
    const casse = [{ rang: 1.5, canal: 'whatsapp' }] as EtageEntrant[];
    expect(problemeDeChaine(casse, 'whatsapp')).toMatch(/rang/i);
  });
});
