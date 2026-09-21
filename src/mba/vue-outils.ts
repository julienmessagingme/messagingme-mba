import type { OutilComplet, OutilBibliotheque, RisqueOutil } from '../agent/catalog';
import { lireCibleMaison, typeDeLaCible, type TypeOutilMba } from './outils-maison';

/**
 * LA LIGNE D'UN OUTIL DANS L'ONGLET « OUTILS » DE L'AGENT DE META (spec 2026-09-21-outils-maison-mba, § 9.1).
 *
 * 🔴 CE QUI MANQUE SE DIT : un champ supprimé, un appel supprimé, un outil illisible. Un outil dont la cible a
 * disparu refuse à chaque appel (le relais refuse d'écrire un champ supprimé) ; sans cette ligne rouge, personne
 * ne le saurait. Un outil illisible ne part plus chez Meta (`publiable`), un champ supprimé si.
 * ⚠️ Un APPEL ne peut pas être supprimé tant qu'un outil l'utilise (`on delete restrict` de 0105, et le 409 de la
 * route des requêtes) : la branche « appel supprimé » est une défense, pas un cas que l'écran rencontre.
 *
 * ⚠️ `actif` VOYAGE AUSSI : le départ d'un collaborateur éteint les consentements qu'il avait donnés
 * (`PgUserStore.deleteUser`), donc un outil qu'il avait créé sort de la publication. L'écran doit le montrer
 * « Désactivé » et proposer de le rallumer (plan 2026-09-21-outils-maison-mba, écart 4).
 */
export type CibleVue =
  | { type: 'tag'; tag: string }
  | { type: 'champ'; champ: string; valeurs: string[] }
  | { type: 'connecteur'; requeteId: string; libelle: string | null }
  | { type: 'inconnu' };

export interface OutilMbaVue {
  id: string;
  name: string;
  title: string;
  description: string;
  nePasUtiliser: string;
  type: TypeOutilMba | 'inconnu';
  cible: CibleVue;
  /** Pourquoi la cible n'existe plus, ou `null`. Texte du serveur, affiché tel quel. */
  cibleManquante: string | null;
  /** Les agents IA qui partagent cet outil (connecteur seulement). */
  aussiUtilisePar: string[];
  actif: boolean;
  /**
   * Ce que l'outil peut faire (`agent_tools.risk`). 🔴 L'écran le DIT pour `irreversible` : l'agent de Meta
   * appelle sans aucune validation humaine, et l'ancienne bibliothèque le montrait ; l'onglet refait l'avait
   * perdu sans que personne l'ait arbitré (relecture du 2026-09-21).
   */
  risque: RisqueOutil;
  /**
   * Cet outil part-il chez Meta quand il est actif ? 🔴 C'est la réponse de `outilsAPublier`, redite ici pour
   * l'écran : sans elle, une ligne jamais publiée s'affichait « ✓ Chez Meta ». La parité est tenue par un test
   * (`tests/mba-outils-parite.test.ts`), qui passe les mêmes outils aux deux fonctions.
   */
  publiable: boolean;
}

export interface ContexteVue {
  requetes: ReadonlyMap<string, { label: string }>;
  champs: ReadonlySet<string>;
  bibliotheque: ReadonlyMap<string, OutilBibliotheque>;
}

export function vueOutilMba(o: OutilComplet, ctx: ContexteVue): OutilMbaVue {
  const base = {
    id: o.id, name: o.name, title: o.title, description: o.description, nePasUtiliser: o.nePasUtiliser, actif: o.actif,
    risque: o.risk,
  };
  if (o.origin === 'http' && o.requestId) {
    const req = ctx.requetes.get(o.requestId) ?? null;
    const aussiUtilisePar = (ctx.bibliotheque.get(o.id)?.consommateurs ?? [])
      .filter((c) => c.agentId !== null)
      .map((c) => c.agentLabel ?? 'un agent IA');
    return {
      ...base, type: 'connecteur',
      cible: { type: 'connecteur', requeteId: o.requestId, libelle: req?.label ?? null },
      cibleManquante: req ? null : 'l’appel de cet outil a été supprimé dans Connecteurs API',
      aussiUtilisePar, publiable: req !== null,
    };
  }
  const cible = o.origin === 'mba' ? lireCibleMaison(o.binding) : null;
  if (cible === null) {
    return {
      ...base, type: 'inconnu', cible: { type: 'inconnu' },
      cibleManquante: 'l’agent de Meta ne peut pas appeler cet outil : supprimez-le', aussiUtilisePar: [], publiable: false,
    };
  }
  const type = typeDeLaCible(cible);
  switch (cible.handler) {
    case 'tag_fixe':
      return { ...base, type, cible: { type: 'tag', tag: cible.tag }, cibleManquante: null, aussiUtilisePar: [], publiable: true };
    case 'champ_fixe':
      return {
        ...base, type, cible: { type: 'champ', champ: cible.champ, valeurs: cible.valeurs },
        cibleManquante: ctx.champs.has(cible.champ) ? null : `le champ « ${cible.champ} » n’existe plus dans le mini-CRM`,
        aussiUtilisePar: [], publiable: true,
      };
  }
}
