import { describe, it, expect } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { verifierSignatureStripe, TOLERANCE_SIGNATURE_S } from '../src/stripe/signature';

/**
 * LA SIGNATURE D'UN WEBHOOK STRIPE : ce qui autorise un appel à créditer de l'argent.
 *
 * 🔴 Le secret est tiré au hasard à chaque exécution, jamais écrit ici : un littéral qui ressemble à un secret Stripe
 * fait sonner `gitleaks`, et finit toujours recopié dans un vrai câblage.
 */
const SECRET = randomBytes(24).toString('hex');
const MAINTENANT_MS = 1_790_000_000_000;
const T = Math.floor(MAINTENANT_MS / 1000);
const CORPS = Buffer.from(JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' }));

/** Signe comme Stripe : HMAC SHA-256 de `<t>.<corps brut>`. */
function signer(corps: Buffer, secret = SECRET, t = T): string {
  return createHmac('sha256', secret).update(`${t}.`).update(corps).digest('hex');
}

describe('verifierSignatureStripe', () => {
  it('une signature valide et fraîche passe', () => {
    expect(verifierSignatureStripe(CORPS, `t=${T},v1=${signer(CORPS)}`, SECRET, MAINTENANT_MS)).toBe(true);
  });

  it('🔴 une signature FALSIFIÉE est refusée', () => {
    const fausse = randomBytes(32).toString('hex');
    expect(verifierSignatureStripe(CORPS, `t=${T},v1=${fausse}`, SECRET, MAINTENANT_MS)).toBe(false);
  });

  it('🔴 signée avec un AUTRE secret : refusée', () => {
    expect(verifierSignatureStripe(CORPS, `t=${T},v1=${signer(CORPS, randomBytes(24).toString('hex'))}`, SECRET, MAINTENANT_MS)).toBe(false);
  });

  it('🔴 un corps MODIFIÉ après signature est refusé : la signature porte sur les octets bruts', () => {
    const autre = Buffer.from(CORPS.toString('utf8').replace('evt_1', 'evt_2'));
    expect(verifierSignatureStripe(autre, `t=${T},v1=${signer(CORPS)}`, SECRET, MAINTENANT_MS)).toBe(false);
  });

  it('🔴 PÉRIMÉE : au-delà de cinq minutes, refusée même bien signée', () => {
    const vieux = T - TOLERANCE_SIGNATURE_S - 1;
    expect(verifierSignatureStripe(CORPS, `t=${vieux},v1=${signer(CORPS, SECRET, vieux)}`, SECRET, MAINTENANT_MS)).toBe(false);
    // La borne elle-même passe : le refus ci-dessus vient bien de l'âge.
    const limite = T - TOLERANCE_SIGNATURE_S;
    expect(verifierSignatureStripe(CORPS, `t=${limite},v1=${signer(CORPS, SECRET, limite)}`, SECRET, MAINTENANT_MS)).toBe(true);
  });

  it('un horodatage trafiqué casse la signature, même frais', () => {
    // `t` est signé : changer l'horodatage pour rajeunir un vieil envoi ne passe pas.
    const vieux = T - 3600;
    expect(verifierSignatureStripe(CORPS, `t=${T},v1=${signer(CORPS, SECRET, vieux)}`, SECRET, MAINTENANT_MS)).toBe(false);
  });

  it('🔴 en-tête ABSENT, vide ou mal formé : refusé', () => {
    expect(verifierSignatureStripe(CORPS, undefined, SECRET, MAINTENANT_MS)).toBe(false);
    expect(verifierSignatureStripe(CORPS, '', SECRET, MAINTENANT_MS)).toBe(false);
    expect(verifierSignatureStripe(CORPS, `v1=${signer(CORPS)}`, SECRET, MAINTENANT_MS)).toBe(false);
    expect(verifierSignatureStripe(CORPS, `t=${T}`, SECRET, MAINTENANT_MS)).toBe(false);
    expect(verifierSignatureStripe(CORPS, `t=abc,v1=${signer(CORPS)}`, SECRET, MAINTENANT_MS)).toBe(false);
  });

  it('🔴 un secret VIDE refuse tout : il signerait avec une clé que tout le monde connaît', () => {
    expect(verifierSignatureStripe(CORPS, `t=${T},v1=${signer(CORPS, '')}`, '', MAINTENANT_MS)).toBe(false);
  });

  it('pendant la rotation d’un secret, UNE des signatures v1 suffit ; une v0 seule ne compte pas', () => {
    const autre = randomBytes(32).toString('hex');
    expect(verifierSignatureStripe(CORPS, `t=${T},v1=${autre},v1=${signer(CORPS)}`, SECRET, MAINTENANT_MS)).toBe(true);
    expect(verifierSignatureStripe(CORPS, `t=${T},v0=${signer(CORPS)}`, SECRET, MAINTENANT_MS)).toBe(false);
  });
});
