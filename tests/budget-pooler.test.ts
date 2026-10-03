import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { schema } from '../src/config';
import { ECRITURES_EN_VOL } from '../src/api/contacts-upsert';

/**
 * LE BUDGET DE CONNEXIONS DE TOUS LES PROCESSUS, TENU ICI ET NULLE PART AILLEURS (2026-10-03).
 *
 * 🔴 CE QUI MORD, C'EST LE POOL DU POOLER, PAS POSTGRES. Chaque processus ouvre son propre pool applicatif
 * (`DB_POOL_MAX`, mode transaction) ; le pooler de Supabase (Supavisor) ne tient, lui, que « Pool Size »
 * connexions vers Postgres pour notre utilisateur, par mode. Au-delà, rien n'échoue : les requêtes attendent
 * chez Supavisor, sans trace, et la latence double. Mesuré le 2026-10-03 avec le réglage à 15 : 16 connexions,
 * quand les pools de l'application en promettaient déjà 19, et celui de l'API saturait 6 % de ses prises de
 * connexion. D'où ce test : la SOMME des pools déclarés dans `docker-compose.yml` ne dépasse pas le pool, et
 * ajouter une copie d'API (un service de plus, sous n'importe quelle forme) le fait échouer tant qu'on n'a pas
 * redimensionné.
 *
 * ⚠️ LA MESURE (à refaire après tout changement du réglage, avant de changer `POOL_SUPAVISOR`) : depuis le
 * conteneur de l'API, N requêtes `select pg_sleep(1)` simultanées sur `APP_DATABASE_URL`, N au-dessus du pool
 * supposé ; le nombre qui finit dans la PREMIÈRE vague est la taille du pool. Elle fait patienter le trafic réel
 * une seconde au plus, sans erreur. ⚠️ Elle voit le réglage PLUS UN, constaté deux fois le 2026-10-03 (16 pour 15,
 * 31 pour 30) : la constante ci-dessous garde le RÉGLAGE, la valeur prudente.
 */

/** « Pool Size » du pooler de Supabase, par utilisateur, base et mode : le MÊME réglage borne le mode transaction
 *  (les pools applicatifs) et le mode session (pg-boss). Monté de 15 à 30 par Julien le 2026-10-03, et MESURÉ
 *  juste après (31 dans la première vague, contre 16 avant). */
const POOL_SUPAVISOR = 30;
/** Les connexions maximales de Postgres pour la taille de base actuelle (Micro), lues dans `pg_settings`. */
const MAX_CONNECTIONS_POSTGRES = 60;
/** La règle de Supabase : au plus 80 % des connexions au pooler quand PostgREST n'est pas le gros consommateur
 *  (c'est notre cas : un seul client PostgREST). Le reste sert à l'authentification et aux outils de Supabase. */
const PART_DU_POOLER = 0.8;
/** Ce que Supabase tient lui-même hors du pooler : PostgREST, l'exportateur, l'administration, deux auth_query.
 *  Lu dans `pg_stat_activity` le 2026-10-03. */
const RESERVE_SUPABASE = 5;
/** Les sessions de mm-hubspot, qui partage la base, l'utilisateur et le mode session : deux processus (API et
 *  worker), chacun avec son pool applicatif (`DB_POOL_MAX` 2) ET le pool de son pg-boss (`PGBOSS_MAX` 2), tous
 *  deux sur `DATABASE_URL`, sans écoute des notifications (`useListenNotify` non posé). Défauts de son
 *  `src/config.ts`, que son `.env.prod` ne change pas (vérifié le 2026-10-03). */
const SESSIONS_MM_HUBSPOT = 2 * (2 + 2);
/** Ce qui peut encore prendre une connexion du mode transaction en plus de nos processus : une sonde, un script
 *  ponctuel. Le mode transaction ne s'ouvre qu'à la demande : son pire cas est notre somme, pas le réglage. */
const AUTRES_CLIENTS_TRANSACTION = 2;
/** Les services sans base de données : la console Next.js, qui ne parle qu'à l'API. Tout AUTRE service compte. */
const SERVICES_SANS_BASE = ['mba-web'];

interface Service { nom: string; worker: boolean; poolMax: number | null; pgbossMax: number | null }

/**
 * TOUS les services de `docker-compose.yml`, sauf ceux de `SERVICES_SANS_BASE` : peu importe qu'une copie soit
 * déclarée par `build`, `image` ou `extends`, elle compte. Un worker se reconnaît à son rôle (`WORKER_ROLE`) ou à
 * sa commande ; tout le reste est une copie d'API.
 */
function servicesDuCompose(): Service[] {
  const lignes = readFileSync(resolve(__dirname, '..', 'docker-compose.yml'), 'utf8').split(/\r?\n/);
  const blocs: { nom: string; lignes: string[] }[] = [];
  let dansServices = false;
  for (const l of lignes) {
    if (/^\S/.test(l)) { dansServices = /^services:\s*$/.test(l); continue; }
    if (!dansServices) continue;
    const debut = /^ {2}([a-z0-9-]+):\s*$/.exec(l);
    if (debut) blocs.push({ nom: debut[1]!, lignes: [] });
    else if (blocs.length > 0) blocs[blocs.length - 1]!.lignes.push(l);
  }
  const valeur = (b: string[], cle: string): number | null => {
    const m = b.map((l) => new RegExp(`^\\s+${cle}:\\s*"?(\\d+)"?\\s*$`).exec(l)).find((x) => x !== null);
    return m ? Number(m[1]) : null;
  };
  const code = (b: string[]): string[] => b.filter((l) => !/^\s*#/.test(l));
  return blocs
    .filter((b) => !SERVICES_SANS_BASE.includes(b.nom))
    .map((b) => ({
      nom: b.nom,
      worker: code(b.lignes).some((l) => /^\s+WORKER_ROLE:/.test(l) || /^\s+command:.*worker/.test(l)),
      poolMax: valeur(b.lignes, 'DB_POOL_MAX'),
      pgbossMax: valeur(b.lignes, 'PGBOSS_MAX'),
    }));
}

const LOURDES_DEFAUT = schema.shape.API_MAX_LOURDES_SIMULTANEES.parse(undefined);

describe('le budget de connexions des processus', () => {
  const services = servicesDuCompose();
  // Chaque worker tient PGBOSS_MAX sessions plus une pour l'écoute des notifications ; l'API n'en ouvre aucune
  // (elle prête son pool applicatif à pg-boss), tant que `APP_DATABASE_URL` est posée.
  const sessions = services.filter((s) => s.worker).reduce((n, s) => n + (s.pgbossMax ?? 0) + 1, 0) + SESSIONS_MM_HUBSPOT;
  const sommePools = services.reduce((n, s) => n + (s.poolMax ?? 0), 0);

  it('la lecture du compose trouve l’API et les deux workers, et rien d’autre n’échappe au compte', () => {
    expect(services.map((s) => s.nom).sort()).toEqual(expect.arrayContaining(['mba-api', 'mba-worker', 'mba-worker-analyse']));
    expect(services.filter((s) => !s.worker).map((s) => s.nom)).toContain('mba-api');
    expect(services.filter((s) => s.worker).map((s) => s.nom).sort()).toEqual(expect.arrayContaining(['mba-worker', 'mba-worker-analyse']));
  });

  it('🔴 chaque processus déclare la taille de son pool, et chaque worker celle de son pg-boss', () => {
    // Un service sans valeur prendrait le défaut de la configuration sans que personne l'ait décidé pour lui, et
    // une valeur posée dans `.env.prod` échapperait à ce test.
    for (const s of services) expect(s.poolMax, `${s.nom} sans DB_POOL_MAX`).not.toBeNull();
    for (const s of services.filter((x) => x.worker)) expect(s.pgbossMax, `${s.nom} sans PGBOSS_MAX`).not.toBeNull();
  });

  it('🔴 la somme des pools tient dans le pool du pooler, sinon l’attente part chez Supavisor, muette', () => {
    const detail = services.map((s) => `${s.nom} ${s.poolMax}`).join(', ');
    expect(sommePools, `${detail} = ${sommePools} pour un pool de ${POOL_SUPAVISOR}`).toBeLessThanOrEqual(POOL_SUPAVISOR);
  });

  it('🔴 les sessions tiennent aussi : le même réglage borne le mode session', () => {
    expect(sessions, `${sessions} sessions (workers et mm-hubspot) pour ${POOL_SUPAVISOR}`).toBeLessThanOrEqual(POOL_SUPAVISOR);
  });

  it('🔴 le pire cas tient dans la part de Postgres que Supabase laisse au pooler', () => {
    // Les deux modes ne s'ouvrent qu'à la demande : leur pire cas est la demande déclarée (bornée par le réglage),
    // plus ce que Supabase tient lui-même. C'est ce qui borne le réglage qu'on peut monter.
    const transaction = Math.min(POOL_SUPAVISOR, sommePools + AUTRES_CLIENTS_TRANSACTION);
    const total = transaction + Math.min(POOL_SUPAVISOR, sessions) + RESERVE_SUPABASE;
    expect(total, `${transaction} (transaction) + ${sessions} (sessions) + ${RESERVE_SUPABASE} (Supabase)`)
      .toBeLessThanOrEqual(Math.floor(MAX_CONNECTIONS_POSTGRES * PART_DU_POOLER));
  });

  it('🔴 chaque copie d’API garde de quoi servir la console et les webhooks pendant ses opérations lourdes', () => {
    // Un lot prend jusqu'à ECRITURES_EN_VOL connexions, et API_MAX_LOURDES_SIMULTANEES lots tournent à la fois :
    // le pool d'une copie doit rester PLUS grand, sinon l'accusé d'un webhook de Meta attend un intégrateur.
    for (const s of services.filter((x) => !x.worker)) {
      expect(s.poolMax ?? 0, s.nom).toBeGreaterThan(ECRITURES_EN_VOL * LOURDES_DEFAUT);
    }
  });
});
