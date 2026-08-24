import type { RcsSuggestion } from './rcs-types';

/**
 * Les six formes de bouton RCS, côté écran : leur libellé, leur fabrication, et le test « est-il complet ? ».
 *
 * Module PUR (aucun import navigateur) : il est testé depuis la suite racine, comme `web/lib/rcs.ts`. Trois
 * écrans composent des boutons (bibliothèque, assistant de campagne, bloc de scénario) et se partageaient
 * jusqu'ici trois copies de la même logique, déjà divergentes sur les valeurs par défaut. Une seule ici.
 */

export type KindBouton = RcsSuggestion['kind'];

/** Ordre d'affichage dans le sélecteur : d'abord ce qui sert tous les jours. */
export const KINDS_BOUTON: readonly KindBouton[] = ['reply', 'openUrl', 'dial', 'calendar', 'showLocation', 'requestLocation'];

/** Libellé `[fr, en]`, même convention que `SYSTEM_FIELDS` : ce module est pur, `useT()` y est inappelable. */
export const LIBELLE_KIND: Record<KindBouton, [string, string]> = {
  reply: ['Réponse', 'Reply'],
  openUrl: ['Lien', 'Link'],
  dial: ['Appel', 'Call'],
  calendar: ['Agenda', 'Calendar'],
  showLocation: ['Voir un lieu', 'Show a place'],
  requestLocation: ['Demander sa position', 'Ask for location'],
};

/** Ce que fait le bouton, en une phrase, sous le sélecteur. Ce qui compte pour choisir : où ça mène. */
export const AIDE_KIND: Record<KindBouton, [string, string]> = {
  reply: [
    'Le contact répond en un tap. C’est le SEUL bouton qui ouvre une sortie à relier dans un scénario.',
    'The contact replies in one tap. This is the ONLY button that opens an output you can connect in a scenario.',
  ],
  openUrl: ['Ouvre une page web. Le contact quitte la conversation.', 'Opens a web page. The contact leaves the conversation.'],
  dial: ['Compose un numéro de téléphone.', 'Dials a phone number.'],
  calendar: [
    'Ajoute un rendez-vous à l’agenda du téléphone. Sans date valable pour ce contact, le bouton disparaît et le message part quand même.',
    'Adds an appointment to the phone calendar. With no valid date for this contact, the button is dropped and the message still goes out.',
  ],
  showLocation: ['Ouvre un lieu sur la carte du contact.', 'Opens a place on the contact’s map.'],
  requestLocation: [
    'Demande sa position au contact. Sa réponse arrive dans l’Inbox avec ses coordonnées, elle n’ouvre PAS de branche de scénario.',
    'Asks the contact for their location. The answer lands in the Inbox with its coordinates; it does NOT open a scenario branch.',
  ],
};

/** Pastille affichée devant le libellé dans un aperçu. Vide pour « Réponse » : c'est la forme par défaut,
 *  et une icône sur tous les boutons ne distinguerait plus rien. */
export const ICONE_KIND: Record<KindBouton, string> = {
  reply: '',
  openUrl: '🔗 ',
  dial: '📞 ',
  calendar: '📅 ',
  showLocation: '🗺️ ',
  requestLocation: '📍 ',
};

/** Un bouton neuf de ce type, en gardant le libellé déjà saisi. Chaque forme naît COMPLÈTE en structure
 *  (champs vides mais présents), pour qu'aucun écran n'ait à deviner ce qu'il manque. */
export function nouveauBouton(kind: KindBouton, base: { text: string; postbackData: string }): RcsSuggestion {
  switch (kind) {
    case 'reply':
      return { ...base, kind };
    case 'openUrl':
      return { ...base, kind, url: '' };
    case 'dial':
      return { ...base, kind, phoneNumber: '' };
    case 'calendar':
      return { ...base, kind, title: '', startAt: '', endAt: '' };
    case 'showLocation':
      return { ...base, kind, latitude: 0, longitude: 0 };
    default:
      return { ...base, kind };
  }
}

/**
 * Ce bouton peut-il être enregistré ?
 *
 * Un bouton incomplet (lien sans URL, agenda sans date) serait refusé par le serveur, et son refus ferait
 * échouer l'enregistrement du message ENTIER. On bloque donc à la saisie, là où quelqu'un peut corriger,
 * plutôt que de laisser découvrir l'erreur au moment d'envoyer.
 */
export function boutonPret(s: RcsSuggestion): boolean {
  if (s.text.trim() === '') return false;
  switch (s.kind) {
    case 'openUrl':
      return s.url.trim() !== '';
    case 'dial':
      return s.phoneNumber.trim() !== '';
    case 'calendar':
      return s.title.trim() !== '' && s.startAt.trim() !== '' && s.endAt.trim() !== '';
    case 'showLocation':
      return Number.isFinite(s.latitude) && Number.isFinite(s.longitude);
    default:
      return true;
  }
}

/** Le bouton ouvre-t-il une sortie reliable dans un scénario ? Seul « Réponse » ramène une charge utile. */
export function ouvreUneSortie(s: { kind: string }): boolean {
  return s.kind === 'reply';
}

/**
 * Boutons relus depuis les données d'un bloc de scénario, où ils sont stockés en JSON libre.
 *
 * Coercition DÉFENSIVE et non validation : un bloc enregistré avant l'arrivée d'une forme, ou par une version
 * plus ancienne, ne doit pas faire planter le panneau de configuration. Ce qui n'est pas reconnu devient un
 * bouton « Réponse » avec son libellé, ce qui est réparable en un clic, plutôt que disparaître en silence.
 */
export function boutonsDepuisNode(raw: unknown): RcsSuggestion[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((b): RcsSuggestion => {
    const o = (b ?? {}) as Record<string, unknown>;
    const base = { text: String(o.text ?? ''), postbackData: String(o.postbackData ?? '') };
    const kind = KINDS_BOUTON.includes(o.kind as KindBouton) ? (o.kind as KindBouton) : 'reply';
    switch (kind) {
      case 'openUrl':
        return { ...base, kind, url: String(o.url ?? '') };
      case 'dial':
        return { ...base, kind, phoneNumber: String(o.phoneNumber ?? '') };
      case 'calendar':
        return {
          ...base, kind,
          title: String(o.title ?? ''),
          startAt: String(o.startAt ?? ''),
          endAt: String(o.endAt ?? ''),
          ...(o.description ? { description: String(o.description) } : {}),
        };
      case 'showLocation':
        return {
          ...base, kind,
          latitude: Number(o.latitude ?? 0),
          longitude: Number(o.longitude ?? 0),
          ...(o.label ? { label: String(o.label) } : {}),
        };
      default:
        return { ...base, kind: 'reply' };
    }
  });
}
