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
 * LA QUESTION DU RATTRAPAGE HORS HORAIRES EST-ELLE POSÉE ?
 *
 * 🔴 DÈS QU'IL Y A UN RATTRAPAGE POSSIBLE, ET SEULEMENT LÀ : un réessai coché, OU une chaîne. Sans l'un
 * ni l'autre, rien ne peut partir à une heure que personne n'a choisie, et poser la question ferait
 * croire à une garde sur un événement qui n'existe pas.
 *
 * ⚠️ LE « OU » N'EST PAS UN « ET », et l'erreur serait invisible : sur une chaîne, l'écran ne pose PAS la
 * question du réessai (le repli tient ce rôle), donc `reessayer` y garde sa valeur par défaut. Exiger les
 * deux ferait disparaître la question précisément sur le cas qui l'a fait naître, un repli qui tombe à
 * 18 h 02 sur une campagne partie à 17 h.
 */
export function rattrapagePossible(choix: { reessayer: boolean; chaine: EtageAssistant[] }): boolean {
  return choix.reessayer || aUnRepli(choix.chaine);
}

/** Les trois intentions de cadence de l'étape 2. */
export type Cadence = 'vite' | 'etale' | 'ouvrees';

/**
 * LE DÉBIT DE « ÉTALÉ SUR LA JOURNÉE », en messages par minute.
 *
 * 🔴 C'EST UN CHOIX, PAS UNE MESURE, et il vaut mieux l'écrire que de laisser croire à un calcul. Le
 * moteur ne connaît qu'un débit en messages/minute (`campaigns.rate_per_minute`), et l'étape du canal
 * ignore encore la taille de l'audience (elle est demandée à l'étape 4) : aucune valeur posée ICI ne peut
 * donc promettre une DURÉE. Ce qui a été vérifié, et qui justifie ce chiffre-ci :
 *
 *   1. 10/min tient une journée ouvrée de 8 h à 4 800 messages, soit au-dessus de la taille réaliste
 *      d'une campagne de ce produit. Sur cette plage, le libellé dit vrai.
 *   2. Il est SOUS LES DEUX PLAFONDS DE CANAL, lus dans `src/campaign/pacing.ts` et `src/config.ts` :
 *      80/min pour WhatsApp (`PHONE_RATE_PER_MINUTE_MAX`) et 60/min pour le RCS
 *      (`RCS_RATE_PER_MINUTE_MAX`). Un débit au-dessus de l'un des deux serait RAMENÉ en silence à
 *      l'envoi, donc l'intention choisie ne serait pas celle appliquée, et elle ne le serait pas de la
 *      même façon selon le canal.
 *   3. Il est visiblement plus lent que « au plus vite » (défaut serveur à 60/min) : un sixième. Deux
 *      intentions dont l'effet se ressemble ne valent pas deux boutons.
 *
 * ⚠️ LE MEILLEUR RÉGLAGE N'EST PAS CELUI-CI, et il appartient à l'étape 5 : une fois l'audience connue,
 * le débit d'un étalement se CALCULE (N contacts / minutes de la journée). Tant que le récapitulatif
 * n'existe pas, une constante honnête vaut mieux qu'un calcul impossible.
 */
export const DEBIT_ETALE_PAR_MINUTE = 10;

/**
 * CE QU'UNE INTENTION DE CADENCE ÉCRIT SUR LA CAMPAGNE.
 *
 * 🔴 DEUX COLONNES, PAS UNE, et c'est ce qui rend cette traduction nécessaire. « Au plus vite » et
 * « étalé » se jouent sur le DÉBIT (`rate_per_minute`), « heures ouvrées seulement » sur un DRAPEAU
 * (`business_hours_only`, migration 0122) qui ne parle pas de vitesse du tout. Les trois sont pourtant
 * une seule question pour l'opérateur, « à quel rythme veux-tu que ça parte », et c'est la bonne
 * question : il ne peut pas choisir un nombre de messages par minute, il n'a aucun moyen de connaître
 * les plafonds des opérateurs.
 *
 * ⚠️ `ratePerMinute: null` VEUT DIRE « le défaut du serveur », JAMAIS « aucun frein ». C'est
 * `resolveRatePerMinute` qui tranche (`src/campaign/pacing.ts`) : à défaut de valeur sur la campagne, il
 * prend `CAMPAIGN_DEFAULT_RATE_PER_MINUTE`. Poser un gros nombre pour dire « vite » serait à la fois
 * faux (le plafond du canal le ramènerait) et fragile (il faudrait le corriger à chaque changement de
 * plafond, dans un écran, sans déploiement du serveur).
 */
export function reglagesDeCadence(cadence: Cadence): { ratePerMinute: number | null; businessHoursOnly: boolean } {
  if (cadence === 'etale') return { ratePerMinute: DEBIT_ETALE_PAR_MINUTE, businessHoursOnly: false };
  if (cadence === 'ouvrees') return { ratePerMinute: null, businessHoursOnly: true };
  return { ratePerMinute: null, businessHoursOnly: false };
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
