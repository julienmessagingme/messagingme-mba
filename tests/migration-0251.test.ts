import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';

/**
 * 0251 : le choix des fonctions HubSpot (lot 1bis). Les espaces existants gardent exactement leur comportement : les
 * trois poussées restent allumées, et l'étape de choix ne s'impose qu'aux espaces où HubSpot ne sert pas encore.
 */
const lire = (chemin: string): string => readFileSync(new URL(chemin, import.meta.url), 'utf8');
const SQL = lire('../db/migrations/0251_hubspot_choix_des_fonctions.sql');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const instructions = decouperInstructions(SQL)
  .map(sansCommentaires)
  .map((i) => i.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim())
  .filter((i) => i !== '');

describe('migration 0251', () => {
  it('🔴 les défauts : les trois poussées ALLUMÉES (le comportement d’avant), la réponse depuis HubSpot ÉTEINTE', () => {
    expect(instructions.slice(0, 5)).toEqual([
      'alter table tenant_settings add column if not exists hubspot_analyse boolean not null default true',
      'alter table tenant_settings add column if not exists hubspot_passage boolean not null default true',
      'alter table tenant_settings add column if not exists hubspot_injoignable boolean not null default true',
      'alter table tenant_settings add column if not exists hubspot_reponse boolean not null default false',
      'alter table tenant_settings add column if not exists hubspot_choix_valide_le timestamptz',
    ]);
  });

  it('🔴 la reprise date le choix des espaces où HubSpot sert VRAIMENT (un numéro synchronisé), sans jamais écraser une date posée', () => {
    expect(instructions).toHaveLength(6);
    const reprise = instructions[5]!;
    expect(reprise).not.toContain('hubspot_actif'); // l'ancien interrupteur d'affichage ne prouve pas que HubSpot sert
    expect(reprise).toContain('p.hubspot_connected');
    expect(reprise).toContain('coalesce(tenant_settings.hubspot_choix_valide_le, excluded.hubspot_choix_valide_le)');
    expect(reprise).not.toMatch(/mmhs\./); // le schéma du connecteur vit sur sa propre base depuis le 2026-10-15
  });

  it('se joue dans une transaction (aucune directive hors transaction)', () => {
    expect(veutHorsTransaction(SQL)).toBe(false);
  });
});
