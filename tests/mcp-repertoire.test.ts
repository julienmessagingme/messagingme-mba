import { describe, it, expect } from 'vitest';
import { OUTILS, type ProprieteEntree } from '../src/mcp/outils';
import { INSTRUCTIONS_MCP } from '../src/mcp/serveur';
import { ACTION_WEBHOOK, ACTION_WEBHOOK_EN } from '../src/mcp/outils-agent';

/**
 * LE RÉPERTOIRE DE CLAUDE (spec 2026-10-14-repertoire-claude-design.md). Ce que la revue d'Anthropic exige des outils
 * d'un connecteur, et ce que Julien a décidé pour eux :
 *  - 🔴 chaque outil porte un `title`, et `readOnlyHint: true` s'il lit, `destructiveHint: true` s'il modifie des données
 *    (« Every tool must include a title and the applicable hint ») : c'est sur eux que claude.ai décide de demander
 *    confirmation, et un outil d'écriture sans `destructiveHint` y est signalé ;
 *  - les titres, descriptions, descriptions des paramètres et instructions du serveur sont en ANGLAIS (les refus et les
 *    valeurs rendues restent en français, Claude les relaie dans la langue de la personne) ;
 *  - une description dit ce que fait l'outil et quand l'appeler, jamais comment Claude doit se conduire (« Describe what
 *    the tool does, and don't tell Claude how to behave »).
 */

/** Tous les textes qu'un client MCP lit pour choisir et appeler un outil, avec leur emplacement. */
function textesDe(): Array<{ ou: string; texte: string }> {
  const textes: Array<{ ou: string; texte: string }> = [{ ou: 'instructions du serveur', texte: INSTRUCTIONS_MCP }];
  const proprietes = (chemin: string, props: Record<string, ProprieteEntree> | undefined): void => {
    for (const [cle, p] of Object.entries(props ?? {})) {
      textes.push({ ou: `${chemin}.${cle}`, texte: p.description });
      proprietes(`${chemin}.${cle}`, p.properties);
      const items = p.items as { properties?: Record<string, ProprieteEntree> } | undefined;
      proprietes(`${chemin}.${cle}[]`, items?.properties);
    }
  };
  for (const o of OUTILS) {
    textes.push({ ou: `${o.nom} (titre)`, texte: o.annotations.title }, { ou: `${o.nom} (description)`, texte: o.description });
    proprietes(o.nom, o.entree.properties);
  }
  return textes;
}

/** Une lettre accentuée, une ligature, une apostrophe ou des guillemets à la française. */
const TYPO_FRANCAISE = /[àâäçéèêëîïôöùûüÿœæÀÂÇÉÈÊËÎÏÔÙÛÜŒ’«»]/;
/** Des mots-outils français qui n'existent pas en anglais. */
const MOTS_FRANCAIS = /\b(les|des|du|une|est|pour|avec|dans|sur|qui|que|pas|aux|cette|ces|chaque|depuis|sont|ou|et|le|la)\b/i;
/** Des consignes adressées à Claude, que la revue refuse. */
const CONSIGNES = /\b(tell the (user|person)|ask the (user|person)|you must|you should|make sure to|do not forget|always call|never call|first call)\b/i;

describe('les outils MCP, aux règles du répertoire de Claude', () => {
  it('🔴 chaque outil a un titre, et le bon indice : readOnlyHint pour une lecture, destructiveHint pour une écriture', () => {
    for (const o of OUTILS) {
      const a = o.annotations;
      expect(a.title.trim(), `outil « ${o.nom} »`).not.toBe('');
      if (o.scope === 'mcp:read') {
        expect(a.readOnlyHint, `outil « ${o.nom} »`).toBe(true);
      } else {
        expect(a.readOnlyHint, `outil « ${o.nom} »`).toBe(false);
        expect(a.readOnlyHint === false && a.destructiveHint, `outil « ${o.nom} » (une écriture)`).toBe(true);
      }
    }
  });

  it('🔴 les titres, descriptions, paramètres et instructions sont en anglais', () => {
    const enFrancais = textesDe()
      .filter((t) => TYPO_FRANCAISE.test(t.texte) || MOTS_FRANCAIS.test(t.texte))
      .map((t) => `${t.ou} : ${t.texte.slice(0, 80)}`);
    expect(enFrancais).toEqual([]);
  });

  it('🔴 aucune description ne dicte sa conduite à Claude', () => {
    const consignes = textesDe().filter((t) => CONSIGNES.test(t.texte)).map((t) => `${t.ou} : ${t.texte.match(CONSIGNES)![0]}`);
    expect(consignes).toEqual([]);
  });

  it('le texte du webhook d’action, rendu en français et décrit en anglais, cite les mêmes repères', () => {
    // Deux textes tenus alignés à la main : celui que set_agent_action REND (français) et celui de sa description.
    const reperes = (t: string) => [...t.matchAll(/agent\.action|list_webhook_endpoints|create_webhook_endpoint|PATCH \/v1\/webhooks\/\{id\}|fields/g)]
      .map((m) => m[0]).sort();
    expect(new Set(reperes(ACTION_WEBHOOK_EN))).toEqual(new Set(reperes(ACTION_WEBHOOK)));
    expect(reperes(ACTION_WEBHOOK).length).toBeGreaterThan(3);
  });

  it('les noms d’outils tiennent en 64 caractères', () => {
    for (const o of OUTILS) expect(o.nom.length, o.nom).toBeLessThanOrEqual(64);
  });
});
