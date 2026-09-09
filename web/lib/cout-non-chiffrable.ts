/**
 * La phrase qui explique un envoi COMPTÉ mais NON CHIFFRÉ, sur les deux écrans qui l'affichent.
 *
 * 🔴 IL Y A DEUX CAUSES, ELLES NE SE RÉPARENT PAS PAREIL, ET UN SEUL MOT LES CONFONDAIT. « catégorie
 * inconnue ou tarif indisponible » laissait le lecteur devant un ou exclusif qu'il ne pouvait pas trancher,
 * donc devant la question « est-ce que ça se répare ? » sans réponse. Julien l'a posée mot pour mot le
 * 2026-09-09 : « y compris sur des campagnes récentes tu n'arrives pas à savoir la catégorie ? ».
 *
 * La réponse, mesurée en production ce jour-là, chemin d'écriture par chemin d'écriture : NON. Les envois de
 * scénario ne portaient pas leur catégorie (le code lisait la fiche du template chez Meta et la jetait), les
 * chemins `campagne` et `humain` l'ont toujours portée, et le dernier envoi sans catégorie date du
 * 2026-09-07 à 12h36. C'est donc un HÉRITAGE fermé, pas une panne en cours, et les deux appellent des gestes
 * opposés : on attend le premier, on va réparer la seconde.
 *
 * ⚠️ MODULE PUR, sans `@/` et sans React : la formulation de ces deux cas se teste depuis la racine, et
 * c'est ce qui empêche les deux cartes de dériver l'une de l'autre (elles l'avaient déjà fait sur ce même
 * texte, avec deux phrases différentes pour le même chiffre).
 */

/**
 * Les deux causes, telles que le serveur les compte (`src/stats/cost.ts`), plus leur total.
 *
 * 🔴 LE DÉTAIL EST OPTIONNEL, ET CE N'EST PAS UNE PRÉCAUTION DE STYLE. La console est déployée par Vercel
 * À CHAQUE PUSH ; l'API vit sur le VPS et se déploie à la main. Il existe donc une FENÊTRE, de quelques
 * minutes à quelques heures, où le nouveau front interroge l'ancienne API : elle rend `nonChiffrables` et
 * rien d'autre. Exiger le détail ferait alors DISPARAÎTRE la phrase, c'est-à-dire escamoter exactement
 * l'information que cet écran existe pour dire, et sans le moindre signe. On retombe donc sur la phrase
 * générique d'avant, qui reste vraie.
 */
export interface CausesNonChiffrable {
  /** Total des envois comptés mais non chiffrés. Seul champ dont la présence est garantie. */
  nonChiffrables: number;
  /** Aucune catégorie enregistrée à l'envoi. Héritage définitif. Absent d'une API antérieure au 2026-09-09. */
  sansCategorie?: number;
  /** Catégorie connue, mais Meta ne rend aucun tarif pour elle. Panne réparable. Même réserve. */
  sansTarif?: number;
}

/**
 * Sur quoi porte le compte, et ce n'est pas un détail de style : « des campagnes affichées » est la vérité
 * du tableau (qui tronque), « de la période » celle du graphe. Annoncer la période sur un tableau tronqué
 * serait faux exactement dans le cas où le chiffre compte le plus.
 *
 * 🔴 `campagne` A ÉTÉ AJOUTÉE EN REVUE, parce que la fiche de campagne affichait « de la période » à deux
 * centimètres de son propre sous-titre, qui dit qu'elle NE SUIT PAS la période. Deux phrases voisines qui
 * se contredisent valent mieux qu'un chiffre faux, mais pas de beaucoup : le lecteur ne sait plus laquelle
 * décrit ce qu'il regarde.
 */
export type PorteeNonChiffrable = 'campagnes-affichees' | 'periode' | 'campagne';

/** Une phrase par cause présente, dans les deux langues. Vide si tout est chiffré. */
export interface PhrasesNonChiffrable {
  fr: string;
  en: string;
}

/**
 * Les phrases à afficher, ou `null` quand il n'y a rien à dire.
 *
 * `fmt` est injecté (et non importé) pour que ce module reste testable sans le formateur localisé : c'est
 * lui qui met l'espace insécable des milliers, il dépend de la locale du navigateur.
 */
export function phrasesNonChiffrables(
  causes: CausesNonChiffrable,
  portee: PorteeNonChiffrable,
  fmt: (n: number) => string,
): PhrasesNonChiffrable[] {
  const entier = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  const total = entier(causes.nonChiffrables) ?? 0;
  if (total === 0) return [];
  const ouFr = portee === 'campagnes-affichees' ? 'des campagnes affichées'
    : portee === 'campagne' ? 'de cette campagne' : 'de la période';
  const ouEn = portee === 'campagnes-affichees' ? 'among the campaigns shown'
    : portee === 'campagne' ? 'in this campaign' : 'over this period';

  const sc = entier(causes.sansCategorie);
  const st = entier(causes.sansTarif);
  // 🔴 LA SOMME DOIT TOMBER JUSTE, SINON ON N'AFFICHE PAS LE DÉTAIL. Un détail partiel (une API à moitié
  // à jour, un proxy qui tronque) donnerait deux phrases dont les nombres ne totalisent pas celui qu'on
  // annonce ailleurs, et c'est pire qu'une phrase moins précise : le lecteur ne saurait plus lequel croire.
  if (sc === null || st === null || sc + st !== total) {
    return [{
      fr: `${fmt(total)} envoi(s) ${ouFr} ne sont pas chiffrables : leur catégorie n’a pas été enregistrée, ou Meta n’en rend pas le tarif. Ils sont comptés dans « Envoyés », pas dans le coût.`,
      en: `${fmt(total)} send(s) ${ouEn} cannot be priced: their category was not recorded, or Meta returns no rate for it. They count under "Sent", not in the cost.`,
    }];
  }

  const sansCategorie = sc;
  const sansTarif = st;
  const out: PhrasesNonChiffrable[] = [];
  if (sansCategorie > 0) {
    out.push({
      fr: `${fmt(sansCategorie)} envoi(s) ${ouFr} n’ont aucune catégorie enregistrée : les envois de scénario n’ont commencé à la porter que le 7 septembre 2026. C’est de l’historique, pas une panne, et il ne redeviendra pas chiffrable. Ils restent comptés dans « Envoyés ».`,
      en: `${fmt(sansCategorie)} send(s) ${ouEn} carry no recorded category: scenario sends only started carrying it on 7 September 2026. This is history, not a failure, and it will not become priceable. They still count under "Sent".`,
    });
  }
  if (sansTarif > 0) {
    out.push({
      fr: `${fmt(sansTarif)} envoi(s) ${ouFr} ont une catégorie connue, mais Meta n’en rend pas le tarif : ils restent comptés dans « Envoyés », hors du coût, et redeviendront chiffrables dès que le tarif sera disponible.`,
      en: `${fmt(sansTarif)} send(s) ${ouEn} have a known category but Meta returns no rate for it: they count under "Sent", outside the cost, and will become priceable as soon as the rate is available.`,
    });
  }
  return out;
}
