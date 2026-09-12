import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * QUI PEUT RECEVOIR UNE CONVERSATION, ET SUR QUEL CRITÈRE (2026-09-12).
 *
 * 🔴 LE DÉFAUT QUE CE FICHIER FERME, ET IL ÉTAIT EN PRODUCTION. Deux requêtes jugeaient qu'un compte était
 * utilisable sur `password_hash`, c'est-à-dire sur la présence d'un MOT DE PASSE. Or la connexion par Google
 * n'en pose aucun : une personne qui travaille dans la console tous les jours y était donc classée
 * « invitation en attente » et retirée de trois listes (membres d'un scénario, assignation d'une campagne,
 * tour de rôle côté serveur).
 *
 * Mesuré en production le 2026-09-12 : sur quatre comptes tous actifs, connectés la veille et
 * l'avant-veille, DEUX étaient écartés. Et un espace dont toute l'équipe passe par Google aurait rendu une
 * liste VIDE, donc aucune affectation du tout, sans la moindre erreur nulle part.
 *
 * ⚠️ AUCUN TEST NE POUVAIT LE VOIR, et c'est pour ça que ce fichier lit le SQL au lieu de l'exécuter. Le
 * défaut ne se manifeste que sur une base où quelqu'un se connecte par Google : un faux de test pose ce
 * qu'il veut dans ses colonnes, et un test d'intégration insère des comptes avec un mot de passe parce que
 * c'est le cas qu'on a en tête en écrivant la fixture. C'est un essai humain qui l'a trouvé, en cinq
 * minutes, sur la question « pourquoi je ne vois qu'une personne alors qu'on est trois ».
 *
 * ⚠️ CE QUE CE TEST VÉRIFIE VRAIMENT : que le critère d'activité d'un compte reste `last_login_at`, et qu'il
 * ne retombe jamais sur `password_hash`. C'est une garde contre la RÉGRESSION d'un raisonnement, pas contre
 * un comportement, et elle vit donc au niveau du texte des requêtes.
 */

const RACINE = resolve(__dirname, '..');
const lire = (f: string): string => readFileSync(join(RACINE, f), 'utf8');

/** La ligne de `select` qui juge un compte, dans chacun des deux fichiers concernés. */
function requeteDe(fichier: string, ancre: string): string {
  const s = lire(fichier);
  const i = s.indexOf(ancre);
  expect(i, `ancre introuvable dans ${fichier} : ${ancre}`).toBeGreaterThan(-1);
  return s.slice(i, i + 2500);
}

describe('un compte actif se juge sur sa DERNIÈRE CONNEXION, jamais sur son mot de passe', () => {
  // ⚠️ ON LIT LE SQL SEUL, PAS LE COMMENTAIRE QUI LE PRÉCÈDE. Une première version cherchait le critère
  // dans toute la fenêtre : elle restait VERTE sous mutation, parce que le docbloc au-dessus de la requête
  // cite le bon critère pour l'expliquer. Un test qui trouve sa preuve dans une phrase de prose ne teste
  // rien, et c'est exactement le piège que ce fichier existe pour surveiller ailleurs.
  it('le tour de rôle retient les comptes qui se sont déjà connectés', () => {
    const q = requeteDe('src/inbox/store.pg.ts', 'async membresAffectables');
    const sql = q.slice(q.indexOf('select id from users'), q.indexOf('order by'));
    expect(sql).toContain('last_login_at is not null');
  });

  // 🔴 LE MIROIR, ET C'EST LUI QUI TIENT LA RÈGLE. Sans ce cas, on peut ajouter le bon critère en LAISSANT
  // le mauvais à côté : la requête deviendrait plus restrictive encore, et le test du dessus resterait vert.
  it('le tour de rôle ne juge PAS sur le mot de passe', () => {
    const q = requeteDe('src/inbox/store.pg.ts', 'async membresAffectables');
    const sql = q.slice(q.indexOf('select id from users'), q.indexOf('order by'));
    expect(sql).not.toContain('password_hash');
  });

  it('« invitation en attente » veut dire « jamais connecté »', () => {
    const q = requeteDe('src/user/store.pg.ts', 'async list(tenantId');
    expect(q).toContain('(last_login_at is null) as pending');
  });

  it('« invitation en attente » ne se lit PAS sur le mot de passe', () => {
    const q = requeteDe('src/user/store.pg.ts', 'async list(tenantId');
    const sql = q.slice(q.indexOf('`select id, email'), q.indexOf('where tenant_id'));
    expect(sql).not.toContain('password_hash');
  });
});
