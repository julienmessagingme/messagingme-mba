'use client';

import { useMemo, useState } from 'react';
import type { BusinessHours } from '@/lib/api';
import {
  chaineDeLaFormule,
  type Cadence,
  type CanalPremier,
  type EtageAssistant,
  type FormuleCanal,
  type TroisiemeNiveau,
} from '@/lib/campagne-chaine';
import { EtapeCanal } from '@/components/campagne/EtapeCanal';
import { EtapeContenu, contenuVide } from '@/components/campagne/EtapeContenu';
import { EtapeAudience } from '@/components/campagne/EtapeAudience';
import { EtapeRecap } from '@/components/campagne/EtapeRecap';
import type { AudienceChoix } from '@/lib/campagne-repartition';
import type { VarRow } from '@/lib/variables-template';
import type { CampaignCategory, PhoneNumber, RcsAgent, RcsSuggestion, TagCount, TemplateSummary, UserFieldDef, WorkflowSummary } from '@/lib/api';

/**
 * L'ASSISTANT DE CRÉATION D'UNE CAMPAGNE : cinq étapes, une question par écran, retour libre.
 *
 * 🔴 IL CRÉE ET LANCE VRAIMENT, ET IL SAIT ASSOCIER LES VARIABLES D'UN MODÈLE DEPUIS LE LOT 6. Le
 * blocage qui le tenait hors service est levé : il envoie son `paramMapping`, donc une campagne à modèle
 * variable part sans se faire refuser par Meta sur le compte de paramètres. Ce qui l'empêche encore de
 * REMPLACER `CampaignCreateForm` est ailleurs, et c'est la § « Ce qui manque » ci-dessous.
 *
 * ⚠️ CE QUE PORTE CE COMPOSANT, ET RIEN DE PLUS : l'état de la campagne en cours d'écriture et la
 * navigation. Chaque étape est un composant qui reçoit ce dont elle a besoin et rend ce qu'elle change.
 * C'est la leçon de l'ancien formulaire, 48 états dans un seul fichier, que l'audit du 2026-08-31 a
 * demandé de découper en prévenant dans la même phrase qu'« une extraction mécanique ne réduit pas la
 * complexité d'état » : on découpe par QUESTION POSÉE, pas par zone de rendu.
 *
 * ⚠️ CE QUI MANQUE ENCORE À L'ASSISTANT, inventorié le 2026-09-12 en préparant le retrait de l'ancien
 * formulaire, et qui explique pourquoi ce retrait n'a PAS eu lieu. Chaque ligne est une capacité que
 * `CampaignCreateForm` porte seul aujourd'hui :
 *   1. ⚠️ l'association des variables d'un modèle sur un étage de REPLI : la campagne n'a qu'un
 *      `param_mapping` et `campaign_etages` n'a pas de colonne pour un second, donc un repli à variables
 *      est REFUSÉ au récapitulatif, avec sa raison (le rang 1, lui, est servi) ;
 *   2. la sélection fine des contacts (cases à cocher, filtres du mini-CRM, exclusions, listes HubSpot) ;
 *   3. l'APERÇU du template, carousel et en-tête média compris ;
 *   4. la création d'un template à la volée ;
 *   5. la programmation « Plus tard » (`scheduledAt`) ;
 *   6. la campagne AU FIL DE L'EAU (alimentée par un webhook) ;
 *   7. les brouillons de composition (écrits dans un `state` opaque que seul l'ancien formulaire relit) ;
 *   8. le visuel RCS et ses médias ;
 *   9. le débit fin (jauge 1..80), ici réduit à trois intentions de cadence.
 */

/** Les cinq étapes, dans l'ordre décidé par Julien le 2026-09-12. */
export type EtapeAssistant = 'nom' | 'canal' | 'contenu' | 'audience' | 'recap';

/**
 * L'ÉTAT DE LA CAMPAGNE EN COURS D'ÉCRITURE.
 *
 * ⚠️ LA CHAÎNE N'EST PAS STOCKÉE, ELLE EST DÉRIVÉE (`chaineDeLaFormule`). Garder à la fois les choix de
 * l'écran et leur résultat, c'est se donner deux vérités à tenir d'accord à la main : revenir en arrière
 * pour passer de « avec repli » à « WhatsApp » laisserait une chaîne à deux étages que plus rien à
 * l'écran ne décrit.
 */
export interface EtatCampagne {
  nom: string;
  /**
   * À QUOI SERT LA CAMPAGNE, au sens de Meta.
   *
   * 🔴 ELLE N'A PAS DE DÉFAUT SILENCIEUX POSSIBLE DANS L'AUTRE SENS. `marketing` exige le consentement
   * (`buildRecipients` écarte les contacts sans opt-in), `utility` non : partir sur `utility` par défaut
   * enverrait du marketing à des gens qui ne l'ont pas accepté, sans que rien ne le signale. Le défaut est
   * donc le plus RESTRICTIF, et la question est posée quand même.
   */
  category: CampaignCategory;
  formule: FormuleCanal;
  premier: CanalPremier;
  troisieme: TroisiemeNiveau;
  /** « Réessayer les envois qui échouent », cochée par défaut. Ne vaut que sur un canal SEUL. */
  reessayer: boolean;
  /** « Le rattrapage peut-il partir en dehors des heures d'ouverture ? ». Défaut : non. */
  rattrapageHorsHoraires: boolean;
  cadence: Cadence;
  /**
   * Le contenu de chaque étage, PAR RANG.
   *
   * ⚠️ INDEXÉ PAR RANG, PAS PAR POSITION DANS UN TABLEAU. Changer l'ordre du repli (« RCS en premier »)
   * réécrit la chaîne : un tableau ferait glisser le contenu WhatsApp sur l'étage RCS sans que rien ne le
   * signale. Le rang est ce que la base stocke (`campaign_etages.rang`), c'est donc la bonne clé.
   */
  contenus: Record<number, ContenuEtage>;
  /** Où va la conversation quand le contact répond. */
  devenir: Devenir;
  /** L'agent IA qui prend la main, quand `devenir` vaut `agent`. */
  agentId: string | null;
  /** La répartition, quand la conversation tombe dans l'Inbox. */
  assignation: Assignation;
  /** La personne, quand `assignation` vaut `personne`. */
  assignationUserId: string | null;
  /** QUI reçoit (étape 4). */
  audience: AudienceChoix;
}

/** Le contenu d'UN étage. Les champs inutiles au canal de l'étage restent absents. */
export interface ContenuEtage {
  /** `seul` = le contenu part tel quel ; `avec_scenario` = il ouvre un parcours. */
  formule: 'seul' | 'avec_scenario';
  templateName?: string;
  templateLanguage?: string;
  workflowId?: string;
  texteRcs?: string;
  suggestions: RcsSuggestion[];
  emailTemplateId?: string;
  /**
   * LA CLÉ DU CHAMP PERSO QUI PORTE L'ADRESSE E-MAIL DU CONTACT.
   *
   * 🔴 IL N'Y A AUCUNE CONVENTION DANS CE PRODUIT, ET C'EST UN FAIT VÉRIFIÉ : `contacts` n'a PAS de
   * colonne `email` (0001 et les `alter table contacts` qui ont suivi), l'adresse vit dans le jsonb
   * `fields` sous la clé que le client a créée. Le dépôt porte déjà la trace d'un espace qui l'appelait
   * « mail » quand un autre l'appelait « email » (`src/workflow/wiring.ts`, cas du 2026-08-25). La
   * deviner, c'est se tromper une fois sur deux EN SILENCE.
   */
  emailChamp?: string;
  /**
   * L'ASSOCIATION DES VARIABLES `{{n}}` DU MODÈLE DE CET ÉTAGE (ce qui devient `paramMapping`).
   *
   * 🔴 SANS ELLE, UN MODÈLE À VARIABLES FAIT REFUSER LA CAMPAGNE ENTIÈRE. Meta compare le nombre de
   * paramètres fournis à celui du modèle approuvé : zéro paramètre sur un modèle qui porte `{{1}}` est un
   * refus global, pas un destinataire sauté (`resolveHintParams`, `src/crm/template.ts`).
   *
   * ⚠️ ELLE EST PAR ÉTAGE, comme le reste du contenu, mais SEUL LE RANG 1 PART AUJOURD'HUI : la campagne
   * n'a qu'un `param_mapping`, et `campaign_etages` n'a pas de colonne pour en porter un second. Un étage
   * de repli sur un modèle à variables est donc REFUSÉ au récapitulatif, avec sa raison, plutôt que
   * enregistré puis refusé par Meta le jour où le repli part.
   */
  variables?: VarRow[];
  /**
   * LE MODÈLE PAR LEQUEL LE SCÉNARIO DE CET ÉTAGE OUVRE, quand la formule est « modèle et scénario ».
   *
   * 🔴 IL NE SORT JAMAIS DE L'ÉCRAN, ET C'EST VOLONTAIRE. Le serveur ne veut pas de modèle sur une
   * campagne de scénario (il écrit `template_name = ''`) : c'est le premier bloc du graphe qui dit ce qui
   * part. Mais ses variables, elles, voyagent dans `paramMapping` et sont passées telles quelles au
   * premier envoi. Il faut donc savoir COMBIEN il en porte, sans pour autant l'enregistrer.
   */
  modeleDuScenario?: { name: string; language: string };
}

/** Où va la conversation quand le contact répond. */
export type Devenir = 'mba' | 'agent' | 'inbox';
/** Comment la conversation se répartit, quand elle tombe dans l'Inbox. */
export type Assignation = 'aucune' | 'personne' | 'tour_de_role';

/** Ce que l'étape Contenu propose à choisir. Chargé par l'écran, jamais par l'étape. */
export interface ReferencesContenu {
  templates: TemplateSummary[];
  workflows: WorkflowSummary[];
  emailTemplates: Array<{ id: string; name: string }>;
  membres: Array<{ id: string; nom: string }>;
  agents: Array<{ id: string; label: string }>;
  /** Les tags de l'espace, pour cibler l'audience. */
  tags: TagCount[];
  /** Les champs perso, pour désigner celui qui porte l'adresse e-mail. */
  userFields: UserFieldDef[];
  /** Les numéros Meta de l'espace. Le premier sert d'expéditeur : un assistant ne pose pas la question. */
  numeros: PhoneNumber[];
  /** Les agents RCS de l'espace. Le premier sert de marque, même raison. */
  agentsRcs: RcsAgent[];
}

export const REFERENCES_VIDES: ReferencesContenu = {
  templates: [], workflows: [], emailTemplates: [], membres: [], agents: [],
  tags: [], userFields: [], numeros: [], agentsRcs: [],
};

export const ETAT_INITIAL: EtatCampagne = {
  nom: '',
  // 🔴 LE DÉFAUT LE PLUS RESTRICTIF : `marketing` exige le consentement, `utility` non.
  category: 'marketing',
  formule: 'whatsapp',
  premier: 'whatsapp',
  troisieme: 'aucun',
  // 🔴 COCHÉE PAR DÉFAUT : sans chaîne de repli, c'est le SEUL rattrapage disponible.
  reessayer: true,
  /**
   * 🔴 DÉFAUT PRUDENT, ET IL N'EST PAS SYMÉTRIQUE DE L'AUTRE. Sur le moment qu'on CHOISIT (l'envoi
   * initial), un défaut permissif est légitime : quelqu'un appuie sur le bouton. Sur le moment que
   * PERSONNE ne choisit (un repli qui tombe à 18 h 02), seul le défaut prudent est défendable.
   */
  rattrapageHorsHoraires: false,
  cadence: 'vite',
  contenus: {},
  /**
   * 🔴 DÉFAUT « INBOX », ET C'EST LE COMPORTEMENT D'AUJOURD'HUI. Une réponse à une campagne arrive dans
   * l'Inbox tant que personne n'a décidé autre chose. Prendre l'agent de Meta ou une IA par défaut
   * ferait répondre une machine à la place de l'équipe sans que quiconque l'ait choisi.
   */
  devenir: 'inbox',
  agentId: null,
  /** Sans assignation : la conversation arrive dans « À traiter », comme aujourd'hui. */
  assignation: 'aucune',
  assignationUserId: null,
  // ⚠️ « Tous les contacts » par défaut, et l'écran l'affiche COMPTÉ : un défaut qui ne se voit pas serait
  // le pire des deux, puisque c'est la sélection la plus large du produit.
  audience: { mode: 'tous', tags: [], sansInjoignables: false },
};

/** Ce que l'espace sait faire, lu une fois et passé aux étapes qui en dépendent. */
export interface CapacitesEspace {
  /** Un agent RCS est rattaché à l'espace. Faux = l'entrée RCS est grisée AVEC sa raison. */
  rcsEnabled: boolean;
  /**
   * L'agent de Meta est-il activé sur cet espace ? Faux = l'entrée est grisée AVEC sa raison.
   *
   * ⚠️ IL VIT ICI ET NON DANS `ReferencesContenu`, où il a passé une heure : ce n'est pas quelque chose
   * qu'on CHOISIT dans une liste, c'est ce que l'espace sait faire, exactement comme `rcsEnabled`. Deux
   * objets qui décrivent tous deux les capacités de l'espace, c'est la question « lequel des deux ? » à
   * chaque ajout suivant.
   */
  mbaEnabled: boolean;
  /** Les heures d'ouverture de l'espace, pour dire la vérité au moment où l'on coche. */
  businessHours?: BusinessHours;
}

const ORDRE: EtapeAssistant[] = ['nom', 'canal', 'contenu', 'audience', 'recap'];
const TITRES: Record<EtapeAssistant, string> = {
  nom: 'Nom',
  canal: 'Canal',
  contenu: 'Contenu',
  audience: 'Audience',
  recap: 'Récapitulatif',
};

export function AssistantCampagne({
  tenantId,
  capacites,
  references = REFERENCES_VIDES,
  etapeInitiale = 'nom',
  etatInitial,
  onCree,
}: {
  tenantId: string;
  capacites: CapacitesEspace;
  /** Ce que l'étape Contenu propose à choisir. Absent = tout est vide, et chaque cas vide le DIT. */
  references?: ReferencesContenu;
  /** L'étape d'ouverture. Sert au retour sur un brouillon, et aux tests d'écran qui visent une étape. */
  etapeInitiale?: EtapeAssistant;
  etatInitial?: Partial<EtatCampagne>;
  /** Appelé une fois la campagne créée ET lancée. Absent = l'écran se contente de le dire. */
  onCree?: (campaignId: string) => void;
}) {
  const [etat, setEtat] = useState<EtatCampagne>({ ...ETAT_INITIAL, ...etatInitial });
  const [etape, setEtape] = useState<EtapeAssistant>(etapeInitiale);

  const chaine: EtageAssistant[] = useMemo(
    () => chaineDeLaFormule({ formule: etat.formule, premier: etat.premier, troisieme: etat.troisieme }),
    [etat.formule, etat.premier, etat.troisieme],
  );

  const rang = ORDRE.indexOf(etape);
  // ⚠️ Le nom est la SEULE condition de passage posée ici. Les autres étapes portent les leurs, là où
  // elles savent ce qui manque : une liste de conditions tenue dans la coquille dériverait de ce que
  // chaque étape demande réellement.
  const peutAvancer = etape !== 'nom' || etat.nom.trim() !== '';

  const modifier = (patch: Partial<EtatCampagne>): void => setEtat((e) => ({ ...e, ...patch }));

  /**
   * MODIFIER LE CONTENU D'UN ÉTAGE, SUR L'ÉTAT COURANT ET NON SUR CELUI DU RENDU.
   *
   * 🔴 ELLE EXISTE PARCE QUE DEUX ÉCRITURES DE SUITE EN PERDAIENT UNE. L'étape Contenu fabriquait son
   * patch en relisant `etat.contenus`, c'est-à-dire la valeur CAPTURÉE au rendu : choisir un modèle écrit
   * son nom, puis ses variables, et la seconde écriture repartait d'un `contenus` où le nom n'était pas
   * encore. Le modèle disparaissait. Le cas asynchrone était pire : les indices d'un modèle reviennent du
   * réseau avec la fermeture d'un rendu périmé, donc ils effaçaient le choix fait entre-temps.
   *
   * ⚠️ LA FORME FONCTIONNELLE EST LA SEULE QUI TIENNE : `setEtat(e => ...)` reçoit l'état COURANT, jamais
   * celui du rendu. Un `modifier({ contenus })` calculé au-dehors a exactement le défaut qu'on ferme ici.
   */
  const modifierContenu = (rang: number, patch: Partial<ContenuEtage>): void => setEtat((e) => ({
    ...e,
    contenus: { ...e.contenus, [rang]: { ...(e.contenus[rang] ?? contenuVide()), ...patch } },
  }));

  return (
    // ⚠️ UNE SEULE COLONNE, BORNÉE. L'écran de référence est un 13 pouces (1280 x 800) moins la barre
    // latérale de 240 px et les marges de la coquille, soit environ 990 px utiles. Une colonne bornée à
    // 768 px y tient sans jamais dépendre de la largeur réelle de la fenêtre, et les blocs s'empilent :
    // rien ne peut se retrouver côte à côte sous un seuil, donc rien ne peut se chevaucher.
    <div className="mx-auto w-full max-w-3xl" data-testid="assistant-campagne">
      <ol className="mb-6 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-400" data-testid="assistant-etapes">
        {ORDRE.map((e, i) => (
          <li key={e} className={i === rang ? 'font-semibold text-brand-600' : ''}>
            {i > 0 && <span className="mr-2 text-ink-300">/</span>}
            {TITRES[e]}
          </li>
        ))}
      </ol>

      {etape === 'nom' && (
        <section data-testid="etape-nom">
          <h2 className="text-lg font-semibold text-ink-800">Nom de la campagne</h2>
          {/* ⚠️ Rien d'autre sur cet écran : c'est la décision d'ordre du 2026-09-12, une question par
              écran, et celle-ci est obligatoire avant tout le reste. */}
          <label className="mt-4 block text-sm text-ink-700">
            <span className="block font-medium">Nom de la campagne</span>
            <input
              type="text"
              value={etat.nom}
              onChange={(ev) => modifier({ nom: ev.target.value })}
              data-testid="assistant-nom"
              className="mt-1 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm outline-none focus:border-brand-400"
            />
          </label>
          <p className="mt-2 text-xs text-ink-400">Il n&apos;est visible que de votre équipe.</p>

          {/*
            🔴 LA CATÉGORIE EST POSÉE ICI PARCE QU'ELLE GOUVERNE LE CONSENTEMENT, PAS LE CONTENU. Une
            campagne `marketing` écarte à la création tout contact sans opt-in (`buildRecipients`), une
            campagne `utility` non. Elle ne peut donc pas être devinée depuis le message, et la poser à
            l'étape du contenu la ferait passer pour un détail de rédaction.
          */}
          <fieldset className="mt-6 w-full rounded-xl border border-ink-200 p-4" data-testid="choix-categorie">
            <legend className="px-1 text-sm font-medium text-ink-700">Nature de la campagne</legend>
            <div className="space-y-2">
              <RadioSimple
                groupe="categorie"
                libelle="Marketing"
                coche={etat.category === 'marketing'}
                onCheck={() => modifier({ category: 'marketing' })}
              />
              <RadioSimple
                groupe="categorie"
                libelle="Service (information liée à une commande, un rendez-vous, un compte)"
                coche={etat.category === 'utility'}
                onCheck={() => modifier({ category: 'utility' })}
              />
            </div>
            <p className="mt-2 text-xs text-ink-500">
              {etat.category === 'marketing'
                ? 'Seuls les contacts qui ont accepté le marketing seront retenus.'
                : 'Une campagne de service ne demande pas de consentement marketing : ne l’utilisez pas pour une promotion.'}
            </p>
          </fieldset>
        </section>
      )}

      {etape === 'canal' && (
        <EtapeCanal
          etat={etat}
          chaine={chaine}
          capacites={capacites}
          onChange={modifier}
        />
      )}

      {etape === 'contenu' && (
        <EtapeContenu
          tenantId={tenantId}
          etat={etat}
          chaine={chaine}
          references={references}
          capacites={capacites}
          /**
           * 🔴 `null` TANT QUE L'AUDIENCE N'EST PAS CHOISIE, et ce n'est pas un câblage manquant : elle
           * est demandée à l'étape SUIVANTE. L'étape Contenu ne peut donc pas afficher un compte, et
           * l'écran le dit plutôt que d'en inventer un.
           */
          nbDestinataires={null}
          onChange={modifier}
          onContenu={modifierContenu}
        />
      )}

      {etape === 'audience' && (
        <EtapeAudience tenantId={tenantId} etat={etat} references={references} onChange={modifier} />
      )}

      {etape === 'recap' && (
        <EtapeRecap
          tenantId={tenantId}
          etat={etat}
          chaine={chaine}
          references={references}
          aller={setEtape}
          {...(onCree ? { onCree } : {})}
        />
      )}

      <div className="mt-8 flex items-center gap-2 border-t border-ink-100 pt-4">
        {rang > 0 && (
          <button
            type="button"
            onClick={() => setEtape(ORDRE[rang - 1]!)}
            className="rounded-lg border border-ink-200 px-4 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50"
          >
            Retour
          </button>
        )}
        {rang < ORDRE.length - 1 && (
          <button
            type="button"
            disabled={!peutAvancer}
            onClick={() => setEtape(ORDRE[rang + 1]!)}
            className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            Suivant
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Un radio dont le NOM ACCESSIBLE est exactement son libellé.
 *
 * ⚠️ Même invariant que dans les étapes Canal et Contenu : rien d'autre que le libellé n'entre dans le
 * `<label>`, sinon aucune requête par rôle ne peut désigner la commande sans réciter sa phrase entière.
 */
function RadioSimple({
  groupe, libelle, coche, onCheck,
}: { groupe: string; libelle: string; coche: boolean; onCheck: () => void }) {
  return (
    <label className="flex w-full items-center gap-2 text-sm text-ink-800">
      <input
        type="radio"
        name={groupe}
        checked={coche}
        onChange={onCheck}
        className="h-4 w-4 shrink-0 accent-brand-500"
      />
      <span className="min-w-0 break-words">{libelle}</span>
    </label>
  );
}
