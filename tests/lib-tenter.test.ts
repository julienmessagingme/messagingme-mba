import { describe, expect, it, vi } from 'vitest';
import { tenter } from '../src/lib/tenter';

describe('tenter : une étape isolée', () => {
  it('attend l’étape et ne journalise rien quand elle réussit', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let fait = false;
    await tenter('étape ignorée:', async () => { fait = true; });
    expect(fait).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('🔴 avale l’échec et journalise la MÊME ligne que les try/catch remplacés', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(tenter('processInbound: opt-out ignoré:', async () => { throw new Error('base indisponible'); })).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith('processInbound: opt-out ignoré:', 'base indisponible');
    await tenter('étape ignorée:', () => Promise.reject('pas une Error'));
    expect(spy).toHaveBeenLastCalledWith('étape ignorée:', 'pas une Error');
    spy.mockRestore();
  });

  it('un échec SYNCHRONE de l’étape est avalé lui aussi', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await tenter('étape ignorée:', () => { throw new Error('boum'); });
    expect(spy).toHaveBeenCalledWith('étape ignorée:', 'boum');
    spy.mockRestore();
  });
});
