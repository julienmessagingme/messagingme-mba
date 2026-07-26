import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pgSsl } from '../src/db/ssl';

/**
 * Verrouille la PRIORITÉ de pgSsl (item 4.11), qui est ce qui rend le rollback sûr : DB_SSL=off > CA_FILE >
 * INSECURE > trust store. Poser CA_FILE active la vérif complète MÊME si INSECURE reste présent (donc retirer
 * CA_FILE fait retomber sur INSECURE = rollback en une ligne).
 */
const KEYS = ['DB_SSL', 'DB_SSL_CA_FILE', 'DB_SSL_INSECURE'] as const;
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
