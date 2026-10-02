import { describe, it, expect } from 'vitest';
import { cleDePhrase, conflitDansLEspace, enConflitAvec, phrasesEnConflit } from '../src/widgets/phrases';
import { matchesTrigger, normalizeText, type AutomationRow } from '../src/automation/match';
import { motCleDepuisPhrase } from '../src/channels-me/jeton';

/**
 * LA COMPARAISON DES PHRASES D'UN ESPACE (widgets ET liens de chaîne), écrite une fois dans `src/widgets/phrases.ts`
 * et appelée par les deux routes. Ce fichier la tient sur ses axes : l'inclusion dans les DEUX sens, et ce que
 * `normalizeText` efface (casse, accents, espaces), plus ce que le mot-clé d'un lien efface en plus (la ponctuation
 * finale), qui est le cas qu'une comparaison des phrases entières laissait passer.
 */
describe('phrasesEnConflit', () => {
  it('🔴 l’inclusion, dans un sens ET dans l’autre', () => {
    expect(phrasesEnConflit('Je veux le guide 2026', 'Je veux le guide')).toBe(true);
    expect(phrasesEnConflit('Je veux le guide', 'Je veux le guide 2026')).toBe(true);
    // Le cas d'école : deux phrases différentes, et pourtant un seul message les contient toutes les deux.
    expect(phrasesEnConflit('Bonjour, je viens du blog', 'je viens du blog')).toBe(true);
  });

  it('deux phrases dont aucune ne contient l’autre ne sont pas en conflit', () => {
    expect(phrasesEnConflit('Je viens du blog', 'Je viens de la page tarifs')).toBe(false);
    expect(phrasesEnConflit('Promo été', 'Promo hiver')).toBe(false);
  });

  it('la casse, les accents et les espaces ne distinguent rien : ce sont ceux que `normalizeText` efface', () => {
    expect(phrasesEnConflit('ÇA M’INTÉRESSE', 'ça m’intéresse')).toBe(true);
    expect(phrasesEnConflit('Ca m’interesse', 'ça m’intéresse')).toBe(true);
    expect(phrasesEnConflit('  Je   veux\tle guide  ', 'je veux le guide')).toBe(true);
  });

  it('🔴 la ponctuation FINALE ne distingue rien non plus : le mot-clé d’un lien de chaîne la perd', () => {
    // « Je veux le guide ! » a pour mot-clé « je veux le guide » : un widget « Je veux le guide. » envoie un message
    // qui le contient. Comparées entières, ces deux phrases ne s'incluent pas, et le conflit passait.
    expect(phrasesEnConflit('Je veux le guide !', 'Je veux le guide.')).toBe(true);
    expect(phrasesEnConflit('Promo!', 'promo?')).toBe(true);
    // La preuve que ce n'est pas un excès de zèle : le VRAI déclencheur du lien part sur le message du widget.
    const lien: AutomationRow = {
      id: 'a1', tenantId: 't1', name: 'lien', enabled: true, triggerKind: 'keyword',
      triggerConfig: { keywords: [motCleDepuisPhrase('Je veux le guide !')], mode: 'contains' },
      conditionGroup: null, workflowId: 'w1', startNodeId: null, possedePar: 'channelsme_link',
      cooldownSeconds: 300, maxFiresPerHour: null,
    };
    expect(matchesTrigger(lien, {
      kind: 'message', waId: '33600000000', body: 'Je veux le guide.', isNewContact: false, channel: 'whatsapp',
    })).toBe(true);
  });

  it('la ponctuation du MILIEU, elle, est du texte', () => {
    expect(phrasesEnConflit('Promo -20 %', 'Promo 20 %')).toBe(false);
  });

  it('une phrase faite de ponctuation seule garde sa clé : « !!! » se reconnaît bien dans un message', () => {
    expect(cleDePhrase('!!!')).toBe('!!!');
    expect(phrasesEnConflit('!!!', 'Promo !!! demain')).toBe(true);
  });

  it('une phrase que la normalisation réduit à rien ne se compare à rien (elle ne déclenche jamais)', () => {
    // Des diacritiques seuls : `normalizeText` les efface. La route la refuse avant, en 400.
    const vide = String.fromCharCode(0x301, 0x300);
    expect(normalizeText(vide)).toBe('');
    expect(phrasesEnConflit(vide, 'Bonjour')).toBe(false);
    expect(phrasesEnConflit('Bonjour', vide)).toBe(false);
  });

  it('enConflitAvec : la phrase contre une liste', () => {
    expect(enConflitAvec('Je veux le guide', ['Autre chose', 'je veux le guide 2026'])).toBe(true);
    expect(enConflitAvec('Je veux le guide', [])).toBe(false);
  });
});

describe('conflitDansLEspace : le contrôle d’un lien de chaîne lit AUSSI les widgets', () => {
  it('🔴 une phrase de lien qui contient celle d’un widget est en conflit, et l’inverse', async () => {
    const enConflit = conflitDansLEspace({
      phrasesDesLiens: async () => [],
      phrasesDesWidgets: async (t) => (t === 't1' ? ['Je viens du blog'] : []),
    });
    expect(await enConflit('t1', 'Bonjour, je viens du blog')).toBe(true);
    expect(await enConflit('t1', 'blog')).toBe(true);
    // L'espace est celui qu'on lui passe : les widgets d'un autre espace ne gênent personne.
    expect(await enConflit('t2', 'Bonjour, je viens du blog')).toBe(false);
  });

  it('il lit toujours les liens', async () => {
    const enConflit = conflitDansLEspace({ phrasesDesLiens: async () => ['Je veux le guide'], phrasesDesWidgets: async () => [] });
    expect(await enConflit('t1', 'Je veux le guide 2026')).toBe(true);
    expect(await enConflit('t1', 'Autre chose')).toBe(false);
  });
});
