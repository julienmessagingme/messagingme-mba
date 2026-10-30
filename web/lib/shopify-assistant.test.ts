import { describe, it, expect } from 'vitest';
import {
  apercuAffiche, delaiEnClair, etatDuMessage, texteDuModele, textePropose, versTexteAffiche, versTexteServeur,
} from './shopify-assistant';
import { lireEtatShopify } from './api-shopify';
import { EVENEMENTS_SHOPIFY, TEXTES_PROPOSES } from './partage/shopify-messages';

describe('les repères du marchand et ceux du serveur', () => {
  it('🔴 chaque texte proposé fait l’aller et retour sans perte, dans les deux langues de la console', () => {
    for (const e of EVENEMENTS_SHOPIFY) {
      for (const langue of ['fr', 'en'] as const) {
        for (const locale of ['fr', 'en'] as const) {
          const affiche = textePropose(e, langue, locale);
          expect(affiche).not.toContain('{{');
          expect(versTexteServeur(affiche, e)).toEqual({ ok: true, texte: TEXTES_PROPOSES[e][langue] });
        }
      }
    }
  });

  it('les repères se lisent dans les deux langues, sans souci de casse ni d’espaces, et sous leur nom technique', () => {
    expect(versTexteServeur('Bonjour {Prénom}, voici { lien  du panier } et {first name}, {{checkout_url}} !', 'checkout_abandoned'))
      .toEqual({ ok: true, texte: 'Bonjour {{first_name}}, voici {{checkout_url}} et {{first_name}}, {{checkout_url}} !' });
    expect(versTexteAffiche('Hi {{first_name}} !', 'en')).toBe('Hi {first name} !');
  });

  it('un repère collé en NFD (e + accent combinant) est reconnu', () => {
    expect(versTexteServeur('Bonjour {pre\u0301nom} !', 'order_paid')).toEqual({ ok: true, texte: 'Bonjour {{first_name}} !' });
  });

  it('🔴 un repère inconnu, ou une donnée que l’événement ne remplit pas, est signalé avant l’envoi', () => {
    expect(versTexteServeur('Bonjour {prénon}, votre panier : {lien du panier} !', 'order_paid'))
      .toEqual({ ok: false, inconnus: ['{prénon}'], horsEvenement: ['{lien du panier}'] });
  });

  it('le corps d’un modèle chez Meta redevient le texte du marchand', () => {
    expect(texteDuModele('Bonjour {{1}}, panier : {{2}} !', ['first_name', 'checkout_url'], 'fr')).toBe('Bonjour {prénom}, panier : {lien du panier} !');
    // Une variable sans donnée connue reste telle quelle : mieux vaut la voir que la perdre.
    expect(texteDuModele('A {{1}} B {{3}}', ['first_name'], 'fr')).toBe('A {prénom} B {{3}}');
  });
});

it('l’aperçu remplace les repères connus par leurs exemples, et laisse le reste', () => {
  expect(apercuAffiche('Bonjour {prénom}, {inconnu} : {lien du panier} !')).toBe('Bonjour Camille, {inconnu} : https://ma-boutique.myshopify.com/checkouts/recover !');
});

describe('l’état d’un message sur la carte', () => {
  const m = (actif: boolean) => ({ evenement: 'checkout_abandoned', modele: 'm', langue: 'fr', variables: [], actif });
  const a = { evenement: 'checkout_abandoned', modele: 'n', langue: 'fr', variables: [], creeLe: null };
  it('🔴 un message actif le reste pendant la validation de sa nouvelle version', () => {
    expect(etatDuMessage({ messages: [m(true)], attentes: [a] }, 'checkout_abandoned')).toBe('actif_nouvelle_version');
    expect(etatDuMessage({ messages: [m(true)], attentes: [] }, 'checkout_abandoned')).toBe('actif');
  });
  it('🔴 une relance active est active : aucune affirmation du consentement ne la met en pause (2026-10-26)', () => {
    // L'état lu ne porte plus d'affirmation : la relance se lit comme un message de commande.
    const vue = lireEtatShopify({ boutique: { domaine: 'b.myshopify.com', etat: 'connectee' }, messages: [{ ...m(true) }, { ...m(true), evenement: 'order_paid' }] })!;
    expect(etatDuMessage(vue, 'checkout_abandoned')).toBe('actif');
    expect(etatDuMessage(vue, 'order_paid')).toBe('actif');
  });
  it('les autres états', () => {
    expect(etatDuMessage({ messages: [], attentes: [] }, 'checkout_abandoned')).toBe('a_regler');
    expect(etatDuMessage({ messages: [], attentes: [a] }, 'checkout_abandoned')).toBe('en_validation');
    expect(etatDuMessage({ messages: [m(false)], attentes: [] }, 'checkout_abandoned')).toBe('arrete');
    expect(etatDuMessage({ messages: [m(false)], attentes: [a] }, 'checkout_abandoned')).toBe('arrete_nouvelle_version');
    expect(etatDuMessage({ messages: [m(true)], attentes: [a] }, 'order_paid')).toBe('a_regler');
  });
});

it('le délai en clair', () => {
  expect([15, 60, 90, 180, 1440, 4320].map(delaiEnClair)).toEqual(['15 min', '1 h', '1 h 30', '3 h', '24 h', '72 h']);
});

describe('la lecture de l’état', () => {
  it('lit l’origine, les données des messages et les attentes ; une ligne mal formée est écartée', () => {
    const v = lireEtatShopify({
      boutique: { domaine: 'b.myshopify.com', nom: 'B', etat: 'connectee', origine: 'console', consentement: { le: '2026-10-22T00:00:00Z' } },
      messages: [{ evenement: 'order_paid', modele: 'm', langue: 'fr', variables: ['first_name', 3], actif: true }, { evenement: 1 }],
      attentes: [{ evenement: 'checkout_abandoned', modele: 'n', langue: 'fr', variables: ['checkout_url'], creeLe: '2026-10-22T00:00:00Z' }, null],
    });
    expect(v?.boutique).toMatchObject({ origine: 'console' });
    // L'affirmation qu'une API d'avant le 2026-10-26 rend encore n'est plus lue.
    expect(v?.boutique).not.toHaveProperty('consentementLe');
    expect(v?.messages).toEqual([{ evenement: 'order_paid', modele: 'm', langue: 'fr', variables: ['first_name'], actif: true }]);
    expect(v?.attentes).toEqual([{ evenement: 'checkout_abandoned', modele: 'n', langue: 'fr', variables: ['checkout_url'], creeLe: '2026-10-22T00:00:00Z' }]);
  });
  it('🔴 une API plus ancienne (sans origine ni attentes) ne casse pas l’écran : l’origine retombe sur Claude Code', () => {
    const v = lireEtatShopify({ boutique: { domaine: 'b.myshopify.com', etat: 'connectee' }, messages: [] });
    expect(v?.boutique?.origine).toBe('claude_code');
    expect(v?.attentes).toEqual([]);
    // Les récupérés (plan 2026-10-30) absents : zéro et aucune ligne, jamais une exception.
    expect(v?.paniers).toEqual({ relances: {}, fermesATemps: 0, enAttente: 0, relancesParties: 0, recuperes: 0, montantsRecuperes: [], recuperesTest: 0 });
  });

  it('lit les relances parties et les récupérés des 7 jours, une ligne de montant mal formée écartée (plan 2026-10-30)', () => {
    const v = lireEtatShopify({
      boutique: { domaine: 'b.myshopify.com', etat: 'connectee' }, messages: [],
      paniers: {
        relances: { envoye: 3 }, fermesATemps: 1, enAttente: 2, relancesParties: 4, recuperes: 2, recuperesTest: 1,
        montantsRecuperes: [{ devise: 'EUR', montant: '59.9' }, { devise: 'EUR', montant: '12,5' }, { montant: '3' }],
      },
    });
    expect(v?.paniers).toEqual({
      relances: { envoye: 3 }, fermesATemps: 1, enAttente: 2,
      relancesParties: 4, recuperes: 2, montantsRecuperes: [{ devise: 'EUR', montant: '59.9' }], recuperesTest: 1,
    });
  });
});
