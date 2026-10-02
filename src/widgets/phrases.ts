import { normalizeText } from '../automation/match';
import { motCleDepuisPhrase } from '../channels-me/jeton';

/**
 * L'ESPACE DES PHRASES D'UN ESPACE : les phrases des widgets ET celles des liens de chaîne (lot 4 de
 * docs/superpowers/plans/2026-10-02-widget-whatsapp.md). Les deux se reconnaissent dans le même message entrant,
 * en mode `contains` : une phrase qui contient l'autre fait déclencher les deux. D'où une seule comparaison, ici,
 * appelée par la route des widgets ET par le contrôle des liens de chaîne (`src/index.ts`). Deux copies
 * divergeraient au premier ajustement, et c'est justement l'endroit où un écart ne se voit qu'en production : deux
 * scénarios démarrés par un seul message.
 *
 * 🔴 LA CLÉ PERD LA PONCTUATION FINALE, ET CE N'EST PAS UN CONFORT. Le mot-clé d'un lien de chaîne est sa phrase
 * PRIVÉE de sa ponctuation finale (`motCleDepuisPhrase`, celle que WhatsApp retire des posts déjà publiés). Un lien
 * « Je veux le guide ! » déclenche donc sur « je veux le guide », et un widget « Je veux le guide. » enverrait un
 * message qui le contient : comparées telles quelles, les deux phrases ne s'incluent pas, et le conflit passait.
 * La clé retire cette ponctuation des DEUX côtés, ce qui couvre aussi tous les cas d'inclusion des phrases entières
 * (une phrase incluse dans l'autre l'est encore, une fois leurs fins retirées).
 *
 * ⚠️ Une phrase faite de ponctuation seule (« !!! ») n'a plus rien une fois sa fin retirée : sa clé retombe alors
 * sur la phrase normalisée entière. Sans ce repli, sa clé vide serait contenue dans toutes les autres, ou ignorée,
 * alors qu'un widget « !!! » se reconnaît bel et bien dans un message qui contient « !!! ».
 */
export function cleDePhrase(phrase: string): string {
  const sansFin = normalizeText(motCleDepuisPhrase(phrase));
  return sansFin !== '' ? sansFin : normalizeText(phrase);
}

/**
 * Ces deux phrases déclencheraient-elles sur un même message ? Inclusion dans un sens ou dans l'autre, sur leurs
 * clés. Une clé vide ne se compare à rien : une phrase que la normalisation réduit à rien ne déclenche jamais
 * (`keywordsOf` l'écarte, la reconnaissance des widgets aussi), et la route la refuse avant d'arriver ici.
 */
export function phrasesEnConflit(a: string, b: string): boolean {
  const ca = cleDePhrase(a);
  const cb = cleDePhrase(b);
  if (ca === '' || cb === '') return false;
  return ca.includes(cb) || cb.includes(ca);
}

/** Cette phrase entre-t-elle en conflit avec l'une de celles-là ? */
export function enConflitAvec(phrase: string, existantes: readonly string[]): boolean {
  return existantes.some((p) => phrasesEnConflit(phrase, p));
}

/** Où lire les phrases d'un espace. Les deux sources sont REQUISES : en oublier une rouvrirait le conflit croisé. */
export interface SourcesDesPhrases {
  phrasesDesLiens(tenantId: string): Promise<string[]>;
  phrasesDesWidgets(tenantId: string): Promise<string[]>;
}

/**
 * Le contrôle d'un lien de chaîne (`ChannelsMeRouteDeps.phraseEnConflit`) : sa phrase contre celles des autres
 * liens ET des widgets. Un lien qui contiendrait la phrase d'un widget ferait appliquer le devenir de ce widget à
 * chaque abonné qui appuie sur le bouton, en plus du scénario du lien.
 */
export function conflitDansLEspace(sources: SourcesDesPhrases): (tenantId: string, phrase: string) => Promise<boolean> {
  return async (tenantId, phrase) => {
    const [liens, widgets] = await Promise.all([sources.phrasesDesLiens(tenantId), sources.phrasesDesWidgets(tenantId)]);
    return enConflitAvec(phrase, [...liens, ...widgets]);
  };
}
