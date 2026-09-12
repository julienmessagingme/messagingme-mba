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
import { EtapeContenu } from '@/components/campagne/EtapeContenu';
import type { RcsSuggestion, TemplateSummary, WorkflowSummary } from '@/lib/api';

/**
 * L'ASSISTANT DE CRÉATION D'UNE CAMPAGNE : cinq étapes, une question par écran, retour libre.
 *
 * 🔴 IL NE REMPLACE PAS ENCORE `CampaignCreateForm`, ET C'EST VOULU. L'ancien formulaire (1 906 lignes)
 * reste le chemin de création en service ; son retrait est une tâche à part, celle qui livrera aussi
 * l'audience et le récapitulatif. Déposer ici un écran qui crée VRAIMENT une campagne avant que le
 * récapitulatif existe reviendrait à lancer des envois depuis un parcours dont personne n'a vu la fin.
 *
 * ⚠️ CE QUE PORTE CE COMPOSANT, ET RIEN DE PLUS : l'état de la campagne en cours d'écriture et la
 * navigation. Chaque étape est un composant qui reçoit ce dont elle a besoin et rend ce qu'elle change.
 * C'est la leçon de l'ancien formulaire, 48 états dans un seul fichier, que l'audit du 2026-08-31 a
 * demandé de découper en prévenant dans la même phrase qu'« une extraction mécanique ne réduit pas la
 * complexité d'état » : on découpe par QUESTION POSÉE, pas par zone de rendu.
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
}

export const REFERENCES_VIDES: ReferencesContenu = {
  templates: [], workflows: [], emailTemplates: [], membres: [], agents: [],
};

export const ETAT_INITIAL: EtatCampagne = {
  nom: '',
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
  capacites,
  references = REFERENCES_VIDES,
  etapeInitiale = 'nom',
  etatInitial,
}: {
  capacites: CapacitesEspace;
  /** Ce que l'étape Contenu propose à choisir. Absent = tout est vide, et chaque cas vide le DIT. */
  references?: ReferencesContenu;
  /** L'étape d'ouverture. Sert au retour sur un brouillon, et aux tests d'écran qui visent une étape. */
  etapeInitiale?: EtapeAssistant;
  etatInitial?: Partial<EtatCampagne>;
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
        />
      )}

      {(etape === 'audience' || etape === 'recap') && (
        // ⚠️ PLACEHOLDER ASSUMÉ, et il ne prétend rien : ces DEUX étapes sont livrées par la tâche
        // suivante (elles étaient trois avant que l'étape Contenu arrive, et ce commentaire le disait
        // encore). Un écran vide qui le DIT vaut mieux qu'un bouton « Créer » qui partirait sans que
        // l'audience ait été demandée.
        <section data-testid={`etape-${etape}`}>
          <h2 className="text-lg font-semibold text-ink-800">{TITRES[etape]}</h2>
          <p className="mt-2 text-sm text-ink-500">Cette étape arrive dans une prochaine livraison.</p>
        </section>
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
