import type { ErreurLivraison } from './api/contacts';

/** La traduction de l'écran (`useT`) : le français, puis l'anglais. */
type Traduire = (fr: string, en?: string) => string;

/** D'où venait un message libre non délivré : la colonne `origin` du message, en mots. */
const ORIGINES_MESSAGE: Record<string, [string, string]> = {
  humain: ['réponse d’un opérateur', 'operator reply'],
  api: ['envoi par l’API', 'API send'],
  mcp: ['agent branché par MCP', 'MCP agent'],
  scenario: ['bloc de scénario', 'scenario block'],
  ia: ['agent IA', 'AI agent'],
  mba: ['agent de Meta', 'Meta agent'],
};

/**
 * L'ORIGINE d'une ligne du journal des erreurs de livraison, en mots : la MÊME à l'écran et dans l'export CSV.
 *
 * ⚠️ L'export écrivait le code brut (`message`), donc un échec de message libre y perdait son canal et sa
 * provenance (API, scénario, Inbox) que l'écran affichait juste à côté. Une origine inconnue (une API plus
 * récente que la console) s'écrit brute plutôt que vide.
 */
export function libelleOrigine(e: Pick<ErreurLivraison, 'origine' | 'canal' | 'origineMessage'>, t: Traduire): string {
  switch (e.origine) {
    case 'envoi': return t('jamais parti', 'never sent');
    case 'livraison': return t('parti, non délivré', 'sent, not delivered');
    case 'scenario': return t('scénario bloqué sur une réponse', 'scenario stuck on a reply');
    case 'message': {
      const base = e.canal === 'rcs' ? t('RCS non délivré', 'RCS not delivered') : t('message non délivré', 'message not delivered');
      const origine = e.origineMessage ? ORIGINES_MESSAGE[e.origineMessage] : undefined;
      return origine ? `${base} (${t(...origine)})` : base;
    }
    default: return String(e.origine);
  }
}

/** L'export CSV du journal : en-têtes et lignes ENSEMBLE, pour que les colonnes ne se décalent jamais. */
export function csvErreursLivraison(erreurs: readonly ErreurLivraison[], t: Traduire): { entetes: string[]; lignes: string[][] } {
  return {
    entetes: [t('Date (ISO)', 'Date (ISO)'), t('Campagne', 'Campaign'), t('Numéro', 'Number'), t('Code', 'Code'), t('Message', 'Message'), t('Origine', 'Source')],
    lignes: erreurs.map((e) => [e.at ?? '', e.campaignName ?? '', e.telephone, e.code === null ? '' : String(e.code), e.message ?? '', libelleOrigine(e, t)]),
  };
}
