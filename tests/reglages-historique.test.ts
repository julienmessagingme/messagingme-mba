import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ORIGINES, problemeDeLigne, type LigneHistorique } from '../src/reglages/historique';

const SQL = readFileSync(
  resolve(__dirname, '../db/migrations/0146_historique_reglages_et_plafond.sql'), 'utf8');

const ligne = (sur: Partial<LigneHistorique> = {}): LigneHistorique => ({
  surface: 'mba', surfaceId: null, element: 'faq', operation: 'ajout',
  cible: 'faq_1', libelle: 'FAQ : horaires du dimanche', avant: null, apres: { q: 'x' },
  origine: 'assistant', acteurEmail: 'julien@messagingme.fr', acteurId: null, ...sur,
});

/**
 * 🔴 CE QUE LE SCHÉMA PROMET, IL LE TIENT LUI-MÊME.
 *
 * Ces cas LISENT le fichier SQL, comme `tests/migration-directives.test.ts` : ils gardent des propriétés que
 * personne ne peut retirer sans le voir passer en revue. Une promesse tenue par la seule discipline du
 * développeur se perd au troisième appelant.
 */
describe('la table d’historique tient ses promesses dans le SCHÉMA', () => {
  it('🔴 interdit une suppression sans son contenu', () => {
    // Meta n'a pas de corbeille : cette ligne est le seul exemplaire du contenu effacé. Une suppression sans
    // `avant` serait une ligne qui dit qu'on a perdu quelque chose sans dire quoi.
    expect(SQL).toContain("check (operation <> 'suppression' or avant is not null)");
  });

  it('🔴 ne porte AUCUN index de purge', () => {
    // Un index sur `at` seul n'a qu'un usage : balayer par date pour supprimer. Son absence est ce qui dit au
    // prochain lecteur que cette table ne se purge pas, contrairement à `audit_log`.
    expect(SQL).not.toMatch(/on reglages_historique \(at\)/);
    expect(SQL).not.toMatch(/reglages_historique_purge/);
  });

  it('⚠️ le départ d’un collaborateur ne rend pas l’historique anonyme', () => {
    // `on delete set null` sur l'acteur, et son e-mail DÉNORMALISÉ à côté : sans lui, supprimer un compte
    // effacerait le « qui » de tout ce qu'il a fait.
    expect(SQL).toContain('acteur_id   uuid references users(id) on delete set null');
    expect(SQL).toContain('acteur_email text');
  });

  it('🔴 et la colonne dénormalisée est REMPLIE, sinon la promesse ci-dessus est un texte', () => {
    /**
     * Ce test existe parce que le précédent PASSAIT alors que personne n'écrivait jamais `acteur_email` :
     * il vérifiait le schéma, c'est-à-dire la place prévue, pas ce qui s'y met. L'écran affichait donc
     * « auteur inconnu » sur toutes les lignes, y compris pour un compte bien vivant.
     */
    const pg = readFileSync(resolve(__dirname, '../src/reglages/historique.pg.ts'), 'utf8');
    const insert = pg.slice(pg.indexOf('insert into reglages_historique'));
    expect(insert).toContain('coalesce($11, (select email from users where id = $12::uuid and tenant_id = $1))');
  });

  it('⚠️ un espace supprimé emporte son historique, jamais l’inverse', () => {
    expect(SQL).toContain('tenant_id   uuid not null references tenants(id) on delete cascade');
  });
});

/**
 * LA GARDE APPLICATIVE, qui double celle du schéma.
 *
 * ⚠️ LES DEUX SONT VOULUES, et ce n'est pas de la ceinture-bretelles : la base rend une violation de
 * contrainte, c'est-à-dire un 500, donc une page Cloudflare sans explication. Celle-ci NOMME le problème.
 */
describe('problemeDeLigne', () => {
  it('🔴 refuse une suppression sans contenu, et le DIT', () => {
    const p = problemeDeLigne(ligne({ operation: 'suppression', avant: null }));
    expect(p).toContain('seul exemplaire');
  });

  it('accepte une suppression qui porte son contenu', () => {
    expect(problemeDeLigne(ligne({ operation: 'suppression', avant: { q: 'horaires' } }))).toBeNull();
  });

  it('🔴 une ligne d’agent doit nommer l’agent', () => {
    expect(problemeDeLigne(ligne({ surface: 'agent', surfaceId: null }))).toContain('nommer l’agent');
  });

  it('🔴 une ligne de MBA n’en porte pas : il est unique par espace', () => {
    expect(problemeDeLigne(ligne({ surface: 'mba', surfaceId: 'ag-1' }))).toContain('unique par espace');
  });

  it('⚠️ un libellé vide est refusé : l’écran n’aurait rien à montrer', () => {
    expect(problemeDeLigne(ligne({ libelle: '   ' }))).toContain('dire ce qui a changé');
  });

  it('une ligne ordinaire passe', () => {
    expect(problemeDeLigne(ligne())).toBeNull();
  });
});

/**
 * 🔴 LES ORIGINES DU CODE SONT CELLES DU CHECK, DANS LES DEUX SENS (0206, lot 8a). Une origine que le code écrit et que
 * le CHECK refuse fait perdre la ligne en 500 ; une origine que le CHECK accepte et que le code ne connaît pas est une
 * valeur que l'écran ne saurait pas dire. Le CHECK lu est le DERNIER posé sous ce nom, parce qu'une migration le
 * remplace en entier (`drop` puis `add`) : 0146 l'a créé, 0206 l'a élargi.
 */
describe('les origines de l’historique', () => {
  it('🔴 le dernier CHECK `reglages_historique_origine_chk` porte exactement `ORIGINES`', () => {
    const dossier = resolve(__dirname, '../db/migrations');
    const definitions = readdirSync(dossier).filter((f) => f.endsWith('.sql')).sort()
      .map((f) => readFileSync(resolve(dossier, f), 'utf8'))
      .map((sql) => /reglages_historique_origine_chk\s+check\s*\(origine in \(([^)]*)\)\)/.exec(sql))
      .filter((m): m is RegExpExecArray => m !== null);
    // Au moins deux : celle de 0146 et celle de 0206. Une seule voudrait dire que l'élargissement a été perdu.
    expect(definitions.length).toBeGreaterThanOrEqual(2);
    const derniere = [...definitions.at(-1)![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect([...derniere].sort()).toEqual([...ORIGINES].sort());
  });
});
