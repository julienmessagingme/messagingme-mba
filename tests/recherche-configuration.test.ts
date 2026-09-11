import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_RECHERCHE } from '../src/agent/knowledge';

/**
 * LA COLONNE ET LA REQUÊTE DOIVENT NOMMER LA MÊME CONFIGURATION, et rien d'autre ne le vérifie.
 *
 * 🔴 C'EST LE CAS D'ÉCOLE DES « DEUX CONSTANTES DE FICHIERS DIFFÉRENTS QUI DOIVENT RESTER ORDONNÉES ».
 * `corps_tsv` est calculée EN BASE par une colonne générée ; la requête est écrite en TypeScript. Chacune
 * est plausible seule. Leur désaccord ne produit AUCUNE erreur : ni le compilateur, ni Postgres, ni un test
 * d'intégration ne bronchent. La recherche rend simplement moins de résultats, ce qui se présente comme
 * « l'agent sait parfois, et parfois pas ». L'invariant n'est visible que d'ici.
 *
 * 🔴 ET LE DÉSACCORD A RÉELLEMENT COÛTÉ. Avant la migration 0132, les deux côtés s'accordaient sur `french`,
 * qui CONSERVE les accents : « prevoyance » ne rencontrait jamais « prévoyance », et une question tapée sans
 * accents ne trouvait rien de la moitié lexicale. Mesuré sur le corpus réel d'un client le 2026-09-11 :
 * zéro fiche contre trois.
 */

const DOSSIER = join(__dirname, '..', 'db', 'migrations');

/** Toutes les migrations, dans l'ordre où le runner les applique (par nom). */
function migrations(): Array<{ nom: string; sql: string }> {
  return readdirSync(DOSSIER)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((nom) => ({ nom, sql: readFileSync(join(DOSSIER, nom), 'utf8') }));
}

/**
 * La DERNIÈRE définition de `corps_tsv` pour chaque table : c'est elle qui décide, les précédentes ayant été
 * remplacées. Lire la première donnerait un verdict faux dès qu'une colonne est reconstruite, ce qui est
 * exactement ce que fait 0132.
 */
function definitionsFinales(): Map<string, { nom: string; config: string }> {
  const out = new Map<string, { nom: string; config: string }>();
  // `alter table X add column corps_tsv ... to_tsvector('config'::regconfig` ou la même chose dans un
  // `create table X (... corps_tsv ... to_tsvector('config'::regconfig`.
  for (const { nom, sql } of migrations()) {
    for (const m of sql.matchAll(/(?:create table(?: if not exists)?|alter table)\s+(\w+)/g)) {
      const table = m[1]!;
      // On ne regarde que la portion qui suit, jusqu'au prochain point-virgule : une instruction à la fois.
      const suite = sql.slice(m.index!, sql.indexOf(';', m.index!) + 1);
      const tsv = /corps_tsv[\s\S]*?to_tsvector\('([a-z_]+)'::regconfig/.exec(suite);
      if (tsv) out.set(table, { nom, config: tsv[1]! });
    }
  }
  return out;
}

describe('La configuration de recherche plein texte', () => {
  it('🔴 chaque colonne `corps_tsv` est générée avec CONFIG_RECHERCHE', () => {
    const defs = definitionsFinales();
    // Les deux corpus du dépôt. Le compte est asserté : un troisième corpus ajouté sans passer par ici
    // hériterait du défaut en silence, et c'est le scénario que ce test existe pour attraper.
    expect([...defs.keys()].sort()).toEqual(['agent_knowledge', 'aide_fiches']);
    for (const [table, d] of defs) {
      expect(d.config, `${table}, définie en dernier par ${d.nom}`).toBe(CONFIG_RECHERCHE);
    }
  });

  it('🔴 une migration CRÉE cette configuration, sinon toute recherche lèverait', () => {
    // Nommer une configuration qui n'existe pas ne rate pas à la compilation : ça rate à la première
    // question posée par un client, sur toutes les questions à la fois.
    const creation = migrations().filter((m) => m.sql.includes(`create text search configuration ${CONFIG_RECHERCHE}`));
    expect(creation.length, 'aucune migration ne crée la configuration').toBeGreaterThan(0);
    // Et le dictionnaire `unaccent` est bien celui qui la distingue de `french` : sans ce mot, elle serait
    // une copie de `french` sous un autre nom, donc le défaut d'origine avec l'air d'être corrigé.
    expect(creation.some((m) => /alter mapping[\s\S]*?with unaccent, french_stem/.test(m.sql))).toBe(true);
    expect(creation.some((m) => /create extension if not exists unaccent/.test(m.sql))).toBe(true);
  });

  it('🔴 aucun dépôt n’interroge plus « french » en dur', () => {
    // Recopier la configuration dans une requête est exactement ce qui la fait diverger de la colonne.
    for (const f of ['src/agent/knowledge.pg.ts', 'src/aide/fiches.pg.ts']) {
      const src = readFileSync(join(__dirname, '..', f), 'utf8');
      expect(src.includes("'french'::regconfig"), `${f} recopie la configuration`).toBe(false);
      expect(src).toContain('CONFIG_RECHERCHE');
    }
  });
});
