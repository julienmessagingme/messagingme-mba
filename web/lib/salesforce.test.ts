import { describe, it, expect } from 'vitest';
import {
  lireSalesforceActif, lireIntegrationSalesforce, etatCarteSalesforce, phraseEtatOrg, lireRefusConnexion, lienEtape,
  type IntegrationSalesforceVue, type OrgSalesforceVue,
} from './salesforce';

const t = (fr: string): string => fr;
const org = (etat: OrgSalesforceVue['etat']): OrgSalesforceVue => ({
  orgId: '00DQL00000ch3nx2AA', myDomain: 'https://acme.my.salesforce.com', sandbox: false, etat, motifCoupure: null,
  quota: null, consentementLead: null, consentementContact: null, envoyerResume: false, proprietaireRepli: null, connecteeLe: null,
});
const vue = (o: Partial<IntegrationSalesforceVue> = {}): IntegrationSalesforceVue => ({
  actif: true, cleAppPosee: true, chiffrementPret: true, liensInstallation: null, org: null, ...o,
});

describe('lireSalesforceActif', () => {
  it('rend le booléen tel quel, et un champ absent ou bancal est INCONNU', () => {
    expect(lireSalesforceActif({ salesforceActif: true })).toBe(true);
    expect(lireSalesforceActif({ salesforceActif: false })).toBe(false);
    expect(lireSalesforceActif({})).toBeUndefined();
    expect(lireSalesforceActif({ salesforceActif: 'oui' })).toBeUndefined();
    expect(lireSalesforceActif(null)).toBeUndefined();
  });
});

describe('lireIntegrationSalesforce', () => {
  it('lit une réponse complète', () => {
    const r = lireIntegrationSalesforce({ actif: true, cleAppPosee: true, chiffrementPret: true, liensInstallation: { production: 'p', sandbox: 's' }, org: org('connectee') });
    expect(r?.org?.etat).toBe('connectee');
    expect(r?.liensInstallation).toEqual({ production: 'p', sandbox: 's' });
  });

  it('🔴 un {} (route absente, API plus ancienne) n est ni une panne ni « connectée » : null', () => {
    expect(lireIntegrationSalesforce({})).toBeNull();
    expect(lireIntegrationSalesforce(null)).toBeNull();
    expect(lireIntegrationSalesforce('texte')).toBeNull();
  });

  it('une org de forme inattendue rend l ensemble illisible, plutôt qu un état inventé', () => {
    expect(lireIntegrationSalesforce({ actif: true, cleAppPosee: true, chiffrementPret: true, org: { orgId: 'x', myDomain: 'y', etat: 'inconnu' } })).toBeNull();
  });

  it('sans liens d installation (package pas encore publié) : null, jamais des liens recomposés', () => {
    expect(lireIntegrationSalesforce({ actif: false, cleAppPosee: true, chiffrementPret: true, org: null })?.liensInstallation).toBeNull();
  });
});

describe('etatCarteSalesforce', () => {
  it('🔴 l extinction est bloquée tant qu une org est reliée, QUEL QUE SOIT son état', () => {
    for (const e of ['connexion', 'connectee', 'en_pause', 'coupee'] as const) {
      expect(etatCarteSalesforce(vue({ org: org(e) })).extinctionBloquee).toBe(true);
    }
    expect(etatCarteSalesforce(vue()).extinctionBloquee).toBe(false);
    expect(etatCarteSalesforce(vue({ actif: false, org: org('connectee') })).extinctionBloquee).toBe(false);
  });

  it('la connexion n est proposée qu allumé ET quand la clé d app est posée sur l instance', () => {
    expect(etatCarteSalesforce(vue()).proposerConnexion).toBe(true);
    expect(etatCarteSalesforce(vue({ actif: false })).proposerConnexion).toBe(false);
    expect(etatCarteSalesforce(vue({ cleAppPosee: false })).proposerConnexion).toBe(false);
  });
});

describe('phraseEtatOrg', () => {
  it('dit chaque état sans le préfixe https', () => {
    expect(phraseEtatOrg(null, t)).toContain('Aucune org');
    expect(phraseEtatOrg(org('connectee'), t)).toBe('Reliée à acme.my.salesforce.com.');
    expect(phraseEtatOrg(org('coupee'), t)).toContain('Reconnectez');
    expect(phraseEtatOrg(org('connexion'), t)).toContain('inachevée');
  });
});

describe('lireRefusConnexion', () => {
  it('lit les manques et ne garde que les étapes connues du guide', () => {
    expect(lireRefusConnexion({ manques: [{ etape: 'package', message: 'absent' }, { etape: 'inventee', message: 'x' }] }))
      .toEqual({ manques: [{ etape: 'package', message: 'absent' }] });
  });

  it('lit une panne passagère', () => {
    expect(lireRefusConnexion({ passager: true, error: 'réessayez' })).toEqual({ passager: 'réessayez' });
  });

  it('rend null pour toute autre forme', () => {
    expect(lireRefusConnexion({})).toBeNull();
    expect(lireRefusConnexion({ manques: [] })).toBeNull();
  });

  it('chaque étape mène à son ancre du guide', () => {
    expect(lienEtape('run-as')).toBe('/tuto-salesforce#run-as');
  });
});
