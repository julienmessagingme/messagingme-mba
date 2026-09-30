import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * 🔴 UN FICHIER DÉPOSÉ PAR UN CLIENT SE LIT HORS DE LA BOUCLE D'ÉVÉNEMENTS (2026-09-30).
 *
 * Les tests de boucle des routes (import de contacts, FAQ, connaissance, pièces jointes) ne couvrent que les routes
 * qui existent : une route écrite demain qui appellerait `parseCsv` en direct figerait l'API pour tous les espaces
 * sur un fichier de quelques centaines de Ko, et aucun d'eux ne tomberait. Cet inventaire, lui, la voit : hors des
 * modules qui les définissent, personne n'appelle ces lectures en direct, seulement leur version `...HorsBoucle`.
 * Les pages web en sont depuis le lot suivant, le même jour (`pageEnFiches`, `liensDeLaPage`).
 */

const RACINE = resolve(__dirname, '..');
const SRC = join(RACINE, 'src');

/** Les lectures qui tiennent la boucle sur un fichier ou une page hostile, et les modules qui les définissent. */
const LECTURES = [
  'parseCsv', 'parseCsvCompact', 'apercuCsv', 'separateurCsv', 'extraireDepuisCsv', 'extraireDepuisHtml',
  'reconnaitre', 'extraireTexte', 'texteEnFiches', 'lireDocument', 'pageEnFiches', 'liensDeLaPage',
];
const DEFINISSENT = [
  'src/crm/csv.ts', 'src/mba/faq-import.ts', 'src/agent/setup/piece-jointe.ts', 'src/agent/scrape.ts', 'src/agent/crawl.ts',
];

function fichiers(dossier: string): string[] {
  return readdirSync(dossier).flatMap((nom) => {
    const chemin = join(dossier, nom);
    return statSync(chemin).isDirectory() ? fichiers(chemin) : chemin.endsWith('.ts') ? [chemin] : [];
  });
}

describe('les lectures de fichiers déposés passent par le worker', () => {
  it('il y a bien des fichiers à inventorier, sinon ce test ne prouve rien', () => {
    expect(fichiers(SRC).length).toBeGreaterThan(100);
  });

  it('🔴 hors des modules qui les définissent, aucun appel direct', () => {
    const appel = new RegExp(`\\b(${LECTURES.join('|')})\\(`, 'g');
    const trouves = fichiers(SRC)
      .map((f) => relative(RACINE, f).replace(/\\/g, '/'))
      .filter((f) => !DEFINISSENT.includes(f))
      .flatMap((f) => [...readFileSync(join(RACINE, f), 'utf8').matchAll(appel)].map((m) => `${f} : ${m[1]}(`));
    expect(trouves).toEqual([]);
  });
});
