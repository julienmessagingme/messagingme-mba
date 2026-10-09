import { describe, it, expect } from 'vitest';
import { porteDesChamps, refusChampsUrl, remplirChampsUrl, valeursDeLaFiche } from '../src/links/champs-url';
import { analyserChampsUrl } from '../web/lib/partage/champs-url';

describe('analyserChampsUrl : la règle lue sur le TEXTE de l’adresse', () => {
  it('une adresse sans accolade n’a aucun champ (toutes les adresses d’avant ce lot)', () => {
    expect(analyserChampsUrl('https://client.fr/promo?a=1#b')).toEqual({ ok: true, cles: [] });
  });

  it('les champs du chemin, de la requête et du fragment, dédoublonnés dans leur ordre', () => {
    expect(analyserChampsUrl(' https://client.fr/c/{numero}/{prenom}?n={nom}&r={numero}#{telephone} '))
      .toEqual({ ok: true, cles: ['numero', 'prenom', 'nom', 'telephone'] });
    expect(analyserChampsUrl('https://client.fr?{a}')).toEqual({ ok: true, cles: ['a'] });
    expect(analyserChampsUrl('https://client.fr#{a}')).toEqual({ ok: true, cles: ['a'] });
  });

  it('🔴 avant le chemin (schéma, utilisateur, hôte, port), c’est un refus', () => {
    for (const url of [
      'https://{a}.client.fr/x', 'https://client.{a}/x', 'https://client.fr{a}/x', 'https://{a}@client.fr/x',
      'https://u:{a}@client.fr/x', 'https://client.fr:{a}/x', 'http{a}://client.fr/x', '{a}://client.fr/x',
      'client.fr/{a}', 'https:client.fr/{a}',
      // Un antislash termine l'autorité pour le navigateur, pas pour cette règle : refusé, jamais accepté à tort.
      'https://client.fr\\{a}',
    ]) {
      expect(analyserChampsUrl(url), url).toEqual({ ok: false, raison: 'avant_le_chemin' });
    }
  });

  it('accolade orpheline, champ vide, clé mal formée, mélange avec {{1}}', () => {
    expect(analyserChampsUrl('https://client.fr/{a')).toEqual({ ok: false, raison: 'accolade' });
    expect(analyserChampsUrl('https://client.fr/a}')).toEqual({ ok: false, raison: 'accolade' });
    expect(analyserChampsUrl('https://client.fr/{}')).toEqual({ ok: false, raison: 'champ_vide', jeton: '{}' });
    expect(analyserChampsUrl('https://client.fr/{a-b}')).toEqual({ ok: false, raison: 'cle_mal_formee', jeton: '{a-b}' });
    expect(analyserChampsUrl('https://client.fr/{a}/{{1}}')).toEqual({ ok: false, raison: 'variable_meta' });
  });

  it('une adresse dynamique de Meta seule ({{1}}) garde son comportement : aucun champ', () => {
    expect(analyserChampsUrl('https://client.fr/produit/{{1}}')).toEqual({ ok: true, cles: [] });
    expect(porteDesChamps('https://client.fr/produit/{{1}}')).toBe(false);
  });
});

describe('refusChampsUrl', () => {
  it('les champs de base passent sans être déclarés, les autres doivent l’être', () => {
    expect(refusChampsUrl('https://client.fr/{prenom}/{nom}/{telephone}', [], 'bouton 1')).toBeNull();
    expect(refusChampsUrl('https://client.fr/{numero}', ['numero'], 'bouton 1')).toBeNull();
    expect(refusChampsUrl('https://client.fr/{numero}', [], 'bouton 2')).toBe('bouton 2 : le champ {numero} n\'existe pas dans vos champs de contact');
    expect(refusChampsUrl('https://client.fr/promo', [], 'bouton 1')).toBeNull();
  });
});

describe('remplirChampsUrl', () => {
  it('remplace, encode, et retire un champ sans valeur', () => {
    expect(remplirChampsUrl('https://client.fr/c/{n}?p={prenom}', { n: 'A 1/2', prenom: 'Zoé' }))
      .toBe('https://client.fr/c/A%201%2F2?p=Zo%C3%A9');
    expect(remplirChampsUrl('https://client.fr/c/{n}', { n: '' })).toBe('https://client.fr/c/');
    expect(remplirChampsUrl('https://client.fr/c/{n}', null)).toBe('https://client.fr/c/');
  });

  it('🔴 une clé du prototype n’est jamais lue (`constructor` a la forme d’une clé)', () => {
    expect(remplirChampsUrl('https://client.fr/{constructor}', {})).toBe('https://client.fr/');
  });

  it('une destination sans champ ou qui ne se laisse pas analyser est rendue telle quelle', () => {
    for (const d of ['https://client.fr/promo', 'https://{x}.client.fr/', 'https://client.fr/a}']) {
      expect(remplirChampsUrl(d, { x: 'evil.com' }), d).toBe(d);
    }
  });
});

describe('valeursDeLaFiche', () => {
  it('les champs de la fiche, plus `nom` (le nom du profil) et `telephone`', () => {
    const v = valeursDeLaFiche({ profile_name: 'Julie', phone_e164: '+33612345678', fields: { prenom: 'Julie', numero_commande: 'A1', age: 30, actif: true, objet: { a: 1 } } });
    expect({ ...v }).toEqual({ prenom: 'Julie', numero_commande: 'A1', age: '30', actif: 'true', objet: null, nom: 'Julie', telephone: '+33612345678' });
    expect(Object.getPrototypeOf(v)).toBeNull();
  });
});
