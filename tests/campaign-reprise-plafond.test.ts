import { describe, it, expect } from 'vitest';
import { estPlafondNumero, raisonDePause, MetaApiError } from '../src/meta/errors';
import { instantDeReprise, messageDePause, REPRISE_MIN_MS, REPRISE_MAX_MS, REPRISE_DEFAUT_MS } from '../src/campaign/pause';
import { runCampaignRepriseSweep } from '../src/campaign/reprise-sweep';

/**
 * La reprise d'une campagne mise en pause par un plafond Meta (migration 0103).
 *
 * 🔴 TOUT CE LOT TIENT SUR UNE DISTINCTION : une limite de CADENCE retombe toute seule, une QUALITÉ dégradée
 * non. Reprendre automatiquement une pause de qualité, c'est relancer sans rien changer un numéro que Meta
 * juge déjà mal, donc aggraver le problème et risquer de perdre le numéro. Ces tests existent pour que cette
 * distinction ne puisse pas être effacée par inadvertance.
 */
const erreurMeta = (httpStatus: number, code?: number, retryAfterMs?: number) =>
  new MetaApiError(httpStatus, code !== undefined ? { message: 'plafond', code } : { message: 'trop de requetes' }, retryAfterMs);

describe('reconnaître un plafond de numéro', () => {
  it('les deux codes connus sont des plafonds', () => {
    expect(estPlafondNumero(erreurMeta(400, 130429))).toBe(true);
    expect(estPlafondNumero(erreurMeta(400, 131048))).toBe(true);
  });

  it('🔴 un HTTP 429 SANS code connu est un plafond lui aussi', () => {
    // Angle mort relevé par le contre-audit du 2026-09-01. Il était rejouable dans le transport mais
    // n'entrait pas ici : une fois les tentatives épuisées, il finissait en ÉCHEC DU DESTINATAIRE, qui n'y
    // est pour rien et devient injoignable sans intervention, pendant que le suivant échouait pareil.
    // « Trop de requêtes » ne parle jamais du destinataire, il parle de nous.
    expect(estPlafondNumero(erreurMeta(429))).toBe(true);
    expect(raisonDePause(erreurMeta(429))).toBe('debit');
  });

  it('une erreur ORDINAIRE n’est pas un plafond : la garde ne doit pas tout avaler', () => {
    // L'autre sens. Si tout devenait un plafond, une campagne se mettrait en pause sur un paramètre invalide
    // et attendrait une limite qui n'existe pas.
    expect(estPlafondNumero(erreurMeta(400, 132000))).toBe(false);
    expect(estPlafondNumero(erreurMeta(500))).toBe(false);
    expect(estPlafondNumero(new Error('réseau'))).toBe(false);
    expect(raisonDePause(erreurMeta(400, 132000))).toBeUndefined();
  });

  it('🔴 la QUALITÉ se distingue du DÉBIT', () => {
    expect(raisonDePause(erreurMeta(400, 131048))).toBe('qualite');
    expect(raisonDePause(erreurMeta(400, 130429))).toBe('debit');
  });
});

describe('quand reprendre', () => {
  const T0 = Date.parse('2026-09-01T12:00:00.000Z');

  it('🔴 une pause de QUALITÉ n’a AUCUN instant de reprise', () => {
    // C'est la garde la plus importante du lot : `null` est ce qui empêche le balayage de la voir.
    expect(instantDeReprise('qualite', 60_000, T0)).toBeNull();
    expect(instantDeReprise('qualite', undefined, T0)).toBeNull();
  });

  it('une pause de débit suit le Retry-After de Meta quand il existe', () => {
    expect(instantDeReprise('debit', 5 * 60_000, T0)?.getTime()).toBe(T0 + 5 * 60_000);
  });

  it('sans Retry-After, un défaut ; et l’en-tête est BORNÉ dans les deux sens', () => {
    // Meta peut envoyer un en-tête fantaisiste. Deux secondes ferait retaper aussitôt sur le plafond ;
    // douze heures endormirait une campagne pour rien. On suit Meta, mais on ne le laisse pas décider seul.
    expect(instantDeReprise('debit', undefined, T0)?.getTime()).toBe(T0 + REPRISE_DEFAUT_MS);
    expect(instantDeReprise('debit', 2_000, T0)?.getTime()).toBe(T0 + REPRISE_MIN_MS);
    expect(instantDeReprise('debit', 12 * 3_600_000, T0)?.getTime()).toBe(T0 + REPRISE_MAX_MS);
    expect(instantDeReprise('debit', -1, T0)?.getTime()).toBe(T0 + REPRISE_DEFAUT_MS);
  });

  it('🔴 le message DIT si la reprise est automatique, et ne le dit PAS quand elle ne l’est pas', () => {
    // La phrase d'avant promettait une reprise automatique qui n'existait pas, et un opérateur attendait
    // devant un écran. Elle doit maintenant être vraie dans les deux cas.
    expect(messageDePause('debit', new Date(T0), 130429)).toMatch(/Reprise automatique/);
    const qualite = messageDePause('qualite', null, 131048);
    expect(qualite).toMatch(/n'est PAS automatique/);
    expect(qualite).toMatch(/qualité dégradée/);
  });
});

describe('le balayage de reprise', () => {
  it('reprend les campagnes dues et enfile un run pour chacune', async () => {
    const enfiles: string[] = [];
    const n = await runCampaignRepriseSweep({
      reprendreDues: async () => [{ id: 'c1', tenantId: 't1' }, { id: 'c2', tenantId: 't2' }],
      getRunSizing: async () => ({ ratePerMinute: 60, pendingCount: 100 }),
      enqueueRun: async (id, tenantId) => { enfiles.push(`${id}@${tenantId}`); },
    });
    expect(n).toBe(2);
    // Le GROUPE de file est l'espace : sans lui, une reprise échapperait au plafond de concurrence par
    // espace, et un client qui touche souvent le plafond occuperait toute la file.
    expect(enfiles).toEqual(['c1@t1', 'c2@t2']);
  });

  it('🔴 une campagne DISPARUE entre la reprise et l’enfilement n’est pas une erreur', async () => {
    const enfiles: string[] = [];
    const erreurs: string[] = [];
    const n = await runCampaignRepriseSweep({
      reprendreDues: async () => [{ id: 'c1', tenantId: 't1' }],
      getRunSizing: async () => null,
      enqueueRun: async (id) => { enfiles.push(id); },
      onError: (m) => erreurs.push(m),
    });
    expect(n).toBe(0);
    expect(enfiles).toEqual([]);
    expect(erreurs).toEqual([]); // ce n'est pas une panne, c'est une course normale
  });

  it('🔴 un échec sur UNE campagne n’empêche pas les autres de repartir', async () => {
    // Sans ça, une file qui refuse un job gèlerait toutes les campagnes reprises derrière elle, alors
    // qu'elles sont déjà passées en `running` en base.
    const enfiles: string[] = [];
    const erreurs: string[] = [];
    const n = await runCampaignRepriseSweep({
      reprendreDues: async () => [{ id: 'ko', tenantId: 't1' }, { id: 'ok', tenantId: 't1' }],
      getRunSizing: async () => ({ ratePerMinute: 60, pendingCount: 10 }),
      enqueueRun: async (id) => { if (id === 'ko') throw new Error('file pleine'); enfiles.push(id); },
      onError: (m) => erreurs.push(m),
    });
    expect(n).toBe(1);
    expect(enfiles).toEqual(['ok']);
    expect(erreurs).toHaveLength(1);
  });
});
