// Traduction des codes d'erreur Meta (WhatsApp Cloud API) en message clair pour l'utilisateur.
// Les erreurs remontent sous la forme "131042 Business eligibility payment issue" (code + texte
// Meta) : on extrait le code numérique et on affiche une explication FR, sinon le texte brut.

const CODES: Record<string, string> = {
  '131042':
    "Éligibilité / facturation Meta. Le marketing via MM Lite exige un onboarding au niveau Business Manager. On envoie désormais par l'endpoint standard ; si ça persiste, vérifie le moyen de paiement du WABA.",
  '131047': "Fenêtre de service 24 h fermée : il faut passer par un template (pas un message libre).",
  '131026': "Message non délivrable : le numéro n'a pas WhatsApp, ou ne peut pas recevoir ce message.",
  '131049': "Meta a limité cet envoi pour préserver la qualité (trop de marketing vers cet utilisateur récemment).",
  '130472': "Numéro inclus dans une expérimentation Meta de limitation marketing : message non envoyé.",
  '131045': "Numéro expéditeur non enregistré / problème de certificat côté Meta.",
  '132000': "Template : le nombre de variables fournies ne correspond pas au template.",
  '132001': "Template introuvable ou non approuvé pour cette langue.",
  '132005': "Template : le texte traduit dépasse la limite de caractères.",
  '132007': "Template : contenu refusé par une politique Meta.",
  '132012': "Template : format d'une variable invalide.",
  '132015': "Template en pause (qualité trop basse).",
  '132016': "Template désactivé (qualité trop basse).",
  '133010': "Numéro non enregistré sur la plateforme.",
  '190': "Token d'accès Meta expiré ou invalide.",
  '100': "Paramètre invalide dans l'appel Meta.",
  '368': "Compte temporairement restreint par Meta (violation de politique).",
  '80007': "Limite de débit atteinte : réessaie un peu plus tard.",
  '131000': "Erreur temporaire côté Meta : réessaie.",
  '131016': "Service Meta momentanément indisponible : réessaie.",
};

/**
 * Rend une erreur Meta lisible. Extrait le 1er code numérique (2 à 6 chiffres) et renvoie
 * l'explication FR + le code entre parenthèses. Inconnu -> texte brut inchangé. null -> null.
 */
export function explainMetaError(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const code = raw.match(/\b(\d{2,6})\b/)?.[1];
  const friendly = code ? CODES[code] : undefined;
  return friendly ? `${friendly} (code ${code})` : raw;
}
