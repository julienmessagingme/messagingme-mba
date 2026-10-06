import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CAUSE_AMORCAGE, TYPES_EVENEMENT } from '../src/inbox/evenements';

/**
 * 0192 : le journal des événements d'une conversation (panneau Détail de l'Inbox). Elle passe AVANT le `up` : le
 * code neuf l'écrit sur le chemin de chaque message entrant. Ce qui se vérifie sans base : sa forme, la parité de
 * son CHECK avec le code, et que l'amorçage n'invente rien (une date par ligne, prise dans sa propre colonne).
 * Son exécution réelle (l'amorçage sur de vraies lignes) : `tests/integration/conversation-evenements.integration.test.ts`.
 */
const sql = readFileSync(new URL('../db/migrations/0192_conversation_evenements.sql', import.meta.url), 'utf8');
const code = sql.split(/\r?\n/).filter((l) => !l.trim().startsWith('--')).join('\n').replace(/\s+/g, ' ');

describe('migration 0192', () => {
  it('une table neuve, qui part avec sa conversation et avec son espace', () => {
    expect(code).toContain('create table if not exists conversation_evenements (');
    expect(code).toContain('conversation_id uuid not null references conversations (id) on delete cascade');
    expect(code).toContain('tenant_id uuid not null references tenants (id) on delete cascade');
  });

  it('🔴 un collaborateur supprimé ne supprime pas l’historique : set null, pas cascade', () => {
    // Une cascade effacerait la trace de ce qu'un collaborateur a fait le jour de son départ ; un restrict
    // bloquerait la suppression d'un compte sur une ligne de journal.
    expect(code).toContain('acteur_id uuid references users (id) on delete set null');
    expect(code).toContain('cible_id uuid references users (id) on delete set null');
  });

  it('🔴 le CHECK des types est la liste du code, dans le même ordre, moins ce que 0194, 0209 et 0216 ont ajouté', () => {
    // Le CHECK EN VIGUEUR est celui de 0216, qui reprend ceux de 0194 et 0209 et l'élargit : sa parité exacte avec le
    // code est tenue par `tests/migration-0216.test.ts`. Ici, que 0192 en reste le préfixe (rien n'a été retiré).
    const m = /check \(type in \(([^)]*)\)\)/.exec(code);
    expect(m, 'le CHECK des types est introuvable').not.toBeNull();
    const types = [...(m?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    expect(types).toEqual(TYPES_EVENEMENT.filter((t) => !['escaladee', 'rendue_scenario', 'sortie_agent', 'urgente', 'urgence_levee'].includes(t)));
  });

  it('l’index sert la seule lecture : une conversation, du plus récent au plus ancien', () => {
    expect(code).toContain('create index if not exists conversation_evenements_conv_idx on conversation_evenements (conversation_id, at desc, id desc);');
  });

  it('🔴 l’amorçage porte la cause du code, et chaque ligne a SA date, jamais inventée', () => {
    const insert = code.slice(code.indexOf('insert into conversation_evenements'));
    // Cinq faits, cinq branches.
    const branches = insert.split(' union all ');
    expect(branches).toHaveLength(5);
    for (const b of branches) expect(b).toContain(`'${CAUSE_AMORCAGE}'`);
    // Pas de date, pas de ligne : la colonne datée de chaque branche est dans son `where`.
    const dateeDans = (type: string, colonne: string): void => {
      const b = branches.find((x) => x.includes(`'${type}'`));
      expect(b, `branche ${type}`).toBeDefined();
      expect(b).toContain(`'${CAUSE_AMORCAGE}', c.${colonne}`);
      expect(b).toContain(`c.${colonne} is not null`);
    };
    dateeDans('assignee', 'assigned_at');
    dateeDans('traitee', 'traitee_le');
    dateeDans('archivee', 'archived_at');
    dateeDans('signalee', 'signalee_le');
    dateeDans('prise_mba', 'control_changed_at');
    // Le fil n'est amorcé que s'il est tenu par l'équipe : un détenteur robot n'est pas un fait à raconter.
    expect(branches.find((x) => x.includes("'prise_mba'"))).toContain("c.control_owner = 'app_human'");
    expect(insert).not.toContain('now()');
  });

  it('⚠️ transactionnelle, sans CONCURRENTLY, et sans accent grave dans le SQL', () => {
    // L'index porte sur une table NEUVE, vide : CONCURRENTLY ne construirait rien et retirerait le filet.
    expect(sql).not.toMatch(/--\s*migrate:\s*no-transaction/);
    expect(code).not.toMatch(/concurrently/i);
    expect(sql).not.toContain('`');
  });
});
