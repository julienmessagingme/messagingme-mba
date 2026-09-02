import { describe, it, expect, afterEach } from 'vitest';
import { schema } from '../src/config';
import { poolOptions, maintenanceOptions, notifyOptions } from '../src/queue/pgboss';

/**
 * Gardes de démarrage (bloc 0 du PLAN.md). Ces règles BLOQUENT le boot : une erreur ici couche la production
 * au déploiement suivant. D'où des tests qui vérifient les deux sens, refus ET acceptation, et pas seulement
 * que « ça throw » : un fail-fast trop large est aussi dangereux qu'un fail-fast absent.
 *
 * On parse le SCHÉMA (et non `config`, figé à l'import) sur un environnement fabriqué.
 */

// Environnement de production MINIMAL et valide : le socle sur lequel on retire une variable à la fois.
const prodEnv = {
  DATABASE_URL: 'postgres://user:pass@host:5432/db',
  META_APP_SECRET: 'x'.repeat(32),
  AUTH_SECRET: 'y'.repeat(32),
};
const asProd = () => { process.env.NODE_ENV = 'production'; };
const errPaths = (r: { success: boolean; error?: { issues: Array<{ path: PropertyKey[] }> } }): string[] =>
  r.success ? [] : (r.error?.issues ?? []).map((i) => String(i.path[0]));

// RESTAURER la valeur d'entrée, ne pas la réécrire en dur : `src/config` parse à l'IMPORT, donc un
// NODE_ENV=production qui fuiterait vers un autre fichier de test le ferait échouer au chargement de module,
// avec un message qui ne pointerait pas ici. Isolé par le pool `forks` de vitest aujourd'hui, pas demain.
const originalNodeEnv = process.env.NODE_ENV;
afterEach(() => { process.env.NODE_ENV = originalNodeEnv; });

describe('gardes de config en production', () => {
  it('environnement complet -> accepté (le fail-fast ne bloque pas une prod valide)', () => {
    asProd();
    expect(schema.safeParse(prodEnv).success).toBe(true);
  });

  it('DATABASE_URL vide -> refusé, en nommant la variable', () => {
    asProd();
    const r = schema.safeParse({ ...prodEnv, DATABASE_URL: '' });
    expect(r.success).toBe(false);
    expect(errPaths(r)).toContain('DATABASE_URL');
  });

  it('META_APP_SECRET vide -> refusé (sinon 100 % des webhooks Meta partent en 403 en silence)', () => {
    asProd();
    const r = schema.safeParse({ ...prodEnv, META_APP_SECRET: '' });
    expect(r.success).toBe(false);
    expect(errPaths(r)).toContain('META_APP_SECRET');
  });

  it('hors production -> les deux gardes sont inertes (ergonomie du dev, aucune variable requise)', () => {
    process.env.NODE_ENV = 'test';
    expect(schema.safeParse({}).success).toBe(true);
  });

  it('les gardes préexistantes ne sont pas affaiblies : AUTH_SECRET faible reste refusé', () => {
    asProd();
    expect(schema.safeParse({ ...prodEnv, AUTH_SECRET: 'dev-insecure-change-me' }).success).toBe(false);
    expect(schema.safeParse({ ...prodEnv, AUTH_SECRET: 'court' }).success).toBe(false);
  });

  it('Zadarma : une seule moitié des identifiants -> refusé ; les deux ou aucune -> accepté', () => {
    // Une clé sans son secret signerait avec une chaîne vide, et Zadarma répondrait « 401 Not authorized »
    // qu'on mettrait sur le dos d'identifiants pourtant valides. Autant refuser au démarrage.
    asProd();
    expect(errPaths(schema.safeParse({ ...prodEnv, ZADARMA_API_KEY: 'k' }))).toContain('ZADARMA_API_SECRET');
    expect(errPaths(schema.safeParse({ ...prodEnv, ZADARMA_API_SECRET: 's' }))).toContain('ZADARMA_API_SECRET');
    expect(schema.safeParse({ ...prodEnv, ZADARMA_API_KEY: 'k', ZADARMA_API_SECRET: 's' }).success).toBe(true);
    expect(schema.safeParse(prodEnv).success).toBe(true); // aucune des deux : la capture est simplement inerte
  });

  it('🔴 la clé du Gateway SANS modèle d’agent -> refusée, en nommant les deux variables', () => {
    // Le piège exact qu'on ferait au déploiement : poser la clé, oublier les modèles. Le code retombe alors
    // sur `LLM_MODEL`, qui est l'identifiant de l'ANALYSE de conversation servie EN DIRECT par Anthropic
    // (`claude-haiku-4-5`), alors que le Gateway attend un identifiant préfixé (`zai/glm-4.7-flash`). Rien ne
    // le dirait à la création d'un agent : ça se verrait au premier vrai contact, en pleine conversation.
    asProd();
    const r = schema.safeParse({ ...prodEnv, AI_GATEWAY_API_KEY: 'vck_test' });
    expect(r.success).toBe(false);
    expect(errPaths(r)).toContain('AGENT_MODEL');
    expect(errPaths(r)).toContain('AGENT_SETUP_MODEL');
    // Une seule des deux ne suffit pas non plus.
    expect(errPaths(schema.safeParse({ ...prodEnv, AI_GATEWAY_API_KEY: 'vck_test', AGENT_MODEL: 'zai/glm-4.7-flash' }))).toContain('AGENT_SETUP_MODEL');
  });

  it('les deux modèles posés avec la clé -> accepté ; et SANS clé, rien n’est exigé', () => {
    // Le fail-fast doit rester borné : une instance qui n'a pas câblé l'agent (la plupart) ne doit pas être
    // obligée de déclarer des modèles qu'elle n'utilisera jamais.
    asProd();
    expect(schema.safeParse({ ...prodEnv, AI_GATEWAY_API_KEY: 'vck_test', AGENT_MODEL: 'zai/glm-4.7-flash', AGENT_SETUP_MODEL: 'zai/glm-4.7' }).success).toBe(true);
    expect(schema.safeParse(prodEnv).success).toBe(true);
  });
});

describe('budget de connexions Postgres', () => {
  it('les plafonds sont BORNÉS par défaut : sans eux, pg et pg-boss prennent 10 chacun (40 sessions pour ~15)', () => {
    const c = schema.parse({});
    // On n'assène pas la constante exacte (ça ne testerait que la relecture du littéral) : ce qui compte est
    // qu'un plafond existe, qu'il reste sous la contrainte RÉELLE, et que l'attente ne soit jamais illimitée.
    // ⚠️ Les deux plafonds ne répondent PAS à la même contrainte, ils avaient été bornés ensemble par erreur :
    //  - DB_POOL_MAX vit sur le pooler en mode TRANSACTION. Capacité mesurée : 16 clients, et le pool est
    //    instancié PAR PROCESS (API + worker), d'où 8 au plus. Au-delà, la file passe chez Supavisor où elle
    //    est muette, et DB_CONN_TIMEOUT_MS ne protège plus de rien.
    //  - PGBOSS_MAX vit, lui, dans le budget de ~15 SESSIONS partagé avec mm-hubspot : il doit rester petit.
    expect(c.DB_POOL_MAX).toBeGreaterThan(0);
    expect(c.DB_POOL_MAX).toBeLessThanOrEqual(8);
    expect(c.PGBOSS_MAX).toBeGreaterThan(0);
    expect(c.PGBOSS_MAX).toBeLessThan(8);
    // 0 = attente ILLIMITÉE : c'est précisément ce qui figeait l'API sans trace. Ne doit jamais être le défaut.
    expect(c.DB_CONN_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('surchargeables par l’environnement (coercition depuis des chaînes)', () => {
    const c = schema.parse({ DB_POOL_MAX: '5', PGBOSS_MAX: '4', DB_CONN_TIMEOUT_MS: '2000' });
    expect(c.DB_POOL_MAX).toBe(5);
    expect(c.PGBOSS_MAX).toBe(4);
    expect(c.DB_CONN_TIMEOUT_MS).toBe(2000);
  });
});

/**
 * `poolOptions` est le CÂBLAGE réel du plafond vers pg-boss. Le tester est ce qui distingue un vrai test d'un
 * faux témoin : sans ces cas, on pourrait revenir à `opts.max ? ...` ou retirer l'option sans rien casser.
 */
describe('poolOptions (options de pool passées à pg-boss)', () => {
  it('max: 0 est TRANSMIS : c’est une valeur explicite, pas une absence', () => {
    // Le piège que corrige `!== undefined` : `opts.max ? ...` rendrait `{}` ici, et pg-boss reprendrait
    // son défaut de 10 connexions alors que l'appelant en demandait zéro.
    expect(poolOptions({ max: 0 })).toEqual({ max: 0 });
  });

  it('une option ABSENTE reste absente (pg-boss applique son propre défaut, on ne le devine pas)', () => {
    expect(poolOptions({})).toEqual({});
    expect(poolOptions({ max: 2 })).toEqual({ max: 2 });
  });

  it('transmet les deux plafonds ensemble', () => {
    expect(poolOptions({ max: 2, connectionTimeoutMillis: 8000 })).toEqual({ max: 2, connectionTimeoutMillis: 8000 });
  });

  it('connectionTimeoutMillis: 0 est transmis tel quel (même piège que max)', () => {
    expect(poolOptions({ connectionTimeoutMillis: 0 })).toEqual({ connectionTimeoutMillis: 0 });
  });
});

/**
 * `maintenanceOptions` est le câblage qui a fermé la fuite d'egress du 2026-08-17 (deux instances pg-boss par
 * service, toutes deux en supervision, maintenance « flow » toutes les 5 s). Sans ces cas, retirer `supervise:
 * false` de l'API ou rebrancher le cron ne casserait rien et la facture repartirait en silence.
 */
describe('maintenanceOptions (bruit de l’instance pg-boss sur la base)', () => {
  it('coupe le cron pg-boss INCONDITIONNELLEMENT (aucun boss.schedule dans ce repo)', () => {
    expect(maintenanceOptions({})).toEqual({ schedule: false });
  });

  it('supervise: false est TRANSMIS (valeur explicite, même piège que max: 0)', () => {
    // `opts.supervise ? ...` rendrait `{schedule:false}` ici, et l'API se remettrait à superviser sans bruit.
    expect(maintenanceOptions({ supervise: false })).toEqual({ schedule: false, supervise: false });
  });

  it('une absence reste une absence (pg-boss garde son défaut : le worker supervise)', () => {
    expect(maintenanceOptions({})).not.toHaveProperty('supervise');
    expect(maintenanceOptions({ flowIntervalSeconds: 60 })).toEqual({ schedule: false, flowIntervalSeconds: 60 });
  });

  it('transmet les deux réglages ensemble', () => {
    expect(maintenanceOptions({ supervise: false, flowIntervalSeconds: 60 })).toEqual({
      schedule: false,
      supervise: false,
      flowIntervalSeconds: 60,
    });
  });
});

/**
 * `notifyOptions` est le câblage de l'écouteur LISTEN/NOTIFY, qui ouvre une connexion DÉDIÉE. Même piège que
 * les deux fonctions ci-dessus : `opts.ecouteNotifications ? ...` avalerait un `false` explicite, ce qui est
 * ici parfaitement bénin (pg-boss a le même défaut) mais deviendrait faux le jour où le défaut de pg-boss
 * change. On ne devine pas le défaut d'une dépendance, on le laisse s'appliquer.
 */
describe('notifyOptions (écouteur LISTEN/NOTIFY de l’instance)', () => {
  it('une absence reste une absence : pg-boss applique son propre défaut', () => {
    expect(notifyOptions({})).toEqual({});
    expect(notifyOptions({})).not.toHaveProperty('useListenNotify');
  });

  it('l’écoute demandée est TRANSMISE', () => {
    expect(notifyOptions({ ecouteNotifications: true })).toEqual({ useListenNotify: true });
  });

  it('un refus EXPLICITE est transmis tel quel (même piège que max: 0)', () => {
    expect(notifyOptions({ ecouteNotifications: false })).toEqual({ useListenNotify: false });
  });
});


describe('les deux chaînes de connexion désignent la MÊME base', () => {
  /**
   * 🔴 Cette garde vient d'un incident réel du 2026-09-02. Un banc de charge a été monté en surchargeant
   * `DATABASE_URL` vers une base jetable, mais `APP_DATABASE_URL` est resté sur la PRODUCTION par héritage du
   * fichier d'environnement. Le worker a donc tourné à cheval sur DEUX bases : ses files d'un côté, ses
   * balayages de l'autre. Aucun dégât ce jour-là, par chance : aucune campagne vivante à reprendre. Avec une
   * campagne en cours, le balayage de reprise l'aurait relancée en `DRY_RUN` et aurait marqué de VRAIS
   * destinataires comme envoyés, sans qu'aucun message ne parte.
   */
  it('🔴 des hôtes DIFFÉRENTS sont refusés, quel que soit l’environnement', () => {
    const r = schema.safeParse({
      DATABASE_URL: 'postgres://u:p@banc-pg:5432/banc',
      APP_DATABASE_URL: 'postgres://u:p@aws-1-eu-west-2.pooler.supabase.com:6543/postgres',
    });
    expect(errPaths(r)).toContain('APP_DATABASE_URL');
  });

  it('🔴 le même hôte sur des PORTS différents est ACCEPTÉ : c’est le montage de production', () => {
    // L'autre sens, et il compte autant : session en 5432, transaction en 6543. Une garde qui refuserait ça
    // empêcherait la production de démarrer, ce qui serait pire que le défaut qu'elle corrige.
    const r = schema.safeParse({
      DATABASE_URL: 'postgres://u:p@aws-1-eu-west-2.pooler.supabase.com:5432/postgres',
      APP_DATABASE_URL: 'postgres://u:p@aws-1-eu-west-2.pooler.supabase.com:6543/postgres',
    });
    expect(errPaths(r)).not.toContain('APP_DATABASE_URL');
  });

  it('`APP_DATABASE_URL` vide reste accepté : c’est le repli documenté sur DATABASE_URL', () => {
    const r = schema.safeParse({ DATABASE_URL: 'postgres://u:p@host:5432/db', APP_DATABASE_URL: '' });
    expect(errPaths(r)).not.toContain('APP_DATABASE_URL');
  });
});
