import { describe, it, expect } from 'vitest';
import { runPhoneStatusSweep, phoneProblem, type PhoneProblem, type PhoneStatusSweepDeps } from '../src/account/status-sweep';
import type { PullResult, PhoneStatusPatch } from '../src/account/pull';
import type { PhoneForSweepRow } from '../src/ops/store.pg';

const num = (id: string, over: Partial<PhoneForSweepRow> = {}): PhoneForSweepRow =>
  ({ id, tenantId: 't1', wabaId: 'w1', status: null, qualityRating: null, ...over });
const ok = (over: Partial<Extract<PullResult, { ok: true }>> = {}): PullResult =>
  ({ ok: true, status: 'CONNECTED', qualityRating: 'GREEN', ...over });
const authFail: PullResult = { ok: false, authError: true };
const netFail: PullResult = { ok: false, authError: false };

function harness(
  numbers: PhoneForSweepRow[],
  pullFn: (n: PhoneForSweepRow) => PullResult | null,
  opts: { throwSaveFor?: string } = {},
) {
  const alerts: string[] = [];
  const saves: Array<{ id: string; patch: PhoneStatusPatch }> = [];
  const alertedState = new Map<string, PhoneProblem>();
  const deps: PhoneStatusSweepDeps = {
    listNumbers: async () => numbers,
    pull: async (n) => pullFn(n),
    save: async (id, patch) => { if (opts.throwSaveFor === id) throw new Error('save boom'); saves.push({ id, patch }); },
    alert: (m) => alerts.push(m),
    alertedState,
  };
  return { deps, alerts, saves, alertedState };
}

describe('phoneProblem (classification pure)', () => {
  it('CONNECTED + GREEN -> null (sain)', () => expect(phoneProblem(ok())).toBeNull());
  it('CONNECTED + YELLOW -> null (hors périmètre alerte)', () => expect(phoneProblem(ok({ qualityRating: 'YELLOW' }))).toBeNull());
  it('CONNECTED + RED -> RED', () => expect(phoneProblem(ok({ qualityRating: 'RED' }))).toBe('RED'));
  it('PENDING -> DISCONNECTED', () => expect(phoneProblem(ok({ status: 'PENDING' }))).toBe('DISCONNECTED'));
  it('status absent -> DISCONNECTED', () => expect(phoneProblem(ok({ status: undefined }))).toBe('DISCONNECTED'));
  it('échec auth -> AUTH', () => expect(phoneProblem(authFail)).toBe('AUTH'));
  it('échec transitoire (réseau) -> null (pas d\'alerte)', () => expect(phoneProblem(netFail)).toBeNull());
});

describe('runPhoneStatusSweep', () => {
  it('alerte sur RED, DISCONNECTED et AUTH ; pas sur CONNECTED+GREEN', async () => {
    const numbers = [num('red'), num('pending'), num('auth'), num('green')];
    const pulls: Record<string, PullResult> = { red: ok({ qualityRating: 'RED' }), pending: ok({ status: 'PENDING' }), auth: authFail, green: ok() };
    const { deps, alerts } = harness(numbers, (n) => pulls[n.id]!);
    expect(await runPhoneStatusSweep(deps)).toBe(3);
    expect(alerts).toHaveLength(3);
    expect(alerts.find((a) => a.includes('red'))).toContain('ROUGE');
    expect(alerts.find((a) => a.includes('pending'))).toContain('CONNECTED');
    expect(alerts.find((a) => a.includes('auth'))).toContain('jeton');
  });

  it('persiste (save) le patch d\'un pull réussi, sans le drapeau ok', async () => {
    const { deps, saves } = harness([num('red')], () => ok({ qualityRating: 'RED', displayPhoneNumber: '+33...' }));
    await runPhoneStatusSweep(deps);
    expect(saves).toHaveLength(1);
    expect(saves[0]!.id).toBe('red');
    expect(saves[0]!.patch.qualityRating).toBe('RED');
    expect('ok' in saves[0]!.patch).toBe(false);
  });

  it('échec transitoire (réseau) : ni save ni alerte', async () => {
    const { deps, saves, alerts } = harness([num('x')], () => netFail);
    expect(await runPhoneStatusSweep(deps)).toBe(0);
    expect(saves).toHaveLength(0);
    expect(alerts).toHaveLength(0);
  });

  it('dédup : pas de re-alerte au 2e passage sur le même problème', async () => {
    const { deps, alerts } = harness([num('red')], () => ok({ qualityRating: 'RED' }));
    await runPhoneStatusSweep(deps);
    await runPhoneStatusSweep(deps);
    expect(alerts).toHaveLength(1); // une seule alerte malgré deux passages
  });

  it('transition de nature (AUTH -> RED) ré-alerte', async () => {
    let state: PullResult = authFail;
    const { deps, alerts } = harness([num('n1')], () => state);
    await runPhoneStatusSweep(deps);
    state = ok({ qualityRating: 'RED' });
    await runPhoneStatusSweep(deps);
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toContain('jeton');
    expect(alerts[1]).toContain('ROUGE');
  });

  it('un échec transitoire intercalé NE ré-arme PAS un problème persistant (anti-spam)', async () => {
    // token invalide -> hoquet réseau -> token toujours invalide. Le hoquet ne doit pas effacer l'état d'alerte.
    const seq: PullResult[] = [authFail, netFail, authFail];
    let i = 0;
    const { deps, alerts } = harness([num('n1')], () => seq[Math.min(i++, seq.length - 1)]!);
    await runPhoneStatusSweep(deps); // AUTH -> alerte
    await runPhoneStatusSweep(deps); // hoquet réseau -> pas d'alerte, état PRÉSERVÉ
    await runPhoneStatusSweep(deps); // AUTH toujours -> PAS de re-alerte (problème stable)
    expect(alerts).toHaveLength(1);
  });

  it('rétablissement ré-arme l\'alerte (problème -> sain -> problème)', async () => {
    let state: PullResult = ok({ qualityRating: 'RED' });
    const { deps, alerts, alertedState } = harness([num('n1')], () => state);
    await runPhoneStatusSweep(deps); // alerte
    state = ok(); // sain
    await runPhoneStatusSweep(deps); // pas d'alerte, état nettoyé
    expect(alertedState.has('n1')).toBe(false);
    state = ok({ qualityRating: 'RED' }); // re-dégradé
    await runPhoneStatusSweep(deps); // ré-alerte
    expect(alerts).toHaveLength(2);
  });

  it('un save qui throw sur un numéro n\'arrête pas le balayage', async () => {
    const numbers = [num('a'), num('b')];
    const { deps, saves, alerts } = harness(numbers, () => ok({ qualityRating: 'RED' }), { throwSaveFor: 'a' });
    await runPhoneStatusSweep(deps);
    // 'a' a échoué au save (pas d'alerte pour lui), 'b' est traité normalement.
    expect(saves.map((s) => s.id)).toEqual(['b']);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('b');
  });

  it('pull null (pas de token) : numéro sauté, ni save ni alerte', async () => {
    const { deps, saves, alerts } = harness([num('x')], () => null);
    expect(await runPhoneStatusSweep(deps)).toBe(0);
    expect(saves).toHaveLength(0);
    expect(alerts).toHaveLength(0);
  });
});
