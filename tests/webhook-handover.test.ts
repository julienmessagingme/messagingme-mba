import { describe, it, expect, vi, afterEach } from 'vitest';
import { processHandovers, ownerFromHandover } from '../src/webhooks/handover';
import type { HandoverDeps } from '../src/webhooks/handover';

/**
 * Pré-câblage MBA : bascules de contrôle et messages de l'agent de Meta.
 *
 * ⚠️ CES TESTS NE PROUVENT PAS QUE ÇA MARCHERA AVEC META. La forme réelle du payload `standby` et
 * `messaging_handovers` n'est documentée NULLE PART : Meta décrit la sémantique, jamais la structure. Les
 * charges utiles ci-dessous sont donc des HYPOTHÈSES, construites à partir du protocole de handover
 * Messenger dont ce vocabulaire est hérité.
 *
 * Ce que ces tests prouvent réellement, et qui est ce qui compte avant le premier test réel :
 *  1. rien ne PLANTE sur une forme inattendue (le webhook est partagé avec les statuts de livraison et
 *     l'inbox, un throw ici les emporterait tous en DLQ) ;
 *  2. tout ce qui n'est pas reconnu est JOURNALISÉ intégralement, ce qui permettra de découvrir la vraie
 *     forme en lisant les logs au lieu de deviner ;
 *  3. le câblage est là : dès que la forme sera connue, seule la fonction de reconnaissance changera.
 */

function deps(over: Partial<HandoverDeps> = {}): {
  deps: HandoverDeps;
  poses: Array<[string, string, string]>;
  messages: Array<[string, string, string]>;
} {
  const poses: Array<[string, string, string]> = [];
  const messages: Array<[string, string, string]> = [];
  return {
    poses,
    messages,
    deps: {
      phoneNumberTenant: async (pn) => (pn === 'pn1' ? 't1' : null),
      setControlOwner: async (t, w, o) => { poses.push([t, w, o]); return true; },
      recordAgentMessage: async (t, w, body) => { messages.push([t, w, body]); return undefined; },
      ...over,
    },
  };
}

const enveloppe = (field: string, value: Record<string, unknown>) => ({
  entry: [{ changes: [{ field, value: { metadata: { phone_number_id: 'pn1' }, ...value } }] }],
});

afterEach(() => { vi.restoreAllMocks(); });

describe('reconnaissance du nouveau détenteur', () => {
  it('un contrôle rendu donne le fil à MBA, un contrôle pris nous le rend', () => {
    expect(ownerFromHandover({ pass_thread_control: {} })).toBe('mba');
    expect(ownerFromHandover({ take_thread_control: {} })).toBe('app_workflow');
  });

  it('une mention explicite de l’agent suffit', () => {
    expect(ownerFromHandover({ new_owner: 'meta_business_agent' })).toBe('mba');
  });

  it('une forme INCONNUE rend null au lieu de deviner', () => {
    // Deviner ici serait pire que ne rien faire : on poserait un détenteur faux, et le scénario se
    // tairait (ou parlerait) sans raison, sur une conversation réelle.
    expect(ownerFromHandover({ quelque_chose: 'inattendu' })).toBeNull();
    expect(ownerFromHandover({})).toBeNull();
  });

  it('les deux marqueurs à la fois -> null (situation ambiguë, on ne tranche pas)', () => {
    expect(ownerFromHandover({ pass_thread_control: {}, take_thread_control: {} })).toBeNull();
  });
});

describe('traitement des bascules de contrôle', () => {
  it('pose le détenteur annoncé par Meta', async () => {
    const d = deps();
    await processHandovers(enveloppe('messaging_handovers', { recipient: '33611', pass_thread_control: {} }), d.deps);
    expect(d.poses).toEqual([['t1', '33611', 'mba']]);
  });

  it('numéro business inconnu -> aucune pose, mais une trace', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const d = deps();
    const payload = { entry: [{ changes: [{ field: 'messaging_handovers', value: { metadata: { phone_number_id: 'AUTRE' }, recipient: '33611' } }] }] };
    await processHandovers(payload, d.deps);
    expect(d.poses).toEqual([]);
    expect(log.mock.calls.some((c) => String(c[0]).includes('handover_numero_inconnu'))).toBe(true);
  });

  it('forme non reconnue -> aucune pose, et le payload COMPLET est journalisé', async () => {
    // C'est le test le plus important du fichier : le jour du premier test MBA réel, c'est cette trace
    // qui dira à quoi ressemble vraiment un handover.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const d = deps();
    await processHandovers(enveloppe('messaging_handovers', { recipient: '33611', forme: 'jamais vue' }), d.deps);
    expect(d.poses).toEqual([]);
    const trace = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes('handover_recu'));
    expect(trace).toBeTruthy();
    expect(trace).toContain('jamais vue'); // le payload brut est dans la trace, pas seulement un résumé
  });

  it('destinataire absent -> aucune pose (on ne devine jamais de qui il s’agit)', async () => {
    const d = deps();
    await processHandovers(enveloppe('messaging_handovers', { pass_thread_control: {} }), d.deps);
    expect(d.poses).toEqual([]);
  });
});

describe('messages envoyés par l’agent de Meta (standby)', () => {
  it('les journalise dans le fil, pour que l’opérateur voie la conversation entière', async () => {
    const d = deps();
    await processHandovers(
      enveloppe('standby', { message_echoes: [{ id: 'wamid.1', to: '33611', text: { body: 'Bonjour, je peux vous aider ?' } }] }),
      d.deps,
    );
    expect(d.messages).toEqual([['t1', '33611', 'Bonjour, je peux vous aider ?']]);
  });

  it('un écho sans corps exploitable est tracé mais pas journalisé comme message', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const d = deps();
    await processHandovers(enveloppe('standby', { message_echoes: [{ id: 'wamid.2', to: '33611', image: {} }] }), d.deps);
    expect(d.messages).toEqual([]);
    expect(log.mock.calls.some((c) => String(c[0]).includes('standby_echo'))).toBe(true);
  });

  it('un standby ne pose JAMAIS de détenteur', async () => {
    // `standby` dit ce que l'agent a envoyé, pas qui détient le fil. Confondre les deux ferait basculer
    // l'état sur un simple écho, alors que seul `messaging_handovers` fait autorité.
    const d = deps();
    await processHandovers(enveloppe('standby', { message_echoes: [{ id: 'w', to: '33611', text: { body: 'x' } }] }), d.deps);
    expect(d.poses).toEqual([]);
  });
});

describe('robustesse : le webhook est partagé, rien ne doit planter', () => {
  it('avale les formes aberrantes sans lever', async () => {
    const d = deps();
    for (const payload of [null, undefined, {}, { entry: 'pas un tableau' }, { entry: [{ changes: null }] }, { entry: [{ changes: [{}] }] }]) {
      await expect(processHandovers(payload, d.deps)).resolves.toBeUndefined();
    }
    expect(d.poses).toEqual([]);
  });

  it('ignore les champs qui ne le concernent pas', async () => {
    const d = deps();
    await processHandovers(enveloppe('messages', { messages: [{ id: 'm1' }] }), d.deps);
    expect(d.poses).toEqual([]);
    expect(d.messages).toEqual([]);
  });
});
