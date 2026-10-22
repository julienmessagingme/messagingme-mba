import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PORTENT_UNE_SESSION, taireLesClesDeSignal } from '../src/application/transport/journal-signal';

/**
 * LES CLÉS DE SIGNAL N'ENTRENT PAS DANS LES JOURNAUX (essai réel du 2026-10-22). `libsignal` passe la session entière,
 * clés privées comprises, à `console.info` et `console.warn` quand il en ouvre ou en ferme une : le service de
 * connexions les écrivait dans les journaux du conteneur.
 */
const SESSION = { currentRatchet: { ephemeralKeyPair: { privKey: Buffer.from('secret-de-signal') } }, rootKey: Buffer.from('racine') };

function console_() {
  const ecrit: unknown[][] = [];
  const c = {
    info: (...a: unknown[]) => { ecrit.push(a); },
    warn: (...a: unknown[]) => { ecrit.push(a); },
  };
  return { c, ecrit };
}

describe('taire les clés de Signal', () => {
  it('🔴 les quatre messages qui portent une session s’écrivent sans elle', () => {
    const { c, ecrit } = console_();
    taireLesClesDeSignal(c);
    c.info('Closing session:', SESSION);
    c.info('Opening session:', SESSION);
    c.info('Removing old closed session:', SESSION);
    c.warn('Session already closed', SESSION);
    expect(ecrit).toEqual([['Closing session:'], ['Opening session:'], ['Removing old closed session:'], ['Session already closed']]);
    expect(JSON.stringify(ecrit)).not.toContain('privKey');
  });

  it('🔴 la liste suit libsignal : chaque appel qui écrit une session y est (sinon une mise à jour rouvrirait la fuite)', () => {
    // Lu dans la bibliothèque installée : un message reformulé par une mise à jour de libsignal rendrait ce test rouge,
    // au lieu d'écrire de nouveau les clés en silence (relecture du 2026-10-22).
    const source = readFileSync(new URL('../node_modules/libsignal/src/session_record.js', import.meta.url), 'utf8');
    const ecrits = [...source.matchAll(/console\.(?:info|warn|log|error)\(\s*["']([^"']+)["']\s*,\s*[A-Za-z_]*[Ss]ession\b/g)].map((m) => m[1]);
    expect(ecrits.length).toBeGreaterThanOrEqual(4);
    for (const e of ecrits) expect(PORTENT_UNE_SESSION, e).toContain(e);
  });

  it('tout autre message passe intact', () => {
    const { c, ecrit } = console_();
    taireLesClesDeSignal(c);
    const objet = { a: 1 };
    c.info('application_demarre', objet);
    c.warn('Closing open session in favor of incoming prekey bundle');
    expect(ecrit).toEqual([['application_demarre', objet], ['Closing open session in favor of incoming prekey bundle']]);
  });
});
