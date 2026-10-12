import { describe, it, expect } from 'vitest';
import { ACTIONS_JOURNAL } from '../web/lib/partage/actions-journal';

/** Les libellés publiés sont la source des actions que le serveur accepte d'écrire. */
describe('vocabulaire du journal d’audit', () => {
  it('garde les actions historiques et donne à chacune deux libellés utilisables', () => {
    const actions = Object.entries(ACTIONS_JOURNAL);
    expect(actions.length).toBeGreaterThanOrEqual(75);
    for (const [action, libelles] of actions) {
      expect(action).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(libelles).toHaveLength(2);
      expect(libelles?.[0].trim(), `${action} en français`).not.toBe('');
      expect(libelles?.[1].trim(), `${action} en anglais`).not.toBe('');
    }
  });
});
