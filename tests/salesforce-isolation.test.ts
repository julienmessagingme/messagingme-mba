import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * 🔴 L'ISOLATION ET L'EXTRACTIBILITÉ DU SCHÉMA `salesforce`, lues dans le CODE (plan 2026-09-26, lot L1).
 *
 * La connexion passe par le pooler en rôle superuser, la RLS est contournée : `tenant_id = $1` est le SEUL
 * contrôle entre clients. Et le schéma doit pouvoir partir sur sa propre base : aucune requête du store ne nomme
 * une table de `public`, et aucun fichier hors de `src/salesforce/` ne nomme une table du schéma. Ce test tourne
 * partout et se mute en local, là où l'intégration ne tourne qu'en CI.
 */
const RACINE = resolve(__dirname, '..');

function requetes(fichier: string): string[] {
  const source = readFileSync(join(RACINE, fichier), 'utf8');
  return [...source.matchAll(/this\.pool\.query(?:<[^>]*>)?\(\s*(?:\/\/[^\n]*\n\s*)*`([\s\S]*?)`/g)].map((m) => m[1]!);
}

/**
 * Les tables qu'une requête nomme après from, join, into ou update. Le `do update set` d'un upsert n'en nomme
 * aucune, d'où l'exclusion ; un `is distinct from $2` non plus, et la forme exigée (lettre en tête) l'écarte.
 */
function tablesNommees(sql: string): string[] {
  return [...sql.matchAll(/\b(?:from|join|into)\s+([a-z_][a-z0-9_.]*)|(?<!\bdo\s)\bupdate\s+([a-z_][a-z0-9_.]*)/gi)]
    .map((m) => (m[1] ?? m[2])!.toLowerCase());
}

function fichiersTs(dossier: string): string[] {
  return readdirSync(dossier).flatMap((nom) => {
    const chemin = join(dossier, nom);
    return statSync(chemin).isDirectory() ? fichiersTs(chemin) : chemin.endsWith('.ts') ? [chemin] : [];
  });
}

describe('le store du connecteur Salesforce', () => {
  const rs = requetes('src/salesforce/store.pg.ts');

  it('le balayage voit toutes les requêtes', () => {
    // lire, commencerConnexion, confirmerConnexion, couper, supprimer, enregistrerReglages, noterQuota,
    // orgParIdentifiant, espacesConnectes. Moins, c'est qu'une requête échappe au balayage.
    expect(rs.length, 'une requête échappe au balayage : c’est le test qui est cassé').toBe(9);
  });

  it('🔴 EXTRACTIBLE : chaque table nommée est dans le schéma salesforce', () => {
    for (const r of rs) {
      const tables = tablesNommees(r);
      expect(tables.length, r).toBeGreaterThan(0);
      for (const t of tables) expect(t, r).toMatch(/^salesforce\./);
    }
  });

  it('🔴 deux lectures transverses seulement, celles qui sont nommées et justifiées', () => {
    const sansFiltre = rs.filter((r) => !/tenant_id = \$1/.test(r) && !/^\s*insert\b/i.test(r));
    expect(sansFiltre).toHaveLength(2);
    expect(sansFiltre.some((r) => /from salesforce\.orgs where org_id = \$1/.test(r))).toBe(true);
    expect(sansFiltre.some((r) => /select tenant_id from salesforce\.orgs where etat = 'connectee'/.test(r))).toBe(true);
  });

  it('🔴 l insertion porte l espace en premier paramètre', () => {
    const inserts = rs.filter((r) => /^\s*insert\b/i.test(r));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatch(/\(tenant_id, org_id,/);
  });
});

describe('le reste du code', () => {
  it('🔴 aucun fichier hors de src/salesforce/ ne nomme une table du schéma salesforce', () => {
    const dossierConnecteur = join(RACINE, 'src', 'salesforce');
    const fautifs = fichiersTs(join(RACINE, 'src'))
      .filter((f) => !f.startsWith(dossierConnecteur))
      .filter((f) => /\bsalesforce\.(orgs|fiches|echecs|campagnes|membres|envois|modeles_autorises|notifications_recues)\b/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(RACINE, f));
    expect(fautifs).toEqual([]);
  });
});
