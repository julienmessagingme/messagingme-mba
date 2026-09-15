import { describe, it, expect } from 'vitest';
import { processStatuses } from '../src/webhooks/delivery';
import type { WebhookEvent } from '../src/webhooks/parse';

/**
 * RENDRE LE FIL À L'AGENT DE META QUAND L'ACCUSÉ DE NOTRE DERNIER ENVOI ARRIVE (migration 0149).
 *
 * 🔴 CE QUE ÇA RÉPARE, MESURÉ LE 2026-09-15 SUR LE NUMÉRO DE PRODUCTION. La fin d'un parcours relâchait le
 * fil dans la seconde suivant son dernier envoi. Or Meta acquitte nos envois avec DEUX MINUTES de retard
 * (corrélation par identifiant : envoi 07:42:17 -> `sent` 07:44:04) et sa documentation dit qu'envoyer un
 * message PREND le fil implicitement. Le release partait avant que l'envoi ne soit traité, l'envoi reprenait
 * le fil juste derrière, l'agent de Meta restait muet et le client parlait dans le vide. Trois releases émis
 * deux secondes après un envoi ont échoué, celui émis quatorze minutes après a marché.
 *
 * 🔴 CE FICHIER GARDE LE POINT DE DÉCLENCHEMENT, pas la requête. Le caractère UNIQUE de la remise est tenu
 * par la base (un `update ... returning` conditionné), et il a son test d'intégration :
 * `tests/integration/release-mba-marqueur.integration.test.ts`. Ici on vérifie que le signal ARRIVE, pour
 * tous les statuts, et qu'une remise ratée ne coûte rien à la livraison.
 */

const statut = (id: string, status: string): WebhookEvent => ({
  source: 'statuses',
  dedupKey: `st:${id}:${status}`,
  data: { id, status },
} as unknown as WebhookEvent);

function magasin() {
  const majs: Array<{ id: string; status: string }> = [];
  return {
    majs,
    delivery: {
      updateDeliveryByMessageId: async (id: string, status: string) => { majs.push({ id, status }); return 1; },
    },
  };
}

describe('l’accusé d’un envoi déclenche la remise du fil', () => {
  it('🔴 le signal part pour CHAQUE statut, et avec l’identifiant du message', async () => {
    const m = magasin();
    const vus: string[] = [];
    await processStatuses(
      [statut('wamid.AAA', 'sent'), statut('wamid.BBB', 'delivered')],
      m.delivery as never, undefined, async (id) => { vus.push(id); },
    );
    expect(vus).toEqual(['wamid.AAA', 'wamid.BBB']);
  });

  it('🔴 `failed` compte AUSSI : ce qu’on attend est la preuve que Meta a fini, pas une bonne nouvelle', async () => {
    // Un fil qui n'attendrait qu'un `sent` resterait gelé jusqu'au balayage quand l'envoi échoue.
    const m = magasin();
    const vus: string[] = [];
    await processStatuses([statut('wamid.CCC', 'failed')], m.delivery as never, undefined, async (id) => { vus.push(id); });
    expect(vus).toEqual(['wamid.CCC']);
  });

  it('🔴 une remise qui ÉCHOUE ne fait perdre AUCUNE livraison, ni la sienne ni les suivantes', async () => {
    // Une exception ici ferait rejouer tout le job par pg-boss, donc re-traiter des statuts déjà appliqués,
    // pour un motif secondaire : la remise ratée est rattrapée par le balayage de contrôle.
    const m = magasin();
    await processStatuses(
      [statut('wamid.AAA', 'sent'), statut('wamid.BBB', 'read')],
      m.delivery as never, undefined, async () => { throw new Error('Meta refuse'); },
    );
    expect(m.majs.map((x) => x.id)).toEqual(['wamid.AAA', 'wamid.BBB']);
  });

  it('⚠️ sans remise câblée, les livraisons s’appliquent comme avant', async () => {
    const m = magasin();
    await processStatuses([statut('wamid.AAA', 'sent')], m.delivery as never);
    expect(m.majs).toEqual([{ id: 'wamid.AAA', status: 'sent' }]);
  });

  it('⚠️ un événement qui n’est PAS un statut ne déclenche rien', async () => {
    const m = magasin();
    const vus: string[] = [];
    await processStatuses(
      [{ source: 'messages', dedupKey: 'msg:x', data: { id: 'wamid.ZZZ' } } as unknown as WebhookEvent],
      m.delivery as never, undefined, async (id) => { vus.push(id); },
    );
    expect(vus).toEqual([]);
    expect(m.majs).toEqual([]);
  });
});
