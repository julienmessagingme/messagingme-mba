import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgRisqueStore, faitsDeLaLigne } from '../src/engagement/risque.pg';

/**
 * Le dépôt du risque SANS base (la base, c'est `tests/integration/risque.integration.test.ts`, en CI) : ce qu'il
 * fait des lignes qu'il reçoit. Les deux propriétés qui comptent ici : l'écriture ne rend QUE les changements de
 * niveau (c'est d'eux que partent signaux et automations), et la lecture applique les règles de joignabilité du
 * dépôt, pas une seconde définition.
 */
const T = '0b8f5c1e-3d2a-4c6b-9e7f-1a2b3c4d5e6f';
const MAINTENANT = new Date('2026-09-25T03:00:00.000Z');

function pool(rows: unknown[]) {
  const appels: Array<{ sql: string; params: unknown[] }> = [];
  const p = { query: async (sql: string, params: unknown[] = []) => { appels.push({ sql, params }); return { rows, rowCount: rows.length }; } } as unknown as Pool;
  return { p, appels };
}

describe('PgRisqueStore.ecrire', () => {
  it('🔴 rend les changements de NIVEAU, et eux seuls : rester où l’on était n’en est pas un', async () => {
    const { p, appels } = pool([
      { id: 'c1', ancien: 'moyen', phone_e164: '+33612345678', bsuid: null },
      { id: 'c2', ancien: 'eleve', phone_e164: '+33612345679', bsuid: null },
      { id: 'c3', ancien: null, phone_e164: null, bsuid: 'BSUID-3' },
    ]);
    const t = await new PgRisqueStore(p).ecrire(T, [
      { contactId: 'c1', risque: { niveau: 'eleve', score: 70, raisons: ['silence_60j'] } },
      { contactId: 'c2', risque: { niveau: 'eleve', score: 85, raisons: ['silence_60j', 'non_lu'] } },
      { contactId: 'c3', risque: { niveau: 'inconnu', score: null, raisons: [] } },
    ], MAINTENANT);
    expect(t).toEqual([
      { contactId: 'c1', waId: '33612345678', ancien: 'moyen', nouveau: 'eleve', score: 70, raisons: ['silence_60j'] },
      { contactId: 'c3', waId: 'BSUID-3', ancien: null, nouveau: 'inconnu', score: null, raisons: [] },
    ]);
    // Une écriture pour le lot, paramétrée, l'espace en premier.
    expect(appels).toHaveLength(1);
    expect(appels[0]!.params[0]).toBe(T);
    expect(JSON.parse(appels[0]!.params[1] as string)).toHaveLength(3);
    expect(appels[0]!.params[2]).toBe(MAINTENANT);
  });

  it('un lot vide ne fait aucune requête', async () => {
    const { p, appels } = pool([]);
    expect(await new PgRisqueStore(p).ecrire(T, [], MAINTENANT)).toEqual([]);
    expect(await new PgRisqueStore(p).faits(T, [], MAINTENANT, MAINTENANT)).toEqual([]);
    expect(appels).toEqual([]);
  });

  /**
   * 🔴 SEULES LES FICHES QUI CHANGENT SONT RÉÉCRITES, et la date ne bouge qu'avec le niveau (relecture du lot 7).
   * Ce qu'une base seule prouve (une fiche inchangée n'est pas touchée) est dans le test d'intégration ; ici, la
   * FORME de l'instruction, qui se mute : sans la garde, chaque fiche évaluée est réécrite chaque nuit.
   */
  it('🔴 la garde porte sur les TROIS colonnes de la valeur, avant le verrou ; la date suit le NIVEAU seul', async () => {
    const { p, appels } = pool([]);
    await new PgRisqueStore(p).ecrire(T, [{ contactId: 'c1', risque: { niveau: 'moyen', score: 40, raisons: ['silence_30j'] } }], MAINTENANT);
    const sql = appels[0]!.sql.replace(/\s+/g, ' ');
    // Dans `avant`, donc une fiche inchangée n'est ni verrouillée ni réécrite.
    expect(sql).toMatch(/and \(c\.risque_niveau, c\.risque_score, c\.risque_raisons\) is distinct from \(v\.niveau, v\.score, v\.raisons\) for update of c/);
    expect(sql).toContain('risque_calcule_le = case when a.risque_niveau is distinct from v.niveau then $3 else c.risque_calcule_le end');
  });

  it('🔴 une fiche réécrite pour son score ou ses raisons, au même niveau, n’est PAS une transition ; un changement de niveau en est toujours une', async () => {
    const { p } = pool([
      { id: 'c1', ancien: 'eleve', phone_e164: '+33612345678', bsuid: null },
      { id: 'c2', ancien: 'faible', phone_e164: '+33612345679', bsuid: null },
      { id: 'c3', ancien: 'inconnu', phone_e164: '+33612345670', bsuid: null },
    ]);
    const t = await new PgRisqueStore(p).ecrire(T, [
      { contactId: 'c1', risque: { niveau: 'eleve', score: 90, raisons: ['silence_60j', 'reclamation'] } },
      { contactId: 'c2', risque: { niveau: 'faible', score: 15, raisons: ['non_lu'] } },
      { contactId: 'c3', risque: { niveau: 'faible', score: 0, raisons: [] } },
    ], MAINTENANT);
    expect(t).toEqual([{ contactId: 'c3', waId: '33612345670', ancien: 'inconnu', nouveau: 'faible', score: 0, raisons: [] }]);
  });
});

describe('PgRisqueStore.declenchablesDepuis (le plafond du jour)', () => {
  it('🔴 compte les passages en élevé de l’espace depuis minuit, hors STOP, blocage et fiche sans adresse', async () => {
    const { p, appels } = pool([{ n: 37 }]);
    const minuit = new Date('2026-09-24T22:00:00.000Z');
    expect(await new PgRisqueStore(p).declenchablesDepuis(T, minuit)).toBe(37);
    expect(appels[0]!.params).toEqual([T, minuit]);
    const sql = appels[0]!.sql.replace(/\s+/g, ' ');
    // L'égalité NUE derrière l'espace et `deleted_at is null` : le contrat de l'index partiel du niveau.
    expect(sql).toContain(`where c.tenant_id = $1 and c.deleted_at is null and c.risque_niveau = 'eleve'`);
    expect(sql).toContain('c.risque_calcule_le >= $2');
    expect(sql).toContain(`not (c.risque_raisons && array['stop', 'bloque']::text[])`);
    expect(sql).toContain(`(coalesce(c.phone_e164, '') <> '' or c.bsuid is not null)`);
  });
});

describe('faitsDeLaLigne', () => {
  const ligne = {
    id: 'c1', opt_in_status: 'opted_in', rcs_optout_at: null, blocked_at: null, whatsapp_joignable: null,
    whatsapp_joignable_le: null, risque_niveau: null, envoyes_le: null, lus: null, lus_le: null, derniere_reponse: null,
    dernier_clic: null, intent: null, sentiment: null, resolved: null, satisfaction: null, analyse_le: null,
    rcs_joignable: null, rcs_verifie_le: null,
  };

  it('les envois délivrés, dans l’ordre reçu, avec leur lecture', () => {
    const f = faitsDeLaLigne({
      ...ligne,
      envoyes_le: [new Date('2026-09-20T10:00:00.000Z'), '2026-09-10T10:00:00.000Z'],
      lus: [true, false],
      lus_le: [new Date('2026-09-20T11:00:00.000Z'), null],
    }, MAINTENANT);
    expect(f.delivres).toEqual([
      { envoyeLe: new Date('2026-09-20T10:00:00.000Z'), lu: true, luLe: new Date('2026-09-20T11:00:00.000Z') },
      { envoyeLe: new Date('2026-09-10T10:00:00.000Z'), lu: false, luLe: null },
    ]);
  });

  it('🔴 un STOP WhatsApp comme un STOP RCS est un désabonnement ; le blocage se lit à part', () => {
    expect(faitsDeLaLigne({ ...ligne, opt_in_status: 'opted_out' }, MAINTENANT).desabonne).toBe(true);
    expect(faitsDeLaLigne({ ...ligne, rcs_optout_at: new Date('2026-09-01T00:00:00.000Z') }, MAINTENANT).desabonne).toBe(true);
    expect(faitsDeLaLigne(ligne, MAINTENANT)).toMatchObject({ desabonne: false, bloque: false });
    expect(faitsDeLaLigne({ ...ligne, blocked_at: new Date('2026-09-01T00:00:00.000Z') }, MAINTENANT).bloque).toBe(true);
  });

  it('la dernière réaction est la plus récente d’une réponse et d’un clic', () => {
    const f = faitsDeLaLigne({ ...ligne, derniere_reponse: new Date('2026-09-10T00:00:00.000Z'), dernier_clic: new Date('2026-09-12T00:00:00.000Z') }, MAINTENANT);
    expect(f.derniereReactionLe).toEqual(new Date('2026-09-12T00:00:00.000Z'));
  });

  it('🔴 la joignabilité suit les règles du dépôt : une mesure WhatsApp périmée, une entrée RCS périmée, redeviennent inconnues', () => {
    const recente = faitsDeLaLigne({
      ...ligne, whatsapp_joignable: false, whatsapp_joignable_le: new Date('2026-09-20T00:00:00.000Z'),
      rcs_joignable: false, rcs_verifie_le: new Date('2026-09-24T00:00:00.000Z'),
    }, MAINTENANT);
    expect([recente.joignableWhatsapp, recente.joignableRcs]).toEqual([false, false]);
    const perimee = faitsDeLaLigne({
      ...ligne, whatsapp_joignable: false, whatsapp_joignable_le: new Date('2026-05-01T00:00:00.000Z'),
      rcs_joignable: false, rcs_verifie_le: new Date('2026-09-01T00:00:00.000Z'),
    }, MAINTENANT);
    expect([perimee.joignableWhatsapp, perimee.joignableRcs]).toEqual([null, null]);
  });

  it('une analyse incomplète n’est pas une analyse', () => {
    expect(faitsDeLaLigne({ ...ligne, intent: 'sav', sentiment: null, resolved: true, analyse_le: MAINTENANT }, MAINTENANT).derniereAnalyse).toBeNull();
    expect(faitsDeLaLigne({ ...ligne, intent: 'sav', sentiment: 'neutre', resolved: true, satisfaction: 7, analyse_le: MAINTENANT }, MAINTENANT).derniereAnalyse)
      .toEqual({ intent: 'sav', sentiment: 'neutre', resolved: true, satisfaction: 7, le: MAINTENANT });
  });
});
