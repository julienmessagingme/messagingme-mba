import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';
import { MOTIFS_DE_PAUSE } from '../src/campaign/pause';

/**
 * LA MIGRATION 0180 (le numéro délié) ET LE CODE PARLENT DES MÊMES MOTIFS DE PAUSE.
 *
 * 🔴 Deux fermetures à tenir ensemble. Le CHECK `campaigns_pause_reason_check` doit accepter TOUS les motifs du
 * type (`MOTIFS_DE_PAUSE`, tenu par le compilateur) : un motif que la base refuse fait échouer la mise en pause à
 * l'écriture, en pleine campagne. Et le balayage de reprise ne doit JAMAIS voir `numero_delie` : ni son WHERE ni
 * l'index partiel qui le sert, sinon une campagne repartirait vers un numéro délié.
 */
const lire = (chemin: string): string => readFileSync(new URL(chemin, import.meta.url), 'utf8');
const SQL = lire('../db/migrations/0180_numero_delie.sql');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const instructions = decouperInstructions(SQL).map(sansCommentaires).map((i) => i.trim()).filter((i) => i !== '');
const codes = (texte: string): string[] => [...texte.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]!);

describe('migration 0180', () => {
  it('🔴 le CHECK des motifs de pause porte EXACTEMENT les motifs du code', () => {
    const i = instructions.find((x) => x.includes('add constraint campaigns_pause_reason_check'));
    expect(i).toBeDefined();
    expect(codes(i!).sort()).toEqual([...MOTIFS_DE_PAUSE].sort());
  });

  it('🔴 elle RETIRE l’ancien CHECK sous le nom posé par 0122, juste avant de reposer le sien', () => {
    // Un nom deviné à côté laisserait l'ancien CHECK en place ET ajouterait le nouveau : `numero_delie` serait
    // alors refusé par le premier, en silence jusqu'à la première mise en pause.
    expect(lire('../db/migrations/0122_campagne_heures_ouvrees.sql')).toContain('add constraint campaigns_pause_reason_check');
    const retrait = instructions.findIndex((x) => x === 'alter table campaigns drop constraint if exists campaigns_pause_reason_check;' || x === 'alter table campaigns drop constraint if exists campaigns_pause_reason_check');
    const pose = instructions.findIndex((x) => x.includes('add constraint campaigns_pause_reason_check'));
    expect(retrait).toBeGreaterThanOrEqual(0);
    expect(pose).toBe(retrait + 1);
  });

  it('la colonne est nullable, sans défaut, et rejouable', () => {
    const i = instructions.find((x) => x.includes('delie_le'));
    expect(i).toMatch(/alter table phone_numbers add column if not exists delie_le timestamptz;?$/);
  });

  it('🔴 elle ne touche PAS à l’index de reprise, et ni l’index ni le balayage ne nomment `numero_delie`', () => {
    expect(SQL.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n')).not.toContain('campaigns_reprise_idx');
    // La DERNIÈRE définition de l'index (0122) : son prédicat ne connaît que les pauses à échéance.
    const index = sansCommentaires(lire('../db/migrations/0122_campagne_heures_ouvrees.sql'));
    const predicat = index.slice(index.lastIndexOf('create index if not exists campaigns_reprise_idx'));
    expect(predicat).toContain("pause_reason in ('debit', 'hors_horaires')");
    expect(predicat).not.toContain('numero_delie');
    // Le WHERE du balayage, lu dans la requête elle-même.
    const store = lire('../src/campaign/store.pg.ts');
    const requete = store.slice(store.indexOf('async reprendreCampagnesDues'), store.indexOf('returning id, tenant_id', store.indexOf('async reprendreCampagnesDues')));
    expect(requete).toContain("pause_reason in ('debit', 'hors_horaires')");
    expect(requete).toContain('paused_until is not null');
    expect(requete).not.toContain('numero_delie');
  });

  it('dans une transaction ordinaire : les deux changements entrent ensemble ou pas du tout', () => {
    expect(veutHorsTransaction(SQL)).toBe(false);
  });
});
