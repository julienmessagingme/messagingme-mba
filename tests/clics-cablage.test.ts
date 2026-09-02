import { describe, it, expect } from 'vitest';
import { campaignRunJob } from '../src/campaign/run-job';
import type { RunJobDeps } from '../src/campaign/run-job';
import type { MessageSender, RecipientStore, CampaignStore, FrequencyStore, QualityProvider } from '../src/campaign/engine';
import type { Campaign, Recipient, QualityRating } from '../src/campaign/types';
import type { SendResult, MarketingParams, TemplateSpec } from '../src/meta/types';

/**
 * LE CÂBLAGE de l'attribution des clics, du worker jusqu'à l'appel Meta.
 *
 * 🔴 CE FICHIER EXISTE À CAUSE D'UNE PANNE DE PRODUCTION (2026-09-02). Les deux dépendances qui décident des
 * composants de bouton (`boutonsTraces`, `jetonsPourContacts`) étaient câblées dans le worker, mais
 * `RunJobDeps` ne les nommait pas et `run-job` ne les recopiait pas dans les options du moteur. Elles
 * arrivaient dans un spread, ce qui échappe au contrôle des propriétés en trop : le compilateur ne disait
 * rien, les tests du moteur passaient (ils appellent `runCampaign` DIRECTEMENT), et pourtant plus aucun
 * template à lien tracé ne pouvait partir. Meta refusait tout en **131008 Required parameter is missing**.
 *
 * La leçon, et le motif de ce test : les tests unitaires du moteur ne voient pas ce qu'on ne LUI PASSE PAS.
 * Il faut au moins un test qui parte du même point d'entrée que la production, `campaignRunJob`.
 */

/** Capture ce qui part vraiment chez Meta, composants compris. */
class SenderQuiCapture implements MessageSender {
  readonly envois: TemplateSpec[] = [];
  async sendMarketing(p: MarketingParams): Promise<SendResult> {
    this.envois.push(p.template);
    return { messageId: 'm-1' };
  }
  async sendTemplate(_to: string, tpl: TemplateSpec): Promise<SendResult> {
    this.envois.push(tpl);
    return { messageId: 'm-1' };
  }
}
class FakeRecipients implements RecipientStore {
  constructor(private readonly pending: Recipient[]) {}
  async listPending(): Promise<Recipient[]> { return this.pending; }
  async claim(): Promise<boolean> { return true; }
  async relacher(): Promise<void> {}
  async markResult(): Promise<void> {}
}
class FakeCampaigns implements CampaignStore { async setStatus(): Promise<void> {} }
class FakeFreq implements FrequencyStore {
  async lastSentAt(): Promise<number | null> { return null; }
  async record(): Promise<void> {}
}
class FakeQuality implements QualityProvider {
  async getRating(): Promise<QualityRating> { return 'GREEN'; }
}

/** Campagne DIRECTE (sans scénario) sur un template dont deux boutons portent `/r/<code>/{{1}}`. */
const campagne: Campaign = {
  id: 'c1', tenantId: 't1', phoneNumberId: 'pn1', category: 'marketing',
  templateName: 'actu_cinema', templateLanguage: 'fr', paramMapping: [],
  status: 'draft', workflowId: null, startNodeId: null, ratePerMinute: null,
};
const destinataire: Recipient = { id: 'r1', contactId: 'ct-1', toE164: '+33600000001', resolvedParams: [], status: 'pending' };

/** Les composants de bouton URL de l'envoi capturé, dans l'ordre des index Meta. */
function boutonsUrl(tpl: TemplateSpec | undefined): Array<{ index: string; texte: string }> {
  return ((tpl?.components ?? []) as Array<Record<string, unknown>>)
    .filter((c) => c.type === 'button' && c.sub_type === 'url')
    .map((c) => ({
      index: String(c.index),
      texte: String(((c.parameters as Array<{ text?: unknown }>)[0] ?? {}).text ?? ''),
    }));
}

function lancer(over: Partial<RunJobDeps>, sender: SenderQuiCapture): Promise<unknown> {
  return campaignRunJob({ campaignId: 'c1' }, {
    getCampaign: async () => campagne,
    senderFor: async () => sender,
    recipients: new FakeRecipients([destinataire]),
    campaigns: new FakeCampaigns(),
    frequency: new FakeFreq(),
    quality: new FakeQuality(),
    ...over,
  } as RunJobDeps);
}

describe('attribution des clics : du worker jusqu’à l’appel Meta', () => {
  it('🔴 le suffixe de bouton arrive DANS l’envoi, il n’est pas perdu en route', async () => {
    // C'est LE test de la panne : avec les mêmes dépendances que le worker, l'envoi doit porter un composant
    // par bouton tracé. Sans le passe-plat de `run-job`, cette liste est vide et Meta répond 131008.
    const sender = new SenderQuiCapture();
    await lancer({
      boutonsTraces: async () => [0, 1],
      jetonsPourContacts: async () => new Map([['ct-1', 'jetonducontact']]),
    }, sender);

    expect(boutonsUrl(sender.envois[0])).toEqual([
      { index: '0', texte: 'jetonducontact' },
      { index: '1', texte: 'jetonducontact' },
    ]);
  });

  it('🔴 sans jeton, les composants partent QUAND MÊME, avec un suffixe anonyme', async () => {
    // Le template est déjà approuvé chez Meta avec `{{1}}` : ne rien envoyer ne « dégrade pas la mesure »,
    // ça fait refuser le message entier. On préfère un clic non attribué à un message qui ne part pas.
    const sender = new SenderQuiCapture();
    await lancer({
      boutonsTraces: async () => [0],
      jetonsPourContacts: async () => new Map(),
    }, sender);

    const boutons = boutonsUrl(sender.envois[0]);
    expect(boutons).toHaveLength(1);
    expect(boutons[0]?.texte).not.toBe('');
  });

  it('un template SANS bouton tracé n’emporte aucun composant de bouton', async () => {
    // La symétrie qui protège les anciens templates : leur URL n'a pas de variable, un composant les ferait
    // tous échouer d'un coup.
    const sender = new SenderQuiCapture();
    await lancer({
      boutonsTraces: async () => [],
      jetonsPourContacts: async () => new Map([['ct-1', 'jetonducontact']]),
    }, sender);

    expect(boutonsUrl(sender.envois[0])).toEqual([]);
  });
});
