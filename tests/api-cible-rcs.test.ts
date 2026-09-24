import { describe, it, expect } from 'vitest';
import { resoudreCibleRcs, nomDuMessageRcs, PREFIXE_ENVOI_API, type DepsCibleRcs } from '../src/api/cible-rcs';
import { schemaVariables, destinataireAvecVariablesInterdites, VARIABLES_MAX } from '../src/api/variables';

/**
 * LA CIBLE `rcsMessage` DE `/v1/sends` ET LES VARIABLES PAR DESTINATAIRE (spec 2026-09-24, § 3, lot 3).
 */
const RELANCE = { kind: 'text' as const, text: 'Votre commande {{commande}} est prête' };

function deps(over: Partial<DepsCibleRcs> = {}) {
  const lectures: string[] = [];
  const d: DepsCibleRcs = {
    messageRcsParNom: async (_t, nom) => {
      lectures.push(`message:${nom}`);
      if (nom === 'relance-panier') return { name: 'relance-panier', content: RELANCE };
      if (nom === 'illisible') return { name: 'illisible', content: null };
      return null;
    },
    agentIdForTenant: async () => { lectures.push('agent'); return 'agent-1'; },
    ...over,
  };
  return { d, lectures };
}

describe('resoudreCibleRcs', () => {
  it('le message par son nom, et l’agent RCS de l’espace', async () => {
    expect(await resoudreCibleRcs(deps().d, 't1', 'relance-panier')).toEqual({ ok: true, nom: 'relance-panier', agentId: 'agent-1', contenu: RELANCE });
  });

  it('message inconnu : 404 rcs_message_not_found, et l’agent n’est pas lu', async () => {
    const { d, lectures } = deps();
    expect(await resoudreCibleRcs(d, 't1', 'inconnu')).toMatchObject({ ok: false, statut: 404, code: 'rcs_message_not_found' });
    expect(lectures).toEqual(['message:inconnu']);
  });

  it('contenu illisible : 422 unsendable_target ; canal éteint : 409 rcs_not_enabled', async () => {
    expect(await resoudreCibleRcs(deps().d, 't1', 'illisible')).toMatchObject({ ok: false, statut: 422, code: 'unsendable_target' });
    expect(await resoudreCibleRcs(deps({ agentIdForTenant: async () => null }).d, 't1', 'relance-panier'))
      .toMatchObject({ ok: false, statut: 409, code: 'rcs_not_enabled' });
  });
});

describe('nomDuMessageRcs', () => {
  it('un envoi RCS de l’API : le nom du message, derrière le préfixe', () => {
    expect(nomDuMessageRcs('[API] relance-panier')).toBe('relance-panier');
  });

  it('🔴 un nom de 120 caractères (la borne de la bibliothèque) revient ENTIER', () => {
    const nom = 'x'.repeat(120);
    expect(nomDuMessageRcs(`${PREFIXE_ENVOI_API}${nom}`)).toBe(nom);
  });

  it('🔴 une campagne RCS créée dans la console (sans préfixe) ne désigne AUCUN message : null, jamais son nom', () => {
    // Elle ne garde que le CONTENU du message : son nom de campagne n'est pas un nom de la bibliothèque.
    expect(nomDuMessageRcs('Soldes d’automne')).toBeNull();
    // Le préfixe seul, sans nom derrière, non plus.
    expect(nomDuMessageRcs(PREFIXE_ENVOI_API)).toBeNull();
  });
});

describe('les variables d’un destinataire', () => {
  it('accepte des textes nommés comme les {{variables}} d’un message RCS', () => {
    expect(schemaVariables.safeParse({ commande: '8412', 'date.rdv': '2026-10-01' }).success).toBe(true);
  });

  it('refuse un nom mal formé, un nom réservé, une valeur trop longue ou non texte, trop de variables', () => {
    expect(schemaVariables.safeParse({ 'a b': 'x' }).success).toBe(false);
    expect(schemaVariables.safeParse(JSON.parse('{"__proto__": "x"}')).success).toBe(false);
    expect(schemaVariables.safeParse({ commande: 'x'.repeat(1025) }).success).toBe(false);
    expect(schemaVariables.safeParse({ commande: 8412 }).success).toBe(false);
    expect(schemaVariables.safeParse(Object.fromEntries(Array.from({ length: VARIABLES_MAX + 1 }, (_v, i) => [`v${i}`, 'x']))).success).toBe(false);
  });

  it('🔴 un scénario ou un bloc n’a nulle part où les ranger : l’index du premier destinataire REÇU qui en porte', () => {
    expect(destinataireAvecVariablesInterdites('scenario', [{}, { variables: { a: 'b' } }])).toBe(1);
    // Les destinataires tels que reçus : `null` ou une chaîne nue ne portent rien, ils ne font pas lever.
    expect(destinataireAvecVariablesInterdites('node', [null, '+33612345678', { variables: {} }])).toBe(2);
    expect(destinataireAvecVariablesInterdites('scenario', [{ contactId: 'c1' }])).toBeNull();
    expect(destinataireAvecVariablesInterdites('template', [{ variables: { a: 'b' } }])).toBeNull();
    expect(destinataireAvecVariablesInterdites('rcsMessage', [{ variables: { a: 'b' } }])).toBeNull();
  });
});
