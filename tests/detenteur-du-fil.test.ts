import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { processInbound, type DepsEntrants, type InboxStore, type InboundMessage } from '../src/webhooks/inbound';
import { creerControleDuFil } from '../src/inbox/fil';
import { bancDuFil, depotEnMemoire } from './banc-du-fil';
import { aucuneCorrectionDuDetenteur, entrantsDe } from './webhook-fixtures';
import { aucunStop } from './consentement';

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
          ? { standby: { contacts: [{ wa_id: '33633921577' }], messages: [{ id: 'wamid.X', from: '33633921577', type: 'text', timestamp: '1758585600', text: { body: 'coucou' } }] } }
          : { contacts: [{ wa_id: '33633921577' }], messages: [{ id: 'wamid.X', from: '33633921577', type: 'text', text: { body: 'coucou' } }] }),
        metadata: { phone_number_id: '1234840649713976' },
      },
    }],
  }],
});

/**
 * Le store des entrants, et la correction du détenteur par le VRAI geste (`ControleDuFil.entrantEnStandby`), sur un
 * dépôt qui note ce qu'on lui demande d'écrire.
 */
function fauxStore() {
  const ecrits: Array<{ owner: string; only?: readonly string[]; saufEscalade?: boolean; effacerEscalade?: boolean; messageEnvoyeLe?: Date }> = [];
  const store: InboxStore = {
    recordInbound: async (_t: string, _m: InboundMessage) => {},
  };
  const { fil } = bancDuFil({
    depot: {
      setControlOwner: async (_t, _w, owner, opts) => {
        ecrits.push({
          owner, ...(opts?.only ? { only: opts.only } : {}), ...(opts?.saufEscalade ? { saufEscalade: true } : {}),
          ...(opts?.effacerEscalade ? { effacerEscalade: true } : {}),
          ...(opts?.messageEnvoyeLe ? { messageEnvoyeLe: opts.messageEnvoyeLe } : {}),
        });
        return true;
      },
    },
  });
  return { store, ecrits, detenteur: fil };
}

describe('le détenteur du fil se déduit du `field` de chaque entrant', () => {
  it('🔴 un `standby` dit que le MBA tient le fil, et il écrase un `app_human`, SAUF une escalade (0164)', () => {
    // Meta fait autorité, y compris contre un `app_human` : si son agent répond, un opérateur qui se croit
    // maître du fil se ferait doubler sans comprendre pourquoi.
    // ⚠️ Sauf une ESCALADE (2026-09-23) : une fois le fil passé à l'équipe, Meta envoie les messages sur
    // `messages` ; un `standby` traité après est un retardataire, et il rendait la conversation à l'agent.
    const { store, ecrits, detenteur } = fauxStore();
    return entrantsDe(PAYLOAD('standby'), 'tenant-1').then((entrants) => processInbound(entrants, store, { optOut: aucunStop, detenteur })).then(() => {
      // 🔴 AVEC LA DATE DU MESSAGE (revue finale du 2026-09-23) : c'est elle qui distingue un retardataire d'un
      // standby postérieur à l'escalade, donc d'un fil que l'agent de Meta a réellement repris. Sans elle, la
      // garde écartait tout standby pour toujours.
      // Et il EFFACE l'escalade quand il passe : un robot reprend le fil (décision de Julien du 2026-09-27).
      expect(ecrits).toEqual([{ owner: 'mba', saufEscalade: true, effacerEscalade: true, messageEnvoyeLe: new Date(1758585600 * 1000) }]);
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
    const { store, ecrits, detenteur } = fauxStore();
    await processInbound(await entrantsDe(PAYLOAD('messages'), 'tenant-1'), store, { optOut: aucunStop, detenteur });
    expect(ecrits).toEqual([]);
  });

  it('🔴 un `field` absent ne corrige RIEN', async () => {
    // Forme de payload qu'on ne sait pas interpréter : deviner vaudrait moins que se taire.
    const { store, ecrits, detenteur } = fauxStore();
    await processInbound(await entrantsDe(PAYLOAD(null), 'tenant-1'), store, { optOut: aucunStop, detenteur });
    expect(ecrits).toEqual([]);
  });

  it('🔴 la correction est REQUISE, et la fixture inerte des autres suites n’empêche pas d’enregistrer', async () => {
    // Optionnelle (jusqu'à la relecture du lot 4), un câblage qui l'oubliait compilait, et notre colonne pouvait
    // croire un opérateur maître d'un fil que l'agent de Meta avait repris. `npm run typecheck` tient ce refus.
    // @ts-expect-error `detenteur` manque, et c'est ce que le type refuse.
    const sansDetenteur: DepsEntrants = { optOut: aucunStop };
    expect(sansDetenteur.optOut).toBe(aucunStop);
    // Les suites qui ne parlent pas du détenteur passent une correction inerte : le message reste la donnée métier.
    const recus: string[] = [];
    await processInbound(await entrantsDe(PAYLOAD('standby'), 'tenant-1'), {
      recordInbound: async (_t, m) => { recus.push(m.body ?? ''); },
    }, { optOut: aucunStop, detenteur: aucuneCorrectionDuDetenteur });
    expect(recus).toEqual(['coucou']);
  });

  it('🔴 le détenteur se corrige AVANT l’affectation : notre colonne d’accord avec Meta, puis on agit', async () => {
    // Dans l'ordre inverse, la prise du fil pour l'équipe (réponse de campagne « Inbox ») était réécrite `mba` par
    // le `standby` du même message, alors que Meta venait de nous céder le fil.
    const ordre: string[] = [];
    await processInbound(await entrantsDe(PAYLOAD('standby'), 'tenant-1'), {
      recordInbound: async () => { ordre.push('enregistre'); },
    }, {
      optOut: aucunStop,
      detenteur: { entrantEnStandby: async () => { ordre.push('detenteur'); } },
      assignation: async () => { ordre.push('affectation'); },
    });
    expect(ordre).toEqual(['enregistre', 'detenteur', 'affectation']);
  });

  it('le worker câble le VRAI geste, pas une correction inerte', () => {
    // Le type exige une valeur, pas la bonne : une fermeture vide compilerait.
    const worker = readFileSync(resolve(__dirname, '../src/worker.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(worker.match(/^\s*detenteur: fil,\s*$/gm)).toHaveLength(1);
  });

  it('🔴 un échec de correction n’empêche PAS d’enregistrer le message', async () => {
    // La correction est best-effort : le message du client est la donnée métier, la propriété du fil est un
    // confort d'aiguillage. Les inverser perdrait un message pour une raison sans rapport.
    const recus: string[] = [];
    const { fil } = bancDuFil({ depot: { setControlOwner: async () => { throw new Error('base indisponible'); } } });
    await processInbound(await entrantsDe(PAYLOAD('standby'), 'tenant-1'), {
      recordInbound: async (_t, m) => { recus.push(m.body ?? ''); },
    }, { optOut: aucunStop, detenteur: fil });
    expect(recus).toEqual(['coucou']);
  });
});

/**
 * Les deux boutons, par le VRAI geste (`src/inbox/fil.ts`) : un numéro et un client Meta qui notent ce qu'on leur
 * passe, sur un dépôt en mémoire. Ces cas gardaient les deux fabriques d'appel à Meta, absorbées par le module.
 */
function monterBouton(o: { numero?: string | null; detenteur: 'mba' | 'app_human'; release?: () => Promise<void>; take?: () => Promise<void> }) {
  const appels: Array<[string, string, string]> = [];
  let clientDemande = false;
  const memoire = depotEnMemoire({ '33633921577': { owner: o.detenteur } });
  const fil = creerControleDuFil({
    depot: memoire.depot,
    reglages: { get: async () => ({ mbaEnabled: true }) },
    parcours: { findWaitingByWaId: async () => null },
    numeros: { getTenantPhoneNumberId: async () => (o.numero === undefined ? '1234840649713976' : o.numero) },
    meta: {
      mbaClientForTenant: async () => {
        clientDemande = true;
        return {
          releaseThread: async (pn: string, waId: string) => { appels.push(['release', pn, waId]); await o.release?.(); },
          takeThread: async (pn: string, waId: string) => { appels.push(['take', pn, waId]); await o.take?.(); },
        };
      },
    },
    attendre: async () => {},
  });
  return { fil, appels, clientDemande: () => clientDemande, etat: memoire.etat };
}

describe('rendre le fil à Meta (« Rendre la main »)', () => {
  it('appelle `releaseThread` avec le numéro du client, puis écrit `mba`', async () => {
    const m = monterBouton({ detenteur: 'app_human' });
    expect(await m.fil.rendreLaMain('tenant-1', '33633921577', { collaborateur: null })).toBe('mba');
    expect(m.appels).toEqual([['release', '1234840649713976', '33633921577']]);
    expect(m.etat('33633921577')?.owner).toBe('mba');
  });

  it('sans numéro connecté, il n’y a rien à rendre : AUCUN appel, et rien d’écrit', async () => {
    // Même règle que le balayage et la fin de parcours (décision de Julien du 2026-09-27) : la colonne ne bouge
    // pas, ni vers `mba` (un agent qui ne peut pas répondre), ni vers `app_workflow` (hors « À traiter »).
    const m = monterBouton({ detenteur: 'app_human', numero: null });
    expect(await m.fil.rendreLaMain('tenant-1', '33633921577', { collaborateur: null })).toBe('aucun_numero');
    expect(m.clientDemande()).toBe(false);
    expect(m.etat('33633921577')?.owner).toBe('app_human');
  });

  it('🔴 LÈVE si Meta refuse, et n’écrit rien', async () => {
    // C'est ce qui permet à la route de répondre 409 sans avoir écrit son état local. Un `catch` silencieux ici
    // recréerait le défaut qu'on répare : un état local qui annonce ce que Meta n'a pas fait.
    const m = monterBouton({ detenteur: 'app_human', release: async () => { throw new Error('jeton expiré'); } });
    await expect(m.fil.rendreLaMain('tenant-1', '33633921577', { collaborateur: null })).rejects.toThrow('jeton expiré');
    expect(m.etat('33633921577')?.owner).toBe('app_human');
  });
});

describe('prendre le fil à Meta (« Reprendre la main »)', () => {
  it('🔴 appelle `takeThread`, PAS `releaseThread`', async () => {
    // Les deux actes partent sur la MÊME URL et ne different que par un mot dans le corps : les confondre
    // rendrait le fil à l'agent de Meta sous un bouton qui promet de le lui prendre, et le symptôme serait
    // exactement celui qu'on répare.
    const m = monterBouton({ detenteur: 'mba' });
    expect(await m.fil.reprendreLaMain('tenant-1', '33633921577', { collaborateur: null })).toBe('pris');
    expect(m.appels).toEqual([['take', '1234840649713976', '33633921577']]);
    expect(m.etat('33633921577')?.owner).toBe('app_human');
  });

  it('sans numéro connecté : AUCUN appel, et le fil est à l’équipe (notre colonne est la seule vérité)', async () => {
    const m = monterBouton({ detenteur: 'mba', numero: null });
    expect(await m.fil.reprendreLaMain('tenant-1', '33633921577', { collaborateur: null })).toBe('pris');
    expect(m.appels).toEqual([]);
    expect(m.etat('33633921577')?.owner).toBe('app_human');
  });

  it('🔴 un refus de Meta est RENDU, et rien n’est écrit', async () => {
    // Meta réserve `take` au « configured escalation partner » : le refus est un cas NORMAL. L'avaler laisserait
    // un opérateur croire qu'il a éteint l'agent de Meta, donc cesser de surveiller la conversation pendant que
    // l'agent continue de répondre. Le geste rejoue un refus passager (décision de Julien du 2026-09-27), jamais
    // un refus définitif : un seul appel ici.
    const m = monterBouton({ detenteur: 'mba', take: async () => { throw new Error('not the configured escalation partner'); } });
    expect(await m.fil.reprendreLaMain('tenant-1', '33633921577', { collaborateur: null })).toBe('refuse');
    expect(m.appels).toHaveLength(1);
    expect(m.etat('33633921577')?.owner).toBe('mba');
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
    const { store, ecrits, detenteur } = fauxStore();
    await processInbound(await entrantsDe(PAYLOAD('messages'), 'tenant-1'), store, { optOut: aucunStop, detenteur });
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
