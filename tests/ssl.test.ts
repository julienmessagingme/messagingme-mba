import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PeerCertificate } from 'node:tls';
import { pgSsl, type PgSslConfig } from '../src/db/ssl';

/**
 * Verrouille la PRIORITÉ de pgSsl (item 4.11), qui est ce qui rend le rollback sûr : DB_SSL=off > CA_FILE >
 * INSECURE > trust store. Poser CA_FILE active la vérif complète MÊME si INSECURE reste présent (donc retirer
 * CA_FILE fait retomber sur INSECURE = rollback en une ligne).
 */
const KEYS = ['DB_SSL', 'DB_SSL_CA_FILE', 'DB_SSL_INSECURE', 'DATABASE_URL'] as const;
let saved: Record<string, string | undefined>;
let dir: string;
let caPath: string;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  dir = mkdtempSync(join(tmpdir(), 'ssl-test-'));
  caPath = join(dir, 'ca.crt');
  writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----\n');
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(dir, { recursive: true, force: true });
});

describe('pgSsl (priorité SSL Postgres)', () => {
  it('DB_SSL=off -> false (Postgres local sans TLS)', () => {
    process.env['DB_SSL'] = 'off';
    process.env['DB_SSL_CA_FILE'] = caPath; // ignoré : off gagne
    expect(pgSsl()).toBe(false);
  });

  it('DB_SSL_CA_FILE posé -> vérif complète { rejectUnauthorized:true, ca }', () => {
    process.env['DB_SSL_CA_FILE'] = caPath;
    const r = pgSsl();
    expect(r).toMatchObject({ rejectUnauthorized: true });
    expect((r as { ca: string }).ca).toContain('BEGIN CERTIFICATE');
  });

  it('CA_FILE ET INSECURE ensemble -> CA_FILE gagne (rollback sûr : retirer CA_FILE retombe sur INSECURE)', () => {
    process.env['DB_SSL_CA_FILE'] = caPath;
    process.env['DB_SSL_INSECURE'] = 'true';
    expect(pgSsl()).toMatchObject({ rejectUnauthorized: true });
  });

  it('DB_SSL_INSECURE=true seul -> { rejectUnauthorized:false } (chiffré, non vérifié)', () => {
    process.env['DB_SSL_INSECURE'] = 'true';
    expect(pgSsl()).toEqual({ rejectUnauthorized: false });
  });

  it('rien -> vérif via trust store système { rejectUnauthorized:true }', () => {
    expect(pgSsl()).toEqual({ rejectUnauthorized: true });
  });

  it('CA_FILE vers un fichier absent -> throw qui NOMME DB_SSL_CA_FILE (pas d\'ENOENT opaque)', () => {
    process.env['DB_SSL_CA_FILE'] = join(dir, 'nexiste-pas.crt');
    expect(() => pgSsl()).toThrow(/DB_SSL_CA_FILE/);
  });
});

/**
 * 🔴 Une base jointe par son ADRESSE IP (Scaleway, sur le réseau privé) : node-postgres ne transmet pas l'hôte au
 * contrôle TLS, et Node comparait le certificat à « localhost » (ERR_TLS_CERT_ALTNAME_INVALID au premier déploiement
 * d'essai, le 2026-10-14). Les certificats ci-dessous ont la forme de celui de la base d'essai (`certs/`).
 */
describe('pgSsl, base jointe par son adresse IP', () => {
  const certificat = (san: string) => ({ subject: { CN: 'x' }, subjectaltname: san }) as unknown as PeerCertificate;
  const scaleway = certificat('DNS:172.16.0.3, IP Address:51.158.243.158, IP Address:172.16.0.3');

  it('🔴 le certificat se vérifie contre l’ADRESSE de la base, pas contre « localhost »', () => {
    process.env['DB_SSL_CA_FILE'] = caPath;
    process.env['DATABASE_URL'] = 'postgres://u:p@172.16.0.3:5432/rdb';
    const r = pgSsl() as PgSslConfig;
    expect(r.rejectUnauthorized).toBe(true);
    // La fonction doit EXISTER : sans elle, l'appel optionnel ci-dessous rendrait undefined, l'etat attendu.
    expect(r.checkServerIdentity).toBeTypeOf('function');
    // Node passe « localhost » faute d'hôte : le contrôle doit l'ignorer et juger l'adresse réelle.
    expect(r.checkServerIdentity?.('localhost', scaleway)).toBeUndefined();
  });

  it('🔴 rien n’est relâché : un certificat qui ne porte pas cette adresse est refusé', () => {
    process.env['DB_SSL_CA_FILE'] = caPath;
    process.env['DATABASE_URL'] = 'postgres://u:p@172.16.0.3:5432/rdb';
    const r = pgSsl() as PgSslConfig;
    expect(r.checkServerIdentity?.('localhost', certificat('IP Address:172.16.0.9'))).toBeInstanceOf(Error);
    expect(r.checkServerIdentity?.('localhost', certificat('DNS:localhost'))).toBeInstanceOf(Error);
  });

  it('l’adresse passée par l’appelant prime sur DATABASE_URL', () => {
    process.env['DB_SSL_CA_FILE'] = caPath;
    process.env['DATABASE_URL'] = 'postgres://u:p@172.16.0.3:5432/rdb';
    const r = pgSsl('postgres://u:p@10.1.2.3:5432/autre') as PgSslConfig;
    expect(r.checkServerIdentity?.('localhost', certificat('IP Address:10.1.2.3'))).toBeUndefined();
    expect(r.checkServerIdentity?.('localhost', scaleway)).toBeInstanceOf(Error);
  });

  it('un hôte NOMMÉ (Supabase) garde le contrôle par défaut de Node', () => {
    process.env['DB_SSL_CA_FILE'] = caPath;
    process.env['DATABASE_URL'] = 'postgres://u:p@aws-1-eu-west-2.pooler.supabase.com:6543/postgres';
    expect(pgSsl()).not.toHaveProperty('checkServerIdentity');
  });
});
