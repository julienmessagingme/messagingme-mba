import type { PgTrackedLinkStore } from './tracked-links.pg';
import { fabriquerJeton } from './jeton-contact';
// La règle des campagnes (suffixe anonyme sans jeton), importée plutôt qu'écrite une seconde fois.
import { suffixesPourDestinataire } from '../campaign/engine';

/**
 * Les suffixes des boutons tracés pour UN envoi de template à une personne connue par son numéro (ou son wa_id).
 *
 * Un bouton soumis à Meta sous la forme `/r/<code>/{{1}}` exige ce `{{1}}` à chaque envoi, quel que soit le chemin :
 * sans lui, Meta refuse tout le message (131008). La campagne le calcule en lot (`boutonsTraces` et
 * `jetonsPourContacts`, `src/worker.ts`) ; ce module est le pendant unitaire, partagé par le bloc de scénario
 * (`src/workflow/envois-bloc.ts`) et l'envoi manuel depuis l'Inbox (`src/inbox/envoi-modele.ts`).
 *
 * Lève si les liens du template sont illisibles : c'est l'appelant qui décide (il part sans, et le dit). Un jeton
 * introuvable donne le suffixe anonyme : le lien marche, le clic n'est pas rattaché.
 */
export async function suffixesPourUnEnvoi(
  liens: Pick<PgTrackedLinkStore, 'listByTemplates' | 'jetonPourE164'>,
  tenant: string,
  name: string,
  waId: string,
): Promise<{ suffixesBoutons?: Record<number, string> }> {
  const traces = await liens.listByTemplates(tenant, [name]);
  // Les boutons de carte de carousel ne portent jamais de `{{1}}` (`estAttribuable`, `src/http/templates.ts`).
  const boutons = traces.filter((l) => l.avecJeton && l.cardIndex === null).map((l) => l.buttonIndex);
  if (boutons.length === 0) return {};
  const jeton = await liens.jetonPourE164(tenant, waId, fabriquerJeton).catch(() => null);
  return suffixesPourDestinataire(boutons, jeton ?? undefined);
}
