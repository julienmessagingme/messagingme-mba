import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgRcsMediaStore } from '../src/rcs/media-store.pg';

/**
 * 🔴 LA SUPPRESSION D'UN FICHIER NE DEMANDE JAMAIS UNE SECONDE CONNEXION PENDANT QU'ELLE TIENT LE VERROU D'ESPACE
 * (relecture du lot B médias, jaune n° 1). Dix suppressions simultanées prenaient les dix connexions du pool de l'API ;
 * celle qui tenait le verrou en attendait une onzième pour vérifier les utilisations, les neuf autres attendaient le
 * verrou : toute l'API gelait huit secondes (`DB_CONN_TIMEOUT_MS`), console, `/m/`, `/v1` et `/mcp` compris.
 * Ici, le pool REFUSE toute requête hors de la transaction : la vérification doit passer par la connexion déjà prise.
 */
describe('PgRcsMediaStore.supprimer', () => {
  function monter(utilisations: Array<{ lieu: string; nom: string }>) {
    const requetes: string[] = [];
    const client = {
      query: async (sql: string) => {
        requetes.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
        if (/select 1 from rcs_media/.test(sql)) return { rowCount: 1, rows: [{}] };
        if (/with motif/.test(sql)) return { rowCount: utilisations.length, rows: utilisations };
        return { rowCount: 1, rows: [] };
      },
      release: () => {},
    };
    const pool = {
      connect: async () => client,
      query: async () => { throw new Error('seconde connexion demandée au pool pendant la transaction'); },
    } as unknown as Pool;
    return { store: new PgRcsMediaStore(pool), requetes };
  }

  it('vérifie les utilisations SUR la connexion de la transaction, puis supprime', async () => {
    const { store, requetes } = monter([]);
    expect(await store.supprimer('t1', 'abcdefghjkmnpqrstvwxyz0123')).toEqual({ issue: 'supprime' });
    expect(requetes.some((r) => r.startsWith('with motif'))).toBe(true);
  });

  it('refuse un fichier utilisé, sans seconde connexion non plus', async () => {
    const { store } = monter([{ lieu: 'scenario', nom: 'Bienvenue' }]);
    expect(await store.supprimer('t1', 'abcdefghjkmnpqrstvwxyz0123')).toEqual({ issue: 'utilise', utilisations: [{ lieu: 'scenario', nom: 'Bienvenue' }] });
  });
});
