import { describe, it, expect } from 'vitest';
import { lancerCampagne, type DepsMoteurDeTest } from './campagne-canaux';
import type {
  MessageSender, RecipientStore, CampaignStore, QualityProvider, CanalServi,
} from '../src/campaign/engine';
import type { Campaign, Recipient, QualityRating } from '../src/campaign/types';
import type { Etage } from '../src/campaign/etages';
import type { SendResult, MarketingParams, TemplateSpec } from '../src/meta/types';

/**
 * « MESSAGE ET SCÉNARIO » SUR UN ÉTAGE RCS : le message part, PUIS le scénario.
 *
 * 🔴 LE DÉFAUT QUE CE FICHIER FERME, MESURÉ LE 2026-09-13 AVEC LE VRAI MOTEUR. La formule existait dans
 * l'écran, l'identifiant du scénario était enregistré sur l'étage, et le moteur ne le lisait JAMAIS :
 * `engine.ts` teste `servi.sender` AVANT `contenu.workflowId`, et un étage RCS a toujours un sender. Le
 * message partait, la campagne comptait un envoi réussi, et le scénario ne démarrait pas. Personne ne
 * pouvait le voir : l'écran affichait « envoyé », ce qui était vrai, pour une campagne à moitié faite.
 *
 * 🔴 ET LE MÊME `!contenu.workflowId` PRIVAIT LE FIL DE SA TRACE. Le journal de conversation était sauté
 * dès qu'un étage portait un scénario, au motif que « le vrai envoi est journalisé ailleurs ». C'est vrai
 * sur WhatsApp (le worker journalise au moment de l'envoi du modèle) et FAUX sur RCS, où le message vient
 * de partir d'ici. L'opérateur ouvrait le fil du client et n'y voyait aucune trace de ce qui venait de lui
 * être envoyé.
 *
 * ⚠️ CE QUI SÉPARE LA BONNE IMPLÉMENTATION DE LA FAUSSE : un scénario qui ne démarre pas ne doit JAMAIS
 * relabelliser en échec un message déjà livré. Un destinataire `failed` est repris par une relance, donc
 * la personne recevrait le message RCS une SECONDE fois.
 */

class Recipients implements RecipientStore {
  readonly resultats = new Map<string, { status: string; error?: string }>();
  constructor(private readonly p: Recipient[]) {}
  async listPending(): Promise<Recipient[]> { return this.p; }
  async claim(): Promise<boolean> { return true; }
  async relacher(): Promise<void> { /* rien */ }
  async markResult(id: string, r: { status: 'sent' | 'failed' | 'skipped'; error?: string }): Promise<void> {
    this.resultats.set(id, { status: r.status, ...(r.error !== undefined ? { error: r.error } : {}) });
  }
}
class Campaigns implements CampaignStore { async setStatus(): Promise<void> { /* rien */ } }
class Quality implements QualityProvider { async getRating(): Promise<QualityRating> { return 'GREEN'; } }
class SenderWa implements MessageSender {
  readonly envois: string[] = [];
  async sendMarketing(p: MarketingParams): Promise<SendResult> {
    this.envois.push(String(p.to ?? p.recipient ?? ''));
    return { messageId: 'wa-1' };
  }
  async sendTemplate(to: string): Promise<SendResult> { this.envois.push(to); return { messageId: 'wa-1' }; }
}

/** Le journal des gestes, dans l'ORDRE où ils se produisent : c'est lui qui prouve la séquence. */
function gestes(): string[] { return []; }

const CHAINE: Etage[] = [
  { rang: 1, canal: 'whatsapp', templateName: 'promo', templateLanguage: 'fr' },
  { rang: 2, canal: 'rcs', rcsMessage: { kind: 'text', text: 'le repli' }, workflowId: 'wf-42' },
];

const CAMPAGNE: Campaign = {
  id: 'c1', tenantId: 't1', phoneNumberId: 'pn1', category: 'marketing',
  templateName: 'promo', templateLanguage: 'fr', paramMapping: [], status: 'draft',
  workflowId: null, ratePerMinute: null, startNodeId: null, channel: 'whatsapp', chaine: CHAINE,
};

function destinataire(etageCourant: number): Recipient {
  return { id: 'r1', contactId: 'ct1', toE164: '+33611', resolvedParams: [], status: 'pending', etageCourant };
}

/** Monte un run sur l'étage 2 (RCS), avec de quoi observer l'ordre des gestes. */
function monter(o: {
  chaine?: Etage[];
  etageCourant?: number;
  envoiRcs?: () => Promise<SendResult | { skipped: string }>;
  demarrage?: () => Promise<void | boolean | string>;
  suivi: string[];
  /** Ce que le scénario a reçu comme variables de premier modèle. Cf. le cas dédié plus bas. */
  paramsRecus?: Array<string[] | null>;
}) {
  const recipients = new Recipients([destinataire(o.etageCourant ?? 2)]);
  const journalFil: Array<{ body: string; type?: string }> = [];
  const rcs: CanalServi = {
    sender: {
      async sendTo(): Promise<SendResult | { skipped: string }> {
        o.suivi.push('rcs');
        return o.envoiRcs ? o.envoiRcs() : { messageId: 'rcs-1' };
      },
    },
  };
  const deps: DepsMoteurDeTest = {
    sender: new SenderWa(), campaigns: new Campaigns(), quality: new Quality(),
    now: () => 1_000_000_000,
    recipients,
    canaux: { rcs },
    startWorkflow: async (_t, _wf, _wa, _ct, params) => {
      o.suivi.push('scenario');
      o.paramsRecus?.push(params ?? null);
      return o.demarrage ? o.demarrage() : true;
    },
    recordOutbound: async (_t, _w, m) => {
      o.suivi.push('journal');
      journalFil.push({ body: m.body, ...(m.type !== undefined ? { type: m.type } : {}) });
    },
  };
  const campagne: Campaign = { ...CAMPAGNE, ...(o.chaine ? { chaine: o.chaine } : {}) };
  return { campagne, deps, recipients, journalFil };
}

describe('un etage RCS qui porte un scenario', () => {
  it('🔴 envoie le message ET demarre le scenario, dans cet ordre', async () => {
    const suivi = gestes();
    const { campagne, deps, recipients } = monter({ suivi });
    const rapport = await lancerCampagne(campagne, deps);
    expect(rapport).toMatchObject({ sent: 1, failed: 0, skipped: 0 });
    // L'ORDRE compte : démarrer le scénario avant l'envoi ferait arriver sa suite avant le message.
    expect(suivi.filter((g) => g === 'rcs' || g === 'scenario')).toEqual(['rcs', 'scenario']);
    expect(recipients.resultats.get('r1')).toMatchObject({ status: 'sent' });
  });

  /**
   * 🔴 LE MESSAGE RCS ENTRE DANS LE FIL, SCÉNARIO OU PAS. La condition d'origine sautait le journal dès
   * qu'un étage portait un scénario : vrai sur WhatsApp, faux ici, où le message vient de partir.
   */
  it('🔴 journalise le message RCS dans le fil, meme avec un scenario', async () => {
    const suivi = gestes();
    const { campagne, deps, journalFil } = monter({ suivi });
    await lancerCampagne(campagne, deps);
    expect(journalFil).toHaveLength(1);
    expect(journalFil[0]).toMatchObject({ body: 'le repli', type: 'rcs' });
  });

  /**
   * 🔴 UN DESTINATAIRE ÉCARTÉ PAR LE CANAL NE DÉMARRE RIEN. Rien n'est parti : démarrer le scénario lui
   * enverrait quand même la suite d'un message qu'il n'a jamais reçu.
   */
  it('🔴 un contact non joignable en RCS ne declenche AUCUN scenario', async () => {
    const suivi = gestes();
    const { campagne, deps, recipients } = monter({
      suivi,
      envoiRcs: async () => ({ skipped: 'non joignable en RCS' }),
    });
    const rapport = await lancerCampagne(campagne, deps);
    expect(rapport).toMatchObject({ sent: 0, skipped: 1 });
    expect(suivi).not.toContain('scenario');
    expect(recipients.resultats.get('r1')).toMatchObject({ status: 'skipped' });
  });

  /**
   * 🔴 UN SCÉNARIO QUI NE DÉMARRE PAS NE RELABELLISE PAS UN MESSAGE LIVRÉ. Le marquer `failed` le rendrait
   * repris par une relance, et la personne recevrait le message RCS une SECONDE fois. Le destinataire
   * reste `sent`, et la raison est enregistrée à côté.
   */
  it('🔴 un scenario refuse laisse le destinataire ENVOYE, avec la raison', async () => {
    const suivi = gestes();
    const { campagne, deps, recipients } = monter({ suivi, demarrage: async () => 'fil repris par un operateur' });
    const rapport = await lancerCampagne(campagne, deps);
    expect(rapport).toMatchObject({ sent: 1, failed: 0 });
    const vu = recipients.resultats.get('r1');
    expect(vu?.status).toBe('sent');
    expect(vu?.error).toMatch(/fil repris par un operateur/);
  });

  it('🔴 une EXCEPTION du demarrage ne fait pas echouer un message deja parti', async () => {
    const suivi = gestes();
    const { campagne, deps, recipients } = monter({
      suivi,
      demarrage: async () => { throw new Error('postgres indisponible'); },
    });
    const rapport = await lancerCampagne(campagne, deps);
    expect(rapport).toMatchObject({ sent: 1, failed: 0 });
    expect(recipients.resultats.get('r1')?.status).toBe('sent');
  });

  it('un scenario qui rend `false` est signale aussi', async () => {
    const suivi = gestes();
    const { campagne, deps, recipients } = monter({ suivi, demarrage: async () => false });
    await lancerCampagne(campagne, deps);
    expect(recipients.resultats.get('r1')?.error).toMatch(/scénario non démarré/i);
  });

  /**
   * ⚠️ L'AUTRE SENS, sans quoi une implémentation qui démarrerait TOUJOURS un scénario passerait tout ce
   * qui précède.
   */
  it('⚠️ un etage RCS SANS scenario ne demarre rien', async () => {
    const suivi = gestes();
    const { campagne, deps } = monter({
      suivi,
      chaine: [
        { rang: 1, canal: 'whatsapp', templateName: 'promo', templateLanguage: 'fr' },
        { rang: 2, canal: 'rcs', rcsMessage: { kind: 'text', text: 'le repli' } },
      ],
    });
    const rapport = await lancerCampagne(campagne, deps);
    expect(rapport).toMatchObject({ sent: 1 });
    expect(suivi).not.toContain('scenario');
  });

  /**
   * ⚠️ ET LE CHEMIN WHATSAPP NE BOUGE PAS. Là-bas le scénario EST l'envoi : il ne doit pas partir en plus
   * d'un message, sans quoi le contact recevrait deux fois la même ouverture.
   */
  it('⚠️ sur un etage WhatsApp, le scenario reste le SEUL envoi', async () => {
    const suivi = gestes();
    const recipients = new Recipients([destinataire(1)]);
    const wa = new SenderWa();
    const campagne: Campaign = {
      ...CAMPAGNE, workflowId: 'wf-42',
      chaine: [{ rang: 1, canal: 'whatsapp', templateName: '', templateLanguage: 'fr', workflowId: 'wf-42' }],
    };
    const rapport = await lancerCampagne(campagne, {
      sender: wa, campaigns: new Campaigns(), quality: new Quality(),
      now: () => 1_000_000_000, recipients,
      startWorkflow: async () => { suivi.push('scenario'); return true; },
    });
    expect(rapport).toMatchObject({ sent: 1 });
    expect(suivi).toEqual(['scenario']);
    expect(wa.envois).toEqual([]);
  });
});

/**
 * 🔴 LES VARIABLES DU RANG 1 NE PARTENT PAS AVEC LE SCÉNARIO D'UN ÉTAGE DE REPLI (relevé en revue le
 * 2026-09-13).
 *
 * `campaign.paramMapping` décrit le modèle du RANG 1 et lui seul, et `startWorkflow` passe ces valeurs au
 * PREMIER bloc « Modèle » que le parcours rencontre. Sur un étage de repli, ce modèle-là n'a aucune raison
 * d'avoir les mêmes variables : Meta refuserait le message (mauvais nombre), ou, pire, remplirait le bon
 * nombre de trous avec les mauvaises valeurs, ce que personne ne verrait avant de lire un message reçu.
 */
describe('les variables heritees d un etage de repli', () => {
  it('🔴 un scenario de RANG 2 ne recoit AUCUNE variable du modele du rang 1', async () => {
    const suivi = gestes();
    const paramsRecus: Array<string[] | null> = [];
    const { campagne, deps } = monter({ suivi, paramsRecus });
    // Le destinataire porte les variables resolues du rang 1 : c'est le cas reel.
    const recipients = new Recipients([{ id: 'r1', contactId: 'ct1', toE164: '+33611', resolvedParams: ['Jean', '42 euros'], status: 'pending', etageCourant: 2 }]);
    await lancerCampagne(campagne, { ...deps, recipients });
    expect(paramsRecus).toEqual([[]]);
  });

  /**
   * ⚠️ L'AUTRE SENS, sans quoi une implementation qui n'enverrait JAMAIS de variables passerait le cas
   * ci-dessus : au rang 1, `paramMapping` decrit bien ce qui part, et les variables doivent suivre.
   */
  it('⚠️ ...mais un scenario de RANG 1 les recoit, elles decrivent bien son modele', async () => {
    const suivi = gestes();
    const paramsRecus: Array<string[] | null> = [];
    const recipients = new Recipients([{ id: 'r1', contactId: 'ct1', toE164: '+33611', resolvedParams: ['Jean'], status: 'pending', etageCourant: 1 }]);
    const campagne: Campaign = {
      ...CAMPAGNE, workflowId: 'wf-42', paramMapping: [{ source: 'field', key: 'prenom' }] as never,
      chaine: [{ rang: 1, canal: 'whatsapp', templateName: '', templateLanguage: 'fr', workflowId: 'wf-42' }],
    };
    await lancerCampagne(campagne, {
      sender: new SenderWa(), campaigns: new Campaigns(), quality: new Quality(),
      now: () => 1_000_000_000, recipients,
      startWorkflow: async (_t, _wf, _wa, _ct, params) => { suivi.push('scenario'); paramsRecus.push(params ?? null); return true; },
    });
    expect(paramsRecus).toEqual([['Jean']]);
  });
});
