import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { ORIGINE_EFFECTIVE_SQL, THEME_DE_ORIGINE, ORIGINES, BASCULE_ORIGINE } from '../src/inbox/origine';
import { PgInboxStore } from '../src/inbox/store.pg';

/** Fake pool : capture les requêtes, rend une conversation pour l'upsert par wa_id. */
function faussePool() {
  const requetes: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      requetes.push({ sql, params: params ?? [] });
      return { rows: [{ id: 'conv-1' }], rowCount: 1 };
    },
  } as unknown as Pool;
  return { pool, requetes };
}

/** L'INSERT du message, et la valeur écrite dans sa colonne `origin`. */
function origineEcrite(requetes: Array<{ sql: string; params: unknown[] }>): unknown {
  const insert = requetes.find((q) => /insert into conversation_messages/i.test(q.sql));
  expect(insert, 'aucun INSERT de message').toBeDefined();
  const colonnes = insert!.sql.match(/\(([^)]*)\)/)![1]!.split(',').map((c) => c.trim());
  const rang = colonnes.indexOf('origin');
  expect(rang, 'la colonne origin ne figure pas dans l’INSERT').toBeGreaterThanOrEqual(0);
  // Les paramètres ne sont PAS dans l'ordre des colonnes ($4 avant $2 sur un des deux chemins) : on relit
  // le numéro du placeholder à la position de la colonne, comme le fait Postgres.
  const valeurs = insert!.sql.match(/values \(([^)]*)\)/i)![1]!.split(',').map((v) => v.trim());
  const placeholder = valeurs[rang]!;
  const numero = Number(placeholder.replace('$', ''));
  return insert!.params[numero - 1];
}

/**
 * D'où vient un message de service (migration 0099).
 *
 * Ce que ces tests protègent n'est pas la table de correspondance en elle-même, c'est la propriété qui
 * rend l'écran honnête : AUCUN message ne doit pouvoir être rangé dans un thème par défaut. Un message
 * dont l'origine est inconnue ressort en « indéterminée », visible, plutôt que de gonfler le scripté.
 * C'est exactement le piège qu'un `else 'scenario'` sans borne aurait créé.
 */
describe('origine d’un message de service', () => {
  it('🔴 chaque origine enregistrable tombe dans un thème, aucune n’est orpheline', () => {
    // Une valeur ajoutée à `ORIGINES` sans entrée dans la table serait comptée « indéterminée » à l'écran,
    // donc signalée comme une anomalie alors qu'elle est légitime. Ce test force à traiter les deux.
    for (const o of ORIGINES) expect(THEME_DE_ORIGINE[o], `origine « ${o} » sans thème`).toBeDefined();
  });

  it('l’agent de Meta et le nôtre versent tous les deux dans le thème IA', () => {
    expect(THEME_DE_ORIGINE.ia).toBe('ia');
    expect(THEME_DE_ORIGINE.mba).toBe('ia');
  });

  it('🔴 un message d’AGENT ne compte pas comme scripté', () => {
    // C'est la distinction qui a motivé la colonne : avant 0099, l'agent et le scénario écrivaient tous
    // les deux `type = 'text'` avec `sender_user_id = null`, donc rien ne les séparait.
    expect(THEME_DE_ORIGINE.ia).not.toBe(THEME_DE_ORIGINE.scenario);
  });

  describe('la dérivation SQL de l’historique', () => {
    it('🔴 est BORNÉE dans le temps : après la bascule, l’inconnu reste indéterminé', () => {
      // Sans cette borne, un chemin d'écriture ajouté demain sans poser son origine serait compté comme du
      // scripté, en silence et pour toujours. La borne le fait ressortir à l'écran.
      expect(ORIGINE_EFFECTIVE_SQL).toContain(`m.created_at < timestamptz '${BASCULE_ORIGINE}'`);
      expect(ORIGINE_EFFECTIVE_SQL).toContain("else 'indeterminee'");
    });

    it('lit d’abord la colonne, et ne devine que si elle est vide', () => {
      // `coalesce(m.origin, ...)` : une valeur réellement enregistrée l'emporte toujours sur la déduction.
      expect(ORIGINE_EFFECTIVE_SQL.replace(/\s+/g, ' ')).toMatch(/^coalesce\( m\.origin,/);
    });

    it('reconnaît l’humain et l’agent de Meta sur l’historique, eux ne peuvent pas mentir', () => {
      expect(ORIGINE_EFFECTIVE_SQL).toContain("when m.sender_user_id is not null then 'humain'");
      expect(ORIGINE_EFFECTIVE_SQL).toContain("when m.type = 'mba' then 'mba'");
    });
  });

  describe('ce que les chemins d’écriture posent réellement', () => {
    it('🔴 un envoi automatisé écrit l’origine qu’on lui donne, dans la colonne `origin`', async () => {
      const { pool, requetes } = faussePool();
      await new PgInboxStore(pool).recordOutboundByWaId('t1', '33611', { body: 'bonjour', messageId: 'wamid-1', type: 'text', origine: 'ia' });
      expect(origineEcrite(requetes)).toBe('ia');
    });

    it('🔴 une réponse d’opérateur est marquée « humain », déduite de l’expéditeur', async () => {
      const { pool, requetes } = faussePool();
      await new PgInboxStore(pool).recordOutbound('conv-1', 'je vous rappelle', 'wamid-2', 'text', null, null, 'user-7');
      expect(origineEcrite(requetes)).toBe('humain');
    });

    it('le même chemin SANS expéditeur humain n’est pas marqué humain', async () => {
      // Deux sens : la déduction doit distinguer, pas coller « humain » sur tout ce qui passe par l'inbox.
      const { pool, requetes } = faussePool();
      await new PgInboxStore(pool).recordOutbound('conv-1', 'message auto', 'wamid-3', 'text', null, null, null);
      expect(origineEcrite(requetes)).not.toBe('humain');
    });

    it('🔴 l’envoi de l’AGENT IA déclare « ia », et pas l’origine de ses voisins', () => {
      // Garde de SOURCE, sur le modèle de `tests/queue-names.test.ts` : TypeScript exige une origine, mais
      // il ne peut pas voir qu'un copier-coller depuis l'envoi de scénario juste au-dessus (`origine:
      // 'scenario'`) ferait compter toutes les réponses de l'agent comme du scripté. C'est silencieux,
      // c'est faux, et seul l'écran le montrerait, des semaines plus tard.
      const src = readFileSync(new URL('../src/workflow/wiring.ts', import.meta.url), 'utf8');
      const debut = src.indexOf('const envoyerTexteAgent');
      expect(debut, 'envoyerTexteAgent introuvable : ce test a besoin d’être re-visé').toBeGreaterThan(0);
      const corps = src.slice(debut, src.indexOf('\n  };', debut));
      expect(corps).toContain('recordOutboundByWaId');
      expect(corps).toContain("origine: 'ia'");
      expect(corps).not.toContain("origine: 'scenario'");
    });
  });

  describe('la migration 0099', () => {
    const sql = readFileSync(new URL('../db/migrations/0099_message_origine.sql', import.meta.url), 'utf8');

    it('🔴 contraint la colonne aux SEULES origines déclarées en TypeScript', () => {
      // Les deux listes doivent rester alignées : une valeur écrite par le code mais absente du `check`
      // ferait échouer l'insertion en production, sur un chemin d'envoi, donc au pire moment.
      for (const o of ORIGINES) expect(sql, `origine « ${o} » absente du check SQL`).toContain(`'${o}'`);
      // Et l'inverse : rien dans le `check` qui ne soit pas déclaré côté code.
      const duCheck = [...(sql.match(/check \(origin in \(([^)]*)\)\)/)?.[1] ?? '').matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
      expect(duCheck.sort()).toEqual([...ORIGINES].sort());
    });

    it('laisse la colonne NULLABLE : un oubli ne doit pas casser un envoi en production', () => {
      // Un `not null` aurait fait échouer l'insertion sur le chemin chaud le jour d'un oubli. La garde
      // contre l'oubli est le paramètre obligatoire côté TypeScript, qui ne coûte rien en exploitation.
      expect(sql).not.toMatch(/origin text[^;]*not null/i);
    });
  });
});
