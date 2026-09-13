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
