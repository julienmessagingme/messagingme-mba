import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIONS_JOURNAL } from '../web/lib/journal';

/**
 * Chaque action que le serveur peut écrire (`AuditAction`, `src/audit/store.pg.ts`) a son libellé dans la console
 * (`ACTIONS_JOURNAL`). Sans lui, le journal des actions affiche l'identifiant brut : rien ne le tenait avant le lot 5.
 */
describe('les libellés du journal des actions', () => {
  it('🔴 chaque action du serveur a son libellé, en français et en anglais', () => {
    const source = readFileSync(join(__dirname, '..', 'src', 'audit', 'store.pg.ts'), 'utf8');
    const debut = source.indexOf('export type AuditAction =');
    const reste = source.slice(debut);
    const bloc = reste.slice(0, reste.search(/';\r?\n/) + 2);
    const actions = [...bloc.matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]!);
    expect(actions.length).toBeGreaterThan(40);
    expect(actions.filter((a) => !ACTIONS_JOURNAL[a]?.[0] || !ACTIONS_JOURNAL[a]?.[1])).toEqual([]);
  });
});
