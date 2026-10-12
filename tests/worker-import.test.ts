import { describe, expect, it, vi } from 'vitest';

describe('orchestration du worker importable', () => {
  it('expose son démarrage sans démarrer le processus à l’import', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const orchestration = await import('../src/worker');

      expect(typeof orchestration.demarrerWorker).toBe('function');
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  }, 30_000);
});
