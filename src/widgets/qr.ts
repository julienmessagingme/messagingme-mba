import QRCode from 'qrcode';

/**
 * Le QR code d'un lien `wa.me`, en SVG, pour le panneau que la bulle ouvre sur un ordinateur.
 *
 * Généré CÔTÉ SERVEUR, et c'est un choix (spec, section 5) : sinon chaque site client ferait télécharger une
 * bibliothèque de QR à ses visiteurs, alors que le contenu du QR est connu au moment de servir le script.
 * `qrcode` est la bibliothèque que la console utilise déjà (`web/package.json`), aux mêmes versions.
 */
export function qrSvg(lien: string): Promise<string> {
  return QRCode.toString(lien, { type: 'svg', margin: 1 });
}
