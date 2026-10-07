import { asArray, asRecord, texteNonVide } from './json';

/**
 * LE TEXTE LISIBLE D'UN MESSAGE INTERACTIF ENVOYÉ PAR L'AGENT DE META, pour l'Inbox.
 *
 * Jusqu'au lot « messages interactifs », un écho de l'agent n'était enregistré que s'il portait `text.body` : un
 * composant (boutons, liste, formulaire, carrousel...) était INVISIBLE, et l'opérateur lisait « Voir les détails
 * ci-dessous. » puis « 10 h » sans savoir qu'une liste avait été proposée (mesuré le 2026-10-07).
 *
 * Les formes viennent de la mesure du 2026-10-07 sur le numéro de test (`tests/echos-mba-fixtures.ts`) : le corps
 * de l'écho reprend la forme d'ENVOI de la Cloud API. Un formulaire part en `galaxy_message`, jamais `flow` ; une
 * demande de position en `location_request_message` ; `image` et `location` sont à plat. Pure ; rien ne s'invente :
 * un sous-type inconnu rend `ECHO_INCONNU`, et l'appelant journalise le payload.
 */

export const ECHO_INCONNU = '[message interactif]';

/** Une étiquette d'aperçu ne sert pas à relire un carrousel entier : on tronque chaque carte. */
const CARTE_MAX = 40;
const tronquer = (s: string): string => (s.length > CARTE_MAX ? `${s.slice(0, CARTE_MAX - 1)}…` : s);

function avecCorps(corps: string | undefined, detail: string): string {
  return corps ? `${corps}\n${detail}` : detail;
}

/** Le texte d'un écho qui n'est pas du texte simple, ou `null` s'il n'y a rien d'affichable (rien n'est alors enregistré). */
export function texteDeLEcho(message: Record<string, unknown>): string | null {
  const type = texteNonVide(message['type']);

  if (type === 'image') {
    return texteNonVide(asRecord(message['image'])['caption']) ?? '[image]';
  }
  if (type === 'location') {
    const lieu = asRecord(message['location']);
    return texteNonVide(lieu['name']) ?? texteNonVide(lieu['address']) ?? '[lieu]';
  }
  if (type !== 'interactive') return null;

  const it = asRecord(message['interactive']);
  const corps = texteNonVide(asRecord(it['body'])['text']);
  const action = asRecord(it['action']);

  switch (texteNonVide(it['type'])) {
    case 'button': {
      const titres = asArray(action['buttons']).map((b) => texteNonVide(asRecord(asRecord(b)['reply'])['title'])).filter((t): t is string => t !== undefined);
      return avecCorps(corps, `[Boutons : ${titres.join(' · ')}]`);
    }
    case 'list': {
      const lignes = asArray(action['sections']).flatMap((s) => asArray(asRecord(s)['rows']))
        .map((r) => texteNonVide(asRecord(r)['title'])).filter((t): t is string => t !== undefined);
      const bouton = texteNonVide(action['button']);
      return avecCorps(corps, `[Liste${bouton ? ` « ${bouton} »` : ''} : ${lignes.join(' · ')}]`);
    }
    case 'cta_url': {
      const p = asRecord(action['parameters']);
      const libelle = texteNonVide(p['display_text']);
      const adresse = texteNonVide(p['url']);
      return avecCorps(corps, `[Bouton lien${libelle ? ` « ${libelle} »` : ''}${adresse ? ` : ${adresse}` : ''}]`);
    }
    case 'galaxy_message': {
      const bouton = texteNonVide(asRecord(action['parameters'])['flow_cta']);
      return avecCorps(corps, `[Formulaire${bouton ? ` « ${bouton} »` : ''}]`);
    }
    case 'carousel': {
      const cartes = asArray(action['cards']).map((c) => texteNonVide(asRecord(asRecord(c)['body'])['text']))
        .filter((t): t is string => t !== undefined).map(tronquer);
      return avecCorps(corps, `[Carrousel : ${cartes.join(' · ')}]`);
    }
    case 'location_request_message':
      return avecCorps(corps, '[Demande de position]');
    default:
      return ECHO_INCONNU;
  }
}
