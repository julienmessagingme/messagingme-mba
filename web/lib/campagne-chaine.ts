/**
 * LA CHAÎNE ET LA CADENCE DE L'ASSISTANT DE CAMPAGNE, en fonctions PURES.
 *
 * 🔴 POURQUOI CE FICHIER EXISTE PLUTÔT QUE DE VIVRE DANS LE COMPOSANT. Les seuls tests du front qui
 * tournent hors navigateur sont ceux de `lib/**` (`web/vitest.config.ts` les y borne). Une règle enfouie
 * dans un `.tsx` ne peut donc être éprouvée QUE par un e2e Playwright, qui monte un vrai serveur Next :
 * un cas de travers y coûte une minute et se lit dans une capture d'écran. Les trois règles ci-dessous
 * décident du contenu ENVOYÉ à des gens ; elles méritent d'être exerçables en quelques millisecondes.
 *
 * ⚠️ ELLES NE CONNAISSENT NI REACT NI L'API : elles traduisent un choix d'écran en ce que la base sait
 * déjà stocker (`campaign_etages`, `campaigns.rate_per_minute`, `campaigns.business_hours_only`). C'est
 * ce qui permet de les relire à côté du serveur sans ouvrir un composant.
 */

/** Les canaux qu'un étage sait porter. Miroir de `CanalEtage` (`src/campaign/etages.ts`). */
export type CanalEtage = 'whatsapp' | 'rcs' | 'email';

/** Un étage de la chaîne, tel que l'assistant le construit. Miroir de `Etage` côté serveur. */
export interface EtageAssistant {
  rang: number;
  canal: CanalEtage;
}

/** Les trois entrées de la liste de canaux (étape 2). */
export type FormuleCanal = 'whatsapp' | 'rcs' | 'repli';
/** Le canal qui part en PREMIER quand la formule est « avec repli ». Le second s'en déduit. */
export type CanalPremier = 'whatsapp' | 'rcs';
/**
 * Le troisième niveau.
 *
 * ⚠️ `sms` EST DANS LE TYPE ALORS QU'IL N'EST PAS SÉLECTIONNABLE, et c'est délibéré : l'écran le montre
 * grisé avec la mention « bientôt », parce qu'une option absente fait croire que la fonctionnalité
 * n'existera jamais. Le garder ici oblige `chaineDeLaFormule` à dire ce qu'elle en fait (rien), plutôt
 * qu'à l'ignorer par omission le jour où quelqu'un rendra l'entrée cliquable.
 */
export type TroisiemeNiveau = 'aucun' | 'email' | 'sms';

/** Le rang du premier étage. Miroir de `RANG_INITIAL` (`src/campaign/etages.ts`). */
export const RANG_INITIAL = 1;
/** Le rang le plus haut qu'une chaîne puisse porter. Miroir de `RANG_MAX`, et du CHECK de la table. */
export const RANG_MAX = 3;

/**
 * LA CHAÎNE QUE LES CHOIX DE L'ÉTAPE 2 DÉCRIVENT, dans l'ordre des rangs.
 *
 * 🔴 LE SECOND CANAL SE DÉDUIT, IL NE SE CHOISIT PAS. C'est la décision de Julien du 2026-09-12 : la
 * formule « avec repli » ne propose que « lequel part en premier », et l'autre suit. Le laisser choisir
 * aurait ouvert la chaîne « WhatsApp puis WhatsApp », qui n'est pas un repli mais un réessai déguisé,
 * avec un second réglage qui dirait le contraire du premier.
 *
 * ⚠️ LE TROISIÈME NIVEAU N'EXISTE QU'AVEC UN REPLI. Sur un canal seul, la question n'est pas posée par
 * l'écran ; si un état résiduel la portait quand même (l'utilisateur choisit « repli » + e-mail, puis
 * revient à « WhatsApp »), la chaîne rendue ici l'ignore. Une chaîne WhatsApp + e-mail sans second canal
 * serait une chaîne dont l'écran n'a jamais montré l'étage 2.
 *
 * ⚠️ `sms` NE PRODUIT AUCUN ÉTAGE : aucune brique fournisseur n'existe, et la table le refuserait
 * (`check (canal in ('whatsapp', 'rcs', 'email'))`). Le rendre ici donnerait une erreur d'écriture en
 * base plutôt qu'un écran qui ne propose pas encore la chose.
 */
export function chaineDeLaFormule(choix: {
  formule: FormuleCanal;
  premier: CanalPremier;
  troisieme: TroisiemeNiveau;
}): EtageAssistant[] {
  if (choix.formule !== 'repli') {
    return [{ rang: RANG_INITIAL, canal: choix.formule }];
  }
  const second: CanalPremier = choix.premier === 'whatsapp' ? 'rcs' : 'whatsapp';
  const chaine: EtageAssistant[] = [
    { rang: 1, canal: choix.premier },
    { rang: 2, canal: second },
  ];
  if (choix.troisieme === 'email') chaine.push({ rang: 3, canal: 'email' });
  return chaine;
}

/** La campagne a-t-elle un REPLI, c'est-à-dire un étage après le premier ? */
export function aUnRepli(chaine: EtageAssistant[]): boolean {
  return chaine.some((e) => e.rang > RANG_INITIAL);
}

/**
 * LE RÉESSAI EST-IL PROPOSABLE ?
 *
 * 🔴 SUR UN CANAL SEUL, ET SEULEMENT LÀ (2026-09-13, retour de Julien sur son essai réel) : « le renvoi,
 * c'est le fallback ». Une chaîne de repli EST le rattrapage d'un échec, et le premier échec y fait
 * basculer vers le canal suivant. Proposer en plus de réessayer le canal qui vient d'échouer, c'est
 * proposer deux mécaniques concurrentes sur le même événement, dont la seconde repart précisément sur
 * le tuyau dont on sait déjà qu'il ne passe pas.
 *
 * ⚠️ CE N'EST PAS QU'UNE QUESTION D'AFFICHAGE, et c'est le piège que cette fonction ferme : l'écran
 * masquait déjà le bloc sur une formule « avec repli », mais l'état, lui, gardait la case cochée d'un
 * choix précédent. Passer de WhatsApp à « avec repli » après avoir coché emportait donc un réessai que
 * plus aucun écran ne montrait. La création s'en sert pour trancher au point d'envoi, pas seulement au
 * point d'affichage.
 */
export function reessaiProposable(chaine: EtageAssistant[]): boolean {
  return !aUnRepli(chaine);
}

/**
 * Ce qu'un étage doit porter pour qu'on ait le droit d'avancer. Miroir MINIMAL de `ContenuEtage`
 * (`AssistantCampagne.tsx`), volontairement réduit aux seuls champs qui décident : cette lib ne connaît
 * ni React ni le reste de l'écran, c'est ce qui la rend exerçable en quelques millisecondes.
 */
export interface ContenuMinimal {
  formule: 'seul' | 'avec_scenario';
  /** Cf. `ContenuEtage.devenir`. Seul `inbox` fait revenir la conversation à l'équipe. */
  devenir?: string | undefined;
  templateName?: string | undefined;
  workflowId?: string | undefined;
  texteRcs?: string | undefined;
  /** Cf. `ContenuEtage.carrouselRcs`. Présent = l'étage RCS a de quoi partir, même sans texte. */
  carrouselRcs?: unknown;
  emailTemplateId?: string | undefined;
}

/**
 * CET ÉTAGE A-T-IL DE QUOI ENVOYER QUELQUE CHOSE ?
 *
 * 🔴 LA RÉPONSE DÉPEND DU CANAL, et les confondre laisserait passer un étage vide. Un étage WhatsApp part
 * par un modèle approuvé, un étage RCS par un texte, un étage e-mail par un gabarit. La formule
 * « modèle et scénario » déplace la question ailleurs : c'est le scénario qui dit ce qui part, donc
 * c'est lui qu'on exige (le serveur écrit d'ailleurs `template_name = ''` dans ce cas).
 */
export function etageRenseigne(canal: CanalEtage, contenu: ContenuMinimal | undefined): boolean {
  if (!contenu) return false;
  if (contenu.formule === 'avec_scenario') return (contenu.workflowId ?? '').trim() !== '';
  if (canal === 'whatsapp') return (contenu.templateName ?? '').trim() !== '';
  if (canal === 'rcs') return contenu.carrouselRcs !== undefined || (contenu.texteRcs ?? '').trim() !== '';
  if (canal === 'email') return (contenu.emailTemplateId ?? '').trim() !== '';
  /**
   * ⚠️ UN CANAL QU'ON NE CONNAÎT PAS N'A RIEN À ENVOYER, donc il BLOQUE. Le `return` final valait
   * auparavant la règle de l'e-mail, ce qui aurait fait exiger un gabarit d'e-mail le jour où `sms`
   * devient un canal d'étage : le blocage aurait été SILENCIEUX et impossible à lever, puisque aucun
   * écran ne propose de gabarit d'e-mail sur un étage SMS. Bloquer explicitement se remarque et se
   * corrige ; bloquer par la mauvaise règle se cherche pendant une heure.
   */
  return false;
}

/**
 * LES RANGS DONT LE CONTENU MANQUE, dans l'ordre de la chaîne. Vide = on peut avancer.
 *
 * 🔴 ELLE EXISTE PARCE QUE L'ASSISTANT LAISSAIT PASSER UNE CAMPAGNE SANS CONTENU (2026-09-13, essai réel
 * de Julien). Son gardien d'étape ne contrôlait QUE le nom : les quatre autres étapes rendaient `true`
 * sans rien regarder, si bien qu'on atteignait le récapitulatif avec un étage 1 vide, et que le refus
 * n'arrivait qu'au tout dernier écran, loin de l'endroit où on pouvait le corriger.
 *
 * ⚠️ ELLE REGARDE TOUS LES ÉTAGES, pas seulement le premier. Un étage de repli vide ne bascule sur rien :
 * la campagne aurait un repli à l'écran et aucun repli en fait, ce qui est la pire des deux situations.
 *
 * ⚠️ CE N'EST PAS UNE RÈGLE NEUVE, C'EST UNE RÈGLE AVANCÉE. `problemeAvantLancement` refusait déjà
 * exactement ces cas, au récapitulatif, avec les mêmes critères par canal : aucun parcours qui lance
 * vraiment ne devient impossible, seul le moment du refus change. Le récapitulatif garde en revanche ses
 * contrôles PLUS FINS (longueur du RCS, boutons incomplets, variables du modèle), qui n'ont rien à faire
 * ici : celle-ci répond « y a-t-il quelque chose à envoyer ? », pas « est-ce envoyable ? ».
 */
export function rangsSansContenu(
  chaine: EtageAssistant[],
  contenus: Record<number, ContenuMinimal | undefined>,
): number[] {
  return chaine.filter((e) => !etageRenseigne(e.canal, contenus[e.rang])).map((e) => e.rang);
}

/**
 * LA JAUGE DE DÉBIT : ses bornes et son défaut, en messages par minute.
 *
 * 🔴 L'ÉCRAN REDEMANDE UN NOMBRE DE MESSAGES PAR MINUTE, ET C'EST UN RETOUR EN ARRIÈRE ASSUMÉ
 * (2026-09-12). Il a porté trois « intentions » (au plus vite, étalé, heures ouvrées) pendant une
 * journée : elles venaient d'une recommandation écrite dans la spec, jamais validée, et elles RETIRAIENT
 * une capacité que l'ancien formulaire offrait depuis toujours et que le client utilise. Retirer une
 * capacité sur la foi d'une recommandation non validée est une régression déguisée en amélioration.
 *
 * ⚠️ 80 EST LA BORNE DE SAISIE, PAS LE PLAFOND APPLIQUÉ. Le frein réel est celui du CANAL
 * (`plafondDuCanal`, côté serveur : 80 pour WhatsApp, 60 pour le RCS), et une campagne réglée au-dessus
 * y est RAMENÉE en silence. Le chiffre du plafond RCS n'est volontairement recopié nulle part dans
 * l'écran : il vit en configuration serveur pour se corriger sans déploiement, et une valeur en dur
 * deviendrait fausse sans que rien ne le signale.
 *
 * ⚠️ 60 PAR DÉFAUT, ET NON LE DÉFAUT DU SERVEUR (30). C'est celui de l'ancien formulaire, donc ce que
 * les campagnes de ce produit envoient réellement aujourd'hui : en prendre un autre ici ferait partir
 * deux campagnes identiques à deux vitesses selon l'écran qui les a créées.
 */
export const DEBIT_MIN = 1;
export const DEBIT_MAX = 80;
export const DEBIT_DEFAUT = 60;

/**
 * LE DÉBIT RAMENÉ DANS SES BORNES.
 *
 * ⚠️ ELLE EXISTE POUR L'ADRESSE ET POUR LA REPRISE, pas pour la jauge : un `<input type="range">` ne
 * peut pas sortir de ses bornes, mais un état venu d'ailleurs (paramètre d'URL, brouillon repris) le
 * peut, et le serveur refuse alors la création entière pour un nombre qu'aucun écran n'a montré.
 */
export function debitBorne(v: number): number {
  if (!Number.isFinite(v)) return DEBIT_DEFAUT;
  return Math.min(DEBIT_MAX, Math.max(DEBIT_MIN, Math.round(v)));
}

/**
 * L'ESPACE A-T-IL DES HEURES D'OUVERTURE RÉGLÉES ?
 *
 * 🔴 LA RÉPONSE CHANGE LE SENS DE LA CASE QU'ON VIENT DE COCHER, et c'est pour ça que l'écran doit la
 * dire au moment du clic. Sans aucun jour ouvert, `fenetreDeRattrapageOuverte`
 * (`src/lib/heures-ouvrees.ts`) rend TOUJOURS vrai : elle teste `withinBusinessHours`, puis, faute de
 * prochaine ouverture, traite l'espace comme ouvert en permanence. Refuser le rattrapage hors horaires
 * ne retient alors rien du tout. Vérifié dans le code, pas déduit du libellé.
 *
 * ⚠️ UN JOUR OUVERT SUFFIT. La structure vient du serveur (`TenantSettings.businessHours`, clés '0'..'6')
 * et un jour n'est réellement ouvert que si `closed` est faux ET que ses deux bornes sont renseignées :
 * `withinBusinessHours` refuse `close <= open`, donc une plage vide n'ouvre aucune fenêtre.
 */
export function heuresDOuvertureReglees(
  hours: Record<string, { closed: boolean; open: string; close: string }> | undefined | null,
): boolean {
  if (!hours) return false;
  return Object.values(hours).some((j) => j && !j.closed && !!j.open && !!j.close && j.close > j.open);
}

/**
 * LA QUESTION « QUE SE PASSE-T-IL QUAND LE CONTACT RÉPOND ? » A-T-ELLE LIEU D'ÊTRE ?
 *
 * 🔴 NON QUAND TOUT PART EN SCÉNARIO, ET C'EST UN RENVERSEMENT ASSUMÉ (2026-09-14, tranché par Julien) :
 * « si la personne choisit Modèle + scénario, il ne faut PAS faire apparaître la question, en effet la
 * logique qui répond, est-ce un agent IA ou un collab, est gérée dans le scénario ». Poser la question
 * deux fois, une fois ici et une fois dans le graphe, c'est offrir deux réglages du même événement dont
 * le second gagne toujours : l'opérateur croit avoir décidé ici, et c'est le scénario qui décide.
 *
 * ⚠️ CE FICHIER AFFIRMAIT L'INVERSE JUSQU'À CE JOUR (« il vaut pour les deux formules, un scénario finit
 * lui aussi »). L'argument n'était pas absurde, il était SANS OBJET : ce qui suit la fin d'un scénario se
 * règle dans le scénario, pas dans la campagne qui l'a ouvert.
 *
 * 🔴 UN SEUL ÉTAGE HORS SCÉNARIO SUFFIT À LA REPOSER, et la nuance n'est pas cosmétique : sur une chaîne
 * de repli dont l'étage 1 ouvre un parcours et l'étage 2 envoie un modèle seul, les contacts joints au
 * second étage répondent SANS qu'aucun scénario ne les prenne. Masquer la question les laisserait dans
 * un défaut que personne n'a choisi, ce qui est précisément le reproche fait à l'ancien comportement.
 *
 * ⚠️ ELLE NE REGARDE PAS SI LES ÉTAGES SONT REMPLIS : c'est `rangsSansContenu` qui répond à cela, et
 * l'écran combine les deux. Un étage vide n'est pas un scénario, il compte donc comme « hors scénario »,
 * ce qui est le bon défaut : tant qu'on ne sait pas, on ne retire pas la question.
 */
/**
 * LE DEVENIR PAR DÉFAUT D'UN ÉTAGE, selon ce que l'espace sait faire.
 *
 * 🔴 IL SUIT L'ESPACE, ET LE CONTRAIRE ÉTAIT UN DÉFAUT (relevé en revue le 2026-09-14).
 *
 * AVEC l'agent de Meta : `mba`, parce que c'est le comportement RÉEL sans réglage (il est le répondeur
 * primaire du numéro, donc ne rien faire revient à le laisser répondre). Un défaut `inbox` ferait prendre le
 * fil sur toute campagne dont personne n'a touché la question, ce qui changerait le produit en silence.
 *
 * SANS lui : `inbox`, sinon le défaut désigne une option que l'écran GRISE au même moment. Le client ne
 * pouvait pas en sortir sans y penser, et ses réponses n'allaient nulle part : ni robot pour répondre, ni
 * équipe à qui les confier. C'est le pire des trois états possibles.
 *
 * ⚠️ ELLE VIT ICI ET NON DANS LE CADRE D'ÉTAGE, pour être éprouvée : la suite unitaire du front est scopée
 * aux fonctions pures de `lib/`, par conception.
 */
export function devenirParDefaut(mbaEnabled: boolean): 'mba' | 'inbox' {
  return mbaEnabled ? 'mba' : 'inbox';
}

export function assignationProposable(
  chaine: EtageAssistant[],
  contenus: Record<number, ContenuMinimal | undefined>,
): boolean {
  return chaine.some((e) => {
    const c = contenus[e.rang];
    return c?.formule !== 'avec_scenario' && c?.devenir === 'inbox';
  });
}
