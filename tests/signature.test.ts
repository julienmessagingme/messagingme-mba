import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyMetaSignature, signRequest } from '../src/lib/signature';

const SECRET = 'sekret';
const raw = Buffer.from('{"a":1}', 'utf8');
const valid = 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex');

describe('signRequest (format v1 cross-repo mba -> mm-hubspot)', () => {
  it('produit le VECTEUR D\'OR (contrat byte-identique, cf. mm-hubspot verifyRequest)', () => {
    // Ce hex DOIT rester identique au test verifyRequest de mm-hubspot. Toute dérive = 401 de tout le trafic en prod.
    const header = signRequest('golden-shared-secret-32bytes-min!', {
      ts: 1_700_000_000_000, nonce: '00112233445566aa', method: 'POST', path: '/ingest', body: '{"hello":"world"}',
    });
    expect(header).toBe('v1=1700000000000.00112233445566aa.8a10465d83921f8f00eaf36d294f973f67d972f1aa88e13217dcbc47b1380c68');
  });
  it('lie ts, nonce, méthode, chemin ET corps (changer l\'un change le hex)', () => {
    const base: { ts: number; nonce: string; method: string; path: string; body: string } =
      { ts: 1, nonce: 'aa', method: 'POST', path: '/ingest', body: 'x' };
    const h = (o: Partial<typeof base>): string => signRequest('S', { ...base, ...o });
    expect(h({})).not.toBe(h({ body: 'y' }));
    expect(h({})).not.toBe(h({ method: 'GET' }));
    expect(h({})).not.toBe(h({ path: '/other' }));
    expect(h({})).not.toBe(h({ ts: 2 }));
    expect(h({})).not.toBe(h({ nonce: 'bb' }));
  });
  it('corps Buffer et string identiques donnent le même header', () => {
    const s = signRequest('S', { ts: 1, nonce: 'aa', method: 'POST', path: '/p', body: '{"a":1}' });
    const b = signRequest('S', { ts: 1, nonce: 'aa', method: 'POST', path: '/p', body: Buffer.from('{"a":1}') });
    expect(s).toBe(b);
  });
});

describe('verifyMetaSignature', () => {
  it('accepte une signature valide', () => {
    expect(verifyMetaSignature(raw, valid, SECRET)).toBe(true);
  });
  it('rejette une signature invalide (même longueur)', () => {
    expect(verifyMetaSignature(raw, 'sha256=' + '0'.repeat(64), SECRET)).toBe(false);
  });
  it('rejette un header absent', () => {
    expect(verifyMetaSignature(raw, undefined, SECRET)).toBe(false);
  });
  it('rejette un header malformé', () => {
    expect(verifyMetaSignature(raw, 'garbage', SECRET)).toBe(false);
  });
  it('rejette un secret vide', () => {
    expect(verifyMetaSignature(raw, valid, '')).toBe(false);
  });
  it('rejette si le corps diffère', () => {
    expect(verifyMetaSignature(Buffer.from('{"a":2}', 'utf8'), valid, SECRET)).toBe(false);
  });
});
