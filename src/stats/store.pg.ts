import type { Pool } from 'pg';
import { STATS_TZ, BOUNDS_CTE } from './range';
import type { DateRange } from './range';
// Type SEUL : `cost.ts` importe deja des types d'ici, et un import de VALEUR dans l'autre sens ferait un
// cycle a l'execution. Le calcul du cout vit dans le cablage (`src/index.ts`), comme pour la serie.
import type { VolumeCampagneRow } from './cost';
// Valeur SEULE, pas un type : le plafond doit etre le meme des deux cotes (le SQL en garde une de plus, la
// fonction pure tranche et l'annonce). Deux nombres ecrits separement divergeraient au premier reglage.
import { PLAFOND_CAMPAGNES_SYNTHESE } from './cost';
import { ORIGINE_EFFECTIVE_SQL, THEME_DE_ORIGINE, DETAIL_IA } from '../inbox/origine';
import { RECIPIENT_FAILED_SQL, INSTANT_ECHEC_SQL } from '../campaign/echecs-sql';
import type { NodeEventCount } from '../workflow/node-events.pg';
import type { EnvoisCampagneRow } from './cout-campagne';
import type { CanalEtage } from '../campaign/etages';

export interface DailyPoint {
  date: string; // 'YYYY-MM-DD' (Europe/Paris)
  count: number;
}

/**
 * Funnel d'UNE campagne : envoyés -> délivrés -> lus -> répondus (message entrant après l'envoi), + échecs.
 *
 * 🔴 IL PORTE DEUX GRAINS DEPUIS LA MIGRATION 0134, ET LES CONFONDRE DONNE DES CHIFFRES FAUX. Tous les
 * compteurs ci-dessous, plus `contactsVises`, comptent des PERSONNES (une ligne par contact dans
 * `campaign_recipients`). `parCanal` compte des TENTATIVES (une ligne par envoi tenté dans
 * `campaign_envois`). Sa somme DÉPASSE légitimement `contactsVises` dès qu'une chaîne de repli a fait
 * deux tentatives pour joindre la même personne : ce n'est pas une incohérence, c'est la réponse à une
 * autre question, et l'écran doit dire laquelle il pose.
 */
export interface CampaignFunnel {
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
  /**
   * Envois partis dont Meta n'a JAMAIS rendu d'accusé : `delivered` et `read` ne les comptent pas, et ce
   * n'est pas la même chose que « ils n'ont pas été délivrés ».
   *
   * 🔴 ET C'EST SYSTÉMATIQUE POUR UNE CAMPAGNE À SCÉNARIO, PAS UN ALÉA. Mesuré le 2026-09-11 sur la base :
   * 29 envois de scénario, 29 sans accusé, soit 100 % ; contre 18 sur 21 AVEC accusé côté template. La
   * raison est écrite dans `campaign/engine.ts` : la branche scénario enregistre un identifiant de message
   * SYNTHÉTIQUE (`wf-…`, le même pour tous les destinataires), quand l'accusé de Meta porte le vrai
   * `wamid`. `updateDeliveryByMessageId` ne peut donc jamais apparier les deux.
   *
   * ⚠️ SANS CE COMPTE, L'ÉCRAN AFFICHE UN ZÉRO LÀ OÙ IL N'Y A PAS DE MESURE, et on le lit comme un fait.
   * Signalé par Julien le 2026-09-11 : « 3 envoyés, 0 délivrés, 0 lus et pourtant 3 répondus, erreur
   * manifeste non ? ». Chaque nombre était juste ; c'est leur mise côte à côte qui mentait.
   */
  sansAccuse: number;
  /**
   * Taps sur un bouton de RÉPONSE RAPIDE du template, attribués comme `replied` (dont ils sont un
   * sous-ensemble : un tap de bouton EST un message entrant).
   */
  buttonReplies: number;
  /**
   * Clics sur les liens TRACÉS du template de la campagne, depuis son premier envoi.
   *
   * `null` = ce template ne porte aucun bouton URL tracé et confirmé : l'étape n'est pas affichable, et une
   * barre à zéro se lirait « personne n'a cliqué » au lieu de « il n'y a rien à cliquer ».
   *
   * ⚠️ C'est un compteur de TEMPLATE, pas de campagne : un lien ne sait pas quel envoi l'a porté. Le seuil au
   * premier envoi écarte l'exploration de Meta (qui clique chaque bouton URL pendant la revue, donc AVANT le
   * premier envoi), mais deux campagnes sur le même template partagent leurs clics. L'écran doit le dire.
   */
  urlClicks: number | null;
  /**
   * COMBIEN D'HUMAINS CETTE CAMPAGNE A VISÉS, quel que soit le nombre de tentatives faites pour les
   * joindre.
   *
   * 🔴 C'EST LA LIGNE DE TÊTE, ET ELLE NE SE DÉDUIT PAS DE `parCanal`. Additionner les envois des canaux
   * donnerait le nombre de TENTATIVES : une personne jointe au second étage après un échec au premier y
   * compterait pour deux. Le grain est garanti par `unique (campaign_id, contact_id)` sur
   * `campaign_recipients`, qui est aussi le dédoublonnage du produit.
   */
  contactsVises: number;
  /**
   * LA VENTILATION PAR CANAL, lue sur le journal des tentatives (`campaign_envois`, migration 0134).
   *
   * ⚠️ ELLE PEUT ÊTRE VIDE ALORS QUE LA CAMPAGNE A ENVOYÉ, et il faut le savoir pour ne pas lire ce vide
   * comme un zéro : le journal ne contient que les tentatives postérieures à sa mise en service. Toute
   * campagne lancée avant n'a aucune ligne ici, pendant que les compteurs du dessus, eux, sont complets.
   * L'écran doit taire la ventilation dans ce cas plutôt que d'annoncer « aucun envoi ».
   *
   * Une ligne par canal RÉELLEMENT emprunté, dans l'ordre des étages de la chaîne.
   */
  parCanal: FunnelCanal[];
}

/** Les compteurs d'UN canal d'une campagne, au grain TENTATIVE (une personne peut en avoir plusieurs). */
export interface FunnelCanal {
  canal: CanalEtage;
  /** Toutes les tentatives de ce canal, quel qu'en soit le verdict (parties, échouées, écartées). */
  envois: number;
  /** Celles qui sont VRAIMENT parties : même définition que `sent` du funnel global. */
  reussis: number;
  delivres: number;
  lus: number;
  repondus: number;
  /**
   * Tentatives parties dont Meta n'a rendu AUCUN accusé, POUR CE CANAL.
   *
   * 🔴 LA DISTINCTION « ZÉRO » CONTRE « ON NE SAIT PAS » S'APPLIQUE PAR CANAL, SINON ELLE NE VEUT PLUS
   * RIEN DIRE. Un canal parfaitement mesuré et un canal sans aucun accusé se retrouveraient derrière un
   * seul verdict global : soit on efface les chiffres justes du premier, soit on affiche un « 0 délivré »
   * crédible pour le second. C'est la mise côte à côte qui ment, exactement comme le 2026-09-11.
   */
  sansAccuse: number;
}

/** Une ligne du breakdown d'erreurs : code Meta numérique + template + occurrences sur la plage. */
export interface ErrorBreakdownRow {
  code: number;
  count: number;
  /** Template de la campagne à l'origine des erreurs (null si non renseigné). */
  templateName: string | null;
  /**
   * La campagne d'où viennent ces erreurs. Elle n'est JAMAIS nulle : la seule population capable de porter
   * une erreur est `campaign_recipients`, jointe à sa campagne (voir le docblock de `getErrorBreakdown`).
   *
   * ⚠️ Ces deux champs rendent la ligne PLUS FINE qu'avant : une par (code, template, campagne) au lieu
   * d'une par (code, template). L'écran agrège déjà par code, donc l'affichage sans filtre est inchangé ;
   * ce qui change, c'est qu'il peut désormais filtrer par campagne sans redemander au serveur.
   */
  campaignId: string;
  campaignName: string;
}


/** Volume d'envois de campagne par (jour, catégorie) — base du graphe de coût estimé. */
export interface CostVolumeRow {
  date: string; // 'YYYY-MM-DD' (Europe/Paris)
  /**
   * 'marketing' | 'utility' | **null**. Le null est arrivé avec la branche « hors campagne » : un envoi de
   * scénario historique n'a pas de catégorie (`logTemplateSent` ne l'écrivait pas avant le 2026-09-07), et
   * `estimateCostSeries` l'ignore alors. Le type le DIT désormais, au lieu de laisser un null atterrir dans
   * un champ déclaré `string` : c'est précisément la valeur que l'écran doit rendre visible.
   */
  category: string | null;
  count: number;
}

/**
 * Le filtre commun des écrans d'Analytics : DES campagnes OU DES templates. Plusieurs valeurs -> un résultat
 * COMPILÉ sur l'ensemble (les volumes s'additionnent jour par jour), pas la première valeur de la liste.
 *
 * Les deux axes restent MUTUELLEMENT EXCLUSIFS côté écran : combiner « campagne A » et « template B » ne
 * décrirait pas une union mais leur intersection, qui ne veut rien dire pour un opérateur. Une liste vide
 * équivaut à « tout », comme l'absence de filtre.
 *
 * ⚠️ Les deux axes ne désignent pas exactement la même population selon l'écran : côté coût, l'axe template
 * ramène AUSSI les envois hors campagne, alors qu'aucune erreur ne peut exister hors campagne. Le filtre est
 * le même, ce qu'il filtre ne l'est pas.
 */
export interface FiltreCampagneOuTemplate {
  campaignIds?: string[];
  templateNames?: string[];
}
/**
 * Le filtre du graphe de coût. ALIAS et non copie : la liste des contacts touchés filtre sur les deux mêmes
 * axes, et deux interfaces jumelles auraient divergé au premier axe ajouté. Le nom historique reste, il est
 * importé par le câblage et par les routes.
 */
export type CostFilter = FiltreCampagneOuTemplate;

export interface DashboardStats {
  /** CUMULATIF : total de contacts à chaque jour (dense, une valeur/jour, reporte les jours sans ajout). */
  contacts: DailyPoint[];
  /**
   * Les contacts ENCORE dans le mini-CRM ce jour-là (arbitrage de Julien du 2026-09-23).
   *
   * ⚠️ DEUX QUESTIONS DIFFERENTES, PAS DEUX VERSIONS DE LA MEME. Les cumulés disent ce qu'on a collecté,
   * les actifs ce qu'on a encore : une base qu'on nettoie voit les deux courbes diverger, et c'est
   * précisément l'écart qui est l'information. Rendre les deux d'un coup permet la bascule sans réseau.
   */
  contactsActifs: DailyPoint[];
  templates: { utility: DailyPoint[]; marketing: DailyPoint[] };
  exchanged: DailyPoint[];
  /**
   * Messages de SERVICE : les SORTANTS qui ne sont pas des templates (réponse d'un agent depuis l'inbox,
   * message d'un scénario dans la fenêtre de 24 h). Affichés à côté des templates, parce que c'est là qu'on
   * lit ce qui est parti. Ils n'entrent PAS dans le coût estimé : Meta ne les facture pas au message, et
   * leur inventer un prix reviendrait à mentir sur la facture.
   *
   * Sous-ensemble de `exchanged`, qui compte aussi les ENTRANTS : deux lectures différentes, même requête.
   */
  service: DailyPoint[];
  /**
   * Les mêmes messages de service, ventilés par ce qui les a ÉCRITS (migration 0099).
   *
   * Trois thèmes demandés par Julien : l'IA (notre agent et celui de Meta), le scripté (un scénario), et
   * l'humain (un opérateur depuis l'inbox). Un quatrième, `indeterminee`, n'existe que pour rendre visible
   * un chemin d'écriture qui aurait oublié de poser son origine : il vaut zéro tant que tout est en règle,
   * et le montrer est le seul moyen de ne pas classer un tel message en silence dans un thème qui l'accueille.
   *
   * 🔴 Le total de cette ventilation ÉGALE la somme de `service` sur la période. C'est ce qui la rend
   * lisible à côté de la courbe : un écart voudrait dire qu'un message échappe au classement.
   */
  serviceParOrigine: { ia: number; scenario: number; humain: number; indeterminee: number };
  /**
   * LE DETAIL SOUS « IA » : laquelle des trois (demande de Julien, 2026-09-15).
   *
   * 🔴 L'INFORMATION EXISTAIT DEJA EN BASE, elle etait ecrasee a l'affichage. La colonne `origin` distingue
   * `ia` (notre agent), `mba` (l'agent de Meta) et `mcp` (un agent tiers branche par MCP) depuis la
   * migration 0099 ; `THEME_DE_ORIGINE` les versait toutes dans un theme unique parce que trois lignes
   * avaient ete demandees et pas six. Aucune migration, aucune reprise : c'est le meme historique, lu plus
   * finement.
   *
   * 🔴 `agent + mba + mcp` EGALE `serviceParOrigine.ia`, ET C'EST UN INVARIANT TENU PAR UN TEST. Les deux
   * sont derives de la MEME boucle, sur les memes lignes : les calculer separement en ferait deux verites
   * qui deriveraient au premier chemin d'ecriture ajoute, et un detail qui ne retombe pas sur son total est
   * pire qu'aucun detail.
   *
   * ⚠️ LA SEPARATION N'EST EXACTE QUE DEPUIS `BASCULE_ORIGINE` (2026-09-01). Avant, la colonne n'etait
   * remplie par personne et la derivation range tout en `scenario`, ce qui a ete MESURE et non supposé :
   * aucun tour d'agent n'avait jamais tourné. Ces trois compteurs valent donc zero sur l'historique ancien,
   * et c'est juste.
   */
  serviceIaDetail: { agent: number; mba: number; mcp: number };
}

/**
 * 🔴 LES ENVOIS DE TEMPLATE FACTURABLES DE LA PÉRIODE, EN UN SEUL ENDROIT.
 *
 * Ce fragment existe parce que deux requêtes décrivaient la même chose et comptaient deux populations
 * DIFFÉRENTES. `getTemplateBreakdown` portait l'union vers `conversation_messages`, `getCostVolume` non :
 * un template envoyé par un nœud de scénario (ou depuis l'inbox) était donc compté dans le tableau
 * « Détail par template » et INVISIBLE du graphe « Coût estimé ». Mesuré le 2026-09-07 en production sur
 * `actu_cin_ma_2` : 0 côté coût, 7 côté détail, et sept autres templates dans le même cas. Le client
 * filtrait sur un template réellement envoyé et obtenait un graphe vide.
 *
 * Même doctrine que `RECIPIENT_FAILED_SQL` (`src/campaign/echecs-sql.ts`) : un fragment SQL partagé, jamais
 * deux copies, parce que deux copies divergent à la première correction.
 *
 * Rend une ligne PAR ENVOI, avec de quoi agréger des deux façons dont on a besoin :
 *  - `sent_at` pour le découpage par jour (le coût), sans découpage pour le volume (le détail) ;
 *  - `campaign_id` : celui de la campagne pour un envoi de campagne, celui de la campagne SCÉNARIO qui a
 *    démarré le parcours pour un envoi de scénario (attribution à la lecture, voir la sous-requête), et
 *    `null` seulement si ce contact n'a JAMAIS été destinataire d'une campagne scénario.
 *    🔴 **Portée réelle, à connaître avant de lire le chiffre** : l'attribution remonte au dernier
 *    destinataire réclamé, SANS borne basse. Dès qu'un contact a reçu une campagne scénario, tous ses
 *    envois de scénario ultérieurs lui sont attribués, quel que soit ce qui les a déclenchés (mot-clé,
 *    webhook, lien de chaîne). C'est le compromis assumé de l'attribution à la lecture, choisie le
 *    2026-09-07 pour ne pas traverser le chemin qui reçoit les messages clients. Le seul moyen de faire
 *    mieux est d'écrire l'attribution à l'envoi.
 *    🔴 C'est ce `null` qui gouverne le filtre par campagne : `campaign_id = any($5)` vaut alors `NULL`, donc PAS `TRUE`, donc la ligne sort du `where`.
 *    ⚠️ Écrire « c'est faux » serait une justification fausse, et elle s'inverserait sous une négation
 *    (`not (...)`, `is distinct from`), où `NULL` ne se comporte pas comme `false`. Filtrer sur une
 *    campagne exclut donc les envois hors campagne, filtrer sur un template les inclut ; les deux sont
 *    voulus et tenus par un test.
 *
 * ⚠️ S'utilise UNIQUEMENT dans une requête qui déclare `${BOUNDS_CTE}` et passe `$1` = tenantId.
 *
 * 🔴 LES DEUX BRANCHES NE TRAITENT PAS L'ÉCHEC DE LA MÊME FAÇON, et le nier serait une justification
 * fausse. Un message jamais PARTI n'a de ligne dans aucune des deux. Mais un échec de LIVRAISON n'est
 * suivi que côté campagne (`delivery_status`), la branche 2 n'en a aucune notion : un template de scénario
 * refusé après coup y reste compté. C'est une asymétrie réelle du modèle, pas un oubli de ce fragment.
 */
/**
 * 🔴 L ATTRIBUTION EST OPTIONNELLE, ET CE N EST PAS UN CONFORT. Cette sous-requete est CORRELEE : elle
 * s execute une fois PAR LIGNE de la branche 2, et son predicat
 * `cv.wa_id = regexp_replace(r3.to_e164, ...)` n est servi par AUCUN index (la migration 0096 a
 * explicitement refuse un index sur `campaign_recipients(to_e164, sent_at)`). Or `getTemplateBreakdown`
 * groupe sur `name, category` : il paierait ce balayage pour une colonne qu il JETTE, a chaque affichage
 * du tableau de bord. Le fragment reste UNIQUE, seule l attribution se branche.
 */
const ATTRIBUTION_CAMPAGNE_SCENARIO = `(
           -- 🔴 ATTRIBUTION A LA LECTURE, decidee par Julien le 2026-09-07. Un envoi de template fait DANS
           -- un scenario n'ecrit nulle part la campagne qui l'a declenche : le parcours n'est enregistre
           -- qu'APRES son premier envoi ("src/workflow/executor.ts", "apply" puis "runs.start"), donc au
           -- moment d'ecrire ce message il n'existe encore rien a interroger. On le rattache donc ici.
           --
           -- MEME DOCTRINE que le « repondu » du funnel ("entrantAttribue" plus bas) : meme numero,
           -- posterieur, et le PLUS RECENT avant lui, ce qui exprime « aucun autre depart intercale ».
           -- La normalisation du numero est celle du depot ("regexp_replace"), pas une variante.
           --
           -- 🔴 "c3.workflow_id is not null" est le discriminant qui rend l'heuristique tenable : seule une
           -- campagne de type SCENARIO peut avoir engendre un envoi de scenario. Une campagne a template
           -- DIRECT envoie elle-meme, et son envoi est deja compte par la branche du dessus ; l'autoriser
           -- ici lui attribuerait en plus les envois d'un scenario declenche par tout autre chose.
           --
           -- ⚠️ CE QUE CETTE ATTRIBUTION NE SAIT PAS FAIRE, et il faut le savoir en lisant le chiffre :
           -- deux campagnes scenario visant le MEME contact a peu d'intervalle peuvent se voler un envoi.
           -- Acceptable ici (c'est deja le compromis retenu pour le funnel), et le seul moyen de faire
           -- mieux serait d'ecrire l'attribution a l'envoi, ce qui traverse le chemin chaud.
           select r3.campaign_id
           from campaign_recipients r3 join campaigns c3 on c3.id = r3.campaign_id
           where c3.tenant_id = cv.tenant_id
             and c3.workflow_id is not null
             and r3.sent_at is not null
             -- 🔴 ON SE CALE SUR "claimed_at", ET C EST UNE BORNE STRUCTURELLE, PAS UNE CONSTANTE.
             -- "sent_at" ne convient pas : le moteur journalise le message dans le fil AVANT de marquer
             -- le destinataire envoye. Mesure sur la campagne reelle « Formation du 3 » du 2026-09-03,
             -- les quatre messages precedent leur ligne de campagne de 55 a 90 ms. Un predicat
             -- "r3.sent_at <= m.created_at" excluait donc EXACTEMENT les envois a rattacher, 1 sur 4.
             --
             -- ⚠️ Une premiere version compensait par une tolerance de 5 secondes. C etait un nombre
             -- choisi, pas mesure : l ecart entre l ecriture du message et "sent_at" contient tout le
             -- reste de la chaine synchrone du scenario, qu aucune borne ne limite. Et une fenetre qui
             -- deborde vers le futur laisse une campagne partie APRES le message le voler.
             --
             -- "claimed_at" est pose par "PgCampaignStore.claim" a la transition pending -> sending,
             -- donc AVANT que le moteur ne demarre le parcours, et "markResult" ne l efface pas. Tout
             -- message ecrit par ce parcours lui est posterieur, y compris ceux des etapes suivantes.
             -- "coalesce" parce que la colonne n existe que depuis la migration 0008.
             and coalesce(r3.claimed_at, r3.sent_at) <= m.created_at
             and cv.wa_id = regexp_replace(r3.to_e164, '[^0-9]', '', 'g')
           order by coalesce(r3.claimed_at, r3.sent_at) desc
           limit 1
         )`;

/** Sans attribution : la colonne existe pour aligner les deux branches du `union all`, et vaut null. */
const SANS_ATTRIBUTION = 'null::uuid';

const envoisTemplateFacturables = (attribution: string): string => `
  select r.sent_at as sent_at, c.template_name as name, c.category as category, c.id as campaign_id
  from campaign_recipients r join campaigns c on c.id = r.campaign_id, bounds b
  where c.tenant_id = $1 and nullif(c.template_name, '') is not null and r.status = 'sent'
    and c.channel = 'whatsapp'
    and r.sent_at >= b.start_ts and r.sent_at < b.end_ts
    and (r.delivery_status is null or r.delivery_status <> 'failed')
  union all
  select m.created_at as sent_at, m.template_name as name, m.template_category as category,
         ${attribution} as campaign_id
  from conversation_messages m join conversations cv on cv.id = m.conversation_id, bounds b
  where cv.tenant_id = $1 and not cv.is_test and m.direction = 'out' and m.type = 'template'
    and m.template_name is not null and m.created_at >= b.start_ts and m.created_at < b.end_ts
    -- Anti double-compte : template de campagne directe déjà compté par la branche du dessus (même wamid).
    and not exists (
      select 1 from campaign_recipients r2 join campaigns c2 on c2.id = r2.campaign_id
      where c2.tenant_id = cv.tenant_id and r2.message_id = m.meta_message_id
    )`;

/** Un template envoyé sur la période, avec son volume (pour le dropdown + le prix estimé). */
export interface TemplateBreakdownRow {
  name: string;
  category: string | null; // 'marketing' | 'utility' | null (envoi inbox sans catégorie)
  count: number;
}

const TZ = STATS_TZ;

/**
 * LA FENETRE D ATTRIBUTION D UNE CAMPAGNE : sept jours apres l envoi recu par le contact.
 *
 * 🔴 UNE SEULE ECRITURE, PARCE QU IL Y EN AVAIT TROIS. Elle borne ce qui est attribue a une campagne :
 * les clics ET les reponses, qui sont les deux moities d `engagementsParCampagne`, et les messages de
 * service (`servicesParCampagne`). ⚠️ Ne pas la chercher dans `clicsParCampagne`, qui est une AUTRE lecture
 * et n a aucune fenetre de sept jours : elle compte depuis le premier envoi, sans borne haute.
 * Le cadrage dit « la fenetre de 7 jours n est pas un nombre choisi ici : c est celle
 * d `engagementsParCampagne`, reprise telle quelle », parce que numerateur et denominateur du cout par
 * engagement doivent parler de la MEME population sur la MEME fenetre. Trois litteraux `interval '7 days'`
 * recopies ne garantissaient rien de tel : le jour ou l un bouge, le ratio rapporte deux ensembles de gens
 * differents, et rien a l ecran ne le signale. Releve en revue finale le 2026-09-18.
 *
 * ⚠️ C EST UN FRAGMENT SQL, pas un nombre : il s interpole dans une requete. Le pendant cote TypeScript
 * existe deja pour la bascule RCS (`FENETRE_BASCULE_MS`), qui est une AUTRE fenetre, de meme duree mais
 * d une autre nature (une reaction qui fait basculer un tarif). Les aligner par accident serait une erreur.
 */
export const FENETRE_IMPUTATION = "interval '7 days'";

/** Séries « 1 point par jour » pour le dashboard. Buckets jour en tz Europe/Paris.
 *  Plage `range` (from..to INCLUS, Europe/Paris) : bornes SQL calculées via bounds CTE (DST-safe),
 *  borne haute EXCLUSIVE = minuit Paris de (to+1). Params partout : [tenantId, from, to, TZ]. */
/**
 * « AUCUN DÉPART INTERCALÉ », lu sur les LIGNES DE DESTINATAIRE (`campaign_recipients`).
 *
 * C'est la garde d'origine, et elle porte tout l'historique : une ligne par contact et par campagne,
 * depuis toujours.
 *
 * 🔴 `exclure` EST OBLIGATOIRE DÈS QUE L'ANCRAGE N'EST PAS `r.sent_at` LUI-MÊME, et l'oublier est
 * exactement le défaut qui a rendu la CI rouge le 2026-09-12. Ancrée sur sa propre colonne, la ligne du
 * destinataire ne peut pas être « postérieure à elle-même » : elle s'auto-exclut, gratuitement. Ancrée sur
 * `e.sent_at`, qui est une colonne DIFFÉRENTE, elle se compare à un instant voisin de quelques
 * millisecondes, et le verdict se met à dépendre du SIGNE de cet écart. Mesuré dans le code : `markResult`
 * est le seul écrivain de `campaign_recipients.sent_at` et y pose l'horloge JS du moteur, tandis que la
 * ligne de journal prend le `now()` de Postgres à l'INSERT qui suit. Deux horloges, deux instants, aucun
 * ordre garanti. Une attribution qui dépend de cela n'est pas une attribution.
 */
const aucunDepartDestinataire = (instant: string, numero: string, exclure?: string): string => `not exists (
               select 1 from campaign_recipients r2 join campaigns c2 on c2.id = r2.campaign_id
               where c2.tenant_id = c.tenant_id
                 and r2.to_e164 = ${numero}${exclure ? `
                 and r2.id <> ${exclure}` : ''}
                 and r2.sent_at is not null
                 and r2.sent_at > ${instant}
                 and r2.sent_at < m.created_at
             )`;

/**
 * « AUCUN DÉPART INTERCALÉ », lu sur le JOURNAL DES TENTATIVES (`campaign_envois`, migration 0134).
 *
 * 🔴 ELLE NE REMPLACE PAS LA PRÉCÉDENTE, ELLE LA COMPLÈTE, et il faut les deux parce qu'aucune des deux
 * ne connaît tous les départs. `campaign_recipients` n'a qu'UNE ligne par contact : elle ne sait pas dire
 * qu'un même destinataire est reparti deux fois, ce qui est précisément ce que le grain « tentative »
 * apporte. Sans cette garde-ci, un destinataire relancé (`resetForRetry`, l'auto-relance existe
 * aujourd'hui et n'attend aucune chaîne) a DEUX tentatives parties sur le même canal, et la même réponse
 * serait comptée sur les deux : `repondus` vaudrait 2 pour une seule personne qui a écrit une fois.
 *
 * ⚠️ `statut = 'sent'` : seule une tentative RÉELLEMENT PARTIE peut voler une réponse. Une tentative
 * échouée ou écartée n'a rien envoyé, donc n'a rien pu provoquer et ne s'intercale pas.
 *
 * ⚠️ CE QU'ELLE NE SAIT PAS FAIRE, et il vaut mieux le savoir que le découvrir : l'écriture du journal est
 * BEST-EFFORT côté moteur. Une tentative dont la ligne de journal n'a pas pu s'écrire est un départ
 * invisible ici. C'est aussi pourquoi la garde du dessus est conservée : elle, verra quand même la ligne
 * du destinataire, et les deux ensemble gardent l'invariant qui compte, `somme(repondus) <= replied`.
 */
const aucunDepartJournalise = (instant: string, numero: string): string => `not exists (
               select 1 from campaign_envois e2
                 join campaign_recipients r3 on r3.id = e2.recipient_id
                 join campaigns c3 on c3.id = e2.campaign_id
               where c3.tenant_id = c.tenant_id
                 and r3.to_e164 = ${numero}
                 and e2.statut = 'sent'
                 and e2.sent_at > ${instant}
                 and e2.sent_at < m.created_at
             )`;

/**
 * Un message ENTRANT attribué à CET envoi : même numéro, après l'envoi, sur un canal par lequel cet envoi
 * est réellement passé, et aucun envoi ultérieur au même numéro entre les deux (sinon la réponse revient au
 * dernier envoi, pas à celui-ci). C'est ce qui empêche une même réponse d'être comptée sur deux campagnes.
 *
 * Sorti en fragment parce que le funnel s'en sert DEUX fois, pour « répondu » et pour « a tapé un bouton ».
 * Deux copies divergeraient à la première correction de l'attribution. Même doctrine que
 * `RECIPIENT_FAILED_SQL` (`src/campaign/echecs-sql.ts`).
 *
 * ⚠️ CE COMMENTAIRE ÉTAIT ORPHELIN : il décrivait ce fragment depuis une position située au-dessus d'une
 * AUTRE fonction, où le lecteur le rapportait au mauvais code. Il est revenu sur ce qu'il justifie.
 *
 * ⚠️ S'utilise UNIQUEMENT dans une requête où `c` est `campaigns` et `r` est `campaign_recipients`.
 * `extra` restreint la nature du message entrant (ex. `and m.type = 'button'`).
 *
 * 🔴 `predicatCanal` EST UN PRÉDICAT, PAS UNE COLONNE, et c'est ce qui a changé le 2026-09-12. Le principe
 * ne bouge pas : l'entrant doit venir d'un tuyau par lequel CETTE campagne a écrit à CE contact. Sans cette
 * garde, un contact qui ignorait le template mais tapait une suggestion RCS reçue par ailleurs était compté
 * « a répondu » ET « a tapé un bouton » de la campagne WhatsApp (une suggestion RCS est enregistrée avec
 * `type='button'`), et l'opérateur jugeait son template sur le taux de clic d'un autre canal. Ce qui bouge,
 * c'est que « le tuyau de la campagne » n'est plus une colonne unique dès qu'une chaîne de repli existe.
 */
const entrantAttribueDepuis = (
  envoi: { instant: string; numero: string; predicatCanal: string },
  extra: string,
  gardes: string[],
): string => `${envoi.instant} is not null and exists (
           select 1 from conversations cv
             join conversation_messages m on m.conversation_id = cv.id
           where cv.tenant_id = c.tenant_id and not cv.is_test
             and cv.wa_id = regexp_replace(${envoi.numero}, '[^0-9]', '', 'g')
             and m.direction = 'in'
             and (${envoi.predicatCanal})
             and m.created_at > ${envoi.instant} ${extra}
             and ${gardes.join('\n             and ')}
         )`;

/**
 * LE CANAL, VU DU FUNNEL GLOBAL : celui que la campagne DÉCLARE, ou n'importe lequel de ceux par lesquels
 * elle a réellement écrit à CE destinataire.
 *
 * 🔴 C'EST LA DETTE DU LOT 3, ET ELLE FAISAIT SE CONTREDIRE DEUX CHIFFRES DU MÊME ÉCRAN. `c.channel` cesse
 * d'être la vérité du canal dès qu'une chaîne existe : la réponse arrive en RCS, la campagne se déclare
 * WhatsApp, le funnel PAR CANAL la compte (il est ancré sur la tentative) et le funnel GLOBAL ne la voit
 * pas. Mesuré en intégration : `somme(parCanal.repondus)` valait 1 et `replied` valait 0.
 *
 * 🔴 ÉLARGIR, JAMAIS REMPLACER, et la nuance vaut tous les chiffres déjà affichés. Le premier terme est
 * celui d'avant, mot pour mot : aucune campagne existante ne voit son `replied` bouger. Le second n'ajoute
 * que des canaux sur lesquels une tentative est RÉELLEMENT PARTIE vers CE destinataire (`statut = 'sent'`,
 * `recipient_id = r.id`) ; sur une campagne sans chaîne, ces lignes portent justement `c.channel`, donc il
 * n'ajoute rien du tout. Retirer la garde de canal au lieu de l'élargir aurait rendu au contraire toute
 * réponse d'un autre tuyau, ce que la ligne du dessus existe pour empêcher.
 *
 * ⚠️ SON INDEX EXISTE DÉJÀ, et c'est pour ça que l'ordre des clauses est celui-ci : `campaign_id` puis
 * `canal` sont les deux colonnes de `campaign_envois_campagne_idx` (migration 0134), dans cet ordre. Le
 * filtre par destinataire et par statut se paie ensuite sur les quelques lignes retenues. Une clause
 * ancrée d'abord sur `recipient_id`, elle, n'a aucun index : la table n'en porte pas sur cette colonne.
 */
const CANAL_DECLARE_OU_TENTE = `m.channel = c.channel or exists (
               select 1 from campaign_envois e4
               where e4.campaign_id = c.id
                 and e4.canal = m.channel
                 and e4.recipient_id = r.id
                 and e4.statut = 'sent'
             )`;

/**
 * L'attribution ancrée sur le DESTINATAIRE (`r`), celle du funnel GLOBAL.
 *
 * ⚠️ UNE SEULE GARDE D'INTERCALATION, sans exclusion, parce que l'ancrage EST la colonne comparée et que la
 * ligne s'auto-exclut donc toute seule. C'est la garde qui est inchangée ; le CANAL, lui, a été élargi le
 * 2026-09-12 (cf. `CANAL_DECLARE_OU_TENTE`), et ce commentaire a affirmé « INCHANGÉE » tout court, ce qui
 * se lisait comme une interdiction d'y toucher. La règle exacte est : ne pas ajouter de garde ici (elle
 * déplacerait les chiffres de toutes les campagnes), et élargir le canal seulement par ÉLARGISSEMENT,
 * c'est-à-dire sans jamais retirer le terme d'origine.
 */
export const entrantAttribue = (extra = ''): string =>
  entrantAttribueDepuis({ instant: 'r.sent_at', numero: 'r.to_e164', predicatCanal: CANAL_DECLARE_OU_TENTE }, extra, [
    aucunDepartDestinataire('r.sent_at', 'r.to_e164'),
  ]);

/**
 * L'attribution ancrée sur UNE TENTATIVE du journal (`e`, `campaign_envois`, migration 0134).
 *
 * 🔴 MÊME DOCTRINE, PAS UNE SECONDE. Le fragment est le même à l'ancrage près, et c'est délibéré : deux
 * heuristiques d'attribution voisines donneraient deux vérités sur le MÊME écran, celui où l'on clique
 * sur une campagne pour voir sa ventilation par canal. Ce qui change est l'instant de référence (celui de
 * la tentative, pas celui du destinataire) et le canal (celui de la tentative, pas celui de la campagne),
 * puisque c'est précisément ce que le grain « une ligne par tentative » permet de distinguer.
 *
 * 🔴 DEUX GARDES, ET LA PREMIÈRE VERSION N'EN AVAIT QU'UNE : C'EST CE QUI A RENDU LA CI ROUGE. Elle
 * affirmait que « l'exclusion reste sur `campaign_recipients`, et c'est nécessaire », au motif que le
 * journal ne porte pas l'historique d'avant sa mise en service. Ce motif était doublement faux, et il
 * vaut mieux écrire pourquoi que le corriger en silence :
 *   1. il ne protégeait rien, puisque seul un départ POSTÉRIEUR à une tentative journalisée peut voler sa
 *      réponse, et qu'un départ postérieur à une ligne de journal est lui-même journalisé (le code neuf
 *      est en place dès qu'une telle ligne existe) ;
 *   2. il cachait le vrai défaut : ancrée sur `e.sent_at`, cette garde attrapait la ligne du destinataire
 *      LUI-MÊME et refusait toute attribution. Mesuré : `repondus` valait 0 partout, pendant que le
 *      `replied` du funnel global valait 1 sur la même personne. Deux vérités sur le même écran, soit
 *      exactement ce que le fragment partagé existe pour empêcher.
 *
 * ⚠️ LES DEUX GARDES DISENT LA MÊME RÈGLE sur deux populations, ce n'est pas une seconde heuristique :
 * « aucun départ intercalé ». Les départs d'un AUTRE destinataire se lisent sur `campaign_recipients`,
 * les départs SUPPLÉMENTAIRES du même destinataire (relance, étage suivant) ne se lisent que dans le
 * journal, parce que `campaign_recipients` n'a qu'une ligne par contact et ne sait pas les exprimer.
 *
 * ⚠️ `e.sent_at is not null` est TOUJOURS vrai (la colonne est `not null default now()`) : c'est le prix
 * du fragment partagé, et il ne coûte qu'un prédicat constant. Le rendre conditionnel aurait coûté une
 * seconde forme du fragment, exactement ce qu'on cherche à éviter.
 */
export const entrantAttribueTentative = (extra = ''): string =>
  entrantAttribueDepuis({ instant: 'e.sent_at', numero: 'r.to_e164', predicatCanal: 'm.channel = e.canal' }, extra, [
    aucunDepartDestinataire('e.sent_at', 'r.to_e164', 'r.id'),
    aucunDepartJournalise('e.sent_at', 'r.to_e164'),
  ]);

export class PgStatsStore {
  constructor(private readonly pool: Pool) {}

  async getDashboard(tenantId: string, range: DateRange): Promise<DashboardStats> {
    const { from, to } = range;

    // 1) Contacts CUMULÉS / jour : total courant = baseline (contacts créés AVANT la plage) +
    //    somme courante des nouveaux/jour. Série DENSE (generate_series de from à to) pour que les jours
    //    sans nouvel ajout reportent le total (pas de retour à 0), sans logique côté front.
    //
    // 🔴 ET LA MEME REQUETE REND LES ACTIFS (demande de Julien du 2026-09-23 : une bascule cumules/actifs).
    // « Actif » = encore dans le mini-CRM ce jour-là, c'est-à-dire créé avant la fin du jour et pas encore
    // supprimé. La suppression est DOUCE (`deleted_at`, migration 0049, aucun `delete from contacts` dans le
    // dépôt), donc l'historique est reconstructible : on ne montre pas une courbe qui commence aujourd'hui.
    //
    // 🔴 PAR DIFFERENCE, ET PAS PAR UNE SOUS-REQUETE PAR JOUR. « Combien de contacts vivants au jour J »
    // s'écrit naturellement en comptant les contacts pour CHAQUE jour de la série : c'est un balayage de la
    // table des contacts par jour affiché, donc jusqu'à 366 balayages pour une plage d'un an. Les supprimés
    // se cumulent exactement comme les créés, et actifs(J) = cumulés(J) - supprimés(J). Un contact créé ET
    // supprimé le même jour entre dans les deux sommes, donc il ne compte pas, ce qui est juste.
    //
    // ⚠️ UN CONTACT SUPPRIME APRES LA PLAGE EST ACTIF PENDANT TOUTE LA PLAGE, et c'est ce que la borne haute
    // de `supprimes_dans` garantit : sans elle, une suppression d'aujourd'hui ferait baisser la courbe d'il
    // y a trois semaines, c'est-à-dire réécrirait le passé.
    const contacts = await this.pool.query<{ d: string; count: string; actifs: string }>(
      `with ${BOUNDS_CTE},
       series as (
         select generate_series($2::date, $3::date, interval '1 day')::date as day
       ),
       baseline as (
         select count(*)::int as n from contacts
         where tenant_id = $1 and created_at < (select start_ts from bounds)
       ),
       daily as (
         select date_trunc('day', created_at at time zone $4)::date as day, count(*)::int as n
         from contacts, bounds b
         where tenant_id = $1 and created_at >= b.start_ts and created_at < b.end_ts
         group by 1
       ),
       supprimes_avant as (
         select count(*)::int as n from contacts
         where tenant_id = $1 and deleted_at is not null and deleted_at < (select start_ts from bounds)
       ),
       supprimes_dans as (
         select date_trunc('day', deleted_at at time zone $4)::date as day, count(*)::int as n
         from contacts, bounds b
         where tenant_id = $1 and deleted_at is not null
           and deleted_at >= b.start_ts and deleted_at < b.end_ts
         group by 1
       )
       select to_char(s.day, 'YYYY-MM-DD') as d,
              ((select n from baseline) + coalesce(sum(dl.n) over (order by s.day), 0))::int as count,
              ((select n from baseline) + coalesce(sum(dl.n) over (order by s.day), 0)
               - (select n from supprimes_avant) - coalesce(sum(sp.n) over (order by s.day), 0))::int as actifs
       from series s
       left join daily dl on dl.day = s.day
       left join supprimes_dans sp on sp.day = s.day
       order by s.day`,
      [tenantId, from, to, TZ],
    );

    // 2) Templates envoyés / jour, par catégorie : campagnes (campaign_recipients + campaigns.category)
    //    + envois template depuis l'inbox (conversation_messages.template_category).
    //    🔴 `c.channel = 'whatsapp'` : une campagne RCS n'envoie AUCUN template. Sans ce filtre, 5 000 envois
    //    RCS grossissaient la série « templates » d'un écran qui parle de Meta.
    const templates = await this.pool.query<{ d: string; category: string | null; count: string }>(
      `with ${BOUNDS_CTE}
       select d, category, sum(cnt)::int as count from (
         select to_char(date_trunc('day', r.sent_at at time zone $4), 'YYYY-MM-DD') d, c.category, count(*) cnt
         from campaign_recipients r join campaigns c on c.id = r.campaign_id, bounds b
         where c.tenant_id = $1 and r.status = 'sent' and r.sent_at >= b.start_ts and r.sent_at < b.end_ts
           and c.channel = 'whatsapp'
           and (r.delivery_status is null or r.delivery_status <> 'failed')
         group by d, c.category
         union all
         select to_char(date_trunc('day', m.created_at at time zone $4), 'YYYY-MM-DD') d, m.template_category, count(*) cnt
         from conversation_messages m join conversations cv on cv.id = m.conversation_id, bounds b
         where cv.tenant_id = $1 and not cv.is_test and m.direction = 'out' and m.type = 'template'
           and m.template_category is not null and m.created_at >= b.start_ts and m.created_at < b.end_ts
           -- Anti double-compte : un template de campagne DIRECTE est déjà compté via campaign_recipients (Pièce 0
           -- le logge aussi dans conversation_messages, même wamid) -> on l'exclut ici. Les envois inbox manuels
           -- (jamais dans campaign_recipients) et workflow (message_id synthétique wf-..., jamais le vrai wamid) sont gardés.
           and not exists (
             select 1 from campaign_recipients r2 join campaigns c2 on c2.id = r2.campaign_id
             where c2.tenant_id = cv.tenant_id and r2.message_id = m.meta_message_id
           )
         group by d, m.template_category
       ) x group by d, category order by d`,
      [tenantId, from, to, TZ],
    );

    // 3) Messages hors template / jour. UNE requête pour deux lectures : les ÉCHANGÉS (entrants + sortants)
    //    et, dans le même passage, les seuls SORTANTS, qui sont les messages de service. Un second balayage de
    //    la même table pour un sous-ensemble ne serait qu'un coût de plus.
    //    🔴 Les ÉCHANGÉS restent tous canaux (c'est un volume, les deux tuyaux comptent), mais les SORTANTS
    //    de service sont restreints à WhatsApp : cette série affirme à l'écran que Meta ne les facture pas au
    //    message, or smsmode facture bien les envois RCS. Le RCS n'a pas encore de série à lui, il vaut donc
    //    mieux ne pas le montrer que le montrer comme gratuit.
    const exchanged = await this.pool.query<{ d: string; count: string; sortants: string }>(
      `with ${BOUNDS_CTE}
       select to_char(date_trunc('day', m.created_at at time zone $4), 'YYYY-MM-DD') as d,
              count(*)::int as count,
              count(*) filter (where m.direction = 'out' and m.channel = 'whatsapp')::int as sortants
       from conversation_messages m join conversations cv on cv.id = m.conversation_id, bounds b
       where cv.tenant_id = $1 and not cv.is_test and m.created_at >= b.start_ts and m.created_at < b.end_ts
         and (m.direction = 'in' or (m.direction = 'out' and m.type is distinct from 'template'))
       group by d order by d`,
      [tenantId, from, to, TZ],
    );

    // 4) Ventilation des SEULS messages de service par origine. Même filtre exactement que la colonne
    //    `sortants` ci-dessus (sortant, hors template, WhatsApp, hors fil de test), pour que le total de la
    //    ventilation retombe sur celui de la courbe. Un filtre qui diverge d'un mot ferait mentir les deux.
    const parOrigine = await this.pool.query<{ origine: string; n: string }>(
      `with ${BOUNDS_CTE}
       select ${ORIGINE_EFFECTIVE_SQL} as origine, count(*)::int as n
       from conversation_messages m join conversations cv on cv.id = m.conversation_id, bounds b
       where cv.tenant_id = $1 and not cv.is_test and m.created_at >= b.start_ts and m.created_at < b.end_ts
         and m.direction = 'out' and m.channel = 'whatsapp' and m.type is distinct from 'template'
       group by 1`,
      [tenantId, from, to, TZ],
    );
    const serviceParOrigine = { ia: 0, scenario: 0, humain: 0, indeterminee: 0 };
    const serviceIaDetail = { agent: 0, mba: 0, mcp: 0 };
    for (const ligne of parOrigine.rows) {
      // Une valeur d'origine inconnue de la table de correspondance tombe en « indéterminée » plutôt que
      // d'être perdue : c'est le seul comportement qui garde le total juste.
      const theme = THEME_DE_ORIGINE[ligne.origine] ?? 'indeterminee';
      serviceParOrigine[theme] += Number(ligne.n);
      // 🔴 LE DETAIL SORT DE LA MEME BOUCLE QUE LE TOTAL, sur la meme ligne : une seconde boucle, ou pire une
      // seconde requete, ferait deux verites qui derivent. `agent` porte NOTRE agent (`origin = 'ia'`), dont
      // le nom de code est justement celui du theme, d'ou le renommage ici : `ia.ia` serait illisible.
      const detail = DETAIL_IA[ligne.origine];
      if (detail) serviceIaDetail[detail] += Number(ligne.n);
    }

    const utility: DailyPoint[] = [];
    const marketing: DailyPoint[] = [];
    for (const r of templates.rows) {
      const point = { date: r.d, count: Number(r.count) };
      if (r.category === 'marketing') marketing.push(point);
      else if (r.category === 'utility') utility.push(point);
    }

    return {
      contacts: contacts.rows.map((r) => ({ date: r.d, count: Number(r.count) })),
      contactsActifs: contacts.rows.map((r) => ({ date: r.d, count: Number(r.actifs) })),
      templates: { utility, marketing },
      exchanged: exchanged.rows.map((r) => ({ date: r.d, count: Number(r.count) })),
      service: exchanged.rows.map((r) => ({ date: r.d, count: Number(r.sortants) })),
      serviceParOrigine,
      serviceIaDetail,
    };
  }

  /**
   * Volume par template envoyé sur la période (campagnes + envois inbox), pour le dropdown du
   * dashboard et le prix estimé. Exclut les livraisons en échec (delivery_status='failed').
   *
   * 🔴 `c.channel = 'whatsapp'` et `nullif(c.template_name, '')` : une campagne RCS n'a pas de template, et
   * elle stocke la CHAÎNE VIDE et non null (http/campaigns.ts), donc elle traversait tous les filtres écrits
   * pour null. Elle apparaissait ici en ligne au nom vide, et son volume était facturé au tarif Meta.
   */
  async getTemplateBreakdown(tenantId: string, range: DateRange): Promise<TemplateBreakdownRow[]> {
    const { from, to } = range;
    const res = await this.pool.query<{ name: string; category: string | null; count: string }>(
      `with ${BOUNDS_CTE}
       select name, category, count(*)::int as count
       from (${envoisTemplateFacturables(SANS_ATTRIBUTION)}) envois
       group by name, category order by count desc`,
      [tenantId, from, to, TZ],
    );
    return res.rows.map((r) => ({ name: r.name, category: r.category, count: Number(r.count) }));
  }

  /**
   * Funnel d'UNE campagne (scopée au tenant) : envoyés -> délivrés -> lus -> répondus, + échecs.
   * « répondu » = il existe un message ENTRANT (conversation_messages.direction='in') du même numéro
   * APRÈS son envoi (created_at > sent_at) ET attribué à CETTE campagne : aucun envoi ULTÉRIEUR au même
   * numéro (même tenant) n'a eu lieu entre cet envoi et la réponse (sinon la réponse est attribuée au
   * dernier envoi, pas à celui-ci). Évite le double-comptage d'une même réponse sur plusieurs campagnes.
   * NB : « répondu » peut dépasser « lu », et pour DEUX raisons qu'il ne faut pas confondre : le contact
   * peut avoir désactivé ses accusés de lecture, ou l'envoi peut n'avoir AUCUN accusé du tout (`sansAccuse`,
   * le cas de toute campagne à scénario). Dans le second, « 0 lus » ne veut pas dire « personne n'a lu ».
   */
  async getCampaignFunnel(tenantId: string, campaignId: string): Promise<CampaignFunnel> {
    const res = await this.pool.query<{ sent: string; delivered: string; read: string; replied: string; failed: string; sans_accuse: string; button_replies: string; contacts_vises: string }>(
      `select
         -- Le grain CONTACT, et il est a part : une ligne par personne visee, que la chaine d etages ait
         -- fait une tentative ou trois pour la joindre. C est la contrainte unique (campaign_id,
         -- contact_id) qui le garantit, pas une convention.
         count(r.id)::int as contacts_vises,
         count(r.id) filter (where r.status = 'sent' and r.delivery_status is distinct from 'failed')::int as sent,
         count(r.id) filter (where r.delivery_status in ('delivered', 'read'))::int as delivered,
         count(r.id) filter (where r.delivery_status = 'read')::int as read,
         count(r.id) filter (where r.status = 'failed' or r.delivery_status = 'failed')::int as failed,
         -- Parti, mais aucun accusé de Meta : ni délivré, ni lu, ni échoué. « On ne sait pas », pas « non ».
         count(r.id) filter (where r.status = 'sent' and r.delivery_status is null)::int as sans_accuse,
         count(r.id) filter (where ${entrantAttribue()})::int as replied,
         -- Sous-ensemble des repondants, restreint aux taps de bouton. On teste type = 'button' et NON
         -- button_payload is not null : ce champ est aussi rempli par un message interactive et par une
         -- reaction (ou il porte un identifiant de message), donc un emoji serait compte comme un clic.
         count(r.id) filter (where ${entrantAttribue("and m.type = 'button'")})::int as button_replies
       from campaign_recipients r join campaigns c on c.id = r.campaign_id
       where c.id = $1 and c.tenant_id = $2`,
      [campaignId, tenantId],
    );
    const row = res.rows[0];
    return {
      contactsVises: Number(row?.contacts_vises ?? 0),
      sent: Number(row?.sent ?? 0),
      delivered: Number(row?.delivered ?? 0),
      read: Number(row?.read ?? 0),
      replied: Number(row?.replied ?? 0),
      failed: Number(row?.failed ?? 0),
      sansAccuse: Number(row?.sans_accuse ?? 0),
      buttonReplies: Number(row?.button_replies ?? 0),
      urlClicks: (await this.clicsParCampagne(tenantId, [campaignId])).get(campaignId) ?? null,
      parCanal: await this.funnelParCanal(tenantId, campaignId),
    };
  }

  /**
   * LA VENTILATION PAR CANAL d'une campagne, lue sur le journal des tentatives (migration 0134).
   *
   * 🔴 UNE REQUÊTE SÉPARÉE, PARCE QUE LES DEUX GRAINS NE SE MÉLANGENT PAS. La requête du dessus compte des
   * PERSONNES (`campaign_recipients`, une ligne par contact), celle-ci compte des TENTATIVES : joindre les
   * deux multiplierait les lignes de destinataires par leurs tentatives et fausserait tous les compteurs
   * du haut, silencieusement, le jour où quelqu'un aura deux étages. Deux grains, deux requêtes.
   *
   * 🔴 ET LA SOMME DES CANAUX N'EST PAS `sent`, C'EST VOULU. Un contact joint au second étage après un
   * échec au premier compte DEUX tentatives ici et UNE personne là-haut. L'écran doit dire laquelle des
   * deux questions il répond ; c'est pour ça que `contactsVises` existe et qu'elle vient d'ailleurs.
   *
   * ⚠️ SCOPÉE AU TENANT PAR LA JOINTURE SUR `campaigns`, parce que `campaign_envois` NE PORTE PAS de
   * `tenant_id` : son isolation passe par la campagne. La règle du dépôt est `tenant_id = $1` sur CHAQUE
   * requête, le pooler étant superuser et la RLS contournée, et c'est cette jointure qui l'applique ici.
   *
   * ⚠️ `order by min(rang), canal` : la ventilation se lit dans l'ordre de la CHAÎNE, du premier étage
   * tenté au dernier, pas dans l'ordre alphabétique d'un nom de canal. `canal` départage deux canaux
   * arrivés au même rang, pour que l'affichage ne bouge pas d'un rafraîchissement à l'autre.
   */
  private async funnelParCanal(tenantId: string, campaignId: string): Promise<FunnelCanal[]> {
    const res = await this.pool.query<{
      canal: CanalEtage; envois: number; reussis: number; delivres: number; lus: number; repondus: number; sans_accuse: number;
    }>(
      `select e.canal,
         count(*)::int as envois,
         -- « Reussi » a EXACTEMENT la definition de « sent » du funnel global : parti, et pas dementi par
         -- un accuse d echec arrive apres coup. Une seconde definition rendrait deux chiffres sur un ecran.
         -- (Pas de guillemet oblique dans ces commentaires : il fermerait le gabarit JS. Invariant du depot.)
         count(*) filter (where e.statut = 'sent' and e.delivery_status is distinct from 'failed')::int as reussis,
         count(*) filter (where e.delivery_status in ('delivered', 'read'))::int as delivres,
         count(*) filter (where e.delivery_status = 'read')::int as lus,
         -- ⚠️ Le statut « sent » EN PLUS de l attribution : une tentative ECHOUEE n a rien envoye, donc ne
         -- peut rien avoir provoque. Sans cette garde, une reponse arrivee apres un echec WhatsApp serait
         -- portee au credit du canal qui vient precisement de ne pas fonctionner.
         count(*) filter (where e.statut = 'sent' and ${entrantAttribueTentative()})::int as repondus,
         -- Parti, mais aucun accusé de Meta : ni délivré, ni lu, ni échoué. « On ne sait pas », pas « non ».
         count(*) filter (where e.statut = 'sent' and e.delivery_status is null)::int as sans_accuse
       from campaign_envois e
         join campaigns c on c.id = e.campaign_id
         join campaign_recipients r on r.id = e.recipient_id
       where e.campaign_id = $1 and c.tenant_id = $2
       group by e.canal
       order by min(e.rang), e.canal`,
      [campaignId, tenantId],
    );
    return res.rows.map((l) => ({
      canal: l.canal,
      envois: Number(l.envois),
      reussis: Number(l.reussis),
      delivres: Number(l.delivres),
      lus: Number(l.lus),
      repondus: Number(l.repondus),
      sansAccuse: Number(l.sans_accuse),
    }));
  }

  /**
   * L'identite d'une campagne, SCOPEE AU TENANT, pour la fiche de cout.
   *
   * 🔴 SCOPEE, et ce n'est pas une precaution de style : `PgCampaignStore.getForRun` lit `where id = $1`
   * SANS tenant (elle rend le tenant pour que l'appelant tranche), et s'en servir ici aurait fait de cette
   * route un IDOR : un identifiant de campagne devine ou vu ailleurs aurait rendu la fiche de couts d'un
   * AUTRE client. La regle du depot est `tenant_id = $1` sur CHAQUE requete, la RLS etant contournee.
   *
   * `null` = la campagne n'existe pas, ou pas ici. L'appelant en fait un 404, jamais une fiche vide.
   */
  async ficheCampagne(tenantId: string, campaignId: string): Promise<{ id: string; nom: string; template: string | null; workflowId: string | null } | null> {
    const res = await this.pool.query<{ id: string; name: string; template_name: string | null; workflow_id: string | null }>(
      `select id, name, nullif(template_name, '') as template_name, workflow_id
         from campaigns where id = $2 and tenant_id = $1`,
      [tenantId, campaignId],
    );
    const r = res.rows[0];
    if (!r) return null;
    return { id: r.id, nom: r.name, template: r.template_name, workflowId: r.workflow_id };
  }

  /**
   * Les envois FACTURABLES d'UNE campagne sur TOUTE SA VIE, separes en LANCEMENT et en RELANCES.
   *
   * 🔴 « LE LANCEMENT » EST LE PREMIER ENVOI PAR PERSONNE, PAS LE PREMIER ENVOI DE LA CAMPAGNE. C'est le
   * denominateur choisi par Julien le 2026-09-09 (« la base de depart, c'est le cout de lancement ») : un
   * message par destinataire reellement parti, quel que soit le chemin. Une campagne a template direct n'a
   * que celui-la ; une campagne a scenario y ajoute les templates que le parcours renvoie plus tard, qui
   * sont factures en plus et qui n'ont RIEN a faire dans un ratio « ce que m'a coute un contact touche »
   * (ils grossiraient a chaque relance, sans nouvelle interaction).
   *
   * ⚠️ MEME POPULATION que `getVolumeParCampagne`, aux memes gardes (statut `sent`, livraison non `failed`,
   * canal WhatsApp, anti-double-compte par `meta_message_id`, attribution des envois de scenario). Deux
   * definitions de « ce que cette campagne a envoye » donneraient deux couts sur deux ecrans qui s'ouvrent
   * l'un depuis l'autre, et c'est le clic sur la ligne qui les mettrait cote a cote.
   *
   * 🔴 AUCUNE BORNE DE PERIODE, et c'est voulu : un scenario recoit des reponses pendant des jours. Borne a
   * la fenetre du haut de l'ecran, on lirait le cout d'un lancement sans les interactions qu'il a produites
   * apres, donc un cout par interaction faux. La branche 2 est quand meme bornee PAR LE BAS au premier
   * `claimed_at` de la campagne : aucun envoi de cette campagne ne peut le preceder, et sans cette borne la
   * sous-requete correlee balaierait tout l'historique des messages du client.
   */
  async envoisDeLaCampagne(tenantId: string, campaignId: string): Promise<EnvoisCampagneRow[]> {
    const res = await this.pool.query<{ category: string | null; total: string; lancement: string }>(
      `with debut as (
         -- ⚠️ SCOPEE elle aussi. La route ne peut pas l atteindre avec une campagne d un autre espace
         -- (ficheCampagne a deja rendu 404), mais la regle du depot est tenant_id = $1 sur CHAQUE requete
         -- PRECISEMENT parce qu une garde posee ailleurs disparait le jour ou la methode est reutilisee.
         -- La jointure ne coute rien, l oubli couterait un espace.
         -- (Pas de guillemet oblique dans ce commentaire : il fermerait le gabarit JS. Invariant du depot.)
         select min(coalesce(r.claimed_at, r.sent_at)) as le
           from campaign_recipients r
           join campaigns c on c.id = r.campaign_id and c.tenant_id = $1
          where r.campaign_id = $2 and r.sent_at is not null
       ),
       envois as (
         select r.sent_at as at, c.category as category,
                regexp_replace(r.to_e164, '[^0-9]', '', 'g') as wa
           from campaign_recipients r join campaigns c on c.id = r.campaign_id
          where c.id = $2 and c.tenant_id = $1 and nullif(c.template_name, '') is not null
            and c.channel = 'whatsapp' and r.status = 'sent'
            and (r.delivery_status is null or r.delivery_status <> 'failed')
         union all
         select m.created_at as at, m.template_category as category, cv.wa_id as wa
           from conversation_messages m
           join conversations cv on cv.id = m.conversation_id, debut d
          where cv.tenant_id = $1 and not cv.is_test and m.direction = 'out' and m.type = 'template'
            and m.template_name is not null
            and d.le is not null and m.created_at >= d.le
            and not exists (
              select 1 from campaign_recipients r2 join campaigns c2 on c2.id = r2.campaign_id
              where c2.tenant_id = cv.tenant_id and r2.message_id = m.meta_message_id
            )
            and $2::uuid = ${ATTRIBUTION_CAMPAGNE_SCENARIO}
       ),
       rangs as (select category, row_number() over (partition by wa order by at) as rang from envois)
       select category, count(*)::int as total, count(*) filter (where rang = 1)::int as lancement
         from rangs group by category`,
      [tenantId, campaignId],
    );
    return res.rows.map((r) => ({
      category: r.category, total: Number(r.total), lancement: Number(r.lancement),
    }));
  }

  /**
   * Les mesures du scenario d'UNE campagne, bloc par bloc, sur toute la vie de la campagne.
   *
   * 🔴 `workflow_node_events` NE PORTE PAS LA CAMPAGNE, et c'est le probleme entier de cette requete. Un
   * scenario est declenche par des campagnes, par des automations et par des reponses de contacts : rendre
   * les compteurs du SCENARIO sur un ecran qui parle d'UNE campagne y melangerait tout le reste. On
   * reutilise donc EXACTEMENT l'attribution des envois (`ATTRIBUTION_CAMPAGNE_SCENARIO`) : l'evenement
   * revient a la derniere campagne scenario reclamee pour ce numero avant lui. Une seconde heuristique,
   * meme voisine, aurait donne deux verites sur le meme ecran.
   *
   * ⚠️ CE QU'ELLE PERD, et il vaut mieux le savoir que le decouvrir : les evenements ANONYMISES par la
   * retention (`wa_id = 'anonyme'`, migration 0063) ne correspondent plus a aucun destinataire et sortent
   * donc du compte. Ils restent visibles dans les mesures du SCENARIO, qui n'ont pas besoin d'attribution.
   *
   * 🔴 GROUPE PAR (BLOC, NATURE) ET NON PAR HANDLE, ET C EST LE COMPTE DES PERSONNES QUI L EXIGE. Avec le
   * handle dans le `group by`, `count(distinct wa_id)` compte les personnes PAR BOUTON, et l appelant, qui
   * n affiche pas le detail par bouton, les additionne : une personne qui tape deux boutons du meme bloc
   * compte alors pour DEUX. Le cas existe en production (verifie le 2026-09-09, un contact reel sur un bloc
   * reel), donc la colonne « pers. » aurait surestime des le premier ecran ouvert. La fiche ne montre pas
   * le detail par bouton : le handle n a rien a faire dans le regroupement.
   *
   * ⚠️ Les clics sur un lien trace ne sont pas dans cette table : ils sont fusionnes a la lecture par
   * `compteursDeClics`, avec leur propre attribution (`clicsAttribuesCampagne`).
   */
  async mesuresScenarioParCampagne(tenantId: string, campaignId: string): Promise<NodeEventCount[]> {
    const res = await this.pool.query<{ node_id: string; kind: string; n: string; c: string }>(
      `select e.node_id, e.kind, count(*)::int as n, count(distinct e.wa_id)::int as c
         from workflow_node_events e
         join campaigns c on c.id = $2 and c.tenant_id = $1
        where e.tenant_id = $1 and c.workflow_id is not null and e.workflow_id = c.workflow_id
          and e.wa_id in (
            select regexp_replace(r.to_e164, '[^0-9]', '', 'g')
              from campaign_recipients r where r.campaign_id = c.id and r.sent_at is not null
          )
          and c.id = (
            select r3.campaign_id
              from campaign_recipients r3 join campaigns c3 on c3.id = r3.campaign_id
             where c3.tenant_id = $1 and c3.workflow_id is not null and r3.sent_at is not null
               and coalesce(r3.claimed_at, r3.sent_at) <= e.at
               and e.wa_id = regexp_replace(r3.to_e164, '[^0-9]', '', 'g')
             order by coalesce(r3.claimed_at, r3.sent_at) desc
             limit 1
          )
        group by e.node_id, e.kind
        order by e.node_id, e.kind`,
      [tenantId, campaignId],
    );
    return res.rows.map((r) => ({
      nodeId: r.node_id, kind: r.kind as NodeEventCount['kind'], handle: null,
      count: Number(r.n), contacts: Number(r.c),
    }));
  }

  /**
   * Clics sur les liens tracés des templates de PLUSIEURS campagnes, à partir du premier envoi de chacune.
   *
   * 🔴 UNE SEULE DÉFINITION DE « LES CLICS D'UNE CAMPAGNE », pour le funnel (une campagne) et pour le
   * tableau de la synthèse (toutes celles de la période). La version par campagne unique existait déjà ;
   * en écrire une seconde pour le tableau aurait donné deux chiffres sous le même mot, sur deux écrans du
   * même onglet, et c'est exactement ce que le dépôt a déjà payé sur les erreurs de livraison. Le funnel
   * appelle donc celle-ci avec un seul identifiant.
   *
   * Une campagne ABSENTE de la réponse n'a pas zéro clic : elle n'a rien de mesurable (campagne à scénario,
   * dont `template_name` est nul, ou template sans lien tracé confirmé). L'appelant en fait `null`, et
   * l'écran le DIT. Un zéro se lirait « personne n'a cliqué », ce qui est une affirmation.
   *
   * Le seuil au premier envoi n'est pas cosmétique : Meta explore puis fait cliquer chaque bouton URL
   * pendant la revue du template, donc AVANT le moindre envoi.
   *
   * ⚠️ L'absence d'une campagne à SCÉNARIO est garantie DEUX fois, et le savoir évite de croire l'une
   * suffisante : la jointure sur `l.template_name = b.template_name` ne peut pas trouver un nom `null`, et
   * le `where` le dit en toutes lettres. Retirer le `where` ne change donc rien aujourd'hui ; le garder
   * couvre le jour où la jointure deviendrait externe. Le test d'intégration, lui, fige le RÉSULTAT (une
   * campagne sans template est absente), pas le mécanisme.
   */
  async clicsParCampagne(tenantId: string, campaignIds: string[]): Promise<Map<string, number>> {
    if (campaignIds.length === 0) return new Map();
    const res = await this.pool.query<{ campaign_id: string; n: string | null }>(
      `with borne as (
         select c.id as campaign_id, c.template_name, c.template_language, min(r.sent_at) as premier_envoi
           from campaigns c join campaign_recipients r on r.campaign_id = c.id
          where c.tenant_id = $1 and c.id = any($2::uuid[]) and r.sent_at is not null
          group by c.id, c.template_name, c.template_language
       )
       select b.campaign_id, count(k.id)::int as n
         from borne b
         join tracked_links l
           on l.tenant_id = $1
          and l.template_name = b.template_name
          and l.template_language = b.template_language
          and l.confirmed_at is not null
         left join tracked_link_clicks k
           on k.code = l.code and k.tenant_id = $1 and k.at >= b.premier_envoi
        where b.template_name is not null
        -- GROUP BY indispensable : un count d agregat SANS group by rend TOUJOURS une ligne (a zero),
        -- donc 'aucun lien trace' serait devenu '0 clic', et l ecran afficherait une etape qui ment.
        -- Avec lui, zero ligne en entree = zero ligne en sortie = absence cote appelant.
        group by b.campaign_id`,
      [tenantId, campaignIds],
    );
    return new Map(res.rows.map((r) => [r.campaign_id, Number(r.n ?? 0)]));
  }

  /**
   * LES PERSONNES QUI SE SONT ENGAGÉES sur une campagne : celles qui ont CLIQUÉ, et celles qui ont RÉPONDU.
   *
   * 🔴 UNE RÉPONSE EST UN ENGAGEMENT DE PREMIER NIVEAU (Julien, 2026-09-13, sur un cas réel : le
   * destinataire de « Testjulien2 » n'avait pas cliqué mais avait répondu). Le tableau ne comptait que
   * les clics, donc il annonçait « aucun engagement » sur une campagne qui en avait produit.
   *
   * 🔴 ON COMPTE DES PERSONNES, PAS DES GESTES, et c'est un écart ASSUMÉ avec la fiche des campagnes à
   * scénario (`EtapeCoutCampagne.interactions` additionne liens + boutons + réponses). Tranché par Julien :
   * diviser un coût par des PERSONNES donne ce que coûte une personne engagée, ce qui se compare d'une
   * campagne à l'autre ; par des gestes, on flatte mécaniquement les campagnes dont les mêmes gens
   * réagissent plusieurs fois. D'où le `count(distinct ...)` sur l'UNION des deux populations : quelqu'un
   * qui clique PUIS répond compte une fois.
   *
   * 🔴 SEPT JOURS APRÈS SON PROPRE ENVOI, PAR DESTINATAIRE, et les deux moitiés de cette phrase comptent.
   * Sans borne haute, toute réponse ultérieure gonflerait le score d'une vieille campagne à chaque message
   * reçu, et son chiffre ne se stabiliserait jamais. Bornée au PREMIER envoi de la campagne plutôt qu'à
   * celui de chacun, une campagne étalée sur plusieurs jours perdrait les réactions de ses derniers
   * destinataires. ⚠️ C'est un écart DÉLIBÉRÉ avec la fiche, qui n'a aucune borne parce qu'un scénario
   * reçoit des réponses pendant des jours : ici on mesure un envoi unique.
   *
   * ⚠️ LES CLICS ANONYMES EN SONT ABSENTS, ET C'EST INÉVITABLE. Un lien d'un template approuvé avant le
   * 2026-09-02 n'a pas de jeton, donc `contact_id` est nul et le clic n'est rattaché à personne (cf.
   * `clicsAnonymes`). On ne peut pas compter une personne qu'on ne sait pas nommer. `clicsParCampagne`,
   * lui, continue de les compter : les deux colonnes ne disent pas la même chose, et c'est pour cela
   * qu'on a ajouté celle-ci au lieu de renommer l'autre.
   *
   * ⚠️ Une campagne ABSENTE de la map = aucune mesure, ce qui n'est pas zéro. Même règle que partout
   * ailleurs dans ce fichier.
   *
   * 🔴 SES TROIS JOINTURES SONT DES CONTRATS AVEC DES INDEX EXISTANTS, ET DEUX SONT PARTIELS. Vérifié en
   * base le 2026-09-13, pas supposé :
   *   - `conversation_messages_unread_idx` : `(conversation_id, created_at) WHERE direction = 'in'`,
   *     c'est-à-dire le prédicat de la branche `repondeurs` mot pour mot ;
   *   - `tracked_link_clicks_contact_idx` : `(tenant_id, contact_id) WHERE contact_id IS NOT NULL`,
   *     celui de la branche `cliqueurs` ;
   *   - `conversations_contact_idx` : `(contact_id) WHERE contact_id IS NOT NULL`.
   *
   * ⚠️ SORTIR DE CES PRÉDICATS NE PRODUIRAIT AUCUNE ERREUR, seulement un balayage. Compter aussi les
   * messages SORTANTS, ou les clics sans `contact_id`, ferait tomber la requête hors de ses index
   * partiels sur les deux tables les plus écrites du produit. Le dépôt a déjà payé ce défaut ailleurs :
   * si le besoin change, l'index change AVEC la requête, dans le même lot.
   */
  async engagementsParCampagne(tenantId: string, campaignIds: string[]): Promise<Map<string, number>> {
    if (campaignIds.length === 0) return new Map();
    const res = await this.pool.query<{ campaign_id: string; n: string | null }>(
      `with envoyes as (
         select r.campaign_id, r.contact_id, r.sent_at
           from campaign_recipients r
           join campaigns c on c.id = r.campaign_id and c.tenant_id = $1
          where r.campaign_id = any($2::uuid[]) and r.sent_at is not null and r.contact_id is not null
       ),
       cliqueurs as (
         select distinct e.campaign_id, k.contact_id
           from envoyes e
           join tracked_link_clicks k
             on k.tenant_id = $1 and k.contact_id = e.contact_id
            and k.at >= e.sent_at and k.at < e.sent_at + ${FENETRE_IMPUTATION}
       ),
       repondeurs as (
         select distinct e.campaign_id, e.contact_id
           from envoyes e
           join conversations cv on cv.tenant_id = $1 and cv.contact_id = e.contact_id
           join conversation_messages m
             on m.conversation_id = cv.id and m.direction = 'in'
            and m.created_at >= e.sent_at and m.created_at < e.sent_at + ${FENETRE_IMPUTATION}
       ),
       engages as (
         select campaign_id, contact_id from cliqueurs
         union
         select campaign_id, contact_id from repondeurs
       )
       select e.campaign_id, count(*)::int as n
         from engages e
        group by e.campaign_id`,
      [tenantId, campaignIds],
    );
    return new Map(res.rows.map((r) => [r.campaign_id, Number(r.n ?? 0)]));
  }

  /**
   * LES MESSAGES DE SERVICE IMPUTES A CHAQUE CAMPAGNE.
   *
   * 🔴 SANS CETTE LECTURE, LE « COUT PAR ENGAGEMENT » NE COMPTAIT QUE LES TEMPLATES, ce qui contredit la
   * demande (« les coûts doivent inclure les templates initiaux ET les messages de service »). Une campagne
   * qui ouvre une conversation et fait échanger dix messages de service coûtait, à l'écran, le seul template
   * de départ. Relevé en revue finale le 2026-09-17 : l'étape existait au plan et n'avait jamais été faite.
   *
   * 🔴 LA MEME FENETRE QUE `engagementsParCampagne`, SEPT JOURS, ET ELLE N'EST PAS CHOISIE ICI. Numérateur
   * et dénominateur du ratio doivent parler de la même population sur la même fenêtre ; deux fenêtres
   * produiraient un rapport dont aucune moitié ne décrit le même ensemble de gens, ce qui est indétectable
   * à l'écran.
   *
   * 🔴 UN MESSAGE N'EST IMPUTE QU'A UNE SEULE CAMPAGNE, LA DERNIERE RECUE AVANT LUI, et c'est ce qui rend
   * la somme juste. Deux campagnes vers le même contact à trois jours d'écart ont des fenêtres qui SE
   * CHEVAUCHENT : compter le message dans les deux le facturerait deux fois, et le total des campagnes
   * dépasserait le coût réel des messages. `engagementsParCampagne`, lui, dédoublonne par (campagne,
   * contact) et peut légitimement créditer les deux d'un même engagé, parce qu'une personne engagée n'est
   * pas une dépense. Compter des PERSONNES et compter des EUROS n'obéit pas à la même règle.
   *
   * ⚠️ LE FILTRE DE SERVICE EST CELUI DE `serviceParMois`, MOT POUR MOT : sortant, WhatsApp, hors template,
   * hors fil de test. Il a maintenant QUATRE consommateurs qui doivent rester d'accord ; un filtre qui
   * diverge d'un mot ferait mentir les quatre.
   */
  async servicesParCampagne(tenantId: string, campaignIds: string[], range: DateRange): Promise<Map<string, number>> {
    if (campaignIds.length === 0) return new Map();
    const { from, to } = range;
    const res = await this.pool.query<{ campaign_id: string; n: string | null }>(
      `with ${BOUNDS_CTE},
       envoyes as (
         select r.campaign_id, r.contact_id, r.sent_at
           from campaign_recipients r
           join campaigns c on c.id = r.campaign_id and c.tenant_id = $1
          where r.campaign_id = any($5::uuid[]) and r.sent_at is not null and r.contact_id is not null
       ),
       services as (
         -- 🔴 BORNEE PAR LA PERIODE, ET SON ABSENCE RENDAIT LE CHIFFRE FAUX D UN FACTEUR DIX. Le prix
         -- unitaire applique a ces messages vient de serviceParMois, qui est bornee ; le cout template de
         -- la meme campagne l est aussi. Sans borne ici, une campagne etalee sur deux jours se voyait
         -- imputer TOUS ses messages de service depuis toujours, au prix effectif d une seule journee : la
         -- somme des campagnes depassait le total de la ligne « Messages » de la meme carte. Un chiffre qui
         -- n etait ni « ce que cette campagne a coute sur la periode » ni « ce qu elle a coute en tout »,
         -- donc plausible et faux, le mode de panne que tout ce lot se donne pour mission d eviter.
         -- Releve en revue finale le 2026-09-18.
         --
         -- ⚠️ engagementsParCampagne n a PAS de borne de periode, et cette phrase a d abord dit que « son
         -- resultat n est divise par aucun total de periode ». C ETAIT FAUX : il EST le denominateur du
         -- cout par engagement, dont le numerateur est desormais entierement borne. Pour une campagne dont
         -- les envois debordent de la fenetre affichee, on divise donc un cout de periode par des engages
         -- de toute la vie de la campagne, et le cout par engage sort trop bas. Le critere du cadrage (la
         -- MEME fenetre de sept jours des deux cotes) reste tenu, d ou le jaune plutot que le rouge, mais
         -- la borner reste a faire et c est ecrit dans todo.md. Releve a la troisieme revue du 2026-09-18.
         select cv.contact_id, m.created_at, m.id as message_id
           from conversation_messages m
           join conversations cv on cv.id = m.conversation_id
           cross join bounds b
          where cv.tenant_id = $1 and not cv.is_test and cv.contact_id is not null
            and m.created_at >= b.start_ts and m.created_at < b.end_ts
            and m.direction = 'out' and m.channel = 'whatsapp' and m.type is distinct from 'template'
       ),
       impute as (
         -- LA DERNIERE campagne recue avant ce message, et elle seule. Le tri descendant sur sent_at fait
         -- le choix ; la fenetre de sept jours le borne.
         -- ⚠️ LA CLE EST L IDENTIFIANT DU MESSAGE, pas (contact, instant) : deux messages au meme
         -- horodatage pour le meme contact n en comptaient qu UN, donc la propriete annoncee etait en
         -- realite « un INSTANT n est impute qu a une seule campagne ». Peu probable en microsecondes, mais
         -- lever le doute ne coute rien.
         select distinct on (s.message_id) e.campaign_id
           from services s
           join envoyes e
             on e.contact_id = s.contact_id
            and s.created_at >= e.sent_at and s.created_at < e.sent_at + ${FENETRE_IMPUTATION}
          order by s.message_id, e.sent_at desc
       )
       select campaign_id, count(*)::int as n from impute group by campaign_id`,
      // ⚠️ L ORDRE EST CELUI DE `BOUNDS_CTE`, qui reserve $2, $3 et $4 : la liste de campagnes prend
      // donc $5. Les intervertir ne produirait pas une erreur de type, seulement un resultat vide.
      [tenantId, from, to, TZ, campaignIds],
    );
    return new Map(res.rows.map((r) => [r.campaign_id, Number(r.n ?? 0)]));
  }

  /**
   * Le VOLUME d'envois facturables de la période, par campagne et par catégorie.
   *
   * ⚠️ MÊMES VOLUMES FACTURABLES que le graphe de coût (`envoisTemplateFacturables`, attribution comprise) :
   * c'est ce qui garantit que les deux écrans chiffrent la même chose. La POPULATION, elle, est plus large
   * depuis le lot 4 : ce tableau porte aussi les campagnes qui ont touché quelqu'un sans rien de facturable,
   * avec un volume nul. Les totaux de coût restent donc égaux, pas le nombre de lignes. Le coût lui-même ne se
   * calcule pas ici : il se calcule dans `estimateCoutParCampagne`, avec les mêmes règles que la série
   * (une catégorie inconnue ou sans tarif ne produit aucun coût et se COMPTE à part).
   *
   * Les envois HORS campagne sont écartés (`campaign_id is not null`) : ce tableau a une ligne par
   * campagne, et il n'y a pas de ligne « le reste » à laquelle les rattacher. Le graphe de coût, lui, les
   * porte, ce qui explique qu'il puisse totaliser davantage.
   */
  async getVolumeParCampagne(
    tenantId: string,
    range: DateRange,
    /**
     * Les campagnes ARCHIVÉES entrent-elles dans le tableau ? Non par défaut (lot 4 de la liste du 2026-09-23) :
     * elles y entraient sans le dire. ⚠️ Le filtre s'applique AVANT le plafond : appliqué après, une archivée
     * prendrait la place d'une campagne visible, puis disparaîtrait de l'écran.
     */
    opts: {
      inclureArchivees?: boolean;
      /**
       * La retention d'instance, en jours (`CONVERSATION_RETENTION_DAYS`). Elle sert a savoir si les envois
       * d'une campagne ont PU etre purges, donc si son cout est encore connaissable.
       *
       * ⚠️ ABSENTE = on ne marque RIEN hors retention, donc le comportement d'avant. C'est le bon defaut :
       * un appelant qui ignore ce parametre ne doit pas faire disparaitre des couts.
       */
      retentionJours?: number;
    } = {},
  ): Promise<VolumeCampagneRow[]> {
    const { from, to } = range;
    const res = await this.pool.query<{
      campaign_id: string; nom: string; template: string | null; canal: string; category: string | null; count: string; envois: string;
      hors_retention: boolean;
    }>(
      `with ${BOUNDS_CTE},
       v as (
         select envois.campaign_id as campaign_id, envois.category as category, count(*)::int as n
         from (${envoisTemplateFacturables(ATTRIBUTION_CAMPAGNE_SCENARIO)}) envois
         where envois.campaign_id is not null
         group by 1, 2
       ),
       -- 🔴 LES CAMPAGNES QUI ONT TOUCHÉ QUELQU'UN, FACTURABLE OU NON (lot 4). Seules celles qui avaient un envoi de
       -- MODÈLE facturable apparaissaient : une campagne à scénario (texte dans la fenêtre de service), RCS, ou
       -- envoyée à un numéro de test, disparaissait du tableau. Mesuré : 2 campagnes visibles sur 7.
       -- ⚠️ ELLE REPARCOURT campaign_recipients, QUE LA BRANCHE 1 DES FACTURABLES PARCOURT DÉJÀ, et aucun index
       -- ne sert sent_at : deux parcours au lieu d'un, assumés sur un écran d'administration qu'on ouvre pour se
       -- faire une idée (relevé en revue le 2026-09-23). À dériver du même passage le jour où la table grossit.
       e as (
         select r.campaign_id as campaign_id, count(*)::int as n, max(r.sent_at) as dernier
         from campaign_recipients r join campaigns c on c.id = r.campaign_id, bounds b
         where c.tenant_id = $1 and r.status = 'sent'
           and r.sent_at >= b.start_ts and r.sent_at < b.end_ts
           and (r.delivery_status is null or r.delivery_status <> 'failed')
         group by 1
       ),
       -- Les deux comptes CÔTE À CÔTE : le facturable (qui chiffre) et le touché (que la colonne montre).
       p as (
         select coalesce(f.campaign_id, e.campaign_id) as campaign_id,
                coalesce(f.facturables, 0) as facturables, coalesce(e.n, 0) as touches
         from (select campaign_id, sum(n)::int as facturables from v group by campaign_id) f
         full outer join e on e.campaign_id = f.campaign_id
       ),
       -- Les campagnes qui ont le PLUS envoye, plafonnees. Une de plus que le plafond : c'est ainsi que
       -- l'appelant sait qu'il tronque, et le dit. Le tri final se fait au COUT, que le SQL ne connait pas
       -- encore (il ne voit pas les tarifs Meta) : la ligne ecartee est donc la moins envoyee.
       -- 🔴 LA COUPE SE FAIT SUR CE QUE LA COLONNE MONTRE (revue finale du 2026-09-23), c'est-à-dire le plus grand
       -- des deux comptes, et estimateCoutParCampagne rejoue EXACTEMENT ce critère. Trier sur le seul
       -- facturable mettait toutes les campagnes à scénario à égalité (0), départagées par leur identifiant.
       garde as (
         select p.campaign_id from p join campaigns c on c.id = p.campaign_id and c.tenant_id = $1
         where ($6::boolean or c.archived_at is null)
         order by greatest(p.facturables, p.touches) desc, p.campaign_id asc limit $5
       )
       select g.campaign_id as campaign_id, c.name as nom, c.template_name as template, c.channel as canal,
              v.category as category, coalesce(v.n, 0) as count, coalesce(e.n, 0) as envois,
              -- 🔴 LES ENVOIS DE CETTE CAMPAGNE ONT-ILS PU ETRE PURGES ? Un envoi de SCENARIO ne vit pas dans
              -- campaign_recipients mais dans les conversations, et la purge les supprime (leurs messages
              -- partent en cascade). Passe cette borne, « rien de facturable » ne veut plus dire « rien n a
              -- ete facture » mais « on ne peut plus le savoir », et afficher 0 se lirait « gratuit ».
              -- ⚠️ LE PREDICAT EST CELUI DE LA PURGE, repris terme a terme (purgeConversationsOlderThan) :
              -- le zero d instance arrete tout, le zero d espace n arrete que cet espace, et la borne se
              -- compte en jours. Deux definitions de « purge » divergeraient au premier reglage change.
              -- ⚠️ ON SE CALE SUR LE DERNIER ENVOI de la campagne, pas sur sa creation : c est lui qui date
              -- les conversations qu elle a ouvertes.
              (coalesce(ts.conversation_retention_days, $7::int) > 0
                 and $7::int > 0
                 and coalesce(e.dernier, (select max(r2.sent_at) from campaign_recipients r2 where r2.campaign_id = g.campaign_id))
                     < now() - make_interval(days => coalesce(ts.conversation_retention_days, $7::int))) as hors_retention
       from garde g
       join campaigns c on c.id = g.campaign_id and c.tenant_id = $1
       left join tenant_settings ts on ts.tenant_id = $1
       left join v on v.campaign_id = g.campaign_id
       left join e on e.campaign_id = g.campaign_id`,
      [tenantId, from, to, TZ, PLAFOND_CAMPAGNES_SYNTHESE + 1, opts.inclureArchivees === true,
       Math.max(0, Math.floor(opts.retentionJours ?? 0))],
    );
    return res.rows.map((r) => ({
      campaignId: r.campaign_id, nom: r.nom, template: r.template, canal: r.canal,
      category: r.category, count: Number(r.count), envois: Number(r.envois),
      horsRetention: r.hors_retention === true,
    }));
  }

  /**
   * Breakdown des codes d'erreur Meta sur la plage (campagnes du tenant), trié par occurrences décroissantes.
   *
   * Population et ancrage viennent de `echecs-sql.ts`, comme le journal d'exploitation et les compteurs de
   * campagne : c'est ce qui garantit qu'un clic sur « 12 » ouvre exactement 12 lignes dans la liste des
   * contacts touchés, laquelle est servie par `PgErreursLivraisonStore.lister`.
   *
   * 🔴 CE QUE CE BREAKDOWN NE PEUT PAS MONTRER, parce qu'il est PAR CODE : un échec sans code Meta. Il en
   * existe (`src/campaign/engine.ts` marque `failed` sans code quand un template ou un carrousel est
   * inenvoyable, et toute panne réseau fait de même) : **2 sur 25** en production, mesurés le 2026-09-07.
   * Ils vivent dans le journal des erreurs de livraison (Paramètres), et l'écran d'Analytics doit le DIRE
   * plutôt que de laisser croire à un inventaire complet.
   */
  async getErrorBreakdown(tenantId: string, range: DateRange, templateName?: string): Promise<ErrorBreakdownRow[]> {
    const { from, to } = range;
    const res = await this.pool.query<{
      code: number; template_name: string | null; campaign_id: string; campaign_name: string; count: string;
    }>(
      `with ${BOUNDS_CTE}
       select r.error_code as code, c.template_name as template_name,
              c.id as campaign_id, c.name as campaign_name, count(*)::int as count
       from campaign_recipients r join campaigns c on c.id = r.campaign_id, bounds b
       where c.tenant_id = $1 and r.error_code is not null and (${RECIPIENT_FAILED_SQL})
         and ${INSTANT_ECHEC_SQL} >= b.start_ts
         and ${INSTANT_ECHEC_SQL} < b.end_ts
         and ($5::text is null or c.template_name = $5::text)
       group by r.error_code, c.template_name, c.id, c.name
       order by count desc, code asc`,
      [tenantId, from, to, TZ, templateName ?? null],
    );
    return res.rows.map((r) => ({
      code: Number(r.code), count: Number(r.count), templateName: r.template_name,
      campaignId: r.campaign_id, campaignName: r.campaign_name,
    }));
  }

  /**
   * Volume d'envois de template FACTURABLES par (jour Paris, catégorie) sur la plage, filtrable par
   * campagne OU par template. Base du graphe de coût estimé (multiplié ensuite par le tarif Meta de la
   * catégorie).
   *
   * ⚠️ Ce docblock a décrit la seule branche campagne jusqu'au 2026-09-07, et il est devenu faux le jour où
   * la requête a gagné les envois HORS campagne. Ce qu'il faut savoir aujourd'hui :
   *  - la population et ses gardes vivent dans `envoisTemplateFacturables`, pas ici. C'est LUI qui porte
   *    `c.channel = 'whatsapp'` (le coût est au tarif Meta ; une campagne RCS part chez smsmode et Meta ne
   *    facture rien, l'y compter affichait un coût WhatsApp inexistant sur l'écran même où le client décide
   *    de son budget) ;
   *  - les deux branches ne s'ancrent PAS sur la même colonne : `sent_at` côté campagne, `created_at` côté
   *    hors campagne, et seule la première connaît `status` et `delivery_status` ;
   *  - `category` peut être `null` (un envoi de scénario antérieur au 2026-09-07 n'en porte pas), et
   *    `estimateCostSeries` ignore alors la ligne.
   */
  async getCostVolume(tenantId: string, range: DateRange, filter: CostFilter): Promise<CostVolumeRow[]> {
    const { from, to } = range;
    const res = await this.pool.query<{ date: string; category: string | null; count: string }>(
      `with ${BOUNDS_CTE}
       select to_char(envois.sent_at at time zone $4, 'YYYY-MM-DD') as date, envois.category as category,
              count(*)::int as count
       from (${envoisTemplateFacturables(ATTRIBUTION_CAMPAGNE_SCENARIO)}) envois
       -- 🔴 Le filtre par CAMPAGNE exclut les envois hors campagne : leur campaign_id est null, donc
       --    \`= any(...)\` vaut NULL, donc pas TRUE, donc la ligne sort du where. Le filtre par TEMPLATE
       --    les inclut. Les deux sont voulus, et tenus par un test.
       where ($5::uuid[] is null or envois.campaign_id = any($5::uuid[]))
         and ($6::text[] is null or envois.name = any($6::text[]))
       group by 1, 2`,
      // Liste VIDE -> null, pas un tableau vide : `= any('{}')` ne matche rien, donc un filtre vide effacerait
      // le graphe au lieu de le laisser complet.
      [
        tenantId, from, to, TZ,
        filter.campaignIds?.length ? filter.campaignIds : null,
        filter.templateNames?.length ? filter.templateNames : null,
      ],
    );
    return res.rows.map((r) => ({ date: r.date, category: r.category, count: Number(r.count) }));
  }

  /**
   * LA GRILLE DE PRIX DE L'ESPACE (migration 0154), telle quelle : c'est `grilleDepuisLigne` qui la lit.
   *
   * ⚠️ `select *` PLUTOT QUE LES SIX COLONNES NOMMEES, et c'est le seul endroit du dépôt où c'est le bon
   * choix : entre le déploiement de Vercel et celui du VPS, la migration n'est pas encore passée, et nommer
   * une colonne absente ferait échouer la requête en `42703` au lieu de retomber sur les défauts. Le tri
   * des champs est fait par `grilleDepuisLigne`, qui ignore tout le reste de la ligne de réglages.
   */
  async grillePrix(tenantId: string): Promise<Record<string, unknown> | null> {
    try {
      const res = await this.pool.query<Record<string, unknown>>(
        'select * from tenant_settings where tenant_id = $1', [tenantId],
      );
      return res.rows[0] ?? null;
    } catch {
      // Table ou ligne absente : la grille par défaut fera l'affaire, et elle ne change rien au chiffre.
      return null;
    }
  }

  /**
   * LES MESSAGES DE SERVICE, MOIS PAR MOIS, avec ce qui a été consommé AVANT la fenêtre affichée.
   *
   * 🔴 C'EST CETTE FORME QUI REND LA FRANCHISE JUSTE, et rien d'autre. La franchise est MENSUELLE et la
   * période affichée n'est pas un mois : savoir seulement « combien le mois a envoyé » ne dit pas si les
   * messages de la période tombent AVANT ou APRES le millième. Une période sur les sept premiers jours d'un
   * mois qui finit à 1200 envois est entièrement gratuite ; une période sur les sept derniers est
   * entièrement payante. Le même total mensuel, deux réponses opposées.
   *
   * ⚠️ LE BALAYAGE COMMENCE AU 1er DU MOIS DE LA BORNE BASSE, pas au début de la période : c'est
   * exactement ce qu'il faut lire pour connaître le « avant ». Comme le scan démarre là, tout message
   * antérieur à `start_ts` appartient forcément au mois de départ, ce qui rend le `filter` juste sans
   * condition supplémentaire.
   *
   * ⚠️ LE FILTRE EST CELUI DES MESSAGES DE SERVICE, MOT POUR MOT : sortant, WhatsApp, hors template, hors
   * fil de test. Il a déjà DEUX consommateurs qui doivent rester d'accord (la courbe et sa ventilation par
   * origine) ; celui-ci est le troisième. Un filtre qui diverge d'un mot ferait mentir les trois.
   */
  async serviceParMois(tenantId: string, range: DateRange): Promise<{ mois: string; avantLaPeriode: number; dansLaPeriode: number }[]> {
    const { from, to } = range;
    const res = await this.pool.query<{ mois: string; avant: number; dans: number }>(
      `with ${BOUNDS_CTE},
       cadre as (
         select (date_trunc('month', b.start_ts at time zone $4)) at time zone $4 as depuis,
                b.start_ts as start_ts, b.end_ts as end_ts
           from bounds b
       )
       select to_char(date_trunc('month', m.created_at at time zone $4), 'YYYY-MM') as mois,
              count(*) filter (where m.created_at < c.start_ts)::int as avant,
              count(*) filter (where m.created_at >= c.start_ts)::int as dans
         from conversation_messages m
         join conversations cv on cv.id = m.conversation_id
         cross join cadre c
        where cv.tenant_id = $1 and not cv.is_test
          and m.created_at >= c.depuis and m.created_at < c.end_ts
          and m.direction = 'out' and m.channel = 'whatsapp' and m.type is distinct from 'template'
        group by 1
        order by 1`,
      [tenantId, from, to, TZ],
    );
    return res.rows.map((r) => ({ mois: r.mois, avantLaPeriode: Number(r.avant), dansLaPeriode: Number(r.dans) }));
  }

  /**
   * LES ENVOIS RCS DE LA PERIODE ET LES REACTIONS QUI PEUVENT LES FAIRE BASCULER.
   *
   * 🔴 UNE LIGNE PAR CONVERSATION, PAS PAR MESSAGE, ET C'EST CE QUI REND CETTE LECTURE TENABLE. La règle
   * de bascule vit dans `basculesRcs` (`src/stats/rcs-conversationnel.ts`), qui est PURE et mutée dans les
   * deux sens : la recopier en SQL créerait deux implémentations d'une même règle, et le jour où l'une
   * change l'autre resterait juste assez plausible pour ne pas se voir. Mais la nourrir message par message
   * ferait transiter une ligne par envoi, soit des dizaines de milliers sur une campagne RCS et un an de
   * période. Le compromis est `array_agg` : le SQL réduit à une ligne par conversation en gardant TOUS les
   * instants, et l'appelant les redéploie pour la fonction pure. Rien n'est approximé, et le transport
   * reste compact.
   *
   * 🔴 LES REACTIONS VONT JUSQU'A SEPT JOURS APRES LA FIN DE LA PERIODE, et l'oublier sous-facturerait le
   * dernier jour de chaque fenêtre : un RCS envoyé le 30 peut basculer le 3 du mois suivant. La fenêtre est
   * passée en paramètre depuis `FENETRE_BASCULE_MS` plutôt que réécrite en `interval '7 days'` : deux
   * constantes de fichiers différents qui doivent rester ordonnées, c'est l'invariant que ce dépôt a déjà
   * payé plusieurs fois.
   *
   * ⚠️ UNE REACTION EST UN ENTRANT SUR LE MEME CANAL. Un contact qui répondrait sur WhatsApp à un RCS ne
   * fait pas basculer l'échange RCS : ce sont deux tuyaux, et Meta comme smsmode facturent le leur.
   *
   * 🔴 CHAQUE LIGNE DIT DE QUELLE CAMPAGNE ELLE VIENT, et c'est ce qui permet au tableau « coût par
   * engagement » de chiffrer une campagne RCS (demande de Julien du 2026-09-23 : « on a justement défini un
   * coût, 6 cts si pas conversationnel et 8 si conversationnel, donc il faut le compter ici »). Le
   * groupement est donc (conversation, campagne) et plus (conversation) seule.
   *
   * ⚠️ LES ENVOIS SANS CAMPAGNE RESTENT DANS LE LOT, avec `campaignId` à `null`, et ce n'est pas du
   * remplissage : la bascule porte sur l'ÉCHANGE ENTIER, donc une réaction qui suit un RCS envoyé hors
   * campagne fait quand même passer à 8 cts les RCS de campagne du même échange. Ne rendre que les envois
   * rattachés aurait sous-facturé ce cas, sans que rien ne le signale.
   *
   * ⚠️ LA CAMPAGNE SE TROUVE EN TROIS COUPS, du plus sûr au plus faible : l'identifiant du message porté par
   * le destinataire, puis celui porté par l'étage (`campaign_envois`, migration 0134), puis l'ATTRIBUTION,
   * la même heuristique que les templates de scénario. Les deux premiers sont des égalités exactes ; le
   * troisième porte les limites écrites sur `ATTRIBUTION`, et les partager est précisément ce qui évite
   * deux définitions de « cet envoi vient de cette campagne ».
   *
   * 🔴 ET LE TROISIEME COUP SE DEBRANCHE, parce qu'il COUTE et que l'un des deux appelants JETTE ce qu'il
   * calcule (relevé en relecture le 2026-09-23). `ATTRIBUTION_CAMPAGNE_SCENARIO` est une sous-requête
   * corrélée, exécutée une fois PAR MESSAGE RCS, et son prédicat n'est servi par AUCUN index : la migration
   * 0096 a explicitement refusé celui de `campaign_recipients(to_e164, sent_at)`. Or `getCoutMessages` ne
   * lit que les instants et les volumes, jamais la campagne. Aggravant : la page de synthèse appelle les
   * DEUX routes, donc l'attribution tournait deux fois par affichage.
   *
   * ⚠️ C'EST LE MOTIF QUE CE FICHIER PORTE DEJA, et pas une invention : `envoisTemplateFacturables` prend son
   * attribution en paramètre pour exactement cette raison, avec `SANS_ATTRIBUTION` en face. Un seul fragment,
   * deux branchements.
   */
  async envoisEtReactionsRcs(
    tenantId: string,
    range: DateRange,
    fenetreMs: number,
    /**
     * Faut-il RATTACHER chaque envoi à sa campagne ? Le rattachement coûte une sous-requête corrélée par
     * message RCS, non servie par un index : seul l'appelant qui LIT `campaignId` doit la payer.
     *
     * ⚠️ DEFAUT `false`, donc le moins cher : un appelant qui ne demande rien ne paie rien et reçoit
     * `campaignId: null` partout. C'est l'inverse du défaut qui flatte, et c'est voulu : oublier de
     * demander se voit (les coûts par campagne tombent à vide), oublier de NE PAS demander ne se voit pas.
     */
    opts: { attribuer?: boolean } = {},
  ): Promise<{
    conversations: { conversationId: string; campaignId: string | null; waId: string; envois: number; instants: string[] }[];
    reactions: { waId: string; at: string }[];
  }> {
    const { from, to } = range;
    const secondes = Math.round(fenetreMs / 1000);
    const [envois, reactions] = await Promise.all([
      this.pool.query<{ conversation_id: string; campaign_id: string | null; wa_id: string; envois: number; instants: string[] }>(
        `with ${BOUNDS_CTE},
         envois as (
           select cv.id::text as conversation_id, cv.wa_id as wa_id, m.created_at as at,
                  case when $5::boolean then coalesce(
                    (select r.campaign_id from campaign_recipients r join campaigns c on c.id = r.campaign_id
                      where c.tenant_id = cv.tenant_id and r.message_id = m.meta_message_id limit 1),
                    (select e.campaign_id from campaign_envois e join campaigns c on c.id = e.campaign_id
                      where c.tenant_id = cv.tenant_id and e.message_id = m.meta_message_id limit 1),
                    ${ATTRIBUTION_CAMPAGNE_SCENARIO}
                  ) end::text as campaign_id
             from conversation_messages m
             join conversations cv on cv.id = m.conversation_id, bounds b
            where cv.tenant_id = $1 and not cv.is_test and m.channel = 'rcs' and m.direction = 'out'
              and m.created_at >= b.start_ts and m.created_at < b.end_ts
         )
         select conversation_id, campaign_id, wa_id, count(*)::int as envois,
                array_agg(to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') order by at) as instants
           from envois group by 1, 2, 3`,
        [tenantId, from, to, TZ, opts.attribuer === true],
      ),
      this.pool.query<{ wa_id: string; at: string }>(
        `with ${BOUNDS_CTE}
         select cv.wa_id as wa_id,
                to_char(m.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at
           from conversation_messages m
           join conversations cv on cv.id = m.conversation_id, bounds b
          where cv.tenant_id = $1 and not cv.is_test and m.channel = 'rcs' and m.direction = 'in'
            and m.created_at >= b.start_ts
            and m.created_at < b.end_ts + make_interval(secs => $5::int)`,
        [tenantId, from, to, TZ, secondes],
      ),
    ]);
    return {
      conversations: envois.rows.map((r) => ({
        conversationId: r.conversation_id,
        campaignId: r.campaign_id,
        waId: r.wa_id,
        envois: Number(r.envois),
        instants: Array.isArray(r.instants) ? r.instants : [],
      })),
      reactions: reactions.rows.map((r) => ({ waId: r.wa_id, at: r.at })),
    };
  }

  /**
   * CE QUE LE CLIENT A DEPENSE EN IA SUR LA PERIODE, et le detail de ses tours.
   *
   * 🔴 SON CREDIT, ET RIEN D'AUTRE (decide avec Julien le 2026-09-17). La transcription des vocaux, le bot
   * d'aide de la console et les deux assistants de configuration sont sur NOTRE clé : les afficher ici
   * ferait se demander a un client pourquoi on lui montre une dépense qu'on ne lui facture pas, et
   * ouvrirait une discussion sur un coût interne. `agent_sessions` porte exactement ce qui est débité de
   * son crédit prépayé.
   *
   * ⚠️ LE COUT DU META BUSINESS AGENT N'EST PAS ICI, ET CE N'EST PAS UN MANQUE : il tourne CHEZ Meta, qui
   * le facture au message de service. Son coût est donc déjà dans la ligne 2 de la carte. L'écran doit le
   * DIRE, sinon un lecteur conclura que la mesure manque.
   *
   * ⚠️ LA LISTE EST PLAFONNEE et le dit : une periode d'un an sur un espace actif porterait des milliers de
   * tours, dans un accordéon qu'on ouvre pour se faire une idée. Même règle que partout ailleurs ici.
   */
  async consommationIa(tenantId: string, range: DateRange, plafond: number): Promise<{
    coutMicroEur: number; tokensEntree: number; tokensSortie: number; sessions: number;
    tours: { id: string; agentId: string; tours: number; tokensEntree: number; tokensSortie: number; coutMicroEur: number; at: string }[];
    tronque: boolean;
  }> {
    const { from, to } = range;
    const [total, liste] = await Promise.all([
      this.pool.query<{ sessions: string; tin: string; tout: string; cout: string }>(
        `with ${BOUNDS_CTE}
         select count(*)::text as sessions,
                coalesce(sum(tokens_in), 0)::text as tin,
                coalesce(sum(tokens_out), 0)::text as tout,
                coalesce(sum(cout_micro_eur), 0)::text as cout
           from agent_sessions s, bounds b
          where s.tenant_id = $1 and s.created_at >= b.start_ts and s.created_at < b.end_ts`,
        [tenantId, from, to, TZ],
      ),
      this.pool.query<{ id: string; agent_id: string; tours: number; tin: string; tout: string; cout: string; at: string }>(
        `with ${BOUNDS_CTE}
         select s.id::text as id, s.agent_id::text as agent_id, s.tours as tours,
                s.tokens_in::text as tin, s.tokens_out::text as tout, s.cout_micro_eur::text as cout,
                to_char(s.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at
           from agent_sessions s, bounds b
          where s.tenant_id = $1 and s.created_at >= b.start_ts and s.created_at < b.end_ts
          order by s.created_at desc
          limit $5::int`,
        // ⚠️ Une de PLUS que le plafond : c'est ainsi qu'on sait qu'on tronque sans compter à part, comme
        // le tableau des campagnes de la synthèse.
        [tenantId, from, to, TZ, plafond + 1],
      ),
    ]);
    const t = total.rows[0];
    const lignes = liste.rows.slice(0, plafond).map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      tours: Number(r.tours),
      tokensEntree: Number(r.tin),
      tokensSortie: Number(r.tout),
      coutMicroEur: Number(r.cout),
      at: r.at,
    }));
    return {
      coutMicroEur: Number(t?.cout ?? 0),
      tokensEntree: Number(t?.tin ?? 0),
      tokensSortie: Number(t?.tout ?? 0),
      sessions: Number(t?.sessions ?? 0),
      tours: lignes,
      tronque: liste.rows.length > plafond,
    };
  }
}
