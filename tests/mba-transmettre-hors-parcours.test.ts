import { describe, it, expect } from 'vitest';
import { creerTransmettreHorsParcours, type DepsTransmettre } from '../src/mba/transmettre-hors-parcours';
import type { EvenementAgent } from '../src/mba/evenement';

/**
 * La réponse « à côté » transmise à l'agent de Meta (spec 2026-09-21-outils-maison-mba, § 5).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE : c'est CE message qui part, et seulement si le fil est à l'agent de Meta (revue
 * finale du 2026-09-22 : la garde du détenteur pouvait disparaître sans qu'aucun test ne tombe).
 */
function faux(o: { detenteur?: string; numero?: string | null; corps?: string | null } = {}) {
  const envois: Array<{ pn: string; to: string; event: EvenementAgent }> = [];
  const lus: string[] = [];
  const journal: string[] = [];
  const deps: DepsTransmettre = {
    detenteur: async () => o.detenteur ?? 'mba',
    numero: async () => (o.numero === undefined ? 'PN1' : o.numero),
    corpsDuMessage: async (_t, id) => { lus.push(id); return o.corps === undefined ? 'Vous êtes ouverts dimanche ?' : o.corps; },
    envoyer: async (_t, pn, to, event) => { envois.push({ pn, to, event }); },
    journal: (l) => { journal.push(l); },
  };
  return { transmettre: creerTransmettreHorsParcours(deps), envois, lus, journal };
}

describe('transmettre la réponse « à côté »', () => {
  it('🔴 transmet CE message, lu par son identifiant, au format mesuré', async () => {
    const f = faux();
    await f.transmettre('t1', '33612345678', 'wamid.X');
    expect(f.lus).toEqual(['wamid.X']);
    expect(f.envois).toHaveLength(1);
    expect(f.envois[0]!.pn).toBe('PN1');
    expect(f.envois[0]!.to).toBe('+33612345678');
    expect(JSON.parse(f.envois[0]!.event.payload)).toEqual({ message: 'Vous êtes ouverts dimanche ?' });
  });

  it('🔴 rien si le fil n’est pas à l’agent de Meta (test, release refusé, marqueur en attente)', async () => {
    for (const detenteur of ['app_human', 'app_workflow']) {
      const f = faux({ detenteur });
      await f.transmettre('t1', '33612345678', 'wamid.X');
      expect(f.envois).toEqual([]);
      expect(f.journal[0]).toContain('pas à l’agent de Meta');
    }
  });

  it('rien pour un message sans texte, ni sans numéro connecté', async () => {
    for (const corps of [null, '', '   ']) {
      const f = faux({ corps });
      await f.transmettre('t1', '33612345678', 'wamid.X');
      expect(f.envois).toEqual([]);
    }
    const sansNumero = faux({ numero: null });
    await sansNumero.transmettre('t1', '33612345678', 'wamid.X');
    expect(sansNumero.envois).toEqual([]);
  });
});
