import { describe, it, expect } from 'vitest';
import { variablesDe, aDesVariables, appliquerVariables } from '../src/rcs/variables';
import type { RcsOutbound } from '../src/rcs/types';

describe('Variables d un message RCS', () => {
  it('liste les variables dans l ordre, sans doublon', () => {
    const msg: RcsOutbound = { kind: 'text', text: 'Bonjour {{prenom}}, votre RDV du {{date}} — {{ prenom }} ?' };
    expect(variablesDe(msg)).toEqual(['prenom', 'date']);
    expect(aDesVariables(msg)).toBe(true);
    expect(aDesVariables({ kind: 'text', text: 'Bonjour' })).toBe(false);
  });

  it('lit aussi le titre et la description d une carte', () => {
    const msg: RcsOutbound = {
      kind: 'card',
      card: { title: 'Offre {{ville}}', description: 'Pour vous {{prenom}}', mediaUrl: 'https://x/i.png' },
    };
    expect(variablesDe(msg)).toEqual(['ville', 'prenom']);
  });

  it('substitue le corps, et rend du VIDE pour une valeur absente', () => {
    const rendu = appliquerVariables(
      { kind: 'text', text: 'Bonjour {{prenom}}, {{inconnu}}fin' },
      { prenom: 'Julien' },
    );
    expect(rendu).toEqual({ kind: 'text', text: 'Bonjour Julien, fin' });
  });

  it('substitue dans une carte sans toucher a son image', () => {
    const rendu = appliquerVariables(
      { kind: 'card', card: { title: 'Offre {{ville}}', description: 'Bonjour {{prenom}}', mediaUrl: 'https://x/i.png', mediaHeight: 'TALL' } },
      { ville: 'Lyon', prenom: 'Julien' },
    );
    expect(rendu).toEqual({
      kind: 'card',
      card: { title: 'Offre Lyon', description: 'Bonjour Julien', mediaUrl: 'https://x/i.png', mediaHeight: 'TALL' },
    });
  });

  // 🔴 La limite est un CHOIX. Un libelle de bouton est plafonne a 25 caracteres et une URL doit rester une
  // URL : substituer la dedans, c'est risquer de faire refuser le message ENTIER par le fournisseur pour un
  // gain nul. Ce test fige la decision, pour qu'elle ne soit pas « corrigee » par megarde.
  it('ne substitue PAS dans les libelles de boutons ni dans les URL', () => {
    const rendu = appliquerVariables(
      {
        kind: 'text',
        text: 'Bonjour {{prenom}}',
        suggestions: [
          { kind: 'reply', text: 'Oui {{prenom}}', postbackData: 'btn:0' },
          { kind: 'openUrl', text: 'Voir', url: 'https://x/{{prenom}}', postbackData: 'btn:1' },
        ],
      },
      { prenom: 'Julien' },
    );
    expect(rendu).toEqual({
      kind: 'text',
      text: 'Bonjour Julien',
      suggestions: [
        { kind: 'reply', text: 'Oui {{prenom}}', postbackData: 'btn:0' },
        { kind: 'openUrl', text: 'Voir', url: 'https://x/{{prenom}}', postbackData: 'btn:1' },
      ],
    });
  });

  // Le rendu est du TEXTE BRUT : un message RCS n'est pas du HTML, echapper y ecrirait `&amp;` en toutes
  // lettres sur le telephone du contact.
  it('n echappe PAS le HTML : le RCS est du texte brut', () => {
    expect(appliquerVariables({ kind: 'text', text: 'Chez {{societe}}' }, { societe: 'Dupont & Fils' }))
      .toEqual({ kind: 'text', text: 'Chez Dupont & Fils' });
  });

  it('ne lit aucune cle heritee d Object.prototype', () => {
    const rendu = appliquerVariables({ kind: 'text', text: 'x{{constructor}}y{{__proto__}}z' }, { prenom: 'Julien' });
    expect(rendu).toEqual({ kind: 'text', text: 'xyz' });
  });
});
