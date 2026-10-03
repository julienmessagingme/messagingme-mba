import { describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { SignJWT } from 'jose';
import { verifierPkce, formeDeDefi } from '../src/oauth/pkce';
import { CLIENTS_OAUTH, clientConnu, adresseDeRetourAcceptee } from '../src/oauth/clients';
import { nouveauJeton, formeDeJeton, PREFIXE_ACCES, PREFIXE_RENOUVELLEMENT, PREFIXE_CODE } from '../src/oauth/jetons';
import { baseOauth, metadonneesRessource, metadonneesServeur, enTeteWwwAuthenticate, ressourceMcp } from '../src/oauth/metadonnees';
import { sha256Hex } from '../src/lib/signature';
import {
  signDemandeOauth, verifyDemandeOauth, signChoixOauth, verifyChoixOauth,
  signSession, verifySession, signChoice, verifyChoice, verifyMfa, verifySessionOps,
  type DemandeOauth,
} from '../src/auth/token';

/**
 * LE NOYAU PUR DE L'OAUTH (tâche 2 du plan `2026-10-03-oauth-mcp.md`) : PKCE, clients acceptés, jetons opaques,
 * métadonnées et jetons signés. Aucun serveur, aucune base : ce qui se décide ici se décide sur des chaînes.
 */

const CLAUDE_CODE = clientConnu('https://claude.ai/oauth/claude-code-client-metadata')!;
const CLAUDE_AI = clientConnu('https://claude.ai/oauth/mcp-oauth-client-metadata')!;

describe('PKCE (S256)', () => {
  it('le vecteur de l’annexe B de la RFC 7636', () => {
    expect(verifierPkce('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(true);
    expect(formeDeDefi('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(true);
  });

  it('🔴 un autre vérificateur, ou le défi présenté comme vérificateur (plain), est refusé', () => {
    const defi = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    expect(verifierPkce('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXl', defi)).toBe(false);
    expect(verifierPkce(defi, defi)).toBe(false);
  });

  it('le vérificateur fait 43 à 128 caractères non réservés', () => {
    const defiDe = (v: string) => createHash('sha256').update(v).digest('base64url');
    for (const v of ['a'.repeat(43), 'a'.repeat(128), 'aZ09-._~'.repeat(6)]) expect(verifierPkce(v, defiDe(v))).toBe(true);
    for (const v of ['a'.repeat(42), 'a'.repeat(129), `${'a'.repeat(42)}+`, `${'a'.repeat(42)} `]) expect(verifierPkce(v, defiDe(v))).toBe(false);
  });

  it('le défi a la forme d’un SHA-256 en base64url', () => {
    expect(formeDeDefi('a'.repeat(42))).toBe(false);
    expect(formeDeDefi('a'.repeat(44))).toBe(false);
    expect(formeDeDefi(`${'a'.repeat(42)}=`)).toBe(false);
  });
});

describe('les clients acceptés', () => {
  it('deux clients, connus par égalité exacte de leur identifiant', () => {
    expect(CLIENTS_OAUTH.map((c) => c.nom)).toEqual(['Claude Code', 'Claude']);
    expect(clientConnu('https://claude.ai/oauth/claude-code-client-metadata/')).toBeNull();
    expect(clientConnu('HTTPS://claude.ai/oauth/claude-code-client-metadata')).toBeNull();
    expect(clientConnu('https://evil.test/oauth/claude-code-client-metadata')).toBeNull();
  });

  it('Claude Code : localhost et 127.0.0.1, tout port, chemin /callback', () => {
    for (const hote of ['localhost', '127.0.0.1']) {
      expect(adresseDeRetourAcceptee(CLAUDE_CODE, `http://${hote}/callback`)).toBe(true);
      for (const port of [1, 33418, 65535]) expect(adresseDeRetourAcceptee(CLAUDE_CODE, `http://${hote}:${port}/callback`)).toBe(true);
    }
  });

  it('🔴 Claude Code : les adresses piégées sont refusées', () => {
    for (const piege of [
      'http://localhost@evil.test/callback',
      'http://localhost:1@evil.test/callback',
      'http://user@localhost:1/callback',
      'http://localhost.evil.test:1/callback',
      'https://localhost/callback',
      'https://localhost:1/callback',
      'http://localhost:1/callback/x',
      'http://localhost:1/callback?x=1',
      'http://localhost:1/callback#f',
      'http://localhost:1/./callback',
      'http://LOCALHOST:1/callback',
      'http://[::1]:5/callback',
      'http://127.0.0.2:5/callback',
      'http://localhost:0x10/callback',
      'http://evil.test:1/callback',
      'pas une adresse',
      '',
    ]) expect(adresseDeRetourAcceptee(CLAUDE_CODE, piege), piege).toBe(false);
  });

  it('🔴 claude.ai : égalité exacte, aucun port libre', () => {
    expect(adresseDeRetourAcceptee(CLAUDE_AI, 'https://claude.ai/api/mcp/auth_callback')).toBe(true);
    for (const piege of [
      'https://claude.ai:8443/api/mcp/auth_callback',
      'https://claude.ai/api/mcp/auth_callback/',
      'https://claude.ai/api/mcp/auth_callback?x=1',
      'http://claude.ai/api/mcp/auth_callback',
      'https://claude.com/api/mcp/auth_callback',
      'http://localhost:1/callback',
    ]) expect(adresseDeRetourAcceptee(CLAUDE_AI, piege), piege).toBe(false);
    // Et l'adresse de claude.ai n'ouvre pas Claude Code.
    expect(adresseDeRetourAcceptee(CLAUDE_CODE, 'https://claude.ai/api/mcp/auth_callback')).toBe(false);
  });

  it('🔴 le port libre ne vaut que pour la boucle locale, même si une fiche déclarait un jour une adresse http ailleurs', () => {
    const hypothetique = { id: 'https://exemple.test/fiche', nom: 'X', adressesDeRetour: ['http://exemple.test/callback'] };
    expect(adresseDeRetourAcceptee(hypothetique, 'http://exemple.test/callback')).toBe(true);
    expect(adresseDeRetourAcceptee(hypothetique, 'http://exemple.test:8080/callback')).toBe(false);
  });
});

describe('les jetons opaques', () => {
  it('trois préfixes distincts de celui d’une clé d’API, 43 caractères, empreinte SHA-256 du jeton entier', () => {
    for (const p of [PREFIXE_ACCES, PREFIXE_RENOUVELLEMENT, PREFIXE_CODE] as const) {
      const { brut, empreinte } = nouveauJeton(p);
      expect(brut.startsWith(p)).toBe(true);
      expect(p).not.toBe('mba_');
      expect(formeDeJeton(brut, p)).toBe(true);
      expect(empreinte).toBe(sha256Hex(brut));
    }
    expect(nouveauJeton(PREFIXE_ACCES).brut).not.toBe(nouveauJeton(PREFIXE_ACCES).brut);
  });

  it('la forme se juge sur le préfixe ET le corps', () => {
    const { brut } = nouveauJeton(PREFIXE_ACCES);
    expect(formeDeJeton(brut, PREFIXE_RENOUVELLEMENT)).toBe(false);
    expect(formeDeJeton(`${brut}x`, PREFIXE_ACCES)).toBe(false);
    expect(formeDeJeton(brut.slice(0, -1), PREFIXE_ACCES)).toBe(false);
    expect(formeDeJeton(`${PREFIXE_ACCES}${'a'.repeat(42)}+`, PREFIXE_ACCES)).toBe(false);
  });
});

describe('les métadonnées', () => {
  const BASE = 'https://api.exemple.test';

  it('la base vient de PUBLIC_API_URL, sans barre finale ; vide ou illisible, pas d’OAuth', () => {
    expect(baseOauth('https://api.exemple.test/')).toBe(BASE);
    expect(baseOauth('  https://api.exemple.test  ')).toBe(BASE);
    expect(baseOauth('')).toBeNull();
    expect(baseOauth('   ')).toBeNull();
    expect(baseOauth('api.exemple.test')).toBeNull();
  });

  it('la ressource : l’adresse de /mcp, et le serveur d’autorisation sur la même base', () => {
    expect(metadonneesRessource(BASE)).toEqual({
      resource: `${BASE}/mcp`,
      authorization_servers: [BASE],
      scopes_supported: ['mcp:read', 'mcp:write'],
      bearer_methods_supported: ['header'],
    });
    expect(ressourceMcp(BASE)).toBe(`${BASE}/mcp`);
  });

  it('🔴 le serveur : les champs REQUIRED de la RFC 8414, S256 seul, aucun enregistrement dynamique', () => {
    const m = metadonneesServeur(BASE);
    expect(m.issuer).toBe(BASE);
    expect(m.authorization_endpoint).toBe(`${BASE}/oauth/authorize`);
    expect(m.token_endpoint).toBe(`${BASE}/oauth/token`);
    expect(m.revocation_endpoint).toBe(`${BASE}/oauth/revoke`);
    expect(m.response_types_supported).toEqual(['code']);
    expect(m.code_challenge_methods_supported).toEqual(['S256']);
    expect(m.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    // Les deux annonces qui font choisir la fiche d'identité à Claude, plutôt que l'enregistrement dynamique.
    expect(m.token_endpoint_auth_methods_supported).toEqual(['none']);
    expect(m.client_id_metadata_document_supported).toBe(true);
    expect(m.authorization_response_iss_parameter_supported).toBe(true);
    expect(m).not.toHaveProperty('registration_endpoint');
    // Toutes les adresses annoncées vivent sur la base, aucune ne vient d'ailleurs.
    for (const v of Object.values(m)) if (typeof v === 'string' && v.startsWith('http')) expect(v.startsWith(BASE)).toBe(true);
  });

  it('l’en-tête du 401 : les métadonnées à chemin, les droits, et le code d’erreur seulement s’il est demandé', () => {
    expect(enTeteWwwAuthenticate(BASE)).toBe(
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp", scope="mcp:read mcp:write"`,
    );
    expect(enTeteWwwAuthenticate(BASE, 'invalid_token')).toBe(
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp", scope="mcp:read mcp:write", error="invalid_token"`,
    );
  });
});

describe('les jetons signés de l’OAuth', () => {
  const SECRET = randomBytes(32).toString('hex');
  const demande: DemandeOauth = {
    clientId: CLAUDE_CODE.id,
    redirectUri: 'http://localhost:33418/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    scopes: ['mcp:read', 'mcp:write'],
    state: 'etat-1',
    resource: 'https://api.exemple.test/mcp',
  };

  it('une demande et une preuve se relisent telles qu’elles ont été signées', async () => {
    expect(await verifyDemandeOauth(await signDemandeOauth(demande, SECRET), SECRET)).toEqual(demande);
    const choix = { email: 'a@exemple.test', demande: sha256Hex('jeton-de-demande') };
    expect(await verifyChoixOauth(await signChoixOauth(choix, SECRET), SECRET)).toEqual(choix);
  });

  it('🔴 aucune ne passe pour une session, un choix d’espace, une étape ou l’exploitation, ni pour l’autre', async () => {
    const d = await signDemandeOauth(demande, SECRET);
    const c = await signChoixOauth({ email: 'a@exemple.test', demande: 'x' }, SECRET);
    for (const jeton of [d, c]) {
      expect(await verifySession(jeton, SECRET)).toBeNull();
      expect(await verifyChoice(jeton, SECRET)).toBeNull();
      expect(await verifyMfa(jeton, SECRET)).toBeNull();
      expect(await verifySessionOps(jeton, SECRET)).toBeNull();
    }
    expect(await verifyChoixOauth(d, SECRET)).toBeNull();
    expect(await verifyDemandeOauth(c, SECRET)).toBeNull();
  });

  it('🔴 le `kind` décide, pas la forme : un jeton qui porterait les champs des deux n’est que ce que dit son `kind`', async () => {
    const cle = new TextEncoder().encode(SECRET);
    const hybride = (kind: string) => new SignJWT({ kind, ...demande, email: 'a@exemple.test', demande: 'x' })
      .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('5m').sign(cle);
    expect(await verifyDemandeOauth(await hybride('oauth_choix'), SECRET)).toBeNull();
    expect(await verifyChoixOauth(await hybride('oauth_demande'), SECRET)).toBeNull();
    expect(await verifyDemandeOauth(await hybride('oauth_demande'), SECRET)).toEqual(demande);
  });

  it('🔴 et l’inverse : une session ou un choix d’espace ne passe pas pour une demande ni une preuve', async () => {
    const session = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
    const choix = await signChoice({ email: 'a@exemple.test', comptes: [{ userId: 'u1', tenantId: 't1', role: 'admin' }] }, SECRET);
    for (const jeton of [session, choix]) {
      expect(await verifyDemandeOauth(jeton, SECRET)).toBeNull();
      expect(await verifyChoixOauth(jeton, SECRET)).toBeNull();
    }
  });

  it('🔴 signée d’un autre secret, échue, ou de la bonne sorte mais mal formée : refusée', async () => {
    expect(await verifyDemandeOauth(await signDemandeOauth(demande, randomBytes(32).toString('hex')), SECRET)).toBeNull();
    const cle = new TextEncoder().encode(SECRET);
    const echue = await new SignJWT({ kind: 'oauth_demande', ...demande })
      .setProtectedHeader({ alg: 'HS256' }).setIssuedAt(Math.floor(Date.now() / 1000) - 1200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 600).sign(cle);
    expect(await verifyDemandeOauth(echue, SECRET)).toBeNull();
    // La signature prouve d'où vient le jeton, pas qu'il a la forme attendue : Zod la juge.
    const malformee = await new SignJWT({ kind: 'oauth_demande', ...demande, scopes: 'mcp:read' })
      .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('10m').sign(cle);
    expect(await verifyDemandeOauth(malformee, SECRET)).toBeNull();
    const sansDroits = await new SignJWT({ kind: 'oauth_demande', ...demande, scopes: [] })
      .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('10m').sign(cle);
    expect(await verifyDemandeOauth(sansDroits, SECRET)).toBeNull();
    const preuveVide = await new SignJWT({ kind: 'oauth_choix', email: '', demande: 'x' })
      .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('5m').sign(cle);
    expect(await verifyChoixOauth(preuveVide, SECRET)).toBeNull();
  });
});
