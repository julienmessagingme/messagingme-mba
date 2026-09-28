import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * 0187 : la vidéo et les audiences dans les brouillons de publicité.
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE : elle passe AVANT le déploiement, donc l'ANCIEN code doit y survivre. Il écrit des
 * brouillons sans vidéo ni audience : les colonnes neuves doivent être nullables ou avoir un défaut, et le CHECK
 * d'exclusivité ne doit rien refuser de ce qu'il écrit. Et elle n'est qu'ADDITIVE : rien de ce qui existe ne bouge.
 * Le schéma réel se relit en base juste après `migrate` ; ce test tient le texte, relu mot pour mot.
 */
const sql = readFileSync(new URL('../db/migrations/0187_pubs_video_audiences.sql', import.meta.url), 'utf8');
const compact = sql.replace(/\s+/g, ' ');
/** Le SQL sans ses commentaires : un commentaire qui cite un mot ne doit pas passer pour une instruction. */
const code = sql.split(/\r?\n/).filter((l) => !l.trim().startsWith('--')).join('\n').replace(/\s+/g, ' ');

describe('migration 0187', () => {
  it('garde l’IDENTIFIANT de la vidéo chez Meta, nullable et sans défaut, jamais ses octets', () => {
    expect(compact).toContain('alter table pubs_brouillons add column if not exists video_id text;');
    expect(code).not.toMatch(/video_[a-z]*\s+bytea/i);
  });

  it('les audiences, en tableaux de texte vides par défaut : l’ancien code qui ne les écrit pas reste valide', () => {
    expect(compact).toContain("add column if not exists audiences_incluses text[] not null default '{}';");
    expect(compact).toContain("add column if not exists audiences_exclues text[] not null default '{}';");
  });

  it('🔴 un seul visuel à la fois, et le CHECK ne refuse rien de ce que l’ancien code écrit', () => {
    // L'ancien code ne pose jamais `video_id` : `video_id is null` suffit à satisfaire la contrainte.
    expect(compact).toContain('add constraint pubs_brouillons_un_visuel_chk check (video_id is null or visuel_octets is null);');
    // Rejouable : la contrainte est retirée avant d'être posée.
    expect(code.indexOf('drop constraint if exists pubs_brouillons_un_visuel_chk'))
      .toBeLessThan(code.indexOf('add constraint pubs_brouillons_un_visuel_chk'));
  });

  it('🔴 ADDITIVE : aucune colonne retirée, aucun type changé, aucune contrainte existante touchée', () => {
    expect(code).not.toMatch(/drop column/i);
    expect(code).not.toMatch(/alter column/i);
    expect(code).not.toMatch(/pubs_brouillons_visuel_chk|pubs_brouillons_destination_chk/);
    expect(code).not.toMatch(/drop table|truncate|delete from|update /i);
  });

  it('⚠️ transactionnelle (pas de directive hors transaction) et sans accent grave dans le SQL', () => {
    expect(sql).not.toMatch(/--\s*migrate:\s*no-transaction/);
    expect(sql).not.toContain('`');
  });
});
