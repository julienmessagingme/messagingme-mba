import { describe, it, expect } from 'vitest';
import { waIdDepuisEntete, formeEntete, lireValeursModele, texteErreur, baseDuRelais, corpsIllisible } from '../src/mba/relais';
import type { VariableDeclaree } from '../src/agent/requetes';

/**
 * La moitié PURE du relais du Meta Business Agent (spec 2026-09-21-relais-mba-design.md) : lire le numéro que
 * Meta remplit, le mesurer sans le divulguer, et valider ce que le modèle de Meta envoie.
 */
describe('le numéro que Meta remplit', () => {
  it('se ramène à ses chiffres, avec ou sans +, espaces ou tirets', () => {
    expect(waIdDepuisEntete('+33 6 12-34-56-78')).toBe('33612345678');
    expect(waIdDepuisEntete('33612345678')).toBe('33612345678');
  });

  it('🔴 absent, vide, trop court ou d’un mauvais type : aucun contact', () => {
    for (const v of [undefined, null, '', '   ', '+12', 42, ['336']]) expect(waIdDepuisEntete(v)).toBeNull();
  });

  it('une valeur qui n’a pas la forme d’un numéro est gardée : c’est peut-être un BSUID', () => {
    expect(waIdDepuisEntete('FR.abc123')).toBe('FR.abc123');
  });

  it('🔴 la forme mesurée ne contient JAMAIS le numéro', () => {
    const f = formeEntete('+33612345678');
    expect(f).toBe('len=12 plus=true chiffres=true');
    expect(f).not.toContain('612345678');
    expect(formeEntete(undefined)).toBe('absent');
  });
});

const VARS: VariableDeclaree[] = [
  { nom: 'user', type: 'string', origine: { type: 'modele' }, requis: true },
  { nom: 'couleur', type: 'string', origine: { type: 'modele' }, enum: ['rouge', 'vert'] },
  { nom: 'qte', type: 'integer', origine: { type: 'modele' } },
  { nom: 'tag', type: 'string', origine: { type: 'champ', cle: 'tag_ns' }, requis: true },
];

describe('les valeurs que le modèle de Meta envoie', () => {
  it('ne garde que les variables d’origine modèle', () => {
    expect(lireValeursModele(VARS, { user: 'u1', tag: 'PIRATE', inconnu: 1 })).toEqual({ ok: true, valeurs: { user: 'u1' } });
  });

  it('🔴 une variable CHAMP ne peut pas être imposée par le modèle', () => {
    // Elle vient du mini-CRM : si le modèle pouvait l'imposer, il enverrait l'étiquette de son choix.
    const r = lireValeursModele(VARS, { user: 'u1', tag: 'PIRATE' });
    expect(r.ok && 'tag' in r.valeurs).toBe(false);
  });

  it('refuse une requise absente, une valeur hors liste, un mauvais type, en les NOMMANT', () => {
    expect(lireValeursModele(VARS, {})).toEqual({ ok: false, erreur: 'valeur manquante ou invalide pour : user' });
    expect(lireValeursModele(VARS, { user: 'u', couleur: 'bleu' })).toEqual({ ok: false, erreur: 'valeur manquante ou invalide pour : couleur' });
    expect(lireValeursModele(VARS, { user: 'u', qte: 1.5 })).toEqual({ ok: false, erreur: 'valeur manquante ou invalide pour : qte' });
  });

  it('🔴 les valeurs permises valent AUSSI pour un nombre', () => {
    // L'écran d'une requête accepte une liste sur un entier, et la description publiée chez Meta l'annonce.
    const qte: VariableDeclaree[] = [{ nom: 'qte', type: 'integer', origine: { type: 'modele' }, requis: true, enum: ['1', '2'] }];
    expect(lireValeursModele(qte, { qte: 2 })).toEqual({ ok: true, valeurs: { qte: 2 } });
    expect(lireValeursModele(qte, { qte: 3 })).toEqual({ ok: false, erreur: 'valeur manquante ou invalide pour : qte' });
  });

  it('🔴 une valeur permise saisie « 1.0 » accepte le 1 que le modèle envoie', () => {
    const prix: VariableDeclaree[] = [{ nom: 'prix', type: 'number', origine: { type: 'modele' }, requis: true, enum: ['1.0', '2.5'] }];
    expect(lireValeursModele(prix, { prix: 1 })).toEqual({ ok: true, valeurs: { prix: 1 } });
    expect(lireValeursModele(prix, { prix: 2.5 })).toEqual({ ok: true, valeurs: { prix: 2.5 } });
    expect(lireValeursModele(prix, { prix: 3 }).ok).toBe(false);
  });

  it('une facultative à null est simplement omise', () => {
    expect(lireValeursModele(VARS, { user: 'u', couleur: null })).toEqual({ ok: true, valeurs: { user: 'u' } });
  });

  it('un corps qui n’est pas un objet est refusé en le disant', () => {
    expect(lireValeursModele(VARS, 'texte')).toEqual({ ok: false, erreur: 'le corps de la requête doit être un objet JSON' });
    expect(lireValeursModele(VARS, [1])).toEqual({ ok: false, erreur: 'le corps de la requête doit être un objet JSON' });
  });

  it('aucune variable modèle : un corps absent passe', () => {
    expect(lireValeursModele([VARS[3]!], undefined)).toEqual({ ok: true, valeurs: {} });
  });
});

describe('le message d’échec rendu à Meta', () => {
  it('reprend le message SÛR du point de passage', () => {
    expect(texteErreur({ erreur: 'le système du client est indisponible' })).toBe('le système du client est indisponible');
    expect(texteErreur(null)).toBe('l’appel a échoué');
  });

describe('l’adresse et le corps du relais', () => {
  it('la base du connecteur se dérive de l’adresse publique, barre finale ou pas', () => {
    expect(baseDuRelais('https://api.messagingme.app')).toBe('https://api.messagingme.app/mba/relais');
    expect(baseDuRelais('https://api.messagingme.app//')).toBe('https://api.messagingme.app/mba/relais');
    expect(baseDuRelais('  ')).toBeNull();
  });

  it('un corps vide n’est pas illisible ; un JSON tronqué l’est', () => {
    expect(corpsIllisible(undefined)).toBe(false);
    expect(corpsIllisible(Buffer.from(''))).toBe(false);
    expect(corpsIllisible(Buffer.from('{"user":"u1"}'))).toBe(false);
    expect(corpsIllisible(Buffer.from('{pas du json'))).toBe(true);
  });
});
});
