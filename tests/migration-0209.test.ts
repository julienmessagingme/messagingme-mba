import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';
import { TYPES_EVENEMENT } from '../src/inbox/evenements';
import { SYSTEMES_SCENARIO } from '../src/workflow/store.pg';

/**
 * 0209 : le répondeur par défaut (lot 5). Elle AJOUTE (le réglage, le drapeau du scénario système, la table des
 * alertes) et RELÂCHE (le CHECK des types d'événements), donc elle passe AVANT le `up` : le magasin des scénarios
 * filtre sur `workflows.systeme` dans chaque lecture, et le code neuf écrit `sortie_agent`.
 * Ce que la base en fait vraiment (les deux ordres du CHECK d'une seule voix, la clé étrangère, l'index partiel) :
 * `tests/integration/repondeur.integration.test.ts`, en CI.
 */
const lire = (chemin: string): string => readFileSync(new URL(chemin, import.meta.url), 'utf8');
const SQL = lire('../db/migrations/0209_repondeur.sql');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const instructions = decouperInstructions(SQL)
  .map(sansCommentaires)
  .map((i) => i.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim())
  .filter((i) => i !== '');

describe('migration 0209', () => {
  it('🔴 le plafond d’attente du verrou vient en tête : placé après un `alter`, il ne borne plus rien', () => {
    expect(instructions[0]).toBe("set local lock_timeout = '5s'");
    // Dans une transaction : le drop et l'add de chaque CHECK ne laissent aucune fenêtre sans contrôle.
    expect(veutHorsTransaction(SQL)).toBe(false);
  });

  it('🔴 le réglage : un uuid nullable SANS défaut, clé étrangère vers l’agent en `on delete set null`', () => {
    // Une cascade supprimerait la ligne de réglages de l'espace avec l'agent ; un `restrict` ferait échouer la
    // suppression d'un agent (un 500 sur un geste ordinaire).
    expect(instructions).toContain(
      'alter table tenant_settings add column if not exists repondeur_agent_id uuid constraint tenant_settings_repondeur_agent_fk references agents (id) on delete set null',
    );
  });

  it('🔴 une seule voix, tenue par la base : le CHECK porte la règle exacte, sous son nom', () => {
    const i = instructions.indexOf('alter table tenant_settings drop constraint if exists tenant_settings_repondeur_une_voix_chk');
    expect(i, 'le retrait sous le même nom précède la pose : la migration se rejoue sans lever').toBeGreaterThan(-1);
    expect(instructions[i + 1]).toBe(
      'alter table tenant_settings add constraint tenant_settings_repondeur_une_voix_chk check (repondeur_agent_id is null or mba_enabled = false)',
    );
  });

  it('🔴 le scénario système : une valeur fermée, celle du code, et UNE ligne par espace (index unique partiel)', () => {
    const pose = instructions.find((x) => x.startsWith('alter table workflows add constraint workflows_systeme_chk'));
    expect(pose).toBeDefined();
    const valeurs = [...(pose ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(valeurs).toEqual([...SYSTEMES_SCENARIO]);
    expect(instructions).toContain('alter table workflows add column if not exists systeme text');
    // Le prédicat est celui de `assurerScenarioSysteme` (`on conflict (tenant_id) where systeme = 'repondeur'`) :
    // un prédicat différent ferait lever le `on conflict` (aucun index ne correspond), donc chaque démarrage.
    expect(instructions).toContain("create unique index if not exists workflows_systeme_uidx on workflows (tenant_id) where systeme = 'repondeur'");
    const magasin = lire('../src/workflow/store.pg.ts');
    expect(magasin).toContain("on conflict (tenant_id) where systeme = 'repondeur'");
  });

  it('🔴 le CHECK des types est la liste du code, sous le nom que 0192 a posé, moins ce que 0216 a ajouté', () => {
    // Un type que le code écrit et que la base refuse fait échouer l'écriture qui le porte, en 23514. Le CHECK EN
    // VIGUEUR est celui de 0216, dont la parité exacte est tenue par `tests/migration-0216.test.ts` ; ici, que 0209 en
    // reste le préfixe (0216 n'a rien retiré).
    const i = instructions.indexOf('alter table conversation_evenements drop constraint if exists conversation_evenements_type_check');
    expect(i).toBeGreaterThan(-1);
    const pose = instructions[i + 1] ?? '';
    expect(pose).toMatch(/^alter table conversation_evenements add constraint conversation_evenements_type_check check \(type in \(/);
    const types = [...pose.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(types).toEqual(TYPES_EVENEMENT.filter((t) => t !== 'urgente' && t !== 'urgence_levee'));
  });

  it('la table des alertes : une ligne par espace et par jour, la clé primaire EST la garde du « une par jour »', () => {
    const table = instructions.find((x) => x.startsWith('create table if not exists repondeur_alertes_credit'));
    expect(table).toBe(
      'create table if not exists repondeur_alertes_credit ( tenant_id uuid not null references tenants (id) on delete cascade, jour date not null, primary key (tenant_id, jour) )',
    );
  });

  it('⚠️ additive : aucune reprise, aucune suppression de donnée, et sans accent grave', () => {
    const code = sansCommentaires(SQL);
    // En tête d'instruction : `on delete set null` d'une clé étrangère n'est pas une suppression.
    expect(code).not.toMatch(/^\s*(update|insert|delete|truncate)\b/im);
    expect(code).not.toMatch(/\bdrop (table|column|index)\b/i);
    expect(SQL).not.toContain('`');
  });
});
