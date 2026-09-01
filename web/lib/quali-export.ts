import type { AnalyzedConversation } from '@/lib/api';

/**
 * Les colonnes d'un export de conversations analysées, dans l'ordre.
 *
 * Séparé du composant pour une raison précise : l'export part de DEUX endroits (la fenêtre ouverte depuis
 * une action suggérée, et le tableau de détail), et deux exports du même objet qui ne rendraient pas les
 * mêmes colonnes seraient impossibles à recoller ensuite dans un tableur.
 *
 * `entetes` prend le traducteur, parce qu'un client anglophone doit ouvrir un CSV en anglais.
 */
export function entetesQuali(t: (fr: string, en?: string) => string): string[] {
  return [
    t('Date d’analyse', 'Analyzed at'),
    t('Contact', 'Contact'),
    t('Numéro', 'Number'),
    t('Sentiment', 'Sentiment'),
    t('Intention', 'Intent'),
    t('Sujet', 'Topic'),
    t('Résolu', 'Resolved'),
    t('Action suggérée', 'Suggested action'),
    t('Confiance', 'Confidence'),
    t('Échanges', 'Exchanges'),
    t('Résumé', 'Summary'),
    t('Justification', 'Justification'),
  ];
}

/**
 * Une conversation en ligne de CSV. Les libellés d'énumération sont RENDUS (« Demande de devis » et non
 * `demande_devis`) : le fichier est lu par un humain dans un tableur, pas par notre propre code.
 *
 * ⚠️ `resolved` sort en oui/non traduit et pas en `true`/`false` : un tableur français interprète `VRAI`,
 * et `true` n'y veut rien dire.
 */
export function ligneQuali(
  c: AnalyzedConversation,
  t: (fr: string, en?: string) => string,
  libelles: { sentiment: (v: string) => string; intent: (v: string) => string; action: (v: string) => string },
): Array<string | number> {
  return [
    c.analyzedAt,
    c.profileName ?? '',
    c.waId,
    libelles.sentiment(c.sentiment),
    libelles.intent(c.intent),
    c.topic,
    c.resolved ? t('oui', 'yes') : t('non', 'no'),
    libelles.action(c.actionSuggestion),
    // En pourcentage entier : le nombre à virgule flottante d'origine (0.8999999) est illisible en tableur.
    `${Math.round(c.confidence * 100)}%`,
    c.exchangesCount,
    c.summary ?? '',
    c.justification,
  ];
}
