import { describe, it, expect } from 'vitest';
import { lireMyDomain } from '../src/salesforce/my-domain';

/**
 * L'ADRESSE D'ORG SAISIE PAR UN CLIENT : la vérification du TEXTE (la résolution se vérifie ailleurs).
 * Les deux premiers cas reprennent les adresses réelles relevées au lot L0 (Dev Hub et scratch org).
 */
describe('lireMyDomain', () => {
  it.each([
    ['https://orgfarm-83beb5a359-dev-ed.develop.my.salesforce.com', 'https://orgfarm-83beb5a359-dev-ed.develop.my.salesforce.com', 'developer'],
    ['https://momentum-site-9947.scratch.my.salesforce.com', 'https://momentum-site-9947.scratch.my.salesforce.com', 'scratch'],
    ['https://acme.my.salesforce.com', 'https://acme.my.salesforce.com', 'production'],
    ['https://acme--recette.sandbox.my.salesforce.com', 'https://acme--recette.sandbox.my.salesforce.com', 'sandbox'],
  ])('accepte %s', (brut, origine, genre) => {
    expect(lireMyDomain(brut)).toEqual({ ok: true, origine, hote: origine.slice('https://'.length), genre });
  });

  it('ramène l adresse de la barre de navigation (Lightning, Configuration, avec un chemin) à l adresse My Domain', () => {
    expect(lireMyDomain('https://orgfarm-83beb5a359-dev-ed.develop.lightning.force.com/lightning/n/devedapp__Welcome'))
      .toMatchObject({ ok: true, origine: 'https://orgfarm-83beb5a359-dev-ed.develop.my.salesforce.com' });
    expect(lireMyDomain('https://orgfarm-274a3a52c9-dev-ed.develop.my.salesforce-setup.com/lightning/setup/Package/home'))
      .toMatchObject({ ok: true, origine: 'https://orgfarm-274a3a52c9-dev-ed.develop.my.salesforce.com' });
  });

  it('suppose https quand le schéma manque, met en minuscules et retire les espaces', () => {
    expect(lireMyDomain('  ACME.my.salesforce.com/  ')).toMatchObject({ ok: true, origine: 'https://acme.my.salesforce.com' });
  });

  it.each([
    ['', 'vide'],
    ['http://acme.my.salesforce.com', 'http explicite'],
    ['https://acme.my.salesforce.com:8443', 'un port'],
    ['https://moi:secret@acme.my.salesforce.com', 'des identifiants'],
    ['https://login.salesforce.com', 'la connexion générale'],
    ['https://test.salesforce.com', 'la connexion des sandboxes'],
    ['https://acme.my.salesforce.com.evil.example', 'un domaine qui ne fait que COMMENCER comme Salesforce'],
    ['https://evil.example/acme.my.salesforce.com', 'Salesforce dans le chemin seulement'],
    ['https://my.salesforce.com', 'le domaine sans nom d org'],
    ['https://acme.inconnu.my.salesforce.com', 'un qualificatif inconnu'],
    ['https://a.b.develop.my.salesforce.com', 'un label de trop'],
    ['https://-acme.my.salesforce.com', 'un nom qui commence par un tiret'],
    ['https://127.0.0.1', 'une adresse IP'],
    ['ftp://acme.my.salesforce.com', 'un autre schéma'],
  ])('refuse %s (%s), avec une raison lisible', (brut) => {
    const r = lireMyDomain(brut);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.raison.length).toBeGreaterThan(10);
  });
});
