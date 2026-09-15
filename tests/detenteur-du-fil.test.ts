import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { processInbound, type InboxStore, type InboundMessage } from '../src/webhooks/inbound';
import { creerRendreLeFil, creerPrendreLeFil } from '../src/inbox/controle-du-fil';

/**
 * Qui détient le fil d'une conversation, et comment on l'apprend.
 *
 * 🔴 CE FICHIER GARDE DEUX PANNES VÉCUES LE 2026-09-10, à quelques heures d'intervalle :
 *
 *  1. le bouton « rendre la main » de l'Inbox n'appelait JAMAIS Meta. Julien rend la main, écrit sur
 *     WhatsApp, et l'agent de Meta reste muet : Meta croyait toujours que nous tenions le fil ;
 *  2. rien, dans notre code, n'apprenait qu'un fil avait changé de mains. On comptait sur l'événement
 *     `messaging_handovers`, dont il y a eu **zéro occurrence** sur 58 payloads réels. Le seul signal qu'on
 *     reçoive vraiment est le `field` de chaque message entrant, et on le jetait.
 */

const PAYLOAD = (field: 'messages' | 'standby' | null) => ({
  entry: [{
    id: '1695646181671929',
    changes: [{
      ...(field === null ? {} : { field }),
      value: {
        ...(field === 'standby'
          ? { standby: { contacts: [{ wa_id: '33633921577' }], messages: [{ id: 'wamid.X', from: '33633921577', type: 'text', text: { body: 'coucou' } }] } }
          : { contacts: [{ wa_id: '33633921577' }], messages: [{ id: 'wamid.X', from: '33633921577', type: 'text', text: { body: 'coucou' } }] }),
        metadata: { phone_number_id: '1234840649713976' },
      },
    }],
  }],
});

function fauxStore() {
  const ecrits: Array<{ owner: string; only?: readonly string[] }> = [];
  const store: InboxStore = {
    phoneNumberTenant: async () => 'tenant-1',
    recordInbound: async (_t: string, _m: InboundMessage) => {},
    setControlOwner: async (_t, _w, owner, opts) => {
      ecrits.push({ owner, ...(opts?.only ? { only: opts.only } : {}) });
      return true;
    },
  };
  return { store, ecrits };
}

describe('le détenteur du fil se déduit du `field` de chaque entrant', () => {
  it('🔴 un `standby` dit que le MBA tient le fil, et il écrase SANS condition', () => {
    // Meta fait autorité, y compris contre un `app_human` : si son agent répond, un opérateur qui se croit
    // maître du fil se ferait doubler sans comprendre pourquoi.
    const { store, ecrits } = fauxStore();
    return processInbound(PAYLOAD('standby'), store).then(() => {
      expect(ecrits).toEqual([{ owner: 'mba' }]);
    });
  });

  it('🔴 un `messages` n’écrit RIEN : un entrant ne dit rien du détenteur', async () => {
    /**
     * 🔴 CE TEST FIGEAIT UNE SÉMANTIQUE FAUSSE, et le code la suivait. Mesuré sur 30 jours de webhooks réels
     * le 2026-09-15 : 126 messages ENTRANTS du client, 100 % en `messages`, ZÉRO en `standby`. Et les 23
     * payloads `standby` ne portent AUCUN expéditeur, tous un `message` sortant : `standby` est l'ÉCHO de ce
     * que l'agent de Meta envoie, pas un canal d'entrants.
     *
     * La branche `messages` se déclenchait donc sur CHAQUE message du client et écrasait l'état `mba`. C'est
     * elle qui rendait une conversation invisible du dossier « À traiter » après un scénario.
     */
    const { store, ecrits } = fauxStore();
    await processInbound(PAYLOAD('messages'), store);
    expect(ecrits).toEqual([]);
  });

  it('🔴 un `field` absent ne corrige RIEN', async () => {
    // Forme de payload qu'on ne sait pas interpréter : deviner vaudrait moins que se taire.
    const { store, ecrits } = fauxStore();
    await processInbound(PAYLOAD(null), store);
    expect(ecrits).toEqual([]);
  });

  it('un store sans `setControlOwner` continue de marcher', async () => {
    // Les suites de tests construisent des deps minimales : la méthode est optionnelle, et son absence ne
    // doit pas casser l'enregistrement du message, qui est la donnée métier.
    const recus: string[] = [];
    await processInbound(PAYLOAD('standby'), {
      phoneNumberTenant: async () => 'tenant-1',
      recordInbound: async (_t, m) => { recus.push(m.body ?? ''); },
    });
    expect(recus).toEqual(['coucou']);
  });

  it('🔴 un échec de correction n’empêche PAS d’enregistrer le message', async () => {
    // La correction est best-effort : le message du client est la donnée métier, la propriété du fil est un
    // confort d'aiguillage. Les inverser perdrait un message pour une raison sans rapport.
    const recus: string[] = [];
    await processInbound(PAYLOAD('standby'), {
      phoneNumberTenant: async () => 'tenant-1',
      recordInbound: async (_t, m) => { recus.push(m.body ?? ''); },
      setControlOwner: async () => { throw new Error('base indisponible'); },
    });
    expect(recus).toEqual(['coucou']);
  });
});

describe('rendre le fil à Meta', () => {
  it('appelle `releaseThread` avec le numéro du client et rend `true`', async () => {
    const appels: Array<[string, string]> = [];
    const rendre = creerRendreLeFil({
      numeroDuTenant: async () => '1234840649713976',
      clientMba: async () => ({ releaseThread: async (pn: string, waId: string) => { appels.push([pn, waId]); }, takeThread: async () => {} }),
    });
    expect(await rendre('tenant-1', '33633921577')).toBe(true);
    expect(appels).toEqual([['1234840649713976', '33633921577']]);
  });

  it('sans numéro connecté, il n’y a rien à rendre : `false`, et AUCUN appel', async () => {
    let appele = false;
    const rendre = creerRendreLeFil({
      numeroDuTenant: async () => null,
      clientMba: async () => { appele = true; return { releaseThread: async () => {}, takeThread: async () => {} }; },
    });
    expect(await rendre('tenant-1', '33633921577')).toBe(false);
    expect(appele).toBe(false);
  });

  it('🔴 LÈVE si Meta refuse, elle n’avale pas l’échec', async () => {
    // C'est ce qui permet à l'appelant de REFUSER d'écrire son état local. Un `catch` silencieux ici
    // recréerait le défaut qu'on répare : un état local qui annonce ce que Meta n'a pas fait.
    const rendre = creerRendreLeFil({
      numeroDuTenant: async () => '1234840649713976',
      clientMba: async () => ({ releaseThread: async () => { throw new Error('jeton expiré'); }, takeThread: async () => {} }),
    });
    await expect(rendre('tenant-1', '33633921577')).rejects.toThrow('jeton expiré');
  });
});

describe('prendre le fil à Meta', () => {
  it('🔴 appelle `takeThread`, PAS `releaseThread`', async () => {
    // Les deux actes partent sur la MÊME URL et ne different que par un mot dans le corps : les confondre
    // rendrait le fil à l'agent de Meta sous un bouton qui promet de le lui prendre, et le symptôme serait
    // exactement celui qu'on répare.
    const appels: Array<[string, string, string]> = [];
    const prendre = creerPrendreLeFil({
      numeroDuTenant: async () => '1234840649713976',
      clientMba: async () => ({
        releaseThread: async (pn: string, waId: string) => { appels.push(['release', pn, waId]); },
        takeThread: async (pn: string, waId: string) => { appels.push(['take', pn, waId]); },
      }),
    });
    expect(await prendre('tenant-1', '33633921577')).toBe(true);
    expect(appels).toEqual([['take', '1234840649713976', '33633921577']]);
  });

  it('sans numéro connecté : `false`, et AUCUN appel', async () => {
    let appele = false;
    const prendre = creerPrendreLeFil({
      numeroDuTenant: async () => null,
      clientMba: async () => { appele = true; return { releaseThread: async () => {}, takeThread: async () => {} }; },
    });
    expect(await prendre('tenant-1', '33633921577')).toBe(false);
    expect(appele).toBe(false);
  });

  it('🔴 LÈVE si Meta refuse, et ça compte plus encore que pour son jumeau', async () => {
    // Meta réserve `take` au « configured escalation partner » : le refus est un cas NORMAL. L'avaler
    // laisserait un opérateur croire qu'il a éteint l'agent de Meta, donc cesser de surveiller la
    // conversation pendant que l'agent continue de répondre.
    const prendre = creerPrendreLeFil({
      numeroDuTenant: async () => '1234840649713976',
      clientMba: async () => ({
        releaseThread: async () => {},
        takeThread: async () => { throw new Error('not the configured escalation partner'); },
      }),
    });
    await expect(prendre('tenant-1', '33633921577')).rejects.toThrow('escalation partner');
  });
});

/**
 * 🔴 LE DÉFAUT QUE CE CHOIX DE VALEUR RÉPARE, ÉNONCÉ COMME UNE PROPRIÉTÉ DU DOSSIER.
 *
 * Mesuré sur le numéro de production le 2026-09-15 : scénario terminé (`status = done`) à 06:16, le client
 * réécrit « D accord » à 06:17, et `control_owner` repasse à `app_workflow`. Le dossier « À traiter » exclut
 * exactement cette valeur : la conversation devenait invisible, sans pastille, pour 24 h.
 */
describe('la valeur posée doit rester VISIBLE du dossier « À traiter »', () => {
  /** Le prédicat du dossier, recopié de `A_TRAITER_SQL` (`src/inbox/store.pg.ts`). */
  const dansATraiter = (owner: string, derniereDirection: string) =>
    owner !== 'app_workflow' && derniereDirection !== 'out';

  it('🔴 après un `messages`, l’état n’est pas TOUCHÉ, donc il reste visible', async () => {
    /**
     * C'est la propriété qui compte, et elle tient maintenant par l'ABSENCE d'écriture. Après un scénario,
     * le fil vaut `mba` (posé par la fin du parcours) : un client qui écrit le laisse à `mba`, qui EST dans
     * le dossier. C'est l'écriture parasite de `app_workflow` qui l'en sortait.
     */
    const { store, ecrits } = fauxStore();
    await processInbound(PAYLOAD('messages'), store);
    expect(ecrits).toEqual([]);
    expect(dansATraiter('mba', 'in')).toBe(true);
  });

  it('⚠️ et `app_workflow` est précisément ce qui l’en sortirait', () => {
    // La garde dit POURQUOI cette valeur est interdite ici, au lieu de se contenter de figer celle qu'on a
    // choisie : le jour où quelqu'un la rechange, c'est cette phrase qu'il doit lire.
    expect(dansATraiter('app_workflow', 'in')).toBe(false);
    expect(dansATraiter('app_human', 'in')).toBe(true);
    expect(dansATraiter('mba', 'in')).toBe(true);
  });
});

/**
 * 🔴 QUAND L'AGENT DE META PASSE LA MAIN À UN HUMAIN.
 *
 * C'est le chemin qui compte le plus : l'agent vient de dire au client « un membre de l'équipe va vous
 * répondre », et il nous rend le fil (`messaging_handovers` / `control_passed`, 4 observés en production).
 * Le code écrivait `app_workflow`, la SEULE valeur que le dossier « À traiter » exclut : la conversation
 * était rangée hors de la liste de travail à l'instant exact où quelqu'un attend une réponse humaine.
 */
describe('le passage de main de l’agent de Meta', () => {
  const handover = readFileSync(resolve(__dirname, '../src/webhooks/handover.ts'), 'utf8');

  it('🔴 pose `app_human`, pas `app_workflow`', () => {
    expect(handover).toContain("if (precedent === 'meta_business_agent') return 'app_human';");
    expect(handover).not.toContain("if (precedent === 'meta_business_agent') return 'app_workflow';");
  });

  it('🔴 et c’est ce qui le rend visible du dossier', () => {
    const dansATraiter = (owner: string) => owner !== 'app_workflow';
    expect(dansATraiter('app_human')).toBe(true);
    expect(dansATraiter('app_workflow')).toBe(false);
  });
});
