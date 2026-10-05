import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { signRequest, verifyRequest } from '../src/lib/signature';

/**
 * 🔴 LE SCRIPT DE L'ASTERISK ET LE SERVEUR SIGNENT À L'IDENTIQUE (lot 3a). Le script vit dans un autre conteneur, en
 * shell, et rien ne relie sa préimage à celle de `signRequest` sinon ce test : un point ou une méthode de travers, et
 * chaque appel de Meta tomberait en 401 en production, sans qu'aucun autre test le voie.
 *
 * Il exécute le VRAI script (`--signer`), avec openssl. La CI tourne sous Linux, où les deux existent ; un poste qui
 * n'a ni `sh` ni `openssl` le saute, et le dit.
 */
const SCRIPT = resolve(__dirname, '..', 'ops', 'otp-asterisk', 'envoyer-otp.sh');
const dispo = spawnSync('sh', ['-c', 'command -v openssl'], { encoding: 'utf8' }).status === 0;

describe.skipIf(!dispo)('envoyer-otp.sh --signer', () => {
  it('🔴 même signature que `signRequest`, sur un vrai fichier binaire, et `verifyRequest` l’accepte', () => {
    const dossier = mkdtempSync(join(tmpdir(), 'otp-sig-'));
    try {
      const secret = 'secret-du-pont-assez-long-pour-la-configuration';
      const audio = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0x0a, 0x0d, 0x2e, 0x00, 0x80]);
      const fichier = join(dossier, 'appel.wav');
      const fichierSecret = join(dossier, 'secret');
      writeFileSync(fichier, audio);
      writeFileSync(fichierSecret, secret);
      const ts = 1_786_000_000_000;
      const nonce = '0123456789abcdef';
      const chemin = '/internes/otp/appels/442071234567/1728137328.12';
      const r = spawnSync('sh', [SCRIPT, '--signer', String(ts), nonce, chemin, fichier, fichierSecret], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toBe(signRequest(secret, { ts, nonce, method: 'POST', path: chemin, body: audio }));
      expect(verifyRequest(readFileSync(fichier), r.stdout, secret, { method: 'POST', path: chemin, now: ts, windowMs: 60_000 })).toBe(true);
    } finally {
      rmSync(dossier, { recursive: true, force: true });
    }
  });
});
