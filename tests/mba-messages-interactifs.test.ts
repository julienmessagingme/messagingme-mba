import { describe, it, expect } from 'vitest';
import {
  CONSIGNE_MAX, ID_MESSAGE_RE, TITRE_MAX, TITRE_RE, TYPES_MESSAGE_INTERACTIF, depuisMeta, lirePage, messagesInteractifsDuFormulaire, octets, validerCreation,
  validerModification, versMetaCreation, versMetaModification, type MessageInteractif,
} from '../src/mba/messages-interactifs';
import { MetaApiError } from '../src/meta/errors';
import { TITRE_SKILL_RE } from '../src/http/mba';

/**
 * La validation des messages interactifs AVANT l'appel à Meta, et la lecture de ce que Meta rend. Les règles
 * viennent de la mesure du 2026-10-07 sur le numéro de test (`docs/MBA-API-REFERENCE.md`).
 */

const base = { titre: 'boutons-de-rdv', type: 'interactive_reply_buttons', consigne: 'Quand : le client veut un rendez-vous\nTexte : ...' };

describe('validerCreation', () => {
  it('accepte une création ordinaire, sans formulaire', () => {
    const v = validerCreation(base);
    expect(v).toEqual({ ok: true, valeur: { ...base, formulaireId: null } });
  });

  it('refuse un type hors des neuf, en les nommant', () => {
    const v = validerCreation({ ...base, type: 'button' });
    expect(v.ok).toBe(false);
    if (!v.ok) for (const t of TYPES_MESSAGE_INTERACTIF) expect(v.erreur).toContain(t);
  });

  it('🔴 exige un formulaire pour le type formulaire, et le refuse ailleurs (les deux 400 de Meta, mesurés)', () => {
    expect(validerCreation({ ...base, type: 'flow' }).ok).toBe(false);
    expect(validerCreation({ ...base, type: 'flow', formulaireId: '3234400576763440' })).toMatchObject({ ok: true, valeur: { formulaireId: '3234400576763440' } });
    expect(validerCreation({ ...base, type: 'cta_url', formulaireId: '3234400576763440' }).ok).toBe(false);
    // Un identifiant qui n'est pas une suite de chiffres n'est pas un identifiant de formulaire Meta.
    expect(validerCreation({ ...base, type: 'flow', formulaireId: '../../x' }).ok).toBe(false);
  });

  it('refuse un titre ou une consigne vide', () => {
    expect(validerCreation({ ...base, titre: '  ' }).ok).toBe(false);
    expect(validerCreation({ ...base, consigne: '' }).ok).toBe(false);
  });

  it('🔴 compte les bornes en OCTETS UTF-8, comme Meta : 20 000 caractères dont un accentué ne passent pas', () => {
    const limite = 'a'.repeat(CONSIGNE_MAX);
    expect(validerCreation({ ...base, consigne: limite }).ok).toBe(true);
    const accentuee = 'é' + 'a'.repeat(CONSIGNE_MAX - 1);
    expect(accentuee.length).toBe(CONSIGNE_MAX);
    expect(octets(accentuee)).toBe(CONSIGNE_MAX + 1);
    expect(validerCreation({ ...base, consigne: accentuee }).ok).toBe(false);
    expect(validerCreation({ ...base, titre: 'a'.repeat(TITRE_MAX) }).ok).toBe(true);
    expect(validerCreation({ ...base, titre: 'a'.repeat(TITRE_MAX + 1) }).ok).toBe(false);
  });

  it('🔴 le titre est un SLUG, comme une consigne (Meta refuse tout autre titre en 400, mesuré le 2026-10-07)', () => {
    expect(validerCreation({ ...base, titre: 'Boutons-RDV' })).toMatchObject({ ok: true, valeur: { titre: 'boutons-rdv' } });
    for (const mauvais of ['boutons rdv', 'rdv-', '-rdv', 'réserver', 'rdv_matin', 'a--b']) {
      expect(validerCreation({ ...base, titre: mauvais }).ok, mauvais).toBe(false);
    }
    // La même règle que les consignes : si l'une change, l'autre doit changer aussi.
    expect(TITRE_RE.source).toBe(TITRE_SKILL_RE.source);
  });

  it('l’identifiant d’un message se refuse s’il peut sortir de son chemin', () => {
    expect(ID_MESSAGE_RE.test('pfbid0226eSHhurNvThi3kfBYFNtV5XEBoqRHgFvf8fgCQWbsi3')).toBe(true);
    for (const mauvais of ['..', '../x', 'a/b', 'a?b', '', 'a b']) expect(ID_MESSAGE_RE.test(mauvais), mauvais).toBe(false);
  });
});

describe('validerModification', () => {
  it('accepte le titre, la consigne et l’état, séparément', () => {
    expect(validerModification({ actif: false })).toEqual({ ok: true, valeur: { actif: false } });
    expect(validerModification({ titre: 'neuf', consigne: 'texte' })).toEqual({ ok: true, valeur: { titre: 'neuf', consigne: 'texte' } });
  });

  it('🔴 refuse le type et le formulaire : Meta les ignore en silence (PUT rendu 200, mesuré)', () => {
    expect(validerModification({ type: 'image' }).ok).toBe(false);
    expect(validerModification({ formulaireId: '1' }).ok).toBe(false);
  });

  it('refuse un champ inconnu, un état non booléen, et une modification vide', () => {
    expect(validerModification({ statut: 'enabled' }).ok).toBe(false);
    expect(validerModification({ actif: 'oui' }).ok).toBe(false);
    expect(validerModification({}).ok).toBe(false);
  });
});

describe('les corps envoyés à Meta', () => {
  it('une création part active, et ne porte flow_id que pour un formulaire', () => {
    expect(versMetaCreation({ titre: 't', type: 'cta_url', consigne: 'c', formulaireId: null }))
      .toEqual({ title: 't', component_type: 'cta_url', status: 'enabled', instruction: 'c' });
    expect(versMetaCreation({ titre: 't', type: 'flow', consigne: 'c', formulaireId: '42' }))
      .toEqual({ title: 't', component_type: 'flow', status: 'enabled', instruction: 'c', flow_id: '42' });
  });

  it('🔴 une modification ne porte jamais component_type ni flow_id', () => {
    const corps = versMetaModification({ titre: 't', consigne: 'c', actif: false });
    expect(corps).toEqual({ title: 't', instruction: 'c', status: 'disabled' });
    expect(Object.keys(corps)).not.toContain('component_type');
    expect(Object.keys(corps)).not.toContain('flow_id');
  });
});

describe('depuisMeta', () => {
  const brut = {
    id: 'pfbid0abc', title: 'formulaire-rdv', component_type: 'flow', status: 'enabled',
    instruction: 'Quand : ...', created_at: 1791386318, updated_at: 1791386320, flow_id: 3234400576763440,
  };

  it('lit la forme mesurée, flow_id rendu en NOMBRE relu en chaîne', () => {
    expect(depuisMeta(brut)).toEqual({
      id: 'pfbid0abc', titre: 'formulaire-rdv', type: 'flow', actif: true, consigne: 'Quand : ...',
      formulaireId: '3234400576763440', creeLe: 1791386318, modifieLe: 1791386320,
    });
  });

  it('rend null sur un type inconnu ou un état inconnu, jamais un objet à moitié rempli', () => {
    expect(depuisMeta({ ...brut, component_type: 'nouveau_type' })).toBeNull();
    expect(depuisMeta({ ...brut, status: 'paused' })).toBeNull();
    expect(depuisMeta(null)).toBeNull();
  });

  it('accepte null là où Meta pourrait le rendre (aucune réponse d’écriture relevée)', () => {
    expect(depuisMeta({ ...brut, component_type: 'cta_url', flow_id: null, created_at: null, updated_at: null }))
      .toMatchObject({ formulaireId: null, creeLe: 0, modifieLe: 0 });
  });

  it('refuse un flow_id numérique hors des entiers sûrs plutôt que de l’arrondir', () => {
    expect(depuisMeta({ ...brut, flow_id: 2 ** 53 + 2 })).toBeNull();
  });
});

describe('lirePage', () => {
  it('🔴 suit cursors.after, et la dernière page (before seul) rend null : Meta ne rend jamais next', () => {
    expect(lirePage({ data: [1, 2], paging: { cursors: { after: 'QVFI' } } })).toEqual({ elements: [1, 2], apres: 'QVFI' });
    expect(lirePage({ data: [3], paging: { cursors: { before: 'QVFJ' } } })).toEqual({ elements: [3], apres: null });
    expect(lirePage({ data: [] })).toEqual({ elements: [], apres: null });
    expect(lirePage({ pas: 'une page' })).toBeNull();
  });
});

describe('messagesInteractifsDuFormulaire : qui ouvre ce formulaire ?', () => {
  const msg = (titre: string, formulaireId: string | null): MessageInteractif => ({
    id: titre, titre, type: formulaireId ? 'flow' : 'cta_url', actif: true, consigne: 'c', formulaireId, creeLe: 0, modifieLe: 0,
  });
  const avec = (o: { numero?: string | null; reglages?: () => Promise<unknown>; liste?: MessageInteractif[] }) => {
    const appels: string[] = [];
    return {
      appels,
      deps: {
        numero: async () => (o.numero === undefined ? 'PN1' : o.numero),
        client: async () => ({
          getSettings: async () => { appels.push('getSettings'); return o.reglages ? o.reglages() : { agent_id: 'AG1' }; },
          listMessagesInteractifs: async () => { appels.push('list'); return o.liste ?? []; },
        }),
      },
    };
  };

  it('rend les titres des seuls messages qui ouvrent CE formulaire', async () => {
    const { deps } = avec({ liste: [msg('a', '42'), msg('b', '43'), msg('c', null), msg('d', '42')] });
    expect(await messagesInteractifsDuFormulaire(deps, 't1', '42')).toEqual(['a', 'd']);
  });

  it('⚠️ un espace sans numéro, ou sans réglages d’agent chez Meta, n’est jamais bloqué', async () => {
    const sansNumero = avec({ numero: null });
    expect(await messagesInteractifsDuFormulaire(sansNumero.deps, 't1', '42')).toEqual([]);
    expect(sansNumero.appels).toEqual([]);
    const sansAgent = avec({ reglages: async () => null });
    expect(await messagesInteractifsDuFormulaire(sansAgent.deps, 't1', '42')).toEqual([]);
    expect(sansAgent.appels).toEqual(['getSettings']);
  });

  it('⚠️ 400, 403 et 404 valent « aucun agent » ; 408, 429 et une panne lèvent (sinon la suppression s’ouvrirait sans vérifier)', async () => {
    for (const statut of [400, 403, 404]) {
      const refus = avec({ reglages: async () => { throw new MetaApiError(statut, { message: 'x' }); } });
      expect(await messagesInteractifsDuFormulaire(refus.deps, 't1', '42'), String(statut)).toEqual([]);
    }
    for (const statut of [408, 429]) {
      const passager = avec({ reglages: async () => { throw new MetaApiError(statut, { message: 'x' }); } });
      await expect(messagesInteractifsDuFormulaire(passager.deps, 't1', '42'), String(statut)).rejects.toThrow();
    }
    const panne = avec({ reglages: async () => { throw new MetaApiError(503, { message: 'down' }); } });
    await expect(messagesInteractifsDuFormulaire(panne.deps, 't1', '42')).rejects.toThrow();
    const reseau = avec({ reglages: async () => { throw new Error('fetch failed'); } });
    await expect(messagesInteractifsDuFormulaire(reseau.deps, 't1', '42')).rejects.toThrow('fetch failed');
  });
});

describe('messagesInteractifsDuFormulaire : la liste se traite comme les réglages', () => {
  const deps = (liste: () => Promise<never>) => ({
    numero: async () => 'PN1',
    client: async () => ({ getSettings: async () => ({ agent_id: 'AG1' }), listMessagesInteractifs: liste }),
  });
  it('un 404 sur la liste vaut « aucun message », un 429 lève (sinon le formulaire resterait bloqué ou s’ouvrirait)', async () => {
    expect(await messagesInteractifsDuFormulaire(deps(async () => { throw new MetaApiError(404, { message: 'x' }); }), 't1', '42')).toEqual([]);
    await expect(messagesInteractifsDuFormulaire(deps(async () => { throw new MetaApiError(429, { message: 'x' }); }), 't1', '42')).rejects.toThrow();
  });
});
