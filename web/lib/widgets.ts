'use client';

import { request } from './http';

/**
 * Les widgets WhatsApp d'un espace : la bulle que le client pose sur son site (lot 4 de
 * docs/superpowers/plans/2026-10-02-widget-whatsapp.md).
 *
 * ⚠️ Module importé EN DIRECT (`@/lib/widgets`), jamais ajouté au barrel `lib/api.ts`, comme `api-chaine` et
 * `api-pubs`.
 *
 * 🔴 LES CHEMINS SONT ÉCRITS UNE SEULE FOIS, dérivés de `base()`, et `tests/web-widgets-parite.test.ts` les compare
 * aux routes que le serveur monte : un chemin est une chaîne, le compilateur ne voit rien.
 *
 * 🔴 L'ADRESSE DU SCRIPT, LA BALISE ET LE LIEN `wa.me` SONT COMPOSÉS PAR LE SERVEUR, jamais ici. Une balise part
 * chez un client et doit répondre pour toujours : deux compositions divergeraient, et la seconde partirait quand même.
 */

const base = (tenantId: string): string => `/tenants/${tenantId}/widgets`;

// --- Bornes recopiées du serveur --------------------------------------------------------------------

/**
 * Recopiées À LA MAIN depuis `src/widgets/gestion.ts` (`web/` n'importe jamais `src/`), et figées par
 * `tests/web-widgets-parite.test.ts`. L'écran guide la saisie, le serveur tranche.
 */
export const LIMITE_WIDGETS = 5;
export const MAX_NOM_WIDGET = 80;
export const MAX_PHRASE_WIDGET = 300;
export const MAX_LIBELLE_WIDGET = 60;
export const COULEUR_PAR_DEFAUT = '#25d366';
export const POSITIONS_WIDGET = ['bas_droite', 'bas_gauche', 'haut_droite', 'haut_gauche'] as const;
export type PositionWidget = (typeof POSITIONS_WIDGET)[number];

/** `agent` existe en base et à l'écran (grisé, « à venir ») ; le serveur le refuse à l'écriture. */
export type DevenirWidget = 'agent' | 'mba' | 'scenario';

// --- Les formes rendues par le serveur --------------------------------------------------------------

/** Un widget tel que `GET /tenants/:id/widgets` le rend (`VueWidget`, `src/widgets/gestion.ts`). */
export interface Widget {
  id: string;
  /** L'identifiant PUBLIC, celui de l'adresse du script. Immuable. */
  code: string;
  nom: string;
  phrase: string;
  /** null = le réglage de l'espace décide qui répond. */
  devenir: DevenirWidget | null;
  workflowId: string | null;
  couleur: string;
  position: PositionWidget;
  libelle: string | null;
  avatarUrl: string | null;
  /** « Propulsé par Engage Me ». Pas modifiable depuis la console : il tient à l'offre, pas à un réglage. */
  badge: boolean;
  actif: boolean;
  /** null = le plafond de l'instance, pas « zéro ». */
  maxParHeure: number | null;
  createdAt: string;
  updatedAt: string;
  adresseScript: string;
  /** La balise `<script ... async></script>` à coller sur le site, prête. */
  balise: string;
  /** Le lien `wa.me` de la bulle. null = la bulle s'affiche grisée (aucun numéro relié, ou numéro délié). */
  waMeUrl: string | null;
  /** Devenir « scénario » dont le scénario a été supprimé : le widget ne démarre plus rien. */
  scenarioSupprime: boolean;
}

/**
 * Ce que l'écran envoie. Pas de `badge` : le serveur refuse la clé (voir `Widget.badge`). Le devenir `agent` n'y
 * figure pas non plus : il est grisé à l'écran et refusé par le serveur.
 */
export interface SaisieWidget {
  nom: string;
  phrase: string;
  devenir: 'mba' | 'scenario' | null;
  workflowId: string | null;
  couleur: string;
  position: PositionWidget;
  libelle: string | null;
  avatarUrl: string | null;
  actif: boolean;
  maxParHeure: number | null;
}

/** Les clés de `SaisieWidget`. `widgets.test.ts` vérifie qu'aucune ne manque : une clé oubliée ne s'enverrait jamais. */
export const CLES_DE_SAISIE: readonly (keyof SaisieWidget)[] = [
  'nom', 'phrase', 'devenir', 'workflowId', 'couleur', 'position', 'libelle', 'avatarUrl', 'actif', 'maxParHeure',
];

/** La saisie qui reproduit un widget existant : le point de départ du formulaire de modification. */
export function saisieDuWidget(w: Widget): SaisieWidget {
  return {
    nom: w.nom,
    phrase: w.phrase,
    // `agent` ne se saisit pas (grisé, « à venir ») : un tel widget n'existe qu'en base, et le serveur refusera de le
    // modifier tant qu'un autre devenir n'est pas choisi.
    devenir: w.devenir === 'agent' ? null : w.devenir,
    workflowId: w.workflowId,
    couleur: w.couleur,
    position: w.position,
    libelle: w.libelle,
    avatarUrl: w.avatarUrl,
    actif: w.actif,
    maxParHeure: w.maxParHeure,
  };
}

/**
 * Ce qui a CHANGÉ entre deux saisies : le corps d'une modification. N'envoyer que l'écart n'est pas une économie,
 * c'est ce qui laisse modifier la couleur d'un widget dont le scénario a été supprimé : renvoyer le devenir
 * « scénario » sans scénario serait CHOISIR ce devenir, que le serveur refuse sans scénario.
 */
export function ecartsDeSaisie(avant: SaisieWidget, apres: SaisieWidget): Partial<SaisieWidget> {
  const ecarts: Partial<SaisieWidget> = {};
  for (const cle of CLES_DE_SAISIE) {
    if (apres[cle] !== avant[cle]) Object.assign(ecarts, { [cle]: apres[cle] });
  }
  return ecarts;
}

// --- Les quatre appels --------------------------------------------------------------------------------

/** `limite` est celle du serveur : l'écran l'affiche, il ne la décide pas. */
export function listerWidgets(tenantId: string): Promise<{ widgets: Widget[]; limite: number }> {
  return request(base(tenantId));
}

export function creerWidget(tenantId: string, saisie: SaisieWidget): Promise<{ widget: Widget }> {
  return request(base(tenantId), { method: 'POST', body: JSON.stringify(saisie) });
}

/** Modification PARTIELLE : un champ absent garde sa valeur. */
export function modifierWidget(tenantId: string, id: string, saisie: Partial<SaisieWidget>): Promise<{ widget: Widget }> {
  return request(`${base(tenantId)}/${id}`, { method: 'PATCH', body: JSON.stringify(saisie) });
}

export function supprimerWidget(tenantId: string, id: string): Promise<{ ok: true }> {
  return request(`${base(tenantId)}/${id}`, { method: 'DELETE' });
}
