import { describe, it, expect } from 'vitest';
import { entrantAttribue, entrantAttribueTentative } from '../src/stats/store.pg';

/**
 * LE PRÉDICAT D'ATTRIBUTION ANCRÉ SUR UNE TENTATIVE, relu sur son TEXTE.
 *
 * ⚠️ CE QUE CE TEST PROUVE, ET CE QU'IL NE PROUVE PAS. Il vérifie que les deux gardes sont PRÉSENTES et
 * ancrées sur le bon instant. Il ne dit RIEN de ce que Postgres en calcule : la preuve du SENS est dans
 * `tests/integration/stats-funnel-canal.integration.test.ts`, qui exerce les deux cas sur une vraie base.
 * Il est ici parce que le défaut du 2026-09-12 était VISIBLE DANS LE TEXTE (une garde comparait une
 * colonne à un instant d'une AUTRE colonne sans exclure la ligne) et qu'une suite qui tourne en une
 * seconde l'aurait montré avant la CI.
 *
 * 🔴 L'INVARIANT, ÉNONCÉ UNE FOIS : toute garde ancrée sur un instant qui n'est pas la colonne de la ligne
 * qu'elle compare DOIT exclure cette ligne. Ancrée sur `r.sent_at`, la ligne du destinataire ne peut pas
 * être postérieure à elle-même et s'auto-exclut ; ancrée sur `e.sent_at`, elle se compare à une horloge
 * différente de quelques millisecondes et s'attrape elle-même.
 */
describe('l attribution d une reponse a UNE tentative', () => {
  const sql = entrantAttribueTentative();

  it('🔴 la garde sur les destinataires EXCLUT la ligne du destinataire ancre', () => {
    // Sans cette exclusion, la ligne s attrape elle-meme et l attribution est refusee pour tout le monde :
    // `repondus` valait 0 partout pendant que `replied` valait 1 sur la meme personne.
    expect(sql).toContain('and r2.id <> r.id');
  });

  it('🔴 une seconde garde lit les departs dans le JOURNAL, que la table des destinataires ignore', () => {
    // `campaign_recipients` n a qu une ligne par contact : elle ne sait pas dire qu un destinataire est
    // reparti deux fois (relance, etage suivant). Sans cette garde, deux tentatives se partagent la meme
    // reponse et la somme par canal depasse le `replied` du funnel global.
    expect(sql).toContain('from campaign_envois e2');
    // Seule une tentative REELLEMENT partie peut voler une reponse.
    expect(sql).toMatch(/e2\.statut = 'sent'/);
  });

  it('les deux gardes sont ancrees sur l instant de la TENTATIVE, jamais sur celui du destinataire', () => {
    expect(sql).toContain('and r2.sent_at > e.sent_at');
    expect(sql).toContain('and e2.sent_at > e.sent_at');
    // ⚠️ Aucune comparaison ne doit retomber sur `r.sent_at` : ce serait l ancrage de l AUTRE variante,
    // celle du funnel global, et melanger les deux redonnerait deux verites sur le meme ecran.
    expect(sql).not.toContain('> r.sent_at');
  });

  it('le canal compare est celui de la TENTATIVE, pas celui de la campagne', () => {
    // Une campagne mono-canal les confond ; une chaine de repli non, et c est tout l objet du lot.
    expect(sql).toContain('m.channel = e.canal');
  });
});

/**
 * L'AUTRE ANCRAGE, celui du funnel global, VÉRIFIÉ DE SON CÔTÉ.
 *
 * 🔴 SANS CE BLOC, L'INVARIANT N'ÉTAIT TENU QUE D'UN SEUL CÔTÉ. Mesuré : contaminer l'ancrage global avec
 * `e.sent_at` laissait la suite unitaire entièrement verte, alors que le SQL produit est invalide hors du
 * funnel par canal (`e` n'y est dans aucune clause `from`) et ferait exploser la requête en production.
 * Le mélange des deux ancrages est LE défaut de ce lot : il doit être refusé dans les deux sens.
 */
describe('l attribution d une reponse a UN destinataire, l ancrage d origine', () => {
  const sql = entrantAttribue();

  it('🔴 reste ancree sur le destinataire, sans une trace de l ancrage par tentative', () => {
    expect(sql).toContain('and r2.sent_at > r.sent_at');
    expect(sql).not.toContain('e.sent_at');
    expect(sql).not.toContain('e.canal');
  });

  it('🔴 n exclut RIEN, et c est correct : ancree sur sa propre colonne, la ligne s auto-exclut', () => {
    // Y ajouter une exclusion ne reparerait rien et changerait les chiffres du funnel global, qui n est
    // pas le sujet de ce lot.
    expect(sql).not.toContain('r2.id <>');
  });

  it('n a QU UNE garde : les departs supplementaires n existent pas a ce grain', () => {
    // Une ligne par contact : le meme destinataire ne peut pas y etre parti deux fois, donc le journal
    // n aurait rien a lui apprendre.
    expect(sql).not.toContain('campaign_envois');
  });
});
