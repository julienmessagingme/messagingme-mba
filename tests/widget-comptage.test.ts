import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { PgChannelsMeLinkStore } from '../src/channels-me/link-store.pg';
import { MOTIF_JETON } from '../src/channels-me/jeton';
import { gestionDesWidgetsEnBase } from '../src/widgets/gestion';
import { MOTIF_ETIQUETTE_WIDGET, PREFIXE_ETIQUETTE_WIDGET, etiquetteDuWidget } from '../src/widgets/arrivee';
import { newTrackingCode } from '../src/ids/code';
import { offresToutOuvert } from './gardes';

/**
 * LE COMPTAGE DES MESSAGES REÇUS QUI CONTIENNENT DÉJÀ UNE PHRASE, côté widget (jaune 1 de la relecture du lot 4,
 * replié au lot 5 de docs/superpowers/plans/2026-10-02-widget-whatsapp.md).
 *
 * Le défaut : la garde d'un widget comptait les arrivées du widget lui-même. Recréer un widget avec la phrase d'un
 * widget supprimé, raccourcir une phrase qui avait servi ou retirer sa ponctuation finale était refusé à cause de son
 * propre succès. La règle qui le corrige vit en SQL (`PgChannelsMeLinkStore.messagesContenantLaPhrase`) et son EFFET
 * se prouve contre un vrai Postgres (`tests/integration/widgets-comptage.integration.test.ts`, en CI). Ce fichier
 * garde ce qui se voit sans base :
 *  1. 🔴 la garde d'un WIDGET demande l'exclusion, celle d'un LIEN DE CHAÎNE ne la demande pas (son comportement ne
 *     change pas) ;
 *  2. la forme d'étiquette que la requête reconnaît est celle que le générateur produit, et rien d'autre ;
 *  3. le filtre d'espace est posé partout où la requête lit, sous-requête comprise.
 */

/** Faux pool : enregistre SQL et paramètres, rend un compte. Aucune base, aucun réseau. */
function fauxPool(n = 0) {
  const requetes: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      requetes.push({ sql, params });
      return { rows: [{ n }], rowCount: 1 };
    },
  } as unknown as Pool;
  return { pool, requetes };
}

describe('qui demande quoi', () => {
  it('🔴 la garde d’un WIDGET écarte les arrivées par un widget', async () => {
    const { pool, requetes } = fauxPool(4);
    expect(await gestionDesWidgetsEnBase(pool, offresToutOuvert).messagesContenantLaPhrase('t1', 'Je viens du blog')).toBe(4);
    expect(requetes).toHaveLength(1);
    expect(requetes[0]!.params).toEqual([
      't1', 'Je viens du blog', expect.any(Number), MOTIF_JETON, true, MOTIF_ETIQUETTE_WIDGET, PREFIXE_ETIQUETTE_WIDGET,
    ]);
  });

  it('🔴 la garde d’un LIEN DE CHAÎNE ne change pas : sans l’option, le drapeau est faux', async () => {
    const { pool, requetes } = fauxPool();
    await new PgChannelsMeLinkStore(pool).messagesContenantLaPhrase('t1', 'Je veux le guide');
    // Les quatre premiers paramètres sont ceux d'avant le lot 5 ; le cinquième rend la condition ajoutée vraie.
    expect(requetes[0]!.params.slice(0, 5)).toEqual(['t1', 'Je veux le guide', expect.any(Number), MOTIF_JETON, false]);
    // Et la route des liens ne peut pas la demander : son contrat n'a que deux paramètres, et elle les passe.
    const route = readFileSync(new URL('../src/http/channels-me.ts', import.meta.url), 'utf8');
    expect(route).toContain('messagesContenantLaPhrase(tenantId: string, phrase: string): Promise<number>;');
    expect(route).toContain('await deps.liens.messagesContenantLaPhrase(tenant, phrase);');
  });

  it('la condition ajoutée est neutralisée par le drapeau, et l’espace est filtré partout où la requête lit', async () => {
    const { pool, requetes } = fauxPool();
    await new PgChannelsMeLinkStore(pool).messagesContenantLaPhrase('t1', 'x', { horsArriveesDeWidget: true });
    const sql = requetes[0]!.sql.replace(/--.*$/gm, '');
    expect(sql).toContain('not ($5::boolean and exists (');
    // La conversation, le contact ET le widget : un widget d'un autre espace ne doit rien écarter ici.
    expect(sql).toContain('c.tenant_id = $1');
    expect(sql).toContain('ct.tenant_id = $1');
    expect(sql).toContain('w.tenant_id = $1');
    // Un widget présent n'écarte que les messages qui contiennent SA phrase ; un supprimé, ceux de ses contacts.
    expect(sql).toContain('w.id is null or strpos(lower(recents.body), lower(w.phrase)) > 0');
  });
});

describe('la forme d’une étiquette de widget', () => {
  const motif = new RegExp(MOTIF_ETIQUETTE_WIDGET);

  it('🔴 reconnaît TOUTE étiquette que le générateur peut produire', () => {
    // Un motif plus étroit que le générateur laisserait compter les arrivées des widgets dont le code tombe hors du
    // motif : le défaut revenait pour eux, au hasard du tirage.
    for (let i = 0; i < 2000; i++) {
      const etiquette = etiquetteDuWidget(newTrackingCode());
      expect(motif.test(etiquette), etiquette).toBe(true);
    }
  });

  it('🔴 ne reconnaît PAS une étiquette posée à la main qui commence pareil', () => {
    // Prise pour celle d'un widget supprimé, elle ferait écarter des messages ordinaires de la mesure.
    const code = 'k7m2p3q9r4st';
    expect(motif.test(etiquetteDuWidget(code)), 'le code de référence doit être reconnu').toBe(true);
    for (const etiquette of ['widget-salon', `widget-${code}x`, `widget-${code.slice(1)}`, `xwidget-${code}`,
      `widget-${code.toUpperCase()}`, code, `widget-${code.slice(0, 11)}i`]) {
      expect(motif.test(etiquette), etiquette).toBe(false);
    }
  });
});
