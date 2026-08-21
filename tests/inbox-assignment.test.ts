import { describe, it, expect } from 'vitest';
import { peutEcrire, peutAffecter } from '../src/inbox/assignment';

const agent = (id: string) => ({ userId: id, role: 'agent' });
const manager = { userId: 'm1', role: 'manager' };
const admin = { userId: 'a1', role: 'admin' };

describe('peutEcrire : qui répond dans une conversation', () => {
  it('non affectée -> tout le monde peut répondre, agents compris', () => {
    expect(peutEcrire(agent('u1'), null)).toBe(true);
    expect(peutEcrire(agent('u2'), null)).toBe(true);
    expect(peutEcrire(manager, null)).toBe(true);
    expect(peutEcrire(admin, null)).toBe(true);
  });

  it('affectée -> l’agent désigné peut répondre', () => {
    expect(peutEcrire(agent('u1'), 'u1')).toBe(true);
  });

  it('🔴 affectée -> un AUTRE agent ne peut pas', () => {
    // C'est tout l'objet de l'affectation : sans ce refus, elle ne serait qu'une étiquette décorative.
    expect(peutEcrire(agent('u2'), 'u1')).toBe(false);
  });

  it('manager et admin peuvent TOUJOURS reprendre la main', () => {
    expect(peutEcrire(manager, 'u1')).toBe(true);
    expect(peutEcrire(admin, 'u1')).toBe(true);
  });

  it('🔴 sans identité, on refuse (fail-closed)', () => {
    // Un câblage sans authentification ne doit pas se retrouver à écrire dans une conversation confiée à
    // quelqu'un. En cas de doute sur l'identité, la bonne réponse est non.
    expect(peutEcrire({ userId: null, role: 'agent' }, 'u1')).toBe(false);
    expect(peutEcrire({ userId: null, role: null }, 'u1')).toBe(false);
    // En revanche une conversation que PERSONNE ne s'est vu confier reste ouverte : la refuser bloquerait
    // les réponses là où il n'y a rien à protéger.
    expect(peutEcrire({ userId: null, role: null }, null)).toBe(true);
  });

  it('un rôle inconnu n’ouvre aucun droit', () => {
    expect(peutEcrire({ userId: 'u9', role: 'superviseur' }, 'u1')).toBe(false);
    expect(peutEcrire({ userId: 'u9', role: 'ADMIN' }, 'u1')).toBe(false); // pas de tolérance de casse
  });
});

describe('peutAffecter : qui distribue le travail', () => {
  it('manager et admin affectent ; un agent non', () => {
    expect(peutAffecter(manager)).toBe(true);
    expect(peutAffecter(admin)).toBe(true);
    expect(peutAffecter(agent('u1'))).toBe(false);
    expect(peutAffecter({ userId: null, role: null })).toBe(false);
  });
});

/**
 * 🔴 `assignedTo` et `controlOwner` sont deux dimensions INDÉPENDANTES, et c'est le piège central du lot.
 *
 *   controlOwner -> QU'EST-CE QUI parle : le scénario, un humain, ou l'agent de Meta.
 *   assignedTo   -> QUEL HUMAIN en a la charge.
 *
 * Les confondre casserait le gel de scénario construit en août : affecter une conversation prendrait le fil
 * au scénario sans que personne l'ait demandé, ou inversement rendre la main effacerait l'affectation.
 */
describe('affectation et contrôle du fil ne se mélangent pas', () => {
  it('la règle d’écriture ignore totalement le détenteur du fil', () => {
    // `peutEcrire` ne reçoit même pas `controlOwner` : c'est la garantie structurelle. Si un jour quelqu'un
    // le lui passait, ce test ne compilerait plus, ce qui est exactement le signal voulu.
    for (const assignee of [null, 'u1']) {
      const attendu = assignee === null;
      expect(peutEcrire(agent('u2'), assignee)).toBe(attendu);
    }
  });

  it('une conversation affectée peut rester tenue par le scénario', () => {
    // Rien dans cette règle n'empêche `control_owner = app_workflow` avec un affectataire : l'affectation
    // dit qui s'en occupe, pas qui parle. C'est un état parfaitement normal, pas une incohérence à corriger.
    expect(peutEcrire(agent('u1'), 'u1')).toBe(true);
    expect(peutAffecter(manager)).toBe(true);
  });
});
