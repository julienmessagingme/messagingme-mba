import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';
import { TYPES_EVENEMENT } from '../src/inbox/evenements';
import { MIGRATION_DES_DEMANDES } from '../src/stats/performance.pg';

/**
 * 0194 : le journal d'une conversation date aussi le passage d'un robot à l'équipe (`escaladee`) et le retour à un
 * scénario (`rendue_scenario`), les deux bornes des demandes du Quantitatif > Performance. Elle RELÂCHE un CHECK,
 * donc passe AVANT le `up` : le code neuf écrit ces types dans la requête même de la bascule.
 * Ce que la base écrit vraiment : `tests/integration/conversation-evenements.integration.test.ts`, en CI.
 */
const lire = (chemin: string): string => readFileSync(new URL(chemin, import.meta.url), 'utf8');
const SQL = lire('../db/migrations/0194_evenements_demandes.sql');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const instructions = decouperInstructions(SQL)
  .map(sansCommentaires)
  .map((i) => i.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim())
  .filter((i) => i !== '');

describe('migration 0194', () => {
  it('🔴 le CHECK des types est la liste du code, dans le même ordre, moins ce que 0209 a ajouté', () => {
    // Un type que le code écrit et que la base refuse fait échouer la BASCULE elle-même (même requête) : une
    // escalade perdue, en 23514, pour une ligne de journal. Le CHECK EN VIGUEUR est celui de 0209, dont la parité
    // exacte est tenue par `tests/migration-0209.test.ts` ; ici, que 0194 en reste le préfixe (0209 n'a rien retiré).
    const pose = instructions.find((i) => i.includes('add constraint conversation_evenements_type_check'));
    expect(pose, 'la pose du CHECK est introuvable').toBeDefined();
    const types = [...(pose ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(types).toEqual(TYPES_EVENEMENT.filter((t) => t !== 'sortie_agent'));
  });

  it('🔴 elle retire le CHECK sous le nom que 0192 a posé, juste avant de reposer le sien, et rien d’autre', () => {
    // Un nom deviné à côté laisserait l'ancien CHECK en place ET ajouterait le neuf : `escaladee` serait refusé par
    // le premier, en silence jusqu'à la première escalade.
    expect(lire('../db/migrations/0192_conversation_evenements.sql')).toContain('constraint conversation_evenements_type_check check (type in (');
    // Le plafond d'attente du verrou vient en tête : placé après l'`alter`, il ne borne plus rien.
    expect(instructions).toHaveLength(3);
    expect(instructions[0]).toBe("set local lock_timeout = '5s'");
    expect(instructions[1]).toBe('alter table conversation_evenements drop constraint if exists conversation_evenements_type_check');
    expect(instructions[2]).toMatch(/^alter table conversation_evenements add constraint conversation_evenements_type_check check \(type in \(/);
  });

  it('⚠️ dans une transaction (aucune fenêtre sans CHECK), sans reprise, et sans accent grave', () => {
    expect(veutHorsTransaction(SQL)).toBe(false);
    expect(sansCommentaires(SQL)).not.toMatch(/\b(update|insert|delete)\b/i);
    expect(SQL).not.toContain('`');
  });

  it('🔴 l’écran lit la date d’application de CE fichier : les deux noms sont le même', () => {
    // « Mesuré depuis le ... » est la ligne de cette migration dans `schema_migrations`. Un nom qui divergerait
    // ferait lire une date absente, donc aucune borne : les demandes d'avant la mesure reviendraient, incomplètes.
    expect(existsSync(new URL(`../db/migrations/${MIGRATION_DES_DEMANDES}`, import.meta.url))).toBe(true);
    expect(MIGRATION_DES_DEMANDES).toBe('0194_evenements_demandes.sql');
  });
});
