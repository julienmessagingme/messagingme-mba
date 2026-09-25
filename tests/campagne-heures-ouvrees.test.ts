import { describe, it, expect } from 'vitest';
import { lancerCampagne, type DepsMoteurDeTest } from './campagne-canaux';
import type { MessageSender, RecipientStore, CampaignStore, QualityProvider } from '../src/campaign/engine';
import { messageDePause } from '../src/campaign/pause';
import type { MotifDePause } from '../src/campaign/pause';
import type { Campaign, Recipient, QualityRating } from '../src/campaign/types';
import type { SendResult, MarketingParams, TemplateSpec } from '../src/meta/types';
import type { BusinessHours } from '../src/workflow/conditions';

/**
 * « Envoyer uniquement pendant les heures ouvrées » (migration 0122, demande de Julien du 2026-09-08).
 *
 * 🔴 CE QUE CES CAS PROTÈGENT. Une campagne qui part au mauvais moment n'échoue pas, elle ARRIVE : des
 * milliers de messages à 1 h du matin ne se rattrapent pas. Et la faute symétrique coûte tout autant : une
 * campagne qui s'arrête sans poser son instant de reprise dort jusqu'à ce qu'un humain la remarque, ce que
 * la migration 0103 avait justement été écrite pour supprimer.
 *
 * Les deux situations décrites par Julien sont ici, et elles passent par le MÊME code : « lancée à 23 h »
 * (le premier tour de boucle ferme) et « pas finie à la fermeture » (un tour du milieu ferme).
 */

const PARIS = 'Europe/Paris';
const jour = (open: string, close: string) => ({ closed: false, open, close });
const FERME = { closed: true, open: '', close: '' };
const SEMAINE: BusinessHours = {
  '0': FERME, '6': FERME,
  '1': jour('09:00', '18:00'), '2': jour('09:00', '18:00'), '3': jour('09:00', '18:00'),
  '4': jour('09:00', '18:00'), '5': jour('09:00', '18:00'),
};

/** Mardi 8 septembre 2026 : 14 h à Paris (ouvert) et 23 h à Paris (fermé). */
const OUVERT = Date.parse('2026-09-08T12:00:00.000Z');
const FERME_23H = Date.parse('2026-09-08T21:00:00.000Z');

class Sender implements MessageSender {
  readonly envoyes: string[] = [];
  async sendMarketing(p: MarketingParams): Promise<SendResult> {
    const to = p.to ?? p.recipient ?? '';
    this.envoyes.push(to);
    return { messageId: `m-${to}` };
  }
  async sendTemplate(to: string, _t: TemplateSpec): Promise<SendResult> {
    this.envoyes.push(to);
    return { messageId: `m-${to}` };
  }
}
class Recipients implements RecipientStore {
  readonly claimed: string[] = [];
  readonly relaches: string[] = [];
  readonly resultats = new Map<string, string>();
  constructor(private readonly pending: Recipient[]) {}
  async listPending(): Promise<Recipient[]> { return this.pending; }
  async claim(id: string): Promise<boolean> { this.claimed.push(id); return true; }
  async relacher(id: string): Promise<void> { this.relaches.push(id); }
  async markResult(id: string, r: { status: 'sent' | 'failed' | 'skipped' }): Promise<void> { this.resultats.set(id, r.status); }
}
class Campaigns implements CampaignStore {
  readonly statuts: string[] = [];
  readonly pauses: Array<{ raison: MotifDePause; reprise: Date | null }> = [];
  async setStatus(_id: string, status: string, pause?: { raison: MotifDePause; reprise: Date | null }): Promise<void> {
    if (pause) this.pauses.push(pause);
    this.statuts.push(status);
  }
}
class Qualite implements QualityProvider {
  async getRating(): Promise<QualityRating> { return 'GREEN'; }
}

const campagne = (over: Partial<Campaign> = {}): Campaign => ({
  id: 'c1', tenantId: 't1', phoneNumberId: 'pn1', category: 'marketing',
  templateName: 'promo', templateLanguage: 'fr', paramMapping: [], status: 'draft',
  workflowId: null, ratePerMinute: null, startNodeId: null, ...over,
});
const rec = (id: string, to: string): Recipient => ({ id, contactId: `ct-${id}`, toE164: to, resolvedParams: ['X'], status: 'pending' });

function deps(over: Partial<DepsMoteurDeTest> & { recipients: RecipientStore }, maintenant: number): DepsMoteurDeTest {
  return {
    sender: new Sender(), campaigns: new Campaigns(), quality: new Qualite(),
    now: () => maintenant,
    horairesOuvres: async () => ({ timeZone: PARIS, businessHours: SEMAINE }),
    ...over,
  };
}

describe('campagne « uniquement pendant les heures ouvrées »', () => {
  it('🔴 lancée à 23 h : RIEN ne part, et l’instant de reprise est posé à 9 h', async () => {
    // Le cas exact de Julien. La campagne n'est pas refusée (ce serait perdre le lancement) : elle est mise
    // en pause AVEC son échéance, et le balayage de reprise (0103) la relancera à l'ouverture.
    const sender = new Sender();
    const recipients = new Recipients([rec('r1', '+33611'), rec('r2', '+33622')]);
    const campaigns = new Campaigns();
    const report = await lancerCampagne(campagne({ businessHoursOnly: true }), deps({ recipients, sender, campaigns }, FERME_23H));

    expect(sender.envoyes).toEqual([]);
    expect(recipients.claimed).toEqual([]); // aucun destinataire RÉSERVÉ : ils restent tous `pending`
    expect(report.paused).toBe(true);
    expect(report.sent).toBe(0);
    expect(campaigns.statuts).toEqual(['running', 'paused']);
    expect(campaigns.pauses).toEqual([{ raison: 'hors_horaires', reprise: new Date('2026-09-09T07:00:00.000Z') }]);
  });

  it('🔴 la fermeture PENDANT l’envoi arrête le run et pose la reprise, sans perdre les suivants', async () => {
    // La seconde situation de Julien, et c'est le même code que la première : le contrôle est DANS la boucle,
    // donc il tombe entre deux destinataires. Celui d'après n'est ni réservé ni envoyé, il reste `pending`.
    //
    // L'horloge bascule QUAND LE PREMIER MESSAGE EST PARTI, pas après N appels : compter les appels à `now()`
    // ferait dépendre le test du nombre de fois que le moteur regarde l'heure, c'est-à-dire de son détail.
    let heure = OUVERT;
    class SenderQuiFerme extends Sender {
      override async sendMarketing(p: MarketingParams): Promise<SendResult> {
        const r = await super.sendMarketing(p);
        heure = FERME_23H;
        return r;
      }
    }
    const sender = new SenderQuiFerme();
    const recipients = new Recipients([rec('r1', '+33611'), rec('r2', '+33622'), rec('r3', '+33633')]);
    const campaigns = new Campaigns();
    const report = await lancerCampagne(
      campagne({ businessHoursOnly: true }),
      deps({ recipients, sender, campaigns, now: () => heure }, OUVERT),
    );

    expect(sender.envoyes).toEqual(['+33611']); // le premier est parti, les deux autres non
    expect(recipients.claimed).toEqual(['r1']); // r2 et r3 restent `pending`, aucun n'est perdu
    expect(report).toMatchObject({ sent: 1, paused: true });
    expect(campaigns.pauses).toEqual([{ raison: 'hors_horaires', reprise: new Date('2026-09-09T07:00:00.000Z') }]);
  });

  it('🔴 SANS la case cochée, l’heure n’a aucune influence : le comportement historique est intact', async () => {
    // La preuve inverse, et elle vaut autant que l'autre : sans elle, cocher ou non ne se distinguerait pas,
    // et toutes les campagnes du parc auraient hérité d'une contrainte que personne n'a demandée.
    const sender = new Sender();
    const recipients = new Recipients([rec('r1', '+33611')]);
    const campaigns = new Campaigns();
    const report = await lancerCampagne(campagne({ businessHoursOnly: false }), deps({ recipients, sender, campaigns }, FERME_23H));

    expect(sender.envoyes).toEqual(['+33611']);
    expect(report.sent).toBe(1);
    expect(campaigns.pauses).toEqual([]);
    expect(campaigns.statuts).toEqual(['running', 'completed']);
  });

  it('cochée mais DANS les heures ouvertes : l’envoi part normalement', async () => {
    const sender = new Sender();
    const recipients = new Recipients([rec('r1', '+33611')]);
    const campaigns = new Campaigns();
    const report = await lancerCampagne(campagne({ businessHoursOnly: true }), deps({ recipients, sender, campaigns }, OUVERT));

    expect(sender.envoyes).toEqual(['+33611']);
    expect(report.sent).toBe(1);
    expect(campaigns.pauses).toEqual([]);
  });

  it('🔴 AUCUN jour ouvert : pause SANS échéance, jamais une reprise qui n’arrivera pas', async () => {
    // `prochaineOuverture` rend `null` quand la semaine entière est fermée. Poser une échéance quand même
    // ferait reprendre la campagne à une heure tout aussi fermée, en boucle. Le message le dit à l'opérateur.
    const tousFermes: BusinessHours = Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, FERME]));
    const sender = new Sender();
    const recipients = new Recipients([rec('r1', '+33611')]);
    const campaigns = new Campaigns();
    const report = await lancerCampagne(
      campagne({ businessHoursOnly: true }),
      deps({ recipients, sender, campaigns, horairesOuvres: async () => ({ timeZone: PARIS, businessHours: tousFermes }) }, OUVERT),
    );

    expect(sender.envoyes).toEqual([]);
    expect(campaigns.pauses).toEqual([{ raison: 'hors_horaires', reprise: null }]);
    expect(report.reason).toContain("Aucun jour d'ouverture");
  });

  it('🔴 une lecture des horaires EN ÉCHEC n’immobilise pas la campagne', async () => {
    // Le réglage sert à choisir un moment, pas à garder une porte. Une panne de sa lecture ne doit pas
    // retenir un envoi que le client a lancé : on ne contraint alors rien, plutôt que de tout bloquer.
    const sender = new Sender();
    const recipients = new Recipients([rec('r1', '+33611')]);
    const report = await lancerCampagne(
      campagne({ businessHoursOnly: true }),
      deps({ recipients, sender, horairesOuvres: async () => { throw new Error('base indisponible'); } }, FERME_23H),
    );
    expect(sender.envoyes).toEqual(['+33611']);
    expect(report.paused).toBe(false);
  });

  it('câblage ABSENT (fixtures, e2e) : la case n’a aucun effet, aucune erreur', async () => {
    const sender = new Sender();
    const recipients = new Recipients([rec('r1', '+33611')]);
    const d = deps({ recipients, sender }, FERME_23H);
    delete d.horairesOuvres;
    const report = await lancerCampagne(campagne({ businessHoursOnly: true }), d);
    expect(report.sent).toBe(1);
  });
});

describe('ce que l’opérateur LIT sur une pause d’horaires', () => {
  const T = new Date('2026-09-09T07:00:00.000Z');

  it('🔴 le message ne parle PAS de Meta : une pause voulue ne doit pas ressembler à une panne', async () => {
    const m = messageDePause('hors_horaires', T, undefined);
    expect(m).not.toContain('Meta');
    expect(m).toContain("heures d'ouverture");
    expect(m).toContain('Reprise automatique');
    expect(m).toContain(T.toISOString());
  });

  it('sans échéance, il DIT qu’il n’y aura pas de reprise, et où corriger', () => {
    const m = messageDePause('hors_horaires', null, undefined);
    expect(m).toContain('AUCUNE reprise automatique');
    expect(m).toContain('Paramètres');
  });

  it('les deux motifs Meta sont inchangés, au caractère près', () => {
    expect(messageDePause('debit', T, 130429)).toContain('plafond Meta atteint');
    expect(messageDePause('qualite', null, 131048)).toContain("La reprise n'est PAS automatique");
  });
});
