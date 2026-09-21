import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SOURCES_APPEL } from '../src/agent/catalog';

/**
 * LES APPELANTS DU JOURNAL, EN CODE ET EN BASE, SONT LES MÊMES.
 *
 * 🔴 SANS CE TEST, `SOURCES_APPEL` N'AVAIT AUCUN LECTEUR (revue finale du 2026-09-21), et rien ne liait le type
 * TypeScript au CHECK de `agent_tool_calls.source`. Un appelant ajouté d'un seul côté se voit ainsi : côté code
 * seulement, l'écriture de journal échoue en base et le point de passage l'avale en silence (il est
 * best-effort) ; côté base seulement, rien ne l'écrit jamais.
 *
 * Il lit la DERNIÈRE migration qui pose ce CHECK, pas une copie de sa liste.
 */
const DOSSIER = resolve(__dirname, '..', 'db', 'migrations');

function listeEnBase(): string[] {
  const fichiers = readdirSync(DOSSIER).filter((f) => f.endsWith('.sql')).sort();
  let derniere: string | null = null;
  for (const f of fichiers) {
    const sql = readFileSync(join(DOSSIER, f), 'utf8');
    const m = /agent_tool_calls_source_check\s+check\s*[(]\s*source\s+in\s*[(]([^)]*)[)]/i.exec(sql);
    if (m) derniere = m[1]!;
  }
  if (derniere === null) throw new Error('aucune migration ne pose agent_tool_calls_source_check');
  return [...derniere.matchAll(/'([^']+)'/g)].map((x) => x[1]!).sort();
}

describe('les appelants du journal des connecteurs', () => {
  it('🔴 le type du code et le CHECK de la base portent la même liste', () => {
    expect([...SOURCES_APPEL].sort()).toEqual(listeEnBase());
  });

  it('la liste lue en base contient bien l’agent de Meta (relais, migration 0161)', () => {
    expect(listeEnBase()).toContain('mba');
  });
});
