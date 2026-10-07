import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';
import { TYPES_EVENEMENT } from '../src/inbox/evenements';

/**
 * 0216 : le statut « urgent » d'une conversation (RC2). Elle AJOUTE (deux colonnes, un index partiel) et RELÂCHE (le
 * CHECK des types d'événements), donc elle passe AVANT le `up` : la liste de l'Inbox nomme `urgente_le` dans son
 * `select` et son tri, et le code neuf écrit `urgente` et `urgence_levee`.
 * Ce que la base en fait vraiment (poser, lever, l'ordre de « À traiter » et sa pagination) :
 * `tests/integration/inbox-urgent.integration.test.ts`, en CI.
 */
const lire = (chemin: string): string => readFileSync(new URL(chemin, import.meta.url), 'utf8');
const SQL = lire('../db/migrations/0216_conversation_urgente.sql');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const instructions = decouperInstructions(SQL)
  .map(sansCommentaires)
  .map((i) => i.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim())
  .filter((i) => i !== '');

describe('migration 0216', () => {
  it('🔴 le plafond d’attente du verrou vient en tête : placé après un `alter`, il ne borne plus rien', () => {
    expect(instructions[0]).toBe("set local lock_timeout = '5s'");
    // Dans une transaction : le drop et l'add du CHECK ne laissent aucune fenêtre sans contrôle.
    expect(veutHorsTransaction(SQL)).toBe(false);
  });

  it('🔴 deux colonnes nullables SANS défaut, l’auteur en `on delete set null`', () => {
    // Un défaut marquerait toutes les conversations existantes ; une cascade supprimerait la conversation avec le
    // collaborateur, un `restrict` ferait échouer la suppression d'un compte.
    expect(instructions).toContain('alter table conversations add column if not exists urgente_le timestamptz');
    expect(instructions).toContain(
      'alter table conversations add column if not exists urgente_par uuid constraint conversations_urgente_par_fk references users (id) on delete set null',
    );
  });

  it('🔴 l’index partiel porte le prédicat du dossier « Urgent », mot pour mot', () => {
    // Le magasin filtre sur `c.urgente_le is not null` : un prédicat différent laisserait le dossier sans index.
    expect(instructions).toContain(
      'create index if not exists conversations_urgentes_idx on conversations (tenant_id, urgente_le desc) where urgente_le is not null',
    );
    expect(lire('../src/inbox/store.pg.ts')).toContain("'c.urgente_le is not null'");
  });

  it('🔴 le CHECK des types est la liste du code moins ce que 0217 a ajouté, sous le nom que 0192 a posé', () => {
    // Un type que le code écrit et que la base refuse fait échouer l'écriture qui le porte, en 23514 : ici « Traité »
    // et l'archivage eux-mêmes, qui lèvent l'urgence dans leur propre requête.
    const i = instructions.indexOf('alter table conversation_evenements drop constraint if exists conversation_evenements_type_check');
    expect(i).toBeGreaterThan(-1);
    const pose = instructions[i + 1] ?? '';
    expect(pose).toMatch(/^alter table conversation_evenements add constraint conversation_evenements_type_check check \(type in \(/);
    const types = [...pose.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(types).toEqual(TYPES_EVENEMENT.filter((t) => t !== 'mba_indisponible'));
    // Et 0209 en reste le préfixe : rien n'a été retiré.
    expect(types.slice(-2)).toEqual(['urgente', 'urgence_levee']);
  });

  it('⚠️ additive : aucune reprise, aucune suppression de donnée, et sans accent grave', () => {
    const code = sansCommentaires(SQL);
    expect(code).not.toMatch(/^\s*(update|insert|delete|truncate)\b/im);
    expect(code).not.toMatch(/\bdrop (table|column|index)\b/i);
    expect(SQL).not.toContain('`');
  });
});
