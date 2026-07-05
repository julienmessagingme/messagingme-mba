import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyMetaSignature } from '../src/lib/signature';

const SECRET = 'sekret';
const raw = Buffer.from('{"a":1}', 'utf8');
const valid = 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex');

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
