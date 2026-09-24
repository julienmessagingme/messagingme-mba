import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * LA MIGRATION DES SIGNAUX (spec 2026-09-24, § 8 et § 11), lue dans le FICHIER, pas recopiée.
 *
 * ⚠️ Elle ne se vérifie en base que dans le job `integration` de la CI (`tests/integration/signaux.integration.test.ts`),
 * et en production juste après `migrate`. Ce test-ci garde ce que le fichier doit dire, sans base.
 */
const DOSSIER = resolve(__dirname, '..', 'db', 'migrations');
const fichiers = readdirSync(DOSSIER).filter((f) => /^\d{4}_signaux_batch\.sql$/.test(f));
const sql = fichiers.length === 1 ? readFileSync(join(DOSSIER, fichiers[0]!), 'utf8') : '';

describe('la migration des signaux', () => {
  it('existe, une seule fois', () => {
    expect(fichiers).toHaveLength(1);
  });

  it('crée le réglage : clés chiffrées, résumé DÉCOCHÉ par défaut, compteur et suspension', () => {
    expect(sql).toMatch(/create table if not exists integration_batch/);
    expect(sql).toMatch(/tenant_id\s+uuid primary key references tenants\(id\) on delete cascade/);
    expect(sql).toMatch(/cle_rest_chiffree\s+text not null/);
    expect(sql).toMatch(/cle_projet_chiffree\s+text not null/);
    expect(sql).toMatch(/envoyer_resume\s+boolean not null default false/);
    expect(sql).toMatch(/sans_identifiant\s+bigint not null default 0/);
    expect(sql).toMatch(/refus_cles_le\s+timestamptz/);
  });

  it('🔴 elle est additive : aucune table ni colonne ne disparaît, donc elle passe AVANT le déploiement', () => {
    expect(sql).not.toMatch(/drop\s+(table|column)/i);
  });

  it('🔴 aucun accent grave dans le fichier (ils ferment le gabarit de chaîne des outils qui le relisent)', () => {
    expect(sql).not.toContain('`');
  });
});
