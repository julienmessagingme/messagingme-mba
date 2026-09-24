import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * 🔴 L'ISOLATION ENTRE CLIENTS DES LECTURES DES SIGNAUX, lue dans le CODE (lot 6 de l'API publique).
 *
 * La connexion passe par le pooler en rôle superuser, la RLS est contournée : `tenant_id = $1` est le SEUL
 * contrôle. Les cas « un autre espace » de `tests/integration/signaux.integration.test.ts` le prouvent contre
 * une vraie base, mais ils ne tournent qu'en CI et ne peuvent donc pas être vérifiés dans le sens ROUGE sans
 * pousser une fuite. Ce test-ci, lui, tourne partout et se mute en local : chaque `from` d'une requête de
 * `PgSignauxStore` a son filtre d'espace, et `PgIntegrationBatchStore` n'a qu'UNE lecture sans filtre, la
 * lecture transverse documentée des espaces actifs.
 */
function requetes(fichier: string): string[] {
  const source = readFileSync(new URL(`../${fichier}`, import.meta.url), 'utf8');
  // `(?:\/\/[^\n]*\n\s*)*` : une requête peut être précédée d'un commentaire `//` (celle de `lire` l'est), qui
  // contient lui-même des accents graves. Sans ce saut, elle serait simplement IGNORÉE, donc jamais vérifiée.
  return [...source.matchAll(/this\.pool\.query(?:<[^>]*>)?\(\s*(?:\/\/[^\n]*\n\s*)*`([\s\S]*?)`/g)].map((m) => m[1]!);
}
const compter = (texte: string, motif: RegExp): number => texte.match(motif)?.length ?? 0;

describe('isolation des lectures des signaux', () => {
  it('🔴 PgSignauxStore : chaque `from` porte son `tenant_id = $1`', () => {
    const rs = requetes('src/signaux/store.pg.ts');
    // Six requêtes : ficheParWaId, ficheParId, waIdDeLaConversation, contexteDuMessage, lien, analyse.
    expect(rs.length, 'une requête échappe au balayage : c’est le test qui est cassé').toBe(6);
    for (const r of rs) {
      expect(compter(r, /tenant_id = \$1/g), r).toBe(compter(r, /\bfrom\b/gi));
    }
  });

  it('🔴 PgIntegrationBatchStore : une seule lecture sans filtre d’espace, celle des espaces actifs', () => {
    const rs = requetes('src/signaux/integration-batch.pg.ts');
    // Huit requêtes : lire, secrets, les deux d'enregistrer, supprimer, espacesActifs, noterSansIdentifiant,
    // suspendre. Moins, c'est qu'une requête échappe au balayage.
    expect(rs.length).toBe(8);
    const sansFiltre = rs.filter((r) => /\bwhere\b/i.test(r) && !/tenant_id = \$1/.test(r));
    expect(sansFiltre).toHaveLength(1);
    expect(sansFiltre[0]).toMatch(/select tenant_id from integration_batch where refus_cles_le is null/);
  });
});
