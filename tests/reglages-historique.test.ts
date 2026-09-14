import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { problemeDeLigne, type LigneHistorique } from '../src/reglages/historique';

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
