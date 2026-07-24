import { describe, it, expect } from 'vitest';
import { MetaCredentialsResolver, TokenInvalidError, isMetaAuthError, type CredentialsResolverDeps } from '../src/meta/credentials';
import { MetaApiError } from '../src/meta/errors';

// Fakes : la résolution ne touche ni DB ni réseau (deps injectées).
function makeDeps(over: Partial<CredentialsResolverDeps> & {
  tenants?: Record<string, string>;             // tenantId -> wabaId
  creds?: Record<string, { businessTokenEnc: string; tokenStatus: 'active' | 'invalid' }>; // wabaId -> cred
} = {}) {
  const tenants = over.tenants ?? {};
  const creds = over.creds ?? {};
  const invalidated: string[] = [];
  let decryptCalls = 0;
  const deps: CredentialsResolverDeps = {
    getWabaIdForTenant: async (t) => tenants[t] ?? null,
    getCredentialsByWaba: async (w) => creds[w] ?? null,
    markTokenInvalid: async (w) => { invalidated.push(w); if (creds[w]) creds[w]!.tokenStatus = 'invalid'; },
    decrypt: (enc) => { decryptCalls += 1; return enc.replace(/^enc:/, ''); }, // "enc:TOK" -> "TOK"
    fallbackToken: 'GLOBAL_TOKEN',
    now: over.now,
    cacheTtlMs: over.cacheTtlMs,
    ...over,
  };
  return { deps, invalidated, get decryptCalls() { return decryptCalls; } };
}

describe('MetaCredentialsResolver (B1 : token Meta par tenant)', () => {
  it('CŒUR : deux tenants -> deux tokens différents (isolation réelle)', async () => {
    const { deps } = makeDeps({
      tenants: { tA: 'wabaA', tB: 'wabaB' },
      creds: { wabaA: { businessTokenEnc: 'enc:TOK_A', tokenStatus: 'active' }, wabaB: { businessTokenEnc: 'enc:TOK_B', tokenStatus: 'active' } },
    });
    const r = new MetaCredentialsResolver(deps);
    expect((await r.resolveForTenant('tA')).token).toBe('TOK_A');
    expect((await r.resolveForTenant('tB')).token).toBe('TOK_B');
  });

  it('SOMMEIL : un tenant sans WABA -> token global de repli (wabaId null)', async () => {
    const { deps } = makeDeps({ tenants: {} });
    const r = new MetaCredentialsResolver(deps);
    expect(await r.resolveForTenant('tX')).toEqual({ token: 'GLOBAL_TOKEN', wabaId: null });
  });

  it('SOMMEIL : un WABA sans credentials (numéro branché à la main) -> token global de repli', async () => {
    const { deps } = makeDeps({ tenants: { tA: 'wabaA' }, creds: {} });
    const r = new MetaCredentialsResolver(deps);
    expect(await r.resolveForTenant('tA')).toEqual({ token: 'GLOBAL_TOKEN', wabaId: null });
  });

  it('token invalide (révoqué) -> TokenInvalidError, aucun envoi', async () => {
    const { deps } = makeDeps({ tenants: { tA: 'wabaA' }, creds: { wabaA: { businessTokenEnc: 'enc:TOK_A', tokenStatus: 'invalid' } } });
    const r = new MetaCredentialsResolver(deps);
    await expect(r.resolveForTenant('tA')).rejects.toBeInstanceOf(TokenInvalidError);
  });

  it('cache : deux résolutions du même WABA -> déchiffrement UNE seule fois', async () => {
    const h = makeDeps({ tenants: { tA: 'wabaA' }, creds: { wabaA: { businessTokenEnc: 'enc:TOK_A', tokenStatus: 'active' } } });
    const r = new MetaCredentialsResolver(h.deps);
    await r.resolveForTenant('tA');
    await r.resolveForTenant('tA');
    expect(h.decryptCalls).toBe(1);
  });

  it('invalidate : purge le cache ET marque invalide (un token mort n\'est plus servi)', async () => {
    const h = makeDeps({ tenants: { tA: 'wabaA' }, creds: { wabaA: { businessTokenEnc: 'enc:TOK_A', tokenStatus: 'active' } } });
    const r = new MetaCredentialsResolver(h.deps);
    await r.resolveForWaba('wabaA'); // met en cache
    await r.invalidate('wabaA');
    expect(h.invalidated).toEqual(['wabaA']);
    // Après invalidation, la prochaine résolution relit l'état (désormais 'invalid') -> throw, pas de cache périmé servi.
    await expect(r.resolveForWaba('wabaA')).rejects.toBeInstanceOf(TokenInvalidError);
  });

  it('onError : erreur d\'auth (190) -> invalide le WABA ; erreur générique (100) -> n\'invalide pas', async () => {
    const h = makeDeps({ tenants: { tA: 'wabaA' }, creds: { wabaA: { businessTokenEnc: 'enc:TOK_A', tokenStatus: 'active' } } });
    const r = new MetaCredentialsResolver(h.deps);
    await r.onError(new MetaApiError(401, { code: 190, message: 'OAuthException', type: 'OAuthException' }), 'wabaA');
    expect(h.invalidated).toEqual(['wabaA']);
    // code 100 = paramètre invalide, générique, PAS une auth (aligné pull.ts).
    await r.onError(new MetaApiError(400, { code: 100, message: 'Invalid parameter' }), 'wabaB');
    expect(h.invalidated).toEqual(['wabaA']); // inchangé
  });

  it('onError : un échec DB de markTokenInvalid est AVALÉ (best-effort), ne masque pas l\'erreur Meta', async () => {
    const deps: CredentialsResolverDeps = {
      getWabaIdForTenant: async () => 'wabaA',
      getCredentialsByWaba: async () => ({ businessTokenEnc: 'enc:TOK', tokenStatus: 'active' }),
      markTokenInvalid: async () => { throw new Error('DB down'); }, // l'écriture d'invalidation échoue
      decrypt: (e) => e,
      fallbackToken: 'GLOBAL',
    };
    const r = new MetaCredentialsResolver(deps);
    // onError ne doit PAS throw : le guard de la fabrique compte dessus pour ensuite rethrow l'erreur Meta d'origine.
    await expect(r.onError(new MetaApiError(401, { code: 190, message: 'x', type: 'OAuthException' }), 'wabaA')).resolves.toBeUndefined();
  });

  it('onError : wabaId null (token global de repli) -> jamais d\'invalidation', async () => {
    const h = makeDeps();
    const r = new MetaCredentialsResolver(h.deps);
    await r.onError(new MetaApiError(401, { code: 190, message: 'x', type: 'OAuthException' }), null);
    expect(h.invalidated).toEqual([]);
  });

  it('isMetaAuthError : 190 / 401 / OAuthException = true ; 100 = false ; non-Meta = false', () => {
    expect(isMetaAuthError(new MetaApiError(401, { code: 190, message: 'x' }))).toBe(true);
    expect(isMetaAuthError(new MetaApiError(400, { code: 100, message: 'x' }))).toBe(false);
    expect(isMetaAuthError(new Error('réseau'))).toBe(false);
  });
});
