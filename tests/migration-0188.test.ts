import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { BOUTON_PUB_DEFAUT } from '../src/meta/pubs-payloads';

/**
 * 0188 : le bouton choisi dans un brouillon de publicité.
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE : elle passe AVANT le déploiement, donc l'ANCIEN code doit y survivre. Il insère des
 * brouillons sans bouton : la colonne neuve doit avoir un défaut, et ce défaut doit être CELUI du code (le bouton
 * WhatsApp), sinon un brouillon écrit par l'ancien code se relirait sur un autre bouton. Et elle n'est qu'ADDITIVE.
 * Le schéma réel se relit en base juste après `migrate` ; ce test tient le texte.
 */
const sql = readFileSync(new URL('../db/migrations/0188_pubs_bouton.sql', import.meta.url), 'utf8');
/** Le SQL sans ses commentaires : un commentaire qui cite un mot ne doit pas passer pour une instruction. */
const code = sql.split(/\r?\n/).filter((l) => !l.trim().startsWith('--')).join('\n').replace(/\s+/g, ' ');

describe('migration 0188', () => {
  it('une colonne de texte, non nulle, dont le défaut est le bouton par défaut du CODE', () => {
    expect(code).toContain(
      `alter table pubs_brouillons add column if not exists bouton text not null default '${BOUTON_PUB_DEFAUT}';`,
    );
  });

  it('🔴 AUCUN CHECK sur la liste : elle vit dans le code, et une seconde copie en base dériverait', () => {
    // Un CHECK oublié lors d'une retouche de `BOUTONS_PUB` ferait échouer l'enregistrement d'un brouillon en 500.
    expect(code).not.toMatch(/check/i);
  });

  it('🔴 ADDITIVE : rien de ce qui existe ne bouge', () => {
    expect(code).not.toMatch(/drop |alter column|truncate|delete from|update /i);
  });

  it('⚠️ transactionnelle et sans accent grave dans le SQL', () => {
    expect(sql).not.toMatch(/--\s*migrate:\s*no-transaction/);
    expect(sql).not.toContain('`');
  });
});
