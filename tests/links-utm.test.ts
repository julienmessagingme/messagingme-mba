import { describe, it, expect } from 'vitest';
import { avecUtm, modeleDesUtm } from '../src/links/utm';

/**
 * LES UTM DE NOS LIENS TRACÉS (plan 2026-10-28, tâche 6a) : Shopify les relit dans le parcours client de la commande, et
 * c'est la preuve qu'une vente vient de notre message (mesuré sur la commande #1003 de la boutique de dev).
 */
describe('les UTM de nos liens', () => {
  it('avecUtm ajoute source, medium et campagne (le nom du modèle)', () => {
    expect(avecUtm('https://boutique.fr/produits/pull?taille=m', 'soldes_hiver'))
      .toBe('https://boutique.fr/produits/pull?taille=m&utm_source=whatsapp&utm_medium=messagingme&utm_campaign=soldes_hiver');
    expect(avecUtm('https://boutique.fr/#avis', 'noel')).toBe('https://boutique.fr/?utm_source=whatsapp&utm_medium=messagingme&utm_campaign=noel#avis');
  });

  it('🔴 avecUtm garde la requête du marchand OCTET POUR OCTET : il ajoute, il ne réécrit rien', () => {
    expect(avecUtm('https://site.fr/r?q=%E9t%E9&a=1;b=2&ref&p=a/b,c:d', 'noel'))
      .toBe('https://site.fr/r?q=%E9t%E9&a=1;b=2&ref&p=a/b,c:d&utm_source=whatsapp&utm_medium=messagingme&utm_campaign=noel');
    expect(avecUtm('https://site.fr/r?', 'noel')).toBe('https://site.fr/r?utm_source=whatsapp&utm_medium=messagingme&utm_campaign=noel');
    expect(avecUtm('https://site.fr/r?x=1', 'promo été')).toBe('https://site.fr/r?x=1&utm_source=whatsapp&utm_medium=messagingme&utm_campaign=promo%20%C3%A9t%C3%A9');
  });

  it('avecUtm n’écrase aucun utm_ déjà présent : le marchand garde son marquage', () => {
    expect(avecUtm('https://boutique.fr/?utm_source=newsletter', 'noel')).toBe('https://boutique.fr/?utm_source=newsletter');
    expect(avecUtm('https://boutique.fr/?UTM_Campaign=x', 'noel')).toBe('https://boutique.fr/?UTM_Campaign=x');
  });

  it('avecUtm laisse une adresse illisible telle quelle', () => {
    expect(avecUtm('pas une adresse', 'noel')).toBe('pas une adresse');
  });

  it('modeleDesUtm ne lit que NOS UTM : source whatsapp ET medium messagingme', () => {
    expect(modeleDesUtm({ source: 'whatsapp', medium: 'messagingme', campaign: 'essai_utm' })).toBe('essai_utm');
    expect(modeleDesUtm({ source: 'whatsapp', medium: 'cpc', campaign: 'essai_utm' })).toBeNull();
    expect(modeleDesUtm({ source: 'newsletter', medium: 'messagingme', campaign: 'x' })).toBeNull();
    expect(modeleDesUtm({ source: 'whatsapp', medium: 'messagingme', campaign: null })).toBeNull();
    expect(modeleDesUtm({ source: 'whatsapp', medium: 'messagingme', campaign: '  ' })).toBeNull();
    expect(modeleDesUtm(null)).toBeNull();
  });
});
