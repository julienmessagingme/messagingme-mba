import { describe, it, expect } from 'vitest';
import { runCampaign, etageServable, contenuDeLEtage } from '../src/campaign/engine';
import type {
  MessageSender, RecipientStore, CampaignStore, QualityProvider,
  EngineDeps, TentativeEnvoi, CanalServi, RateGate,
} from '../src/campaign/engine';
import type { Campaign, Recipient, QualityRating } from '../src/campaign/types';
import type { Etage } from '../src/campaign/etages';
import type { CampaignSender } from '../src/campaign/sender';
import type { SendResult, MarketingParams, TemplateSpec } from '../src/meta/types';

/**
 * LE MOTEUR ENVOIE SUR LE CANAL DE L'ÉTAGE, PAS SUR CELUI DE SA CAMPAGNE (lot 6).
 *
 * 🔴 SANS ÇA, LA CHAÎNE EST DÉCORATIVE, et c'est l'état exact d'avant ce lot : la bascule écrivait
 * `etage_courant`, le journal l'enregistrait, et le run REFUSAIT tout rang supérieur parce qu'il était
 * construit sur les colonnes de `campaigns`. Sept branches en dépendaient, et chacune a ici son cas :
 * le sender, le plafond de débit, la porte de qualité, les pré-lectures de modèle, le journal du fil, la
 * joignabilité, et le choix du contenu.
 *
 * ⚠️ CE QUI SÉPARE LA BONNE IMPLÉMENTATION DE LA FAUSSE, et c'est le seul critère qui vaille ici : faire
 * lire `campaign.channel` ou `campaign.templateName` à une de ces branches doit rendre un test ROUGE. Un
 * jeu de cas qui se contenterait de vérifier « le message est parti » passerait sur les deux.
 */

class FakeRecipients implements RecipientStore {
  readonly results = new Map<string, { status: string; error?: string }>();
  constructor(private readonly pending: Recipient[]) {}
  async listPending(): Promise<Recipient[]> { return this.pending; }
  async claim(): Promise<boolean> { return true; }
  async relacher(): Promise<void> { /* rien */ }
  async markResult(id: string, r: { status: 'sent' | 'failed' | 'skipped'; error?: string }): Promise<void> {
    this.results.set(id, { status: r.status, ...(r.error !== undefined ? { error: r.error } : {}) });
  }
}
class FakeCampaigns implements CampaignStore {
  readonly statuses: string[] = [];
  async setStatus(_id: string, status: string): Promise<void> { this.statuses.push(status); }
}
/** Compte les interrogations de la porte de qualité, et sur QUEL numéro. */
class FakeQuality implements QualityProvider {
  readonly numeros: string[] = [];
  async getRating(phoneNumberId: string): Promise<QualityRating> {
    this.numeros.push(phoneNumberId);
    return 'GREEN';
  }
}
/** Sender Meta qui capture le modèle RÉELLEMENT envoyé. */
class SenderMeta implements MessageSender {
  readonly specs: TemplateSpec[] = [];
  async sendMarketing(p: MarketingParams): Promise<SendResult> {
    this.specs.push(p.template);
    return { messageId: `wa-${p.to ?? p.recipient ?? ''}` };
  }
  async sendTemplate(to: string, tpl: TemplateSpec): Promise<SendResult> {
    this.specs.push(tpl);
    return { messageId: `wa-${to}` };
  }
}
/** Sender de canal (RCS), qui capture ce qu'il a envoyé et à qui. */
function senderRcs(o: { aBesoinDeJeton?: boolean } = {}): CampaignSender & { envois: string[]; jetons: Array<string | undefined> } {
  const envois: string[] = [];
  const jetons: Array<string | undefined> = [];
  return {
    ...(o.aBesoinDeJeton ? { aBesoinDeJeton: true } : {}),
    envois,
    jetons,
    async sendTo(r, jeton) {
      envois.push(r.toE164);
      jetons.push(jeton);
      return { messageId: `rcs-${r.toE164}` };
    },
  };
}
/** Un frein de cadence qui se laisse compter. */
function frein(): RateGate & { prises: number } {
  const g = { prises: 0, acquire: async (): Promise<void> => { g.prises += 1; } };
  return g;
}

const CAMPAGNE_WA: Campaign = {
  id: 'c1', tenantId: 't1', phoneNumberId: 'pn1', category: 'marketing',
  templateName: 'promo', templateLanguage: 'fr', paramMapping: [], status: 'draft',
  workflowId: null, ratePerMinute: null, startNodeId: null, channel: 'whatsapp',
};
/** La chaîne du repli le plus courant du produit : WhatsApp, puis RCS avec SON message. */
const CHAINE_WA_RCS: Etage[] = [
  { rang: 1, canal: 'whatsapp', templateName: 'promo', templateLanguage: 'fr' },
  { rang: 2, canal: 'rcs', rcsMessage: { kind: 'text', text: 'le message du repli' } },
];

function rec(id: string, to: string, etageCourant?: number): Recipient {
  return { id, contactId: `ct-${id}`, toE164: to, resolvedParams: ['X'], status: 'pending', ...(etageCourant !== undefined ? { etageCourant } : {}) };
}
function deps(over: Partial<EngineDeps> & { recipients: RecipientStore }): EngineDeps {
  return {
    sender: new SenderMeta(),
    campaigns: new FakeCampaigns(),
    quality: new FakeQuality(),
    now: () => 1_000_000_000,
    ...over,
  };
}
/** La table des canaux telle que `run-job` la construit en production. */
function canaux(o: { whatsapp?: CanalServi; rcs?: CanalServi }): Partial<Record<'whatsapp' | 'rcs' | 'email', CanalServi>> {
  return { ...(o.whatsapp ? { whatsapp: o.whatsapp } : {}), ...(o.rcs ? { rcs: o.rcs } : {}) };
}
function journal(): { vues: TentativeEnvoi[]; noterEnvoi: EngineDeps['noterEnvoi'] } {
  const vues: TentativeEnvoi[] = [];
  return { vues, noterEnvoi: async (t) => { vues.push(t); } };
}

describe('le moteur sert le canal de l etage', () => {
  /**
   * 🔴 CHAQUE ÉTAGE PREND LE PLAFOND DE SON CANAL, pas celui de la campagne. Un étage RCS sous le plafond
   * qu'impose Meta à un NUMÉRO WhatsApp est exactement le défaut que la tâche 9 a corrigé : on ne le
   * rouvre pas par le bas en faisant tenir la cadence d'un canal par la contrainte d'un autre.
   */
  it('l etage 2 en RCS prend le frein RCS, pas celui de la campagne WhatsApp', async () => {
    const freinWa = frein();
    const freinRcs = frein();
    const rcs = senderRcs();
    const avecRepli: Campaign = { ...CAMPAGNE_WA, chaine: CHAINE_WA_RCS };
    const recipients = new FakeRecipients([rec('r1', '+33611', 2)]);
    const report = await runCampaign(avecRepli, deps({
      recipients,
      canaux: canaux({ whatsapp: { rateLimiter: freinWa, phoneNumberId: 'pn1' }, rcs: { sender: rcs, rateLimiter: freinRcs } }),
    }));
    expect(report).toMatchObject({ sent: 1, failed: 0 });
    expect(freinRcs.prises).toBe(1);
    expect(freinWa.prises).toBe(0);
  });

  // ⚠️ L'AUTRE SENS, sans quoi une implémentation qui prendrait TOUJOURS le frein RCS passerait le cas
  // du dessus : un destinataire resté au rang 1 prend le frein WhatsApp.
  it('l etage 1 prend le frein de SON canal, pas celui du repli', async () => {
    const freinWa = frein();
    const freinRcs = frein();
    const avecRepli: Campaign = { ...CAMPAGNE_WA, chaine: CHAINE_WA_RCS };
    const recipients = new FakeRecipients([rec('r1', '+33611', 1)]);
    await runCampaign(avecRepli, deps({
      recipients,
      canaux: canaux({ whatsapp: { rateLimiter: freinWa, phoneNumberId: 'pn1' }, rcs: { sender: senderRcs(), rateLimiter: freinRcs } }),
    }));
    expect(freinWa.prises).toBe(1);
    expect(freinRcs.prises).toBe(0);
  });

  /**
   * 🔴 LE CONTENU EST CELUI DE L'ÉTAGE 2, JAMAIS CELUI DE L'ÉTAGE 1. C'est LE défaut que ce lot ferme :
   * renvoyer le contenu du rang 1 sur le canal du rang 1 revient à réexpédier EXACTEMENT le message qui
   * vient d'échouer, à quelqu'un qui ne l'a pas reçu.
   */
  it('l etage 2 envoie le contenu de l ETAGE 2, pas celui de l etage 1', async () => {
    const rcs = senderRcs();
    const meta = new SenderMeta();
    const avecRepli: Campaign = { ...CAMPAGNE_WA, chaine: CHAINE_WA_RCS };
    const recipients = new FakeRecipients([rec('r1', '+33611', 2)]);
    const fil: Array<{ body: string; channel?: string }> = [];
    await runCampaign(avecRepli, deps({
      recipients,
      sender: meta,
      canaux: canaux({ whatsapp: { phoneNumberId: 'pn1' }, rcs: { sender: rcs } }),
      recordOutbound: async (_t, _w, m) => { fil.push({ body: m.body, ...(m.channel ? { channel: m.channel } : {}) }); },
    }));
    // Le message RCS de l'étage 2 est parti, et AUCUN modèle WhatsApp n'a été envoyé.
    expect(rcs.envois).toEqual(['+33611']);
    expect(meta.specs).toEqual([]);
    // 🔴 LE JOURNAL DU FIL PORTE LE MESSAGE DE L'ÉTAGE, pas `campaign.rcsMessage` (qui vaut `undefined`
    // sur une campagne WhatsApp : une implémentation qui le lirait afficherait « Message RCS »).
    expect(fil).toEqual([{ body: 'le message du repli', channel: 'rcs' }]);
  });

  /**
   * 🔴 LE JOURNAL DES TENTATIVES NOTE LE CANAL RÉELLEMENT UTILISÉ. C'est la SEULE source de l'analytique
   * par canal : une ligne « whatsapp » sur un envoi RCS met au crédit d'un canal ce qu'un autre a fait,
   * et le chiffre affiché sert à condamner un canal.
   */
  it('le journal note le canal REELLEMENT utilise, pas celui de la campagne', async () => {
    const { vues, noterEnvoi } = journal();
    const avecRepli: Campaign = { ...CAMPAGNE_WA, chaine: CHAINE_WA_RCS };
    const recipients = new FakeRecipients([rec('r1', '+33611', 2), rec('r2', '+33622', 1)]);
    await runCampaign(avecRepli, deps({
      recipients,
      ...(noterEnvoi ? { noterEnvoi } : {}),
      canaux: canaux({ whatsapp: { phoneNumberId: 'pn1' }, rcs: { sender: senderRcs() } }),
    }));
    expect(vues).toHaveLength(2);
    expect(vues[0]).toMatchObject({ rang: 2, canal: 'rcs', statut: 'sent' });
    expect(vues[1]).toMatchObject({ rang: 1, canal: 'whatsapp', statut: 'sent' });
  });

  /**
   * ⚠️ LA JOIGNABILITÉ NE S'ÉCRIT QUE POUR WHATSAPP : un envoi RCS réussi ne dit RIEN de WhatsApp. Écrire
   * « joignable » sur la foi d'un autre canal serait une mesure inventée, et `inconnu` n'exclut personne
   * alors qu'un faux « oui » ferait viser ce numéro par un premier étage qui échouera.
   */
  it('un etage RCS reussi n ecrit aucune joignabilite WhatsApp', async () => {
    const notes: Array<{ contactId: string; joignable: boolean }> = [];
    const avecRepli: Campaign = { ...CAMPAGNE_WA, chaine: CHAINE_WA_RCS };
    const recipients = new FakeRecipients([rec('r1', '+33611', 2)]);
    await runCampaign(avecRepli, deps({
      recipients,
      canaux: canaux({ whatsapp: { phoneNumberId: 'pn1' }, rcs: { sender: senderRcs() } }),
      noterJoignabilite: async (_t, contactId, joignable) => { notes.push({ contactId, joignable }); },
    }));
    expect(notes).toEqual([]);
  });

  // ⚠️ L'AUTRE SENS : un étage WHATSAPP réussi l'écrit bien. Sans ce cas, une implémentation qui n'écrirait
  // JAMAIS la joignabilité passerait le test du dessus, et la couverture ne se rafraîchirait plus jamais.
  it('un etage WhatsApp reussi ecrit bien la joignabilite', async () => {
    const notes: Array<{ contactId: string; joignable: boolean }> = [];
    const avecRepli: Campaign = { ...CAMPAGNE_WA, chaine: CHAINE_WA_RCS };
    const recipients = new FakeRecipients([rec('r1', '+33611', 1)]);
    await runCampaign(avecRepli, deps({
      recipients,
      canaux: canaux({ whatsapp: { phoneNumberId: 'pn1' }, rcs: { sender: senderRcs() } }),
      noterJoignabilite: async (_t, contactId, joignable) => { notes.push({ contactId, joignable }); },
    }));
    expect(notes).toEqual([{ contactId: 'ct-r1', joignable: true }]);
  });

  /**
   * 🔴 LA PORTE DE QUALITÉ EST UNE NOTION META : elle n'a aucun équivalent RCS, et l'interroger sur un
   * étage RCS appellerait Graph avec le numéro d'un canal qui n'est pas le sien.
   */
  it('un etage RCS n interroge pas la porte de qualite', async () => {
    const quality = new FakeQuality();
    const avecRepli: Campaign = { ...CAMPAGNE_WA, chaine: CHAINE_WA_RCS };
    const recipients = new FakeRecipients([rec('r1', '+33611', 2)]);
    await runCampaign(avecRepli, deps({
      recipients,
      quality,
      canaux: canaux({ whatsapp: { phoneNumberId: 'pn1' }, rcs: { sender: senderRcs() } }),
    }));
    expect(quality.numeros).toEqual([]);
  });

  /**
   * 🔴 ET SUR UN ÉTAGE WHATSAPP, ELLE INTERROGE LE NUMÉRO QUI SERT CET ÉTAGE, pas `campaign.phoneNumberId`.
   * Une campagne RCS a cette colonne VIDE (migration 0056) : une porte de qualité qui la lirait
   * interrogerait Graph sur une chaîne vide, sur le seul cas où le repli WhatsApp compte.
   */
  it('la porte de qualite interroge le numero QUI SERT l etage', async () => {
    const quality = new FakeQuality();
    const rcsDAbord: Campaign = {
      ...CAMPAGNE_WA, phoneNumberId: '', templateName: '', templateLanguage: '', channel: 'rcs',
      rcsMessage: { kind: 'text', text: 'offre' },
      chaine: [
        { rang: 1, canal: 'rcs', rcsMessage: { kind: 'text', text: 'offre' } },
        { rang: 2, canal: 'whatsapp', templateName: 'relance', templateLanguage: 'fr' },
      ],
    };
    const recipients = new FakeRecipients([rec('r1', '+33611', 2)]);
    await runCampaign(rcsDAbord, deps({
      recipients,
      quality,
      canaux: canaux({ whatsapp: { phoneNumberId: 'pn-espace' }, rcs: { sender: senderRcs() } }),
    }));
    expect(quality.numeros).toEqual(['pn-espace']);
  });

  /**
   * 🔴 LE MODÈLE D'UN ÉTAGE WHATSAPP DE REPLI EST CELUI DE SA LIGNE, PAS `campaign.templateName`. Sur une
   * campagne RCS, cette colonne vaut la chaîne VIDE : une implémentation qui la lirait enverrait un
   * modèle sans nom, que Meta refuse pour tout le monde.
   */
  it('un etage WhatsApp de repli envoie SON modele, pas celui de la campagne', async () => {
    const meta = new SenderMeta();
    const rcsDAbord: Campaign = {
      ...CAMPAGNE_WA, phoneNumberId: '', templateName: '', templateLanguage: '', channel: 'rcs',
      rcsMessage: { kind: 'text', text: 'offre' },
      chaine: [
        { rang: 1, canal: 'rcs', rcsMessage: { kind: 'text', text: 'offre' } },
        { rang: 2, canal: 'whatsapp', templateName: 'relance', templateLanguage: 'fr' },
      ],
    };
    const recipients = new FakeRecipients([rec('r1', '+33611', 2)]);
    await runCampaign(rcsDAbord, deps({
      recipients,
      sender: meta,
      canaux: canaux({ whatsapp: { phoneNumberId: 'pn-espace' }, rcs: { sender: senderRcs() } }),
    }));
    expect(meta.specs.map((s) => s.name)).toEqual(['relance']);
    expect(meta.specs[0]!.language).toBe('fr');
  });

  /**
   * 🔴 LES PRÉ-LECTURES DE MODÈLE SUIVENT L'ÉTAGE WHATSAPP DE LA CHAÎNE, OÙ QU'IL SOIT. Elles étaient
   * faites sur `campaign.templateName` : sur une campagne RCS à repli WhatsApp, elles auraient interrogé
   * Meta avec un nom vide, ou n'auraient pas eu lieu, et un modèle à en-tête média serait parti sans son
   * média, donc refusé en 132012 pour TOUS les destinataires du repli.
   */
  it('les pre-lectures de modele visent l etage WhatsApp, pas la campagne', async () => {
    const lus: string[] = [];
    const rcsDAbord: Campaign = {
      ...CAMPAGNE_WA, phoneNumberId: '', templateName: '', templateLanguage: '', channel: 'rcs',
      rcsMessage: { kind: 'text', text: 'offre' },
      chaine: [
        { rang: 1, canal: 'rcs', rcsMessage: { kind: 'text', text: 'offre' } },
        { rang: 2, canal: 'whatsapp', templateName: 'relance', templateLanguage: 'fr' },
      ],
    };
    const recipients = new FakeRecipients([rec('r1', '+33611', 2)]);
    await runCampaign(rcsDAbord, deps({
      recipients,
      canaux: canaux({ whatsapp: { phoneNumberId: 'pn-espace' }, rcs: { sender: senderRcs() } }),
      getTemplateCarousel: async (_t, name) => { lus.push(name); return null; },
      getTemplateHeaderMedia: async (_t, name) => { lus.push(name); return null; },
      boutonsTraces: async (_t, name) => { lus.push(name); return []; },
    }));
    expect(lus).toEqual(['relance', 'relance', 'relance']);
  });

  /**
   * 🔴 LES JETONS SE CHARGENT DÈS QU'UN DES DEUX CANAUX EN A BESOIN. Les deux branches d'avant étaient
   * EXCLUSIVES (`else if`) : une campagne WhatsApp à repli RCS aurait chargé les jetons pour un canal et
   * pas pour l'autre, donc des liens tracés anonymes sur la moitié de la chaîne.
   */
  it('un repli RCS a liens traces recoit bien son jeton', async () => {
    const rcs = senderRcs({ aBesoinDeJeton: true });
    const avecRepli: Campaign = { ...CAMPAGNE_WA, chaine: CHAINE_WA_RCS };
    const recipients = new FakeRecipients([rec('r1', '+33611', 2)]);
    await runCampaign(avecRepli, deps({
      recipients,
      canaux: canaux({ whatsapp: { phoneNumberId: 'pn1' }, rcs: { sender: rcs } }),
      jetonsPourContacts: async () => new Map([['ct-r1', 'jeton-r1']]),
      boutonsTraces: async () => [],
    }));
    expect(rcs.jetons).toEqual(['jeton-r1']);
  });

  /**
   * 🔴 UN CANAL NON SERVABLE REFUSE AVEC SA RAISON, IL NE RETOMBE PAS SUR LE CANAL DE LA CAMPAGNE. C'est
   * le cas d'un étage e-mail (aucun sender de campagne n'existe) et d'un étage RCS sans agent. Le repli
   * silencieux renverrait le message qui vient d'échouer.
   */
  it('un etage dont le canal n est pas servable echoue AVEC SA RAISON, sans rien envoyer', async () => {
    const meta = new SenderMeta();
    const { vues, noterEnvoi } = journal();
    const avecEmail: Campaign = {
      ...CAMPAGNE_WA,
      chaine: [...CHAINE_WA_RCS, { rang: 3, canal: 'email', emailTemplateId: 'em-1', emailChamp: 'email' }],
    };
    const recipients = new FakeRecipients([rec('r1', '+33611', 3)]);
    const report = await runCampaign(avecEmail, deps({
      recipients,
      sender: meta,
      ...(noterEnvoi ? { noterEnvoi } : {}),
      canaux: canaux({ whatsapp: { phoneNumberId: 'pn1' }, rcs: { sender: senderRcs() } }),
    }));
    expect(meta.specs).toEqual([]);
    expect(report).toMatchObject({ sent: 0, failed: 1 });
    expect(recipients.results.get('r1')!.error).toContain('étage 3');
    // Le journal porte le VRAI rang et le VRAI canal : au rang 1, l'échec irait au crédit de WhatsApp.
    expect(vues[0]).toMatchObject({ rang: 3, canal: 'email', statut: 'failed' });
  });

  /**
   * ⚠️ UN MODÈLE INENVOYABLE NE COUPE QUE SON ÉTAGE. Le refus pré-boucle (carousel ou en-tête média
   * cassé) visait TOUTE la campagne : il aurait privé de leur message des destinataires qu'une bascule
   * avait précisément amenés sur l'autre canal parce que le premier avait échoué.
   */
  it('un modele WhatsApp inenvoyable ne coupe pas le repli RCS', async () => {
    const rcs = senderRcs();
    const avecRepli: Campaign = { ...CAMPAGNE_WA, chaine: CHAINE_WA_RCS };
    const recipients = new FakeRecipients([rec('r1', '+33611', 1), rec('r2', '+33622', 2)]);
    const report = await runCampaign(avecRepli, deps({
      recipients,
      canaux: canaux({ whatsapp: { phoneNumberId: 'pn1' }, rcs: { sender: rcs } }),
      // En-tête média présent mais non préparé : `headerMediaSendBlocker` refuse l'envoi WhatsApp.
      getTemplateHeaderMedia: async () => ({ headerFormat: 'IMAGE', mediaId: null }),
    }));
    expect(recipients.results.get('r1')).toMatchObject({ status: 'failed' });
    expect(rcs.envois).toEqual(['+33622']);
    expect(report).toMatchObject({ sent: 1, failed: 1 });
  });
});

/**
 * `etageServable` et `contenuDeLEtage`, éprouvées SEULES. Elles décident d'un envoi sur le chemin le plus
 * chaud du produit : les exercer à travers un run entier ne dit pas ce qu'elles répondent.
 */
describe('etageServable : les canaux servis', () => {
  it('un canal servi ne refuse plus, quel que soit le rang', () => {
    expect(etageServable({ chaine: CHAINE_WA_RCS, channel: 'whatsapp' }, 2, ['whatsapp', 'rcs']))
      .toEqual({ rang: 2, canal: 'rcs', refus: null });
  });

  /**
   * ⚠️ `canauxServis` ABSENT = LE CANAL DE LA CAMPAGNE, ET RIEN D'AUTRE, c'est-à-dire le comportement
   * d'avant ce lot mot pour mot. C'est ce qui laisse intacts tous les faux de test qui ne le fournissent
   * pas : sans lui, un rang 2 (qui ne peut pas partager le canal du rang 1) est toujours refusé.
   */
  it('sans liste de canaux, seul celui de la campagne est servi', () => {
    const v = etageServable({ chaine: CHAINE_WA_RCS, channel: 'whatsapp' }, 2);
    expect(v.refus).toContain('étage 2');
    expect(v.canal).toBe('rcs');
  });

  it('un canal ABSENT de la liste refuse, au vrai canal', () => {
    const v = etageServable({ chaine: CHAINE_WA_RCS, channel: 'whatsapp' }, 2, ['whatsapp']);
    expect(v).toMatchObject({ rang: 2, canal: 'rcs' });
    expect(v.refus).toContain('rcs');
  });
});

describe('contenuDeLEtage', () => {
  /**
   * 🔴 LE RANG 1 VIENT TOUJOURS DES COLONNES DE LA CAMPAGNE, JAMAIS DE SA LIGNE D'ÉTAGE. C'est l'invariant
   * de la migration 0134 (« une seule source pour le contenu d'un étage ») : `insertCampaignRow` RECOPIE
   * ces colonnes dans la ligne du rang 1 et ignore ce que le client y aurait mis. Lire la ligne ici
   * rouvrirait la seconde vérité que cet invariant ferme.
   */
  it('le rang 1 prend le contenu de la campagne, meme si sa ligne dit autre chose', () => {
    const c: Campaign = {
      ...CAMPAGNE_WA,
      chaine: [{ rang: 1, canal: 'whatsapp', templateName: 'autre_chose', templateLanguage: 'en' }],
    };
    expect(contenuDeLEtage(c, 1)).toMatchObject({ templateName: 'promo', templateLanguage: 'fr' });
  });

  it('un rang superieur prend le contenu de SA ligne', () => {
    const c: Campaign = { ...CAMPAGNE_WA, chaine: CHAINE_WA_RCS };
    expect(contenuDeLEtage(c, 2).rcsMessage).toEqual({ kind: 'text', text: 'le message du repli' });
  });

  /**
   * 🔴 UN RANG SUPÉRIEUR SANS CONTENU PART VIDE, IL NE RETOMBE PAS SUR LA CAMPAGNE. Le repli serait alors
   * exactement le message qui vient d'échouer, ce que tout ce lot existe pour empêcher.
   */
  it('un rang superieur sans contenu ne retombe PAS sur celui de la campagne', () => {
    const c: Campaign = { ...CAMPAGNE_WA, chaine: [CHAINE_WA_RCS[0]!, { rang: 2, canal: 'rcs' }] };
    expect(contenuDeLEtage(c, 2)).toEqual({ templateName: '', templateLanguage: '', rcsMessage: undefined, workflowId: null });
  });

  it('sans chaine, tout rang rend le contenu de la campagne au rang 1', () => {
    expect(contenuDeLEtage(CAMPAGNE_WA, 1)).toMatchObject({ templateName: 'promo', workflowId: null });
  });
});
