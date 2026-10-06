import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { SignJWT } from 'jose';
import {
  signLienNumero, verifyLienNumero, DUREE_LIEN_NUMERO_MS, type LienNumero,
  signSession, verifySession, signChoice, verifyChoice, verifyMfa, verifySessionOps,
  signDemandeOauth, verifyDemandeOauth, signChoixOauth, verifyChoixOauth,
} from '../src/auth/token';

/**
 * LE JETON DU LIEN DE CONNEXION DU NUMÉRO (lot 3c, livraison A, tâche 1). Claude Code le met dans le lien qu'il donne :
 * il ouvre la page « Connecter WhatsApp » d'UN espace sans la console. 🔴 Ce n'est jamais une session : `verifySession`
 * le refuse, donc aucune route d'espace ne s'ouvre avec lui ; seule la garde de la connexion du numéro le lit.
 */
describe('le jeton du lien de connexion du numéro', () => {
  const SECRET = randomBytes(32).toString('hex');
  const lien: LienNumero = { tenantId: 't-1', userId: 'u-1', mode: 'fourni' };
  const cle = new TextEncoder().encode(SECRET);

  it('se relit tel qu’il a été signé, pour les deux modes', async () => {
    expect(await verifyLienNumero(await signLienNumero(lien, SECRET), SECRET)).toEqual(lien);
    const apporte: LienNumero = { ...lien, mode: 'apporte' };
    expect(await verifyLienNumero(await signLienNumero(apporte, SECRET), SECRET)).toEqual(apporte);
  });

  it('🔴 il ne passe pour aucun autre jeton : ni session, ni choix d’espace, ni étape, ni exploitation, ni OAuth', async () => {
    const jeton = await signLienNumero(lien, SECRET);
    expect(await verifySession(jeton, SECRET)).toBeNull();
    expect(await verifyChoice(jeton, SECRET)).toBeNull();
    expect(await verifyMfa(jeton, SECRET)).toBeNull();
    expect(await verifySessionOps(jeton, SECRET)).toBeNull();
    expect(await verifyDemandeOauth(jeton, SECRET)).toBeNull();
    expect(await verifyChoixOauth(jeton, SECRET)).toBeNull();
  });

  it('🔴 et l’inverse : aucun autre jeton ne passe pour un lien, même s’il porte les mêmes champs', async () => {
    const autres = [
      await signSession({ userId: 'u-1', tenantId: 't-1', role: 'admin' }, SECRET),
      await signChoice({ email: 'a@exemple.test', comptes: [{ userId: 'u-1', tenantId: 't-1', role: 'admin' }] }, SECRET),
      await signChoixOauth({ email: 'a@exemple.test', demande: 'x' }, SECRET),
      await signDemandeOauth({
        clientId: 'c', redirectUri: 'http://localhost/cb', codeChallenge: 'x', scopes: ['mcp:write'], state: 's', resource: 'r',
      }, SECRET),
      await new SignJWT({ kind: 'oauth_choix', ...lien }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('5m').sign(cle),
      await new SignJWT({ ...lien }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('5m').sign(cle),
    ];
    for (const jeton of autres) expect(await verifyLienNumero(jeton, SECRET)).toBeNull();
  });

  it('🔴 signé d’un autre secret, échu, ou mal formé : refusé', async () => {
    expect(await verifyLienNumero(await signLienNumero(lien, randomBytes(32).toString('hex')), SECRET)).toBeNull();
    const maintenant = Math.floor(Date.now() / 1000);
    const echu = await new SignJWT({ kind: 'lien_numero', ...lien })
      .setProtectedHeader({ alg: 'HS256' }).setIssuedAt(maintenant - 7200).setExpirationTime(maintenant - 1).sign(cle);
    expect(await verifyLienNumero(echu, SECRET)).toBeNull();
    for (const corps of [{ ...lien, mode: 'autre' }, { ...lien, tenantId: '' }, { mode: 'fourni', userId: 'u-1' }]) {
      const jeton = await new SignJWT({ kind: 'lien_numero', ...corps })
        .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1h').sign(cle);
      expect(await verifyLienNumero(jeton, SECRET)).toBeNull();
    }
  });

  it('il vit une heure, et pas davantage', async () => {
    expect(DUREE_LIEN_NUMERO_MS).toBe(3_600_000);
    const [, corps] = (await signLienNumero(lien, SECRET)).split('.');
    const { iat, exp } = JSON.parse(Buffer.from(corps!, 'base64url').toString('utf8')) as { iat: number; exp: number };
    expect(exp - iat).toBe(3600);
  });
});
