import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * LA MIGRATION DU SOCLE SALESFORCE (plan 2026-09-26, lot L1), lue dans le FICHIER, pas recopiée.
 *
 * ⚠️ Elle ne se vérifie en base que dans le job `integration` de la CI, et en production juste après `migrate`.
 * Ce test-ci garde ce que le fichier doit dire, sans base : surtout ce qui rend le schéma EXTRACTIBLE vers sa
 * propre base (aucune clé étrangère vers `public`, aucun `search_path`, des noms toujours qualifiés).
 */
const DOSSIER = resolve(__dirname, '..', 'db', 'migrations');
const fichiers = readdirSync(DOSSIER).filter((f) => /^\d{4}_salesforce_socle\.sql$/.test(f));
const sql = fichiers.length === 1 ? readFileSync(join(DOSSIER, fichiers[0]!), 'utf8') : '';
/** Le SQL sans ses commentaires, pour ne pas prendre un mot de l'en-tête pour une instruction. */
const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

describe('la migration du socle Salesforce', () => {
  it('existe, une seule fois', () => {
    expect(fichiers).toHaveLength(1);
  });

  it('crée le schéma et la table des orgs, qualifiée', () => {
    expect(code).toMatch(/create schema if not exists salesforce;/);
    expect(code).toMatch(/create table if not exists salesforce\.orgs \(/);
  });

  it('une org, un espace, dans les deux sens ; l identifiant d org a 18 caractères', () => {
    expect(code).toMatch(/tenant_id\s+uuid primary key,/);
    expect(code).toMatch(/org_id\s+text not null unique check \(org_id ~ '\^00D\[0-9A-Za-z\]\{15\}\$'\)/);
  });

  it('les quatre états, et une org connectée porte toujours un secret', () => {
    expect(code).toMatch(/check \(etat in \('connexion', 'connectee', 'en_pause', 'coupee'\)\)/);
    expect(code).toMatch(/check \(etat <> 'connectee' or secret_entrant_chiffre is not null\)/);
  });

  it('le résumé est DÉCOCHÉ par défaut (propos du client)', () => {
    expect(code).toMatch(/envoyer_resume\s+boolean not null default false/);
  });

  it('l interrupteur d espace vit dans le coeur, faux par défaut, comme hubspot_actif', () => {
    expect(code).toMatch(/alter table tenant_settings add column if not exists salesforce_actif boolean not null default false;/);
  });

  it('🔴 EXTRACTIBLE : aucune clé étrangère, aucun search_path', () => {
    expect(code).not.toMatch(/references/i);
    expect(code).not.toMatch(/search_path/i);
  });

  it('🔴 toute table créée ou modifiée dans le schéma est QUALIFIÉE', () => {
    const tables = [...code.matchAll(/create table if not exists ([a-z_.]+)/g)].map((m) => m[1]);
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) expect(t).toMatch(/^salesforce\./);
  });

  it('les rôles de l API de données de Supabase ne reçoivent rien, et la garde tient sur une base sans eux', () => {
    expect(code).toMatch(/revoke all on schema salesforce from %I/);
    expect(code).toMatch(/if exists \(select 1 from pg_roles where rolname = r\)/);
  });

  it('🔴 elle est additive : aucune table ni colonne ne disparaît, donc elle passe AVANT le déploiement', () => {
    expect(code).not.toMatch(/drop\s+(table|column|schema)/i);
  });

  it('🔴 aucun accent grave dans le fichier (ils ferment le gabarit de chaîne des outils qui le relisent)', () => {
    expect(sql).not.toContain('`');
  });
});
