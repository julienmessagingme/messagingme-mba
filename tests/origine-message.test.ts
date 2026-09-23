import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import type { Pool } from 'pg';
import { ORIGINE_EFFECTIVE_SQL, THEME_DE_ORIGINE, DETAIL_IA, ORIGINES, BASCULE_ORIGINE } from '../src/inbox/origine';
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

    it('🔴 l’envoi par conversation écrit l’origine QU’ON LUI DONNE, il ne la déduit plus', async () => {
      // 🔴 Le correctif d'un vrai bug, trouvé en revue. Cette origine était DÉDUITE de l'expéditeur : « pas
      // d'expéditeur, donc un scénario ». Vrai tant que les seuls appelants étaient les routes de la
      // console ; faux dès que le serveur MCP en a ajouté un, qui n'a pas d'expéditeur humain et n'est pas
      // un scénario pour autant. Chaque réponse d'agent tiers partait marquée « scenario », et comme la
      // valeur était écrite explicitement, le repli « indéterminée » ne pouvait même pas la signaler.
      const { pool, requetes } = faussePool();
      await new PgInboxStore(pool).recordOutbound('conv-1', 'je vous rappelle', 'wamid-2', 'humain', 'text', null, null, 'user-7');
      expect(origineEcrite(requetes)).toBe('humain');
    });

    it('🔴 le MÊME chemin, sans expéditeur humain, n’écrit PAS « scenario » par défaut', async () => {
      // L'autre sens, et c'est celui qui aurait attrapé le bug : un appelant sans expéditeur humain doit
      // pouvoir dire ce qu'il est. Un agent tiers écrit « mcp », pas « scenario ».
      const { pool, requetes } = faussePool();
      await new PgInboxStore(pool).recordOutbound('conv-1', 'réponse d’un agent tiers', 'wamid-3', 'mcp', 'text', null, null, null);
      expect(origineEcrite(requetes)).toBe('mcp');
      expect(origineEcrite(requetes)).not.toBe('scenario');
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

  describe('les migrations de la colonne', () => {
    const sql = readFileSync(new URL('../db/migrations/0099_message_origine.sql', import.meta.url), 'utf8');
    /**
     * LA DERNIÈRE MIGRATION QUI REDÉFINIT LE CHECK, TROUVÉE DANS LE DOSSIER, jamais nommée ici.
     *
     * 🔴 CE NOM ÉTAIT ÉCRIT EN DUR (`0101_origine_mcp.sql`) ET IL FALLAIT PENSER À LE CHANGER. Chaque
     * nouvelle origine rouvre le CHECK dans une migration de plus : le test aurait continué de lire 0101,
     * donc d'affirmer que la contrainte n'accepte que six valeurs, et il serait tombé en annonçant que le
     * CODE écrit une valeur interdite. Un test qui échoue POUR LA MAUVAISE RAISON coûte plus cher qu'un
     * test absent : on cherche le défaut là où il n'est pas. La liste se dérive donc du dossier, et la
     * prochaine origine n'aura rien à éditer ici.
     *
     * ⚠️ TRI PAR NOM, comme le runner de migrations lui-même (`db/`), et pas par date de fichier : c'est
     * l'ordre qui fait foi, et deux sessions qui écrivent en parallèle ne le respecteraient pas.
     */
    const dossier = new URL('../db/migrations/', import.meta.url);
    const redefinissent = readdirSync(dossier)
      .filter((f) => f.endsWith('.sql'))
      .filter((f) => /check \(origin in \(/.test(readFileSync(new URL(f, dossier), 'utf8')))
      .sort();
    const derniere = redefinissent[redefinissent.length - 1]!;
    const sqlCourant = readFileSync(new URL(derniere, dossier), 'utf8');

    it('🔴 contraint la colonne aux SEULES origines déclarées en TypeScript', () => {
      // Les deux listes doivent rester alignées : une valeur écrite par le code mais absente du `check`
      // ferait échouer l'insertion en production, sur un chemin d'envoi, donc au pire moment.
      for (const o of ORIGINES) expect(sqlCourant, `origine « ${o} » absente du check SQL`).toContain(`'${o}'`);
      // Et l'inverse : rien dans le `check` qui ne soit pas déclaré côté code.
      const duCheck = [...(sqlCourant.match(/check \(origin in \(([^)]*)\)\)/)?.[1] ?? '').matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
      expect(duCheck.sort()).toEqual([...ORIGINES].sort());
    });

    it('laisse la colonne NULLABLE : un oubli ne doit pas casser un envoi en production', () => {
      // Un `not null` aurait fait échouer l'insertion sur le chemin chaud le jour d'un oubli. La garde
      // contre l'oubli est le paramètre obligatoire côté TypeScript, qui ne coûte rien en exploitation.
      expect(sql).not.toMatch(/origin text[^;]*not null/i);
    });
  });
});

describe('le détail sous le thème « IA » (2026-09-15)', () => {
  /**
   * 🔴 L'INVARIANT QUI EMPÊCHE LE DÉTAIL DE MENTIR : chaque origine versée dans le thème `ia` doit avoir une
   * entrée dans `DETAIL_IA`, et réciproquement. Sans ce test, ajouter une quatrième IA demain la ferait
   * compter dans le total « IA » sans apparaître dans le détail : la somme des sous-lignes cesserait de
   * retomber sur sa ligne, et un tableau dont le détail ne fait pas le total est pire qu'un tableau sans
   * détail. C'est exactement pourquoi les deux tables vivent dans le même fichier.
   */
  it('🔴 toute origine du thème IA a son détail, et aucune autre', () => {
    const duTheme = Object.keys(THEME_DE_ORIGINE).filter((o) => THEME_DE_ORIGINE[o] === 'ia').sort();
    const duDetail = Object.keys(DETAIL_IA).sort();
    expect(duDetail).toEqual(duTheme);
  });

  it('🔴 les trois IA restent DISTINCTES en base, c’est ce qui rend le détail possible', () => {
    // Elles auraient pu être écrites `ia` toutes les trois : l'historique serait alors irrécupérable, et
    // cette demande aurait coûté une migration plus une reprise au lieu d'un changement d'affichage.
    expect(DETAIL_IA.ia).toBe('agent');
    expect(DETAIL_IA.mba).toBe('mba');
    expect(DETAIL_IA.mcp).toBe('mcp');
  });

  it('⚠️ une origine qui n’est PAS une IA n’a pas de détail', () => {
    expect(DETAIL_IA.humain).toBeUndefined();
    expect(DETAIL_IA.scenario).toBeUndefined();
    expect(DETAIL_IA.campagne).toBeUndefined();
    // L'API publique du client : un envoi automatise, sans aucun modele au bout. Le ranger sous « IA »
    // afficherait un cout d'IA la ou il n'y en a pas (migration 0166).
    expect(DETAIL_IA.api).toBeUndefined();
  });
});
