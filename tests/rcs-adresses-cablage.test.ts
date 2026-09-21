import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * LES ADRESSES QUE LE RCS DISTRIBUE SE CONSTRUISENT SUR L'API, JAMAIS SUR `APP_URL` (2026-09-21).
 *
 * 🔴 LE DÉFAUT QUE CE TEST EMPÊCHE DE REVENIR. La bascule Vercel du 2026-09-03 a séparé le front (`APP_URL`,
 * `engageme.messagingme.app`) de l'API (`PUBLIC_API_URL`, `api.messagingme.app`), et `adressesPubliques` est
 * le point de passage unique des adresses que l'API sert. Les liens WhatsApp et les visuels RCS y ont été
 * rebranchés (`src/index.ts`) ; DEUX adresses du RCS, câblées dans `src/workflow/wiring.ts`, sont restées sur
 * `config.APP_URL` :
 *   - l'adresse de rappel donnée à smsmode : rapports de livraison ET réponses des contacts, STOP compris ;
 *   - la base des liens tracés des boutons RCS.
 * Vercel ne relaie pas ces chemins (`404 DNS_HOSTNAME_RESOLVED_PRIVATE`, mesuré le 2026-09-21) : aucun rappel
 * n'est arrivé depuis le 26 août, et les boutons « En savoir plus » du premier carrousel ouvraient une page
 * d'erreur. Aucun test ne pouvait le voir : le front et l'API répondent tous deux en local.
 *
 * ⚠️ CE TEST LIT LE CÂBLAGE, et c'est assumé : la propriété est « quelle base reçoivent ces deux appels », et
 * `buildWorkflowRuntime` ne se monte pas sans une base de données. Sa mutation (remettre `config.APP_URL`) le
 * fait tomber, vérifié à l'écriture.
 */
const cablage = readFileSync(join(__dirname, '..', 'src', 'workflow', 'wiring.ts'), 'utf8');

/** Le texte d'un appel, de son nom jusqu'à la parenthèse qui le ferme. */
function appel(source: string, debut: string): string {
  const i = source.indexOf(debut);
  expect(i, `${debut} introuvable dans wiring.ts : le câblage a changé de forme`).toBeGreaterThan(-1);
  let profondeur = 0;
  for (let j = i + debut.length - 1; j < source.length; j += 1) {
    if (source[j] === '(') profondeur += 1;
    if (source[j] === ')') {
      profondeur -= 1;
      if (profondeur === 0) return source.slice(i, j + 1);
    }
  }
  throw new Error(`parenthèse fermante introuvable après ${debut}`);
}

describe('les adresses que le RCS distribue', () => {
  it('🔴 l adresse de rappel smsmode se construit sur l API', () => {
    const texte = appel(cablage, 'urlRappelRcs(');
    expect(texte).not.toContain('APP_URL');
    expect(texte).toContain('avecPrefixe');
  });

  it('🔴 les liens traces des boutons RCS se construisent sur l API', () => {
    const texte = appel(cablage, 'new TraceurLiensRcs(');
    expect(texte).not.toContain('APP_URL');
    expect(texte).toContain('racine');
  });
});
