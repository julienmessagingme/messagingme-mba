'use client';

import { useRef, useState } from 'react';
import { getTemplateHints, getWorkflow, type RcsMessage, type RcsSuggestion, type UserFieldDef } from '@/lib/api';
import { RcsButtonsEditor } from '@/components/RcsButtonsEditor';
import { TemplatePreview } from '@/components/TemplatePreview';
import { ChampImageHebergee } from '@/components/ChampImageHebergee';
import { ChampCorpsVariables } from '@/components/ChampCorpsVariables';
import { CreationModeleEnLigne } from '@/components/campagne/CreationModeleEnLigne';
import type { CreatedTemplate } from '@/components/TemplateForm';
import { MAX_BOUTONS_CARTE, MAX_BOUTONS_RCS, maxTexteRcs, versBrouillonRcs } from '@/lib/rcs';
import { CreationMessageRcsEnLigne } from '@/components/campagne/CreationMessageRcsEnLigne';
import { versBrouillonCarrousel } from '@/lib/rcs-carrousel';
import { RcsCarouselPreview } from '@/components/RcsCarouselPreview';
import { RcsPhoneFrame } from '@/components/RcsPhoneFrame';
import { assignationProposable, devenirParDefaut, type CanalEtage, type EtageAssistant } from '@/lib/campagne-chaine';
import { champEmailEffectif } from '@/lib/campagne-repartition';
import { scenariosPourEtage } from '@/lib/campagne-scenario';
import { CreationScenarioEnLigne } from '@/components/campagne/CreationScenarioEnLigne';
import { modeleDeLEtage } from '@/lib/campagne-creation';
import type { WorkflowSummary } from '@/lib/api';
import { SYSTEM_FIELDS, customFieldsOnly, varCountOf } from '@/lib/fields';
import { firstTemplateOf } from '@/lib/campaign-eligibility';
import { appliquerIndices, exemplesDApercu, lignesParDefaut, type VarRow } from '@/lib/variables-template';
import type { TemplateSummary } from '@/lib/api';
import type { CapacitesEspace, ContenuEtage, Devenir, EtatCampagne, ReferencesContenu } from '@/components/campagne/AssistantCampagne';
import { TitrePage } from '@/components/TitrePage';
import { Icone } from '@/components/Icone';

/**
 * ÉTAPE 3 : le contenu de chaque étage, puis le devenir de la conversation.
 *
 * 🔴 LES CADRES SONT EMPILÉS, JAMAIS CÔTE À CÔTE, ET C'EST DE LA CONCEPTION, PAS DE LA DÉCORATION.
 * Trois cadres à 320 px avec leurs gouttières ne tiennent pas dans les ~990 px utiles d'un 13 pouces, et
 * une grille qui se réorganise sous un seuil produit exactement les chevauchements qu'on cherche à
 * éviter. Un empilement n'a pas de seuil : il ne peut pas se réorganiser, donc il ne peut pas se
 * chevaucher. `web/e2e/campagne-assistant-contenu.spec.ts` le mesure, en plus de mesurer le débordement.
 *
 * 🔴 LE DEVENIR DE LA CONVERSATION SE DEMANDE PAR ÉTAGE DEPUIS LE 2026-09-14, et ce paragraphe affirmait
 * l'inverse (« demandé une seule fois, pour toute la campagne ») jusqu'au 2026-09-23. La question vit dans
 * le cadre de CHAQUE étage sans scénario (`BlocDevenirEtage`, plus bas), sur demande de Julien : « qui
 * s'appliquera alors QUE pour le WhatsApp, et ensuite tu passes à l'étage 2, et pareil ».
 *
 * ⚠️ CE QUI RESTE PROPRE À LA CAMPAGNE EST « À QUI » la conversation revient, pas « à quoi » : le tour de
 * rôle compte sur un rang unique et ne peut pas être réglé deux fois. Cette question-là, elle, n'apparaît
 * qu'une fois tout le contenu choisi.
 *
 * 🔴 ET UNE JUSTIFICATION FAUSSE SE RECOPIE : celle-ci a été lue par quelqu'un qui écrivait la fiche d'aide
 * de cet écran, et le client a lu pendant neuf jours qu'une « dernière question » lui serait posée pour
 * toute la campagne. Le commentaire qui dit la vérité existait pourtant 150 lignes plus bas.
 *
 * 🔴 ET ELLE N'EST PAS POSÉE QUAND TOUT PART EN SCÉNARIO (2026-09-14, tranché par Julien) : « la
 * logique qui répond, est-ce un agent IA ou un collab, est gérée dans le scénario ». Ce fichier
 * affirmait EXACTEMENT L'INVERSE la veille (« un scénario finit lui aussi, la conversation doit bien
 * aller quelque part »), et l'argument était sans objet : ce qui suit la fin d'un parcours se règle dans
 * le parcours. Deux réglages du même événement, c'est un opérateur qui croit avoir décidé ici pendant que
 * le graphe décide ailleurs.
 *
 * ⚠️ UN SEUL ÉTAGE HORS SCÉNARIO LA REPOSE (`devenirProposable`), et ce n'est pas une subtilité : sur une
 * chaîne dont l'étage 1 ouvre un parcours et l'étage 2 envoie un modèle seul, les contacts joints au
 * second répondent sans qu'aucun scénario ne les prenne. La garde vit dans la lib parce que la MÊME
 * fonction tranche au point d'envoi : ce qu'on cache ici est exactement ce qu'on n'envoie pas là-bas.
 *
 * ⚠️ TOUS LES CADRES SONT REPLIÉS À L'ARRIVÉE, mais PLUSIEURS PEUVENT ÊTRE OUVERTS ENSEMBLE depuis le
 * 2026-09-14. Le repli initial garde sa raison (on voit d'abord la FORME de sa chaîne, combien d'étages et
 * dans quel ordre, avant de plonger dans l'un d'eux) ; la fermeture AUTOMATIQUE du voisin, elle, n'en avait
 * pas de bonne et Julien l'a relevée à l'usage : sur une chaîne de repli, le message de l'étage 2 s'écrit
 * en regard de celui de l'étage 1, et le replier oblige à le rédiger de mémoire.
 */

const LIBELLE_CANAL: Record<CanalEtage, string> = {
  whatsapp: 'WhatsApp',
  rcs: 'RCS',
  email: 'E-mail',
};

export function EtapeContenu({
  tenantId,
  etat,
  chaine,
  references,
  capacites,
  nbDestinataires,
  rangsIncomplets,
  rechargerTemplates,
  rechargerScenarios,
  rechargerMessagesRcs,
  modeleSoumis,
  onModeleSoumis,
  onChange,
  onContenu,
}: {
  /** L'espace, pour lire les INDICES d'un modèle et le graphe d'un scénario. Rien d'autre n'en a besoin. */
  tenantId: string;
  etat: EtatCampagne;
  chaine: EtageAssistant[];
  references: ReferencesContenu;
  capacites: CapacitesEspace;
  /**
   * Le nombre de destinataires, quand il est connu.
   *
   * 🔴 `null` À CETTE ÉTAPE, ET C'EST LA CONSÉQUENCE DE L'ORDRE CHOISI : l'audience est demandée à
   * l'étape 4, donc après celle-ci. On ne peut donc pas afficher un compte ici, et en inventer un serait
   * pire que de ne pas l'afficher. La phrase de l'assignation dit alors ce qu'elle sait, « toutes »,
   * et renvoie au récapitulatif, qui est précisément l'écran qui rachète cet ordre.
   */
  nbDestinataires: number | null;
  /**
   * LES RANGS DONT LE CONTENU MANQUE, calculés par la coquille (`rangsSansContenu`).
   *
   * ⚠️ CALCULÉS AILLEURS, ET C'EST VOLONTAIRE : la MÊME liste grise le bouton « Suivant ». La recalculer
   * ici en ferait une seconde règle, qui finirait par dire l'autre chose que celle qui bloque, et
   * l'écran afficherait « tout est rempli » sur un bouton grisé.
   */
  rangsIncomplets: number[];
  /**
   * Relit la liste des modèles et rend la liste COMPLÈTE. ABSENTE = la création à la volée n'est pas
   * proposée, cf. le docblock de `AssistantCampagne`.
   */
  rechargerTemplates?: (silencieux?: boolean) => Promise<TemplateSummary[]>;
  /**
   * Relit la liste des scénarios. ABSENTE = « Créer un scénario » n'est pas proposé, même convention que
   * `rechargerTemplates` : sans relecture, un scénario neuf serait choisi sans figurer dans la liste, et le
   * sélecteur afficherait un vide sur un champ pourtant rempli.
   */
  rechargerScenarios?: () => Promise<WorkflowSummary[]>;
  /**
   * Relit la bibliothèque de messages RCS et rend la liste COMPLÈTE. ABSENTE = « Créer un nouveau message »
   * n'est pas proposé, même convention que les deux au-dessus.
   *
   * ⚠️ SANS FILTRE, contrairement aux scénarios : le sélecteur de l'étage écarte lui-même ce qu'il ne sait
   * pas poser. Filtrée, elle ferait passer pour absent le message qu'on vient justement d'écrire.
   */
  rechargerMessagesRcs?: () => Promise<RcsMessage[]>;
  /** Le modèle en cours de revue chez Meta. Il vit dans la COQUILLE : cf. `AssistantCampagne`. */
  modeleSoumis: CreatedTemplate | null;
  onModeleSoumis: (t: CreatedTemplate | null) => void;
  onChange: (patch: Partial<EtatCampagne>) => void;
  /**
   * Modifier le contenu d'UN étage.
   *
   * 🔴 ELLE VIENT DE LA COQUILLE, ET C'EST CE QUI LA REND SÛRE. Fabriquée ici, elle relirait
   * `etat.contenus` du RENDU : deux écritures de suite (le nom d'un modèle, puis ses variables) en
   * perdraient une, et une écriture asynchrone (les indices, qui reviennent du réseau) effacerait ce qui
   * a été choisi entre-temps. La coquille, elle, part de l'état COURANT.
   */
  onContenu: (rang: number, patch: Partial<ContenuEtage>) => void;
}) {
  /**
   * Les cadres dépliés. L'état est local, il ne décrit pas la campagne.
   *
   * 🔴 PLUSIEURS À LA FOIS DEPUIS LE 2026-09-14, et c'est une correction, pas un réglage. Ouvrir l'étage 2
   * repliait l'étage 1 : Julien, après son essai, « quand tu passes de l'étage 1 à l'étage 2, je veux que
   * tout l'étage 1 reste visible, on ne voit plus le contenu du WhatsApp ou du RCS de l'étape 1, je trouve
   * ça dommage (car ça permet d'ajuster éventuellement l'étage 2) ». C'est le cœur d'une chaîne de repli :
   * le message de repli s'écrit EN REGARD du premier, sinon on le rédige de mémoire.
   */
  const [ouverts, setOuverts] = useState<ReadonlySet<number>>(new Set());

  return (
    <section data-testid="etape-contenu" className="w-full">
      <TitrePage>Que reçoivent les contacts ?</TitrePage>
      <p className="mt-1 text-sm text-ink-500">
        Un cadre par étage de la chaîne, dans l&apos;ordre d&apos;envoi. Ouvrez celui que vous voulez
        remplir.
      </p>

      {/*
        🔴 SANS CANAL, IL N'Y A AUCUN ETAGE A REMPLIR, ET L'ECRAN DOIT LE DIRE (releve en revue le
        2026-09-14, introduit le jour meme). Le bouton « Suivant » de l'etape Canal est garde, mais
        l'adresse, elle, ne l'est pas : `?etape=contenu` sans canal, ou un brouillon abandonne avant le
        choix, arrivent ici avec une chaine VIDE. On y voyait un titre, une phrase d'aide qui parle de
        cadres, et rien d'autre : exactement l'allure d'une page a moitie chargee.
      */}
      {chaine.length === 0 && (
        <p className="mt-4 rounded-controle bg-alerte-50 px-3 py-2 text-sm text-ink-900" data-testid="contenu-sans-canal">
          Aucun canal n&apos;est choisi : revenez à l&apos;étape Canal pour dire par où partent les
          messages, et les étages à remplir apparaîtront ici.
        </p>
      )}

      {chaine.map((etage) => (
        <CadreEtage
          key={etage.rang}
          tenantId={tenantId}
          etage={etage}
          ouvert={ouverts.has(etage.rang)}
          onToggle={() => setOuverts((o) => {
            // Une COPIE, jamais une mutation : muter le Set en place garderait la même référence et React
            // ne rendrait rien, ce qui donnerait un cadre qui ne s'ouvre pas une fois sur deux.
            const suivant = new Set(o);
            if (suivant.has(etage.rang)) suivant.delete(etage.rang);
            else suivant.add(etage.rang);
            return suivant;
          })}
          contenu={etat.contenus[etage.rang] ?? contenuVide(capacites.mbaEnabled)}
          references={references}
          {...(rechargerTemplates ? { rechargerTemplates } : {})}
          {...(rechargerScenarios ? { rechargerScenarios } : {})}
          {...(rechargerMessagesRcs ? { rechargerMessagesRcs } : {})}
          capacites={capacites}
          modeleSoumis={modeleSoumis}
          onModeleSoumis={onModeleSoumis}
          onChange={(patch) => onContenu(etage.rang, patch)}
        />
      ))}

      {/*
        🔴 LA QUESTION DU DEVENIR A QUITTÉ CET ENDROIT LE 2026-09-14 : elle vit maintenant DANS chaque cadre
        d'étage, et seulement pour les étages sans scénario (demande de Julien : « qui s'appliquera alors QUE
        pour le WhatsApp, et ensuite tu passes à l'étage 2, et pareil »). Ce qui reste ici est la seule
        question qui demeure propre à la CAMPAGNE : à qui la conversation revient quand elle revient à
        l'équipe. Le tour de rôle compte sur un rang unique, il ne peut pas être réglé deux fois.

        ⚠️ ELLE N'APPARAÎT QU'UNE FOIS TOUT LE CONTENU CHOISI, et seulement si au moins un étage renvoie
        vers l'Inbox : sinon personne ne revient à l'équipe et la question n'a pas d'objet.
      */}
      {rangsIncomplets.length === 0 && assignationProposable(chaine, etat.contenus) && (
        <BlocAssignation
          etat={etat}
          references={references}
          nbDestinataires={nbDestinataires}
          onChange={onChange}
        />
      )}

      {/* Ce qui reste à remplir, nommé. Un bouton grisé sans sa raison est le défaut qu'on vient de
          corriger ailleurs : l'écran doit dire ce qu'il attend, au moment où il l'attend. */}
      {rangsIncomplets.length > 0 && (
        <p className="mt-4 rounded-controle bg-alerte-50 px-3 py-2 text-sm text-ink-900" data-testid="contenu-incomplet">
          {rangsIncomplets.length === 1
            ? `Le contenu de l'étage ${rangsIncomplets[0]} n'est pas encore choisi.`
            : `Le contenu des étages ${rangsIncomplets.join(', ')} n'est pas encore choisi.`}
          {' '}Remplissez-le pour passer à la suite.
        </p>
      )}
    </section>
  );
}

/** Un contenu d'étage vierge. Les suggestions partent VIDES : cf. `CadreRcs`. */
export function contenuVide(mbaEnabled = true): ContenuEtage {
  // ⚠️ LA RÈGLE DU DÉFAUT VIT DANS `lib/campagne-chaine.ts` (`devenirParDefaut`), pas ici : c'est la seule
  // façon de l'éprouver, la suite unitaire du front étant scopée aux fonctions pures de `lib/`.
  return { formule: 'seul', devenir: devenirParDefaut(mbaEnabled), suggestions: [] };
}

function CadreEtage({
  capacites,
  tenantId,
  etage,
  ouvert,
  onToggle,
  contenu,
  references,
  rechargerTemplates,
  rechargerScenarios,
  rechargerMessagesRcs,
  modeleSoumis,
  onModeleSoumis,
  onChange,
}: {
  tenantId: string;
  etage: EtageAssistant;
  ouvert: boolean;
  onToggle: () => void;
  contenu: ContenuEtage;
  references: ReferencesContenu;
  rechargerTemplates?: (silencieux?: boolean) => Promise<TemplateSummary[]>;
  /** Cf. `EtapeContenu.rechargerScenarios`. */
  rechargerScenarios?: () => Promise<WorkflowSummary[]>;
  /** Cf. `EtapeContenu.rechargerMessagesRcs`. */
  rechargerMessagesRcs?: () => Promise<RcsMessage[]>;
  /** Ce que l'espace sait faire, pour l'éditeur de scénario ouvert à la volée. */
  capacites: CapacitesEspace;
  modeleSoumis: CreatedTemplate | null;
  onModeleSoumis: (t: CreatedTemplate | null) => void;
  onChange: (patch: Partial<ContenuEtage>) => void;
}) {
  const titreId = `etage-titre-${etage.rang}`;
  return (
    /**
     * ⚠️ `role="group"` PORTÉ PAR UN `div`, ET NON PAR UN `fieldset` AVEC SA `legend`. Une `legend` est
     * rendue DANS la bordure, au-dessus du contenu : replié, le cadre aurait alors deux zones, et son
     * centre géométrique tomberait entre les deux. Ici, replié, le cadre ne contient QUE son en-tête,
     * donc cliquer le cadre c'est cliquer l'en-tête, sans dépendre d'un pixel.
     */
    <div
      role="group"
      aria-labelledby={titreId}
      data-testid={`etage-${etage.rang}`}
      className="mt-3 w-full overflow-hidden rounded-carte border border-ink-200"
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={ouvert}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left hover:bg-ink-50"
      >
        <span id={titreId} className="min-w-0 break-words text-sm font-medium text-ink-900">
          Étage {etage.rang} · {LIBELLE_CANAL[etage.canal]}
        </span>
        <Icone nom="deplier" taille="petite" className={`text-ink-400 transition-transform duration-150 ${ouvert ? 'rotate-180' : ''}`} />
      </button>

      {ouvert && (
        <div className="border-t border-ink-100 px-4 py-4">
          {etage.canal === 'whatsapp' && (
            <CadreWhatsApp
              tenantId={tenantId}
              rang={etage.rang}
              contenu={contenu}
              references={references}
              {...(rechargerTemplates ? { rechargerTemplates } : {})}
              {...(rechargerScenarios ? { rechargerScenarios } : {})}
              capacites={capacites}
              modeleSoumis={modeleSoumis}
              onModeleSoumis={onModeleSoumis}
              onChange={onChange}
            />
          )}
          {etage.canal === 'rcs' && (
            <CadreRcs
              tenantId={tenantId}
              rang={etage.rang}
              contenu={contenu}
              references={references}
              capacites={capacites}
              {...(rechargerScenarios ? { rechargerScenarios } : {})}
              {...(rechargerMessagesRcs ? { rechargerMessagesRcs } : {})}
              onChange={onChange}
            />
          )}
          {etage.canal === 'email' && <CadreEmail contenu={contenu} references={references} onChange={onChange} />}

          {/*
            🔴 LA QUESTION DU DEVENIR EST ICI, DANS L'ÉTAGE, ET SEULEMENT SI CET ÉTAGE PART SANS SCÉNARIO
            (2026-09-14, demande de Julien après son essai) : « si la personne dit Modèle + scénario, tu ne
            fais pas apparaître cette question, et si elle choisit modèle tu fais apparaître la question, qui
            s'appliquera alors QUE pour le WhatsApp ; et ensuite tu passes à l'étage 2, admettons RCS, et
            pareil ».

            ⚠️ AVEC UN SCÉNARIO, C'EST LUI QUI DÉCIDE, donc on ne pose rien : la phrase le dit plutôt que de
            laisser un vide, sans quoi l'écran ressemble à une question qu'on aurait oubliée.
          */}
          <div className="mt-4 border-t border-ink-100 pt-4">
            {contenu.formule === 'avec_scenario' ? (
              <p className="text-sm text-ink-500" data-testid={`devenir-scenario-${etage.rang}`}>
                Ce qui se passe quand le contact répond à cet étage est réglé dans le scénario.
              </p>
            ) : (
              <BlocDevenirEtage rang={etage.rang} contenu={contenu} capacites={capacites} onChange={onChange} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * QUI RÉPOND QUAND LE CONTACT RÉPOND À CET ÉTAGE. Deux choix, exclusifs.
 *
 * 🔴 IL N'Y A PAS DE TROISIÈME OPTION « un agent IA prend la main », et son retrait est une CORRECTION.
 * Elle existait, faisait choisir un agent précis dans une liste, et ne produisait aucun effet : ni
 * `devenir` ni `agentId` ne quittaient le navigateur. En allant la câbler, le fait qui l'interdit est
 * apparu : `agent_sessions.run_id` est `NOT NULL`, un agent IA ne sait pas exister hors d'un scénario. Le
 * chemin pour qu'un agent reprenne une campagne existe déjà, c'est « modèle + scénario ».
 */
function BlocDevenirEtage({
  rang,
  contenu,
  capacites,
  onChange,
}: {
  rang: number;
  contenu: ContenuEtage;
  capacites: CapacitesEspace;
  onChange: (patch: Partial<ContenuEtage>) => void;
}) {
  return (
    <div data-testid={`bloc-devenir-${rang}`}>
      <p className="text-sm font-medium text-ink-900">Que se passe-t-il quand le contact répond ?</p>
      <div className="mt-3 space-y-2">
        <Radio
          groupe={`devenir-${rang}`}
          libelle="L'agent de Meta prend la main"
          coche={contenu.devenir === 'mba'}
          desactive={!capacites.mbaEnabled}
          onCheck={() => onChange({ devenir: 'mba' })}
        />
        <Radio
          groupe={`devenir-${rang}`}
          libelle="La conversation arrive dans l'Inbox"
          coche={contenu.devenir === 'inbox'}
          onCheck={() => onChange({ devenir: 'inbox' })}
        />
      </div>
      {/* ⚠️ GRISÉ AVEC SA RAISON, comme les canaux de l'étape précédente : une option absente ferait croire
          que la fonctionnalité n'existe pas. */}
      {!capacites.mbaEnabled && (
        <p className="mt-3 rounded-controle bg-ink-50 px-3 py-2 text-xs text-ink-500">
          L’agent de Meta n’est pas activé sur cet espace.
        </p>
      )}
      {contenu.devenir === 'inbox' && (
        <p className="mt-3 rounded-controle bg-ink-50 px-3 py-2 text-xs text-ink-500">
          L’agent de Meta ne répondra pas : la conversation revient à votre équipe.
        </p>
      )}
    </div>
  );
}

function CadreWhatsApp({
  capacites,
  tenantId,
  rang,
  contenu,
  references,
  rechargerTemplates,
  rechargerScenarios,
  modeleSoumis,
  onModeleSoumis,
  onChange,
}: {
  tenantId: string;
  rang: number;
  contenu: ContenuEtage;
  references: ReferencesContenu;
  rechargerTemplates?: (silencieux?: boolean) => Promise<TemplateSummary[]>;
  /** Cf. `EtapeContenu.rechargerScenarios`. */
  rechargerScenarios?: () => Promise<WorkflowSummary[]>;
  /** Ce que l'espace sait faire, pour l'éditeur de scénario ouvert à la volée. */
  capacites: CapacitesEspace;
  modeleSoumis: CreatedTemplate | null;
  onModeleSoumis: (t: CreatedTemplate | null) => void;
  onChange: (patch: Partial<ContenuEtage>) => void;
}) {
  /**
   * LES INDICES ARRIVENT APRÈS, ET UN SEUL CHOIX COMPTE.
   *
   * 🔴 UNE `useRef`, PAS UN `useState`, ET LA DIFFÉRENCE EST TOUTE LA GARDE. Un état est CAPTURÉ par
   * la fermeture du rendu : la comparaison faite dans le `.then` relirait la valeur d'alors, donc elle
   * serait toujours vraie et n'écarterait jamais rien. Une ref est partagée entre les rendus, donc elle
   * voit le choix suivant. C'est le même `useRef` que porte l'ancien formulaire (`chooseSeq`), et c'est
   * pour cette raison-là.
   *
   * ⚠️ Sans elle : choisir « promo » puis « rappel » pendant que la première lecture est en vol reposerait
   * les indices de « promo » sur les variables de « rappel ».
   */
  const tour = useRef(0);

  /**
   * Le modèle dont on associe les variables : celui de l'étage, ou celui par lequel son scénario ouvre.
   *
   * ⚠️ `modeleDeLEtage` EST LE MÊME POINT DE PASSAGE QUE LE RÉCAPITULATIF. Lui, il compte ce qu'il
   * ATTEND ; ici on affiche ce qu'on PROPOSE d'associer. Deux règles séparées auraient montré une liste
   * que la garde de lancement aurait jugée incomplète, sans rien pour l'expliquer à l'écran.
   */
  const modele = modeleDeLEtage(contenu);
  /**
   * LE MODÈLE COMPLET, PAS SEULEMENT SON NOM.
   *
   * ⚠️ IL SERT DEUX LECTEURS D'UN SEUL COUP : le compte de variables (son corps) et l'APERÇU (son corps,
   * ses boutons, son carousel, son en-tête). Les chercher deux fois dans la même liste donnerait deux
   * occasions de viser deux modèles différents dans le même cadre.
   */
  const tpl = references.templates.find((t) => t.name === modele?.name);
  const nbVariables = varCountOf(tpl?.body);

  /**
   * POSER LES LIGNES TOUT DE SUITE, PUIS LES AFFINER.
   *
   * 🔴 LE DÉFAUT EST POSÉ DE FAÇON SYNCHRONE, ET C'EST CE QUI REND LA GARDE DU RÉCAPITULATIF VRAIE : un
   * modèle choisi porte immédiatement autant de lignes que de `{{n}}`, donc un lancement qui suit le clic
   * d'une seconde part avec un `paramMapping` complet. Les indices ne font que remplacer des sources.
   */
  const poserVariables = (n: number, nom: string, langue: string, avec: Partial<ContenuEtage> = {}): void => {
    const mien = (tour.current += 1);
    // ⚠️ UN SEUL PATCH POUR LE CHOIX ET SES VARIABLES : deux appels de suite partiraient du même état de
    // rendu et le second effacerait le premier. La coquille fusionne, elle ne devine pas.
    onChange({ ...avec, variables: lignesParDefaut(n) });
    if (n === 0) return;
    void getTemplateHints(tenantId, nom, langue)
      .then(({ hints }) => {
        // Un autre modèle a été choisi entre-temps : sa réponse à lui n'a rien à faire ici.
        if (mien !== tour.current || hints.length === 0) return;
        onChange({ variables: appliquerIndices(lignesParDefaut(n), hints, references.userFields) });
      })
      .catch(() => { /* pas d'indices -> on garde le défaut, jamais une liste vide */ });
  };

  const choisirModele = (v: string): void => {
    const tpl = references.templates.find((t) => t.name === v);
    poserVariables(varCountOf(tpl?.body), v, tpl?.language ?? '', { templateName: v, templateLanguage: tpl?.language ?? '' });
  };

  /**
   * CHOISIR UN SCÉNARIO, C'EST CHOISIR LE MODÈLE PAR LEQUEL IL OUVRE.
   *
   * 🔴 SES VARIABLES SONT CELLES QUE LA CAMPAGNE DOIT FOURNIR. Le premier envoi d'un scénario de campagne
   * reçoit `paramMapping` RÉSOLU PAR CONTACT et l'utilise tel quel, sans relire les indices
   * (`explicitParams`, `src/workflow/wiring.ts`) : un mapping vide sur un modèle à variables est donc le
   * même refus global de Meta que sur une campagne de modèle direct.
   *
   * ⚠️ Le graphe est lu À LA DEMANDE : la liste des scénarios ne le porte plus (elle renvoyait deux
   * graphes complets par scénario pour afficher des noms). Une lecture en échec laisse le scénario
   * choisi SANS modèle connu, et le récapitulatif REFUSE alors le lancement avec sa raison.
   * ⚠️ Cette phrase a affirmé pendant un jour que « le récapitulatif le dira », alors qu'il ne disait
   * rien : `problemeDesVariables` rendait `null` dès que le modèle était inconnu. La garde qui la rend
   * vraie a été ajoutée le 2026-09-13, dans `problemeAvantLancement`.
   */
  const choisirScenario = (id: string): void => {
    // Le canal d'ouverture vient de la LISTE, pas du graphe : il y est déjà, et le lire ici évite une
    // seconde lecture réseau pour une information que le serveur a déjà calculée.
    const canal = references.workflows.find((w) => w.id === id)?.canalOuverture;
    onChange({ workflowId: id, ...(canal !== undefined ? { canalOuvertureDuScenario: canal } : {}) });
    if (id === '') return;
    const mien = (tour.current += 1);
    void getWorkflow(tenantId, id)
      .then(({ workflow }) => {
        if (mien !== tour.current) return;
        const entree = workflow.graph ? firstTemplateOf(workflow.graph) : null;
        const nom = entree ? String(entree.data.templateName ?? '').trim() : '';
        if (nom === '') return;
        const langue = String(entree?.data.language ?? 'fr');
        // Le modèle du scénario ET ses variables dans le MÊME patch, pour la même raison qu'au-dessus.
        poserVariables(
          varCountOf(references.templates.find((t) => t.name === nom)?.body),
          nom,
          langue,
          { modeleDuScenario: { name: nom, language: langue } },
        );
      })
      .catch(() => { /* graphe illisible -> aucun modèle connu, le récapitulatif le dira */ });
  };

  return (
    <div className="w-full space-y-3">
      <Formule
        groupe="formule-whatsapp"
        seul="Modèle seul"
        avecScenario="Modèle et scénario"
        contenu={contenu}
        onChange={onChange}
      />
      {/*
        🔴 LE SÉLECTEUR DE MODÈLE N'EXISTE PAS EN FORMULE « MODÈLE ET SCÉNARIO » (2026-09-13, bug
        signalé par Julien : « le user ne doit pas choisir un modèle puis un scénario »). Le modèle qui
        part est celui du PREMIER BLOC du scénario, et `choisirScenario` le DÉDUIT déjà du graphe.

        🔴 CE N'ÉTAIT PAS UNE QUESTION DE TROP, C'ÉTAIT UNE CAMPAGNE REFUSÉE. `choisirModele` appelle
        `poserVariables`, qui ÉCRASE `variables` avec les lignes du modèle choisi à la main. Les
        variables envoyées ne correspondaient donc plus au modèle réellement envoyé, et Meta compare le
        nombre de paramètres au modèle approuvé : c'est un refus GLOBAL de la campagne, pas un
        destinataire sauté (`resolveHintParams`, `src/crm/template.ts`).
      */}
      {contenu.formule === 'seul' && (
        <Selecteur
          libelle="Modèle"
          testId={`modele-${rang}`}
          valeur={contenu.templateName ?? ''}
          onChange={choisirModele}
          options={references.templates.map((t) => ({ valeur: t.name, libelle: `${t.name} (${t.language})` }))}
          vide="Aucun modèle approuvé sur cet espace."
        />
      )}
      {/*
        🔴 LE PARCOURS DE SOUMISSION À META EST CELUI DE L'ÉCRAN EN SERVICE, pas une seconde version. Un
        modèle neuf revient `PENDING`, donc inenvoyable, et le sélecteur ci-dessus ne liste que les
        approuvés : c'est tout l'objet du panneau, qui nomme l'attente et choisit le modèle dès son
        approbation. Le refaire ici aurait donné deux façons de soumettre un modèle à Meta.
      */}
      {contenu.formule === 'seul' && rechargerTemplates && (
        <CreationModeleEnLigne
          tenantId={tenantId}
          templates={references.templates}
          rechargerTemplates={rechargerTemplates}
          nomChoisi={contenu.templateName ?? ''}
          onChoisir={choisirModele}
          soumis={modeleSoumis}
          onSoumis={onModeleSoumis}
          /**
           * 🔴 L'APERÇU PASSE SOUS LES CHAMPS, ET C'EST MESURÉ, PAS SUPPOSÉ. L'assistant est une colonne
           * bornée à 768 px : dans le cadre d'un étage il reste environ 700 px utiles, dont l'aperçu de
           * `TemplateForm` prendrait 300 en dur. Le champ « Nom » y tomberait sous 400 px, et l'incident
           * du 2026-09-08 (« la miniature passe au-dessus des cases à remplir ») vient exactement de là.
           * ⚠️ Aucune media query ne peut décider à sa place : les points de rupture lisent la largeur de
           * l'ÉCRAN, pas celle du conteneur. C'est l'appelant qui SAIT dans quoi il rend.
           */
          colonneEtroite
        />
      )}
      {contenu.formule === 'avec_scenario' && (
        <SelecteurScenario
          contenu={contenu}
          references={references}
          canal="whatsapp"
          onChange={choisirScenario}
          testId={`scenario-${rang}`}
          tenantId={tenantId}
          capacites={capacites}
          {...(rechargerScenarios ? { rechargerScenarios } : {})}
        />
      )}
      <ApercuModele rang={rang} contenu={contenu} tpl={tpl} references={references} />
      <EditeurVariables
        rang={rang}
        nbVariables={nbVariables}
        lignes={contenu.variables ?? []}
        champs={references.userFields}
        onChange={(lignes) => onChange({ variables: lignes })}
      />
    </div>
  );
}

/**
 * L'APERÇU DU MODÈLE QUI VA PARTIR : carousel, en-tête média et boutons compris.
 *
 * 🔴 SANS LUI, L'OPÉRATEUR VALIDE UN ENVOI DE MASSE SUR UN NOM DE MODÈLE. C'est la capacité qui manquait
 * le plus à l'usage, et la raison pour laquelle elle vient en premier dans ce lot. Elle RÉUTILISE
 * `TemplatePreview`, le composant que l'écran en service et l'Inbox appellent déjà : le choix carousel ou
 * bulle simple se fait sur le CONTENU du modèle, jamais sur l'écran qui l'affiche, donc les trois endroits
 * du produit qui montrent un modèle approuvé montrent la même chose.
 *
 * 🔴 C'EST LE MODÈLE RÉSOLU PAR `modeleDeLEtage`, PAS `templateName`. En formule « modèle et scénario »,
 * ce n'est pas le modèle du sélecteur qui part : c'est celui par lequel le scénario OUVRE. Montrer le
 * premier afficherait une bulle que personne ne recevra, juste à côté de la liste de variables du second.
 *
 * ⚠️ BORNÉ À `max-xs`, ET C'EST LA GARDE DE LARGEUR. `PhoneFrame` est fluide : dans la colonne de 768 px
 * de l'assistant, il rendrait une bulle de téléphone large comme la page. La borne le ramène aux ~320 px
 * qu'il occupe dans l'écran en service, et par construction il ne peut plus rien déborder.
 */
function ApercuModele({
  rang,
  contenu,
  tpl,
  references,
}: {
  rang: number;
  contenu: ContenuEtage;
  tpl: TemplateSummary | undefined;
  references: ReferencesContenu;
}) {
  // ⚠️ RIEN À MONTRER PLUTÔT QU'UN CADRE VIDE : un modèle sans corps (anciens modèles, `body` absent de la
  // liste) donnerait une bulle « Le message apparaîtra ici… » qui ressemble à une panne.
  if (!tpl?.body) return null;
  const parScenario = contenu.formule === 'avec_scenario';
  return (
    <div className="w-full" data-testid={`apercu-${rang}`}>
      {parScenario && (
        <p className="mb-1 text-xs text-ink-500">
          1<sup>er</sup> modèle envoyé par le scénario : <b>{tpl.name}</b>
        </p>
      )}
      <div className="w-full max-w-xs">
        <TemplatePreview
          template={tpl}
          examples={exemplesDApercu(contenu.variables ?? [])}
          {...(references.numeros[0]?.verifiedName ? { senderName: references.numeros[0]!.verifiedName! } : {})}
        />
      </div>
    </div>
  );
}

/**
 * D'OÙ VIENT CHAQUE VARIABLE `{{n}}` DU MODÈLE.
 *
 * 🔴 C'EST LA MÊME SÉMANTIQUE QUE L'ANCIEN FORMULAIRE, PAS UNE SECONDE : les trois fonctions qui
 * traduisent un choix en `ParamSource` vivent dans `web/lib/variables-template.ts` et servent les DEUX
 * écrans. Deux règles pour décider du même envoi finiraient par diverger sur un cas (une clé système
 * renommée, un indice périmé), et la divergence ferait sauter des contacts en silence.
 *
 * ⚠️ UNE LIGNE PAR VARIABLE, EMPILÉES ET BORNÉES À LA LARGEUR DU CADRE. C'est une liste qui GRANDIT avec
 * le modèle : dix variables sur un 13 pouces sont le pire cas réaliste, et le `<select>` y est en
 * `min-w-0 flex-1` pour rétrécir au lieu de pousser le champ de texte hors du cadre.
 */
function EditeurVariables({
  rang,
  nbVariables,
  lignes,
  champs,
  onChange,
}: {
  rang: number;
  nbVariables: number;
  lignes: VarRow[];
  champs: UserFieldDef[];
  onChange: (lignes: VarRow[]) => void;
}) {
  if (nbVariables === 0) return null;
  const perso = customFieldsOnly(champs);
  const majLigne = (i: number, patch: Partial<VarRow>): void =>
    onChange(lignes.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div className="w-full" data-testid={`variables-${rang}`}>
      <p className="text-sm font-medium text-ink-900">Variables ({nbVariables})</p>
      <div className="mt-1 w-full space-y-2">
        {lignes.map((l, i) => (
          <div key={`var-${i + 1}`} className="flex w-full items-center gap-1.5">
            <span className="w-10 shrink-0 text-xs text-ink-500">{`{{${i + 1}}}`}</span>
            <select
              value={l.sel}
              onChange={(e) => majLigne(i, { sel: e.target.value })}
              data-testid={`variable-${rang}-${i + 1}`}
              aria-label={`Variable ${i + 1}`}
              className="min-w-0 flex-1 rounded-controle border border-ink-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand-400"
            >
              <optgroup label="Champs de base">
                {SYSTEM_FIELDS.map((f) => <option key={f.key} value={`sys:${f.key}`}>{f.label[0]}</option>)}
              </optgroup>
              {perso.length > 0 && (
                <optgroup label="Mes champs">
                  {perso.map((f) => <option key={f.key} value={`field:${f.key}`}>{f.label}</option>)}
                </optgroup>
              )}
              <optgroup label="Autre">
                <option value="now">Date du jour (auto)</option>
                <option value="literal">Texte fixe</option>
              </optgroup>
            </select>
            {l.sel === 'literal' && (
              <input
                value={l.value}
                onChange={(e) => majLigne(i, { value: e.target.value })}
                data-testid={`variable-${rang}-${i + 1}-texte`}
                aria-label={`Texte fixe de la variable ${i + 1}`}
                placeholder="valeur"
                className="w-28 min-w-0 shrink rounded-controle border border-ink-200 px-3 py-2 text-sm outline-none focus:border-brand-400"
              />
            )}
          </div>
        ))}
      </div>
      <p className="mt-1.5 text-xs text-ink-500">
        Un contact sans la valeur choisie est écarté de la campagne, et le récapitulatif le compte.
      </p>
    </div>
  );
}

/**
 * Poser un message de la bibliothèque sur l'étage. DEUX appelants : le sélecteur « partir d'un message
 * enregistré », et la création à la volée.
 *
 * 🔴 SORTI EN FONCTION PARCE QU'IL PORTE DEUX INVARIANTS QU'ON NE RECOPIE PAS. ⚠️ UN SEUL PATCH POUR LES
 * TROIS CHAMPS : trois appels de suite partiraient du même état de rendu et les deux derniers effaceraient
 * le premier. 🔴 ET CHOISIR UN MESSAGE SIMPLE RETIRE LE CARROUSEL, sans quoi il continuerait de partir à la
 * place de ce qu'on vient de choisir. Recopié, le second appelant aurait oublié l'un des deux.
 *
 * ⚠️ C'est une COPIE, jamais un lien : la campagne garde le message tel qu'il était au moment où on l'a
 * repris, donc modifier la bibliothèque ensuite ne réécrit pas une campagne déjà partie.
 */
function poserMessageRcs(c: RcsMessage['content'] | null, onChange: (patch: Partial<ContenuEtage>) => void): void {
  if (c?.kind === 'carousel') { onChange({ carrouselRcs: c }); return; }
  const b = versBrouillonRcs(c);
  if (b) onChange({ texteRcs: b.text, imageRcs: b.imageUrl, suggestions: b.suggestions, carrouselRcs: undefined });
}

function CadreRcs({
  tenantId,
  rang,
  contenu,
  references,
  capacites,
  rechargerScenarios,
  rechargerMessagesRcs,
  onChange,
}: {
  /** L'espace, pour TÉLÉVERSER le visuel : c'est le seul appel réseau de ce cadre. */
  tenantId: string;
  rang: number;
  contenu: ContenuEtage;
  references: ReferencesContenu;
  /** Ce que l'espace sait faire, pour l'éditeur de scénario ouvert à la volée. */
  capacites: CapacitesEspace;
  /** Cf. `EtapeContenu.rechargerScenarios`. */
  rechargerScenarios?: () => Promise<WorkflowSummary[]>;
  /** Cf. `EtapeContenu.rechargerMessagesRcs`. */
  rechargerMessagesRcs?: () => Promise<RcsMessage[]>;
  onChange: (patch: Partial<ContenuEtage>) => void;
}) {
  const image = contenu.imageRcs ?? '';
  // Le carrousel posé sur l'étage, relu en brouillon pour l'aperçu. `null` = l'étage porte un message simple.
  const carrousel = contenu.carrouselRcs ? versBrouillonCarrousel(contenu.carrouselRcs) : null;
  return (
    <div className="w-full space-y-3">
      <Formule
        groupe="formule-rcs"
        seul="Message seul"
        avecScenario="Message et scénario"
        contenu={contenu}
        onChange={onChange}
      />
      {/*
        ⚠️ PARTIR D'UN MESSAGE ENREGISTRÉ fait une COPIE, jamais un lien. La campagne garde le message tel
        qu'il était au moment où on l'a repris : modifier la bibliothèque ensuite ne doit pas réécrire une
        campagne déjà partie. Un message simple se recopie dans les trois champs de ce cadre ; un CARROUSEL
        se pose EN ENTIER (`carrouselRcs`, depuis le 2026-09-21), parce que trois champs ne savent pas porter
        plusieurs cartes. La carte à titre, que ce composeur ne sait pas éditer, n'est toujours pas proposée :
        l'ouvrir à moitié réenregistrerait un message amputé.
      */}
      <Selecteur
        libelle="Partir d’un message enregistré"
        testId={`rcs-bibliotheque-${rang}`}
        valeur=""
        onChange={(id) => {
          poserMessageRcs(references.messagesRcs.find((m) => m.id === id)?.content ?? null, onChange);
        }}
        options={references.messagesRcs
          .filter((m) => versBrouillonRcs(m.content) !== null || m.content?.kind === 'carousel')
          .map((m) => ({ valeur: m.id, libelle: m.content?.kind === 'carousel' ? `${m.name} (carrousel)` : m.name }))}
        vide="Aucun message RCS enregistré sur cet espace."
      />
      {/*
        🔴 ÉCRIRE UN MESSAGE SANS QUITTER LA CAMPAGNE (Julien, 2026-09-24 : « il faut dire : partir d'un
        message enregistré, ou créer un nouveau modèle de message, et là ça ouvre le créateur, soit normal
        soit carrousel »). C'est le seul chemin pour CRÉER un carrousel depuis une campagne, le sélecteur
        juste au-dessus sachant seulement en reprendre un déjà enregistré : le composeur de l'étage ne sait
        éditer que le visuel, le texte et les boutons.
        ⚠️ CETTE PHRASE A DIT « ET VERS UNE CARTE À TITRE », ET C'ÉTAIT FAUX, en se contredisant avec le
        commentaire du sélecteur, plus haut dans ce même fichier. Le modèle accepte un titre
        sur une carte SIMPLE, mais aucun composeur n'expose ce champ : ouvrir le créateur n'ouvre donc pas ce
        chemin-là. 🔴 Corrigée ici le 2026-09-24 après avoir été déclarée corrigée PARTOUT deux fois : la
        première ne couvrait que le composant voisin et `todo.md`, la seconde qu'un fichier e2e. Ce qui a
        fini par la trouver n'est pas un troisième souvenir, c'est un `grep` sur la FORMULATION.
        🔴 ET CETTE MÊME PHRASE A ENSUITE GARDÉ SON AUTRE MOITIÉ FAUSSE, « le seul chemin vers un
        CARROUSEL », que le commentaire du sélecteur, plus haut dans ce fichier, et le filtre de ses options
        contredisent tous les deux : un carrousel déjà enregistré entre dans une campagne SANS ce créateur.
        Corriger une phrase fausse sur le point qu'on vient de mesurer laisse intact ce qu'on n'a pas mesuré.
        ⚠️ ET LE `grep` CI-DESSUS ÉTAIT SENSIBLE À LA CASSE : il comptait quinze occurrences quand la base en
        portait seize (`tests/web-rcs-brouillon.test.ts`, « Carte » majuscule). La seizième était juste, donc
        le correctif tient, mais le chiffre avancé comme preuve d'exhaustivité ne l'était pas. Un balayage ne
        vaut que si son motif ignore la casse.
        ⚠️ SOUS LE SÉLECTEUR ET NON DEDANS, pour la même raison que « Créer un scénario » : une option dans
        une liste déroulante se sélectionnerait comme une valeur, et un brouillon rechargé porterait un
        identifiant qui ne désigne rien.
      */}
      {rechargerMessagesRcs && (
        <CreationMessageRcsEnLigne
          tenantId={tenantId}
          champs={references.userFields}
          rechargerMessagesRcs={rechargerMessagesRcs}
          onCree={(m) => poserMessageRcs(m.content, onChange)}
        />
      )}
      {carrousel ? (
        /*
          🔴 UN CARROUSEL SE MONTRE, IL NE S'ÉDITE PAS ICI : c'est une copie figée, et les champs du message
          simple, masqués, restent en mémoire pour « Revenir à un message simple ». Ils ne partent pas tant que
          le carrousel est posé (`messageRcs`, `campagne-creation.ts`).
        */
        <div className="space-y-2" data-testid={`rcs-carrousel-etage-${rang}`}>
          <RcsPhoneFrame>
            <RcsCarouselPreview brouillon={carrousel} sansFond />
          </RcsPhoneFrame>
          <p className="text-xs text-ink-500">
            {'Copié depuis la bibliothèque : pour le modifier, modifiez-le dans Contenu > Messages RCS, puis choisissez-le à nouveau ici.'}
          </p>
          <button
            type="button"
            onClick={() => onChange({ carrouselRcs: undefined })}
            data-testid={`rcs-carrousel-retirer-${rang}`}
            className="text-xs text-brand-600 hover:underline"
          >
            Revenir à un message simple
          </button>
        </div>
      ) : (
      <>
      {/*
        🔴 LE VISUEL CHANGE LE FORMAT DU MESSAGE, PAS SEULEMENT SON APPARENCE. Dès qu'il y en a un,
        `versMessageRcs` bascule en CARTE : l'image passe au-dessus du texte, les boutons deviennent des
        boutons pleine largeur empilés DANS la carte (4 au plus) au lieu de pastilles éphémères sous la
        bulle (11 au plus), et le plafond de texte descend de 3 072 à 2 000 caractères. Les deux plafonds
        ci-dessous suivent donc le visuel, sans quoi l'écran laisserait saisir ce que l'envoi refuserait.
      */}
      <div>
        <p className="text-sm font-medium text-ink-900">Visuel</p>
        <div className="mt-1 w-full">
          <ChampImageHebergee
            tenantId={tenantId}
            valeur={image}
            onChange={(url) => onChange({ imageRcs: url })}
            testIdPrefix={`campagne-rcs-${rang}`}
            compact
          />
        </div>
      </div>
      {/*
        ⚠️ LE MÊME COMPOSEUR QUE LA BIBLIOTHÈQUE ET QUE L'ÉCRAN EN SERVICE : il porte l'insertion des
        variables `{{champ}}` (remplacées par la fiche de chaque contact à l'envoi) et le compteur de
        caractères. Le `<textarea>` nu qui était ici n'avait ni l'une ni l'autre, donc écrire une variable
        y demandait de connaître la syntaxe par cœur.
      */}
      <ChampCorpsVariables
        valeur={contenu.texteRcs ?? ''}
        onChange={(v) => onChange({ texteRcs: v })}
        fields={references.userFields}
        label="Message"
        testId="rcs-texte"
        max={maxTexteRcs(image)}
      />
      {/* 🔴 LE RCS NE SE RÉDUIT PAS À UN LIEN : ses suggestions sont ce qui le distingue d'un SMS enrichi,
          et l'éditeur partagé est celui de la bibliothèque, du carrousel et du bloc de scénario, pas une
          copie de plus.
          ⚠️ On part de ZÉRO suggestion : une suggestion posée d'office serait un bouton vide envoyé à des
          clients par celui qui n'aurait pas pensé à la retirer. */}
      <div>
        {/*
          🔴 « BOUTONS », PAS « SUGGESTIONS » (Julien, 2026-09-24). La bibliothèque (`RcsMessageForm`) et le
          panneau de scénario (`WorkflowConfigPanel`) disent « Boutons » depuis toujours, et l'éditeur partagé
          retombe lui-même sur « + bouton ». C'est pour ça que Julien a cru qu'on ne pouvait pas mettre de
          boutons dans une campagne RCS : ils y sont depuis le 2026-09-12, sous un nom qu'un client ne
          cherche pas.
          ⚠️ LA NUANCE QUE « SUGGESTION » PORTAIT N'EST PAS PERDUE : la différence entre une pastille sous la
          bulle et un bouton pleine largeur dans la carte est dite par la phrase du visuel juste au-dessus, et
          l'éditeur montre les six formes une par une.
          ⚠️ CE COMMENTAIRE A DIT « CET ÉCRAN ÉTAIT LE SEUL À EMPLOYER LE MOT DE GOOGLE », ET C'ÉTAIT FAUX : le
          choix du canal du même assistant (`EtapeCanal`) le disait aussi, dans une phrase VISIBLE DU CLIENT.
          Il était resté parce que le balayage cherchait le libellé d'un champ, pas le mot. Ne pas écrire
          « le seul » sans avoir balayé le MOT, sans distinction de casse, sur tout ce que le client lit.
        */}
        <p className="text-sm font-medium text-ink-900">Boutons</p>
        <div className="mt-1 w-full">
          <RcsButtonsEditor
            boutons={contenu.suggestions}
            onChange={(b: RcsSuggestion[]) => onChange({ suggestions: b })}
            max={image.trim() !== '' ? MAX_BOUTONS_CARTE : MAX_BOUTONS_RCS}
            dateFields={references.userFields}
            testIdPrefix={`campagne-rcs-${rang}`}
            compact
          />
        </div>
      </div>
      </>
      )}
      <p className="text-xs text-alerte-700">
        Les contacts non joignables en RCS ne reçoivent RIEN et sont comptés « ignorés » dans le rapport.
      </p>
      {/* ⚠️ Un scénario RCS n'a pas de modèle WhatsApp à paramétrer : on ne pose que son identifiant.
          ⚠️ SON `testId` MANQUAIT (ajouté le 2026-09-14) : l'étage WhatsApp le posait, pas celui-ci, donc
          aucun test ne pouvait choisir un scénario sur un étage RCS. Le trou ne se voyait pas, faute de
          cas qui en ait eu besoin. */}
      {contenu.formule === 'avec_scenario' && (
        <SelecteurScenario
          contenu={contenu}
          references={references}
          canal="rcs"
          testId={`scenario-${rang}`}
          onChange={(v) => onChange({ workflowId: v })}
          tenantId={tenantId}
          capacites={capacites}
          {...(rechargerScenarios ? { rechargerScenarios } : {})}
        />
      )}
    </div>
  );
}

function CadreEmail({
  contenu,
  references,
  onChange,
}: {
  contenu: ContenuEtage;
  references: ReferencesContenu;
  onChange: (patch: Partial<ContenuEtage>) => void;
}) {
  return (
    <div className="w-full space-y-3">
      {/* ⚠️ PAS DE SCÉNARIO À CET ÉTAGE, et ce n'est pas un oubli : un scénario est une CONVERSATION, et
          l'e-mail n'en ouvre pas. Proposer le choix ici promettrait un enchaînement qui n'existe pas. */}
      {/* ⚠️ UNE CLÉ DE TEST SANS RANG, comme `rcs-texte` juste au-dessus : un seul cadre est déplié à la
          fois, donc il n'y a jamais deux de ces champs à l'écran. Désigner celui-ci par son libellé
          buterait sur « Modèle » et « Modèle d'e-mail », que les requêtes par étiquette confondent. */}
      <Selecteur
        libelle="Modèle d'e-mail"
        valeur={contenu.emailTemplateId ?? ''}
        onChange={(v) => onChange({ emailTemplateId: v })}
        options={references.emailTemplates.map((t) => ({ valeur: t.id, libelle: t.name }))}
        vide="Aucun modèle d'e-mail sur cet espace."
        testId="email-modele"
      />
      {/*
        🔴 QUEL CHAMP PORTE L'ADRESSE ? LA QUESTION SE POSE PARCE QU'IL N'Y A AUCUNE CONVENTION. `contacts`
        n'a PAS de colonne `email` (vérifié : 0001, puis les `alter table contacts` qui ont suivi) :
        l'adresse vit dans le jsonb `fields`, sous la clé que le client a créée dans « Champs perso ». Le
        dépôt porte déjà la trace d'un espace qui l'appelait « mail » quand un autre l'appelait « email »
        (`src/workflow/wiring.ts`, cas du 2026-08-25, où le bloc visait un champ vide). Deviner la clé,
        c'est se tromper une fois sur deux, EN SILENCE, sur un envoi réel.

        ⚠️ La valeur est SUGGÉRÉE et non imposée (`champEmailEffectif`, le MÊME point de passage que le
        comptage du récapitulatif) : on épargne un clic quand un champ
        ressemble à une adresse, et l'opérateur garde la main. Sans suggestion, le sélecteur reste vide et
        le récapitulatif le dit au lieu d'inventer un compte.
      */}
      <Selecteur
        libelle="Champ qui porte l'adresse e-mail"
        valeur={champEmailEffectif(contenu.emailChamp, references.userFields) ?? ''}
        onChange={(v) => onChange({ emailChamp: v })}
        options={references.userFields.map((f) => ({ valeur: f.key, libelle: `${f.label} (${f.key})` }))}
        vide="Aucun champ perso sur cet espace : créez-en un dans Contacts > Champs perso."
      />
      <p className="rounded-controle bg-ink-50 px-3 py-2 text-xs text-ink-500">
        L&apos;e-mail part à l&apos;adresse portée par ce champ. Un contact dont le champ est vide sort de
        la chaîne avant cet étage.
      </p>
    </div>
  );
}

function Formule({
  groupe,
  seul,
  avecScenario,
  contenu,
  onChange,
}: {
  groupe: string;
  seul: string;
  avecScenario: string;
  contenu: ContenuEtage;
  onChange: (patch: Partial<ContenuEtage>) => void;
}) {
  return (
    <div className="w-full space-y-2">
      {/*
        🔴 CHANGER DE FORMULE VIDE LES VARIABLES, ET C'EST LA MOITIÉ DU CORRECTIF (2026-09-13). Les
        lignes de `variables` décrivent UN modèle précis. Passer de « modèle seul » à « modèle et
        scénario » change le modèle qui part (c'est désormais celui du premier bloc du scénario) : les
        garder ferait voyager l'association de l'ANCIEN modèle avec le NOUVEAU, et Meta refuse la
        campagne entière sur un compte de paramètres qui ne correspond pas.

        ⚠️ `choisirScenario` et `choisirModele` les reposent aussitôt après le choix suivant. Le seul
        moment où l'écran reste sans variables est celui où il n'a effectivement plus de modèle.
      */}
      <Radio
        groupe={groupe}
        libelle={seul}
        coche={contenu.formule === 'seul'}
        onCheck={() => onChange({ formule: 'seul', variables: [] })}
      />
      <Radio
        groupe={groupe}
        libelle={avecScenario}
        coche={contenu.formule === 'avec_scenario'}
        onCheck={() => onChange({ formule: 'avec_scenario', variables: [] })}
      />
    </div>
  );
}

function SelecteurScenario({
  contenu,
  references,
  canal,
  onChange,
  testId,
  tenantId,
  capacites,
  rechargerScenarios,
}: {
  contenu: ContenuEtage;
  references: ReferencesContenu;
  /**
   * 🔴 LE CANAL DE CET ÉTAGE-CI, pas celui de la campagne. Un scénario qui ouvre par un modèle WhatsApp
   * proposé sur un étage de repli RCS fait refuser la campagne ENTIÈRE par Meta, pas un destinataire.
   */
  canal: CanalEtage;
  /**
   * ⚠️ LA VALEUR, PAS UN PATCH. Choisir un scénario ne pose plus seulement son identifiant : il faut
   * aussi lire le modèle par lequel il ouvre, pour savoir combien de variables la campagne doit fournir.
   * Un patch laisserait cette lecture au bon vouloir de chaque appelant.
   */
  onChange: (workflowId: string) => void;
  /** Cf. `Selecteur.testId` : « Scénario » est sans ambiguïté, mais l'écran en porte un par étage. */
  testId?: string;
  /** L'espace, pour créer le scénario. */
  tenantId: string;
  /** Ce que l'espace sait faire : l'éditeur n'ouvre que les briques réellement disponibles. */
  capacites: CapacitesEspace;
  /** Absente = pas de création à la volée. Cf. `EtapeContenu.rechargerScenarios`. */
  rechargerScenarios?: () => Promise<WorkflowSummary[]>;
}) {
  return (
    <div className="space-y-1">
    <Selecteur
      libelle="Scénario"
      {...(testId ? { testId } : {})}
      valeur={contenu.workflowId ?? ''}
      onChange={onChange}
      options={scenariosPourEtage(references.workflows, canal).map((w) => ({ valeur: w.id, libelle: w.name }))}
      vide="Aucun scénario ne peut ouvrir cet étage."
    />
    {/*
      ⚠️ L'ENTRÉE EST SOUS LE SÉLECTEUR ET NON DEDANS. Une option « Créer un scénario » dans la liste
      déroulante serait un choix qui n'en est pas un : elle se sélectionnerait comme une valeur, et un
      brouillon rechargé porterait un identifiant qui ne désigne aucun scénario.
    */}
    {rechargerScenarios && (
      <CreationScenarioEnLigne
        tenantId={tenantId}
        canal={canal}
        rcsEnabled={capacites.rcsEnabled}
        mbaEnabled={capacites.mbaEnabled}
        onCree={(id) => {
          // 🔴 LA LISTE D'ABORD, LE CHOIX ENSUITE. Choisir un identifiant absent des options laisserait le
          // sélecteur vide sur un champ pourtant rempli.
          void rechargerScenarios().then(() => onChange(id)).catch(() => onChange(id));
        }}
      />
    )}
    </div>
  );
}

/**
 * À QUI VA LA CONVERSATION, quand elle revient à l'équipe.
 *
 * 🔴 ELLE RESTE UNE POLITIQUE DE CAMPAGNE, PAS D'ÉTAGE, alors que le devenir, lui, est descendu dans les
 * étages le 2026-09-14. Ce n'est pas une inconséquence : le tour de rôle compte ses réponses sur un rang
 * unique (`campaigns.tour_de_role_rang`), et un rang par étage ferait tourner deux roulements indépendants
 * sur la même équipe, donc servirait deux fois la même personne.
 *
 * ⚠️ Elle n'est posée QUE si au moins un étage renvoie vers l'Inbox : sinon personne ne revient à l'équipe,
 * et la question n'a pas d'objet.
 */
function BlocAssignation({
  etat,
  references,
  nbDestinataires,
  onChange,
}: {
  etat: EtatCampagne;
  references: ReferencesContenu;
  nbDestinataires: number | null;
  onChange: (patch: Partial<EtatCampagne>) => void;
}) {
  return (
    <div data-testid="bloc-assignation" className="mt-6 w-full rounded-carte border border-ink-200 p-4">
        <div className="mt-4 border-t border-ink-100 pt-4">
          <p className="text-sm font-medium text-ink-900">À qui va la conversation ?</p>
          <div className="mt-2 space-y-2">
            <Radio
              groupe="assignation"
              libelle="Sans assignation"
              coche={etat.assignation === 'aucune'}
              onCheck={() => onChange({ assignation: 'aucune' })}
            />
            <Radio
              groupe="assignation"
              libelle="Assignée à une personne"
              coche={etat.assignation === 'personne'}
              onCheck={() => onChange({ assignation: 'personne' })}
            />
            <Radio
              groupe="assignation"
              libelle="Répartie à tour de rôle"
              coche={etat.assignation === 'tour_de_role'}
              onCheck={() => onChange({ assignation: 'tour_de_role' })}
            />
          </div>

          {etat.assignation === 'personne' && (
            <div className="mt-3 space-y-2">
              {/*
                🔴 LES MEMBRES NON ACTIVÉS SONT LÀ, GRISÉS AVEC LEUR RAISON (2026-09-12). L'écran les
                MASQUAIT : Julien a ouvert la liste et y a vu une personne sur les trois de son espace,
                sans un mot d'explication. Les écarter est juste (une conversation assignée à quelqu'un
                qui ne peut pas se connecter est rangée là où personne ne la lira), mais le produit grise
                ailleurs les options indisponibles AVEC leur raison au lieu de les faire disparaître, et
                ici l'empêchement se lève tout seul dès que la personne accepte son invitation.

                ⚠️ `disabled` SUR L'OPTION, ET PAS SEULEMENT UN LIBELLÉ : un `<option>` grisé ne peut pas
                être choisi, donc l'écran ne peut pas enregistrer une affectation vers un compte qui ne
                se connectera pas. La mention est dans le libellé plutôt qu'à côté, parce qu'un `<select>`
                fermé ne montre rien d'autre que le libellé de la ligne choisie.
              */}
              <Selecteur
                libelle="Personne"
                valeur={etat.assignationUserId ?? ''}
                onChange={(v) => onChange({ assignationUserId: v })}
                options={references.membres.map((m) => ({
                  valeur: m.id,
                  libelle: m.enAttente ? `${m.nom} (invitation en attente)` : m.nom,
                  desactive: m.enAttente,
                }))}
                vide="Aucun collaborateur sur cet espace."
                testId="assignation-personne"
              />
              {references.membres.some((m) => m.enAttente) && (
                <p className="text-xs text-ink-500" data-testid="membres-en-attente">
                  Les membres dont l&apos;invitation est en attente ne peuvent pas encore recevoir de
                  conversation : ils apparaissent ici dès qu&apos;ils ont accepté.
                </p>
              )}
              {/* 🔴 LE NOMBRE AVANT DE VALIDER. Assigner cinq mille conversations à quelqu'un doit se voir
                  au moment où on le décide, pas le lendemain matin quand il ouvre sa liste.
                  ⚠️ À CETTE ÉTAPE, L'AUDIENCE N'EST PAS ENCORE CHOISIE (elle vient à l'étape 4) : on dit
                  donc ce qu'on sait, « toutes », et on renvoie au récapitulatif. Afficher un chiffre
                  inventé serait la seule faute vraiment grave ici. */}
              <p className="text-xs text-ink-500">
                {nbDestinataires === null
                  ? 'Toutes les conversations lui seront attribuées ; leur nombre s’affiche au récapitulatif, une fois l’audience choisie.'
                  : `${nbDestinataires.toLocaleString('fr-FR')} conversations lui seront attribuées.`}
              </p>
            </div>
          )}

          {etat.assignation === 'tour_de_role' && (
            // ⚠️ LE TOUR DE RÔLE SE JOUE À L'ARRIVÉE DE LA RÉPONSE, PAS AU LANCEMENT. Répartir cinq mille
            // conversations d'avance attribuerait des conversations qui n'existeront jamais (la plupart
            // des destinataires ne répondront pas) et fausserait tous les compteurs de charge.
            <p className="mt-3 text-xs text-ink-500">
              Chaque conversation est attribuée au suivant de l&apos;équipe au moment où elle arrive, jamais
              d&apos;avance.
            </p>
          )}
        </div>
    </div>
  );
}

/** Un `select` étiqueté, borné à la largeur de son parent (`w-full`), avec son cas vide. */
function Selecteur({
  libelle,
  valeur,
  onChange,
  options,
  vide,
  testId,
}: {
  libelle: string;
  valeur: string;
  onChange: (v: string) => void;
  options: Array<{ valeur: string; libelle: string; desactive?: boolean }>;
  vide: string;
  /**
   * ⚠️ UNE CLÉ DE TEST PLUTÔT QU'UNE DÉSIGNATION PAR LIBELLÉ, et ce n'est pas un confort : « Modèle »
   * désigne aussi les deux boutons radio « Modèle seul » et « Modèle et scénario » du même cadre, donc
   * une requête par étiquette y trouve trois éléments et échoue. Le libellé reste ce que l'utilisateur
   * lit ; la clé est ce qui désigne le champ sans ambiguïté.
   */
  testId?: string;
}) {
  return (
    <label className="block w-full text-sm">
      <span className="block font-medium text-ink-900">{libelle}</span>
      {options.length === 0 ? (
        <span className="mt-1 block text-xs text-ink-500">{vide}</span>
      ) : (
        <select
          value={valeur}
          onChange={(e) => onChange(e.target.value)}
          {...(testId ? { 'data-testid': testId } : {})}
          className="mt-1 w-full rounded-controle border border-ink-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand-400"
        >
          <option value="">Choisir...</option>
          {options.map((o) => (
            <option key={o.valeur} value={o.valeur} disabled={o.desactive === true}>{o.libelle}</option>
          ))}
        </select>
      )}
    </label>
  );
}

/**
 * Un bouton radio dont le NOM ACCESSIBLE est exactement son libellé.
 *
 * ⚠️ C'est le même invariant que dans l'étape Canal : rien d'autre que le libellé ne rentre dans le
 * `<label>`, sinon aucune requête par rôle ne peut plus désigner la commande sans réciter sa phrase.
 */
function Radio({
  groupe,
  libelle,
  coche,
  desactive,
  onCheck,
}: {
  groupe: string;
  libelle: string;
  coche: boolean;
  desactive?: boolean;
  onCheck: () => void;
}) {
  return (
    <label className={`flex w-full items-center gap-2 text-sm text-ink-900 ${desactive ? 'opacity-50' : ''}`}>
      <input
        type="radio"
        name={groupe}
        checked={coche}
        disabled={desactive === true}
        onChange={onCheck}
        className="h-4 w-4 shrink-0 accent-brand-500"
      />
      <span className="min-w-0 break-words">{libelle}</span>
    </label>
  );
}

export type { Devenir };
