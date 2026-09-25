import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { campaignRunJob } from '../src/campaign/run-job';
import type { RunJobDeps } from '../src/campaign/run-job';
import type { MessageSender, RecipientStore, CampaignStore, QualityProvider } from '../src/campaign/engine';
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
    quality: new FakeQuality(),
    // DÉCLARÉE, et plus couverte par un `as RunJobDeps` : le cast cachait qu'elle était devenue requise.
    pauserSiNumeroDelie: async () => false,
    ...over,
  });
}

describe('attribution des clics : du worker jusqu’à l’appel Meta', () => {
  it('🔴 le suffixe de bouton arrive DANS l’envoi, il n’est pas perdu en route', async () => {
    // C'est LE test de la panne : avec les mêmes dépendances que le worker, l'envoi doit porter un composant
    // par bouton tracé. Sans le passe-plat de `run-job`, cette liste est vide et Meta répond 131008.
    const sender = new SenderQuiCapture();
    await lancer({
      // En BLOC depuis le constat C1 : c'est précisément l'oubli de ces deux capacités dans la recopie
      // manuelle qui a fait échouer toutes les campagnes à lien tracé le 2026-09-02.
      moteur: {
        boutonsTraces: async () => [0, 1],
        jetonsPourContacts: async () => new Map([['ct-1', 'jetonducontact']]),
      },
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
      moteur: {
        boutonsTraces: async () => [0],
        jetonsPourContacts: async () => new Map(),
      },
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
      moteur: {
        boutonsTraces: async () => [],
        jetonsPourContacts: async () => new Map([['ct-1', 'jetonducontact']]),
      },
    }, sender);

    expect(boutonsUrl(sender.envois[0])).toEqual([]);
  });
});

/**
 * 🔴 LA CAUSE, PAS LE SYMPTÔME (constat C1 de l'audit externe du 2026-09-02).
 *
 * Les tests ci-dessus prouvent que DEUX capacités précises traversent. Ils ne prouvent rien de la TROISIÈME
 * qu'on ajoutera un jour : c'est exactement ce qui a fait la panne, un contrat et une recopie tenus alignés à
 * la main, dont le désalignement ne produisait aucune erreur de compilation.
 *
 * Ce test-ci garde la FORME qui rend l'oubli impossible : un seul spread, aucune énumération. Il est lu dans
 * la source parce qu'aucun type ne peut exprimer « ne recopie pas les membres un par un ».
 */
describe('run-job : les capacités du moteur voyagent en bloc, elles ne se recopient pas', () => {
  const source = readFileSync(new URL('../src/campaign/run-job.ts', import.meta.url), 'utf8');
  const sansCommentaires = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('🔴 les options du moteur reçoivent `...deps.moteur`, d’un seul geste', () => {
    expect(sansCommentaires, 'sans ce spread, chaque capacité redevient une ligne à ne pas oublier')
      .toMatch(/^\s{4}\.\.\.deps\.moteur,$/m);
  });

  it('🔴 AUCUNE capacité n’est recopiée nommément : c’est la recopie qui était le défaut', () => {
    // La liste des onze qui l'étaient. En rajouter une ici reviendrait à rouvrir la porte, et le jour où
    // quelqu'un le fera, ce test le lui dira.
    const recopiees = [
      'startWorkflow', 'startWorkflowFromNode', 'getTemplateCarousel', 'getTemplateHeaderMedia',
      'recordOutbound', 'thresholds', 'boutonsTraces', 'jetonsPourContacts',
      'arretDemande', 'dureeMaxMs', 'now',
    ];
    const fautives = recopiees.filter((nom) => sansCommentaires.includes(`deps.${nom}`));
    expect(fautives, `ces capacités sont de nouveau recopiées à la main : ${fautives.join(', ')}`).toEqual([]);
  });

  it('le contrat ne les nomme plus non plus : c’était la SECONDE liste à tenir alignée', () => {
    expect(sansCommentaires, 'le contrat doit exposer un bloc de capacités, pas une énumération')
      .toMatch(/moteur\?: CapacitesMoteur;/);
    expect(sansCommentaires, 'plus aucun Pick d’EngineDeps dans ce contrat').not.toMatch(/Pick<\s*EngineDeps/);
  });
});
