'use client';

import { useRef, useState } from 'react';
import { getTemplateHints, getWorkflow, type RcsSuggestion, type UserFieldDef } from '@/lib/api';
import { RcsButtonsEditor } from '@/components/RcsButtonsEditor';
import { TemplatePreview } from '@/components/TemplatePreview';
import { ChampImageHebergee } from '@/components/ChampImageHebergee';
import { ChampCorpsVariables } from '@/components/ChampCorpsVariables';
import { CreationModeleEnLigne } from '@/components/campagne/CreationModeleEnLigne';
import type { CreatedTemplate } from '@/components/TemplateForm';
import { MAX_BOUTONS_CARTE, MAX_BOUTONS_RCS, maxTexteRcs, versBrouillonRcs } from '@/lib/rcs';
import { RANG_INITIAL, type CanalEtage, type EtageAssistant } from '@/lib/campagne-chaine';
import { champEmailEffectif } from '@/lib/campagne-repartition';
import { modeleDeLEtage } from '@/lib/campagne-creation';
import { SYSTEM_FIELDS, customFieldsOnly, varCountOf } from '@/lib/fields';
import { firstTemplateOf } from '@/lib/campaign-eligibility';
import { appliquerIndices, exemplesDApercu, lignesParDefaut, type VarRow } from '@/lib/variables-template';
import type { TemplateSummary } from '@/lib/api';
import type { CapacitesEspace, ContenuEtage, Devenir, EtatCampagne, ReferencesContenu } from '@/components/campagne/AssistantCampagne';

/**
 * ÉTAPE 3 : le contenu de chaque étage, puis le devenir de la conversation.
 *
 * 🔴 LES CADRES SONT EMPILÉS, JAMAIS CÔTE À CÔTE, ET C'EST DE LA CONCEPTION, PAS DE LA DÉCORATION.
 * Trois cadres à 320 px avec leurs gouttières ne tiennent pas dans les ~990 px utiles d'un 13 pouces, et
 * une grille qui se réorganise sous un seuil produit exactement les chevauchements qu'on cherche à
 * éviter. Un empilement n'a pas de seuil : il ne peut pas se réorganiser, donc il ne peut pas se
 * chevaucher. `web/e2e/campagne-assistant-contenu.spec.ts` le mesure, en plus de mesurer le débordement.
 *
 * 🔴 LE DEVENIR DE LA CONVERSATION EST DEMANDÉ UNE SEULE FOIS, POUR TOUTE LA CAMPAGNE. Le poser par étage
 * serait à la fois faux et impossible à tenir : c'est le MÊME fil de conversation quel que soit le canal
 * par lequel le message est parti, et un contact joint au second étage ne doit pas tomber dans un autre
 * traitement que son voisin joint au premier.
 *
 * ⚠️ ET IL VAUT POUR LES DEUX FORMULES, modèle seul comme modèle plus scénario. Un scénario finit, lui
 * aussi, et la conversation doit alors aller quelque part. Ne poser la question que pour la campagne
 * simple laisserait le cas « scénario » sans réponse, c'est-à-dire des conversations qui retombent dans
 * un défaut que personne n'a choisi.
 *
 * ⚠️ TOUS LES CADRES SONT REPLIÉS À L'ARRIVÉE, un seul s'ouvre à la fois. Deux raisons, et la seconde est
 * la plus utile : on voit d'abord la FORME de sa chaîne (combien d'étages, dans quel ordre) avant de
 * plonger dans l'un d'eux ; et un cadre replié se résume à son en-tête, donc le cadre entier est une
 * cible de clic sans ambiguïté, pour un utilisateur comme pour un test.
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
  /** Le cadre déplié, ou `null`. Un seul à la fois : l'état est local, il ne décrit pas la campagne. */
  const [ouvert, setOuvert] = useState<number | null>(null);

  return (
    <section data-testid="etape-contenu" className="w-full">
      <h2 className="text-lg font-semibold text-ink-800">Que reçoivent les contacts ?</h2>
      <p className="mt-1 text-sm text-ink-500">
        Un cadre par étage de la chaîne, dans l&apos;ordre d&apos;envoi. Ouvrez celui que vous voulez
        remplir.
      </p>

      {chaine.map((etage) => (
        <CadreEtage
          key={etage.rang}
          tenantId={tenantId}
          etage={etage}
          ouvert={ouvert === etage.rang}
          onToggle={() => setOuvert((o) => (o === etage.rang ? null : etage.rang))}
          contenu={etat.contenus[etage.rang] ?? contenuVide()}
          references={references}
          {...(rechargerTemplates ? { rechargerTemplates } : {})}
          modeleSoumis={modeleSoumis}
          onModeleSoumis={onModeleSoumis}
          onChange={(patch) => onContenu(etage.rang, patch)}
        />
      ))}

      {/*
        🔴 LA QUESTION DU DEVENIR N'APPARAÎT QU'UNE FOIS L'ÉTAGE 1 REMPLI (2026-09-13, demande de Julien
        après son essai réel). Demander « que se passe-t-il quand le contact répond ? » avant de savoir ce
        que le contact REÇOIT pose la question dans le désordre : la réponse dépend de ce qu'on envoie, et
        l'écran donnait à croire que l'étape était finie alors que rien n'avait été choisi.

        ⚠️ ELLE SE LIT SUR LE RANG 1 SEUL, pas sur la chaîne entière, et la nuance compte : sur une chaîne
        de repli, on remplit son premier étage puis on veut régler le devenir sans avoir à descendre
        remplir d'abord l'étage 2. La conversation, elle, n'a qu'un devenir pour toute la campagne.
      */}
      {!rangsIncomplets.includes(RANG_INITIAL) && (
        <BlocDevenir
          etat={etat}
          references={references}
          capacites={capacites}
          nbDestinataires={nbDestinataires}
          onChange={onChange}
        />
      )}

      {/* Ce qui reste à remplir, nommé. Un bouton grisé sans sa raison est le défaut qu'on vient de
          corriger ailleurs : l'écran doit dire ce qu'il attend, au moment où il l'attend. */}
      {rangsIncomplets.length > 0 && (
        <p className="mt-4 rounded-lg bg-gold/10 px-3 py-2 text-sm text-ink-700" data-testid="contenu-incomplet">
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
export function contenuVide(): ContenuEtage {
  return { formule: 'seul', suggestions: [] };
}

function CadreEtage({
  tenantId,
  etage,
  ouvert,
  onToggle,
  contenu,
  references,
  rechargerTemplates,
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
      className="mt-3 w-full overflow-hidden rounded-xl border border-ink-200"
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={ouvert}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left hover:bg-ink-50"
      >
        <span id={titreId} className="min-w-0 break-words text-sm font-medium text-ink-800">
          Étage {etage.rang} · {LIBELLE_CANAL[etage.canal]}
        </span>
        <span aria-hidden className="shrink-0 text-ink-400">{ouvert ? '–' : '+'}</span>
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
              modeleSoumis={modeleSoumis}
              onModeleSoumis={onModeleSoumis}
              onChange={onChange}
            />
          )}
          {etage.canal === 'rcs' && <CadreRcs tenantId={tenantId} rang={etage.rang} contenu={contenu} references={references} onChange={onChange} />}
          {etage.canal === 'email' && <CadreEmail contenu={contenu} references={references} onChange={onChange} />}
        </div>
      )}
    </div>
  );
}

function CadreWhatsApp({
  tenantId,
  rang,
  contenu,
  references,
  rechargerTemplates,
  modeleSoumis,
  onModeleSoumis,
  onChange,
}: {
  tenantId: string;
  rang: number;
  contenu: ContenuEtage;
  references: ReferencesContenu;
  rechargerTemplates?: (silencieux?: boolean) => Promise<TemplateSummary[]>;
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
   * choisi SANS modèle connu, et c'est le récapitulatif qui le dira plutôt que l'écran d'ici.
   */
  const choisirScenario = (id: string): void => {
    onChange({ workflowId: id });
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
      <Selecteur
        libelle="Modèle"
        testId={`modele-${rang}`}
        valeur={contenu.templateName ?? ''}
        onChange={choisirModele}
        options={references.templates.map((t) => ({ valeur: t.name, libelle: `${t.name} (${t.language})` }))}
        vide="Aucun modèle approuvé sur cet espace."
      />
      {/*
        🔴 LE PARCOURS DE SOUMISSION À META EST CELUI DE L'ÉCRAN EN SERVICE, pas une seconde version. Un
        modèle neuf revient `PENDING`, donc inenvoyable, et le sélecteur ci-dessus ne liste que les
        approuvés : c'est tout l'objet du panneau, qui nomme l'attente et choisit le modèle dès son
        approbation. Le refaire ici aurait donné deux façons de soumettre un modèle à Meta.
      */}
      {rechargerTemplates && (
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
        <SelecteurScenario contenu={contenu} references={references} onChange={choisirScenario} testId={`scenario-${rang}`} />
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
      <p className="text-sm font-medium text-ink-700">Variables ({nbVariables})</p>
      <div className="mt-1 w-full space-y-2">
        {lignes.map((l, i) => (
          <div key={`var-${i + 1}`} className="flex w-full items-center gap-1.5">
            <span className="w-10 shrink-0 text-xs text-ink-400">{`{{${i + 1}}}`}</span>
            <select
              value={l.sel}
              onChange={(e) => majLigne(i, { sel: e.target.value })}
              data-testid={`variable-${rang}-${i + 1}`}
              aria-label={`Variable ${i + 1}`}
              className="min-w-0 flex-1 rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand-400"
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
                className="w-28 min-w-0 shrink rounded-lg border border-ink-200 px-3 py-2 text-sm outline-none focus:border-brand-400"
              />
            )}
          </div>
        ))}
      </div>
      <p className="mt-1.5 text-[11px] text-ink-400">
        Un contact sans la valeur choisie est écarté de la campagne, et le récapitulatif le compte.
      </p>
    </div>
  );
}

function CadreRcs({
  tenantId,
  rang,
  contenu,
  references,
  onChange,
}: {
  /** L'espace, pour TÉLÉVERSER le visuel : c'est le seul appel réseau de ce cadre. */
  tenantId: string;
  rang: number;
  contenu: ContenuEtage;
  references: ReferencesContenu;
  onChange: (patch: Partial<ContenuEtage>) => void;
}) {
  const image = contenu.imageRcs ?? '';
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
        campagne déjà partie. `versBrouillonRcs` rend `null` sur un format que ce composeur ne sait pas
        éditer (carrousel, carte à titre), et ces messages-là ne sont donc PAS proposés : les ouvrir à
        moitié réenregistrerait un message amputé.
      */}
      <Selecteur
        libelle="Partir d’un message enregistré"
        testId={`rcs-bibliotheque-${rang}`}
        valeur=""
        onChange={(id) => {
          const b = versBrouillonRcs(references.messagesRcs.find((m) => m.id === id)?.content ?? null);
          // ⚠️ UN SEUL PATCH POUR LES TROIS CHAMPS : trois appels de suite partiraient du même état de
          // rendu et les deux derniers effaceraient le premier. Même règle que le choix d'un modèle.
          if (b) onChange({ texteRcs: b.text, imageRcs: b.imageUrl, suggestions: b.suggestions });
        }}
        options={references.messagesRcs
          .filter((m) => versBrouillonRcs(m.content) !== null)
          .map((m) => ({ valeur: m.id, libelle: m.name }))}
        vide="Aucun message RCS enregistré sur cet espace."
      />
      {/*
        🔴 LE VISUEL CHANGE LE FORMAT DU MESSAGE, PAS SEULEMENT SON APPARENCE. Dès qu'il y en a un,
        `versMessageRcs` bascule en CARTE : l'image passe au-dessus du texte, les boutons deviennent des
        boutons pleine largeur empilés DANS la carte (4 au plus) au lieu de pastilles éphémères sous la
        bulle (11 au plus), et le plafond de texte descend de 3 072 à 2 000 caractères. Les deux plafonds
        ci-dessous suivent donc le visuel, sans quoi l'écran laisserait saisir ce que l'envoi refuserait.
      */}
      <div>
        <p className="text-sm font-medium text-ink-700">Visuel</p>
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
          et l'éditeur partagé est celui des trois autres écrans, pas une quatrième copie.
          ⚠️ On part de ZÉRO suggestion : une suggestion posée d'office serait un bouton vide envoyé à des
          clients par celui qui n'aurait pas pensé à la retirer. */}
      <div>
        <p className="text-sm font-medium text-ink-700">Suggestions</p>
        <div className="mt-1 w-full">
          <RcsButtonsEditor
            boutons={contenu.suggestions}
            onChange={(b: RcsSuggestion[]) => onChange({ suggestions: b })}
            max={image.trim() !== '' ? MAX_BOUTONS_CARTE : MAX_BOUTONS_RCS}
            dateFields={references.userFields}
            testIdPrefix={`campagne-rcs-${rang}`}
            libelleAjout="Ajouter une suggestion"
            compact
          />
        </div>
      </div>
      <p className="text-[11px] text-amber-700">
        Les contacts non joignables en RCS ne reçoivent RIEN et sont comptés « ignorés » dans le rapport.
      </p>
      {/* ⚠️ Un scénario RCS n'a pas de modèle WhatsApp à paramétrer : on ne pose que son identifiant. */}
      {contenu.formule === 'avec_scenario' && (
        <SelecteurScenario contenu={contenu} references={references} onChange={(v) => onChange({ workflowId: v })} />
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
      <Selecteur
        libelle="Modèle d'e-mail"
        valeur={contenu.emailTemplateId ?? ''}
        onChange={(v) => onChange({ emailTemplateId: v })}
        options={references.emailTemplates.map((t) => ({ valeur: t.id, libelle: t.name }))}
        vide="Aucun modèle d'e-mail sur cet espace."
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
      <p className="rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">
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
      <Radio groupe={groupe} libelle={seul} coche={contenu.formule === 'seul'} onCheck={() => onChange({ formule: 'seul' })} />
      <Radio
        groupe={groupe}
        libelle={avecScenario}
        coche={contenu.formule === 'avec_scenario'}
        onCheck={() => onChange({ formule: 'avec_scenario' })}
      />
    </div>
  );
}

function SelecteurScenario({
  contenu,
  references,
  onChange,
  testId,
}: {
  contenu: ContenuEtage;
  references: ReferencesContenu;
  /**
   * ⚠️ LA VALEUR, PAS UN PATCH. Choisir un scénario ne pose plus seulement son identifiant : il faut
   * aussi lire le modèle par lequel il ouvre, pour savoir combien de variables la campagne doit fournir.
   * Un patch laisserait cette lecture au bon vouloir de chaque appelant.
   */
  onChange: (workflowId: string) => void;
  /** Cf. `Selecteur.testId` : « Scénario » est sans ambiguïté, mais l'écran en porte un par étage. */
  testId?: string;
}) {
  return (
    <Selecteur
      libelle="Scénario"
      {...(testId ? { testId } : {})}
      valeur={contenu.workflowId ?? ''}
      onChange={onChange}
      options={references.workflows.map((w) => ({ valeur: w.id, libelle: w.name }))}
      vide="Aucun scénario lançable en campagne sur cet espace."
    />
  );
}

/**
 * LE DEVENIR DE LA CONVERSATION, posé une fois pour toute la campagne.
 */
function BlocDevenir({
  etat,
  references,
  capacites,
  nbDestinataires,
  onChange,
}: {
  etat: EtatCampagne;
  references: ReferencesContenu;
  capacites: CapacitesEspace;
  nbDestinataires: number | null;
  onChange: (patch: Partial<EtatCampagne>) => void;
}) {
  const sansAgent = references.agents.length === 0;
  return (
    <div data-testid="bloc-devenir" className="mt-6 w-full rounded-xl border border-ink-200 p-4">
      <p className="text-sm font-medium text-ink-800">Que se passe-t-il quand le contact répond ?</p>
      <div className="mt-3 space-y-2">
        <Radio
          groupe="devenir"
          libelle="L'agent de Meta prend la main"
          coche={etat.devenir === 'mba'}
          desactive={!capacites.mbaEnabled}
          onCheck={() => onChange({ devenir: 'mba' })}
        />
        <Radio
          groupe="devenir"
          libelle="Un agent IA prend la main"
          coche={etat.devenir === 'agent'}
          desactive={sansAgent}
          onCheck={() => onChange({ devenir: 'agent' })}
        />
        <Radio
          groupe="devenir"
          libelle="La conversation arrive dans l'Inbox"
          coche={etat.devenir === 'inbox'}
          onCheck={() => onChange({ devenir: 'inbox' })}
        />
      </div>
      {/* ⚠️ GRISÉ AVEC SA RAISON, comme les canaux de l'étape précédente : une option absente ferait croire
          que la fonctionnalité n'existe pas. */}
      {sansAgent && (
        <p className="mt-3 rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">
          Aucun agent IA actif sur cet espace.
        </p>
      )}

      {etat.devenir === 'agent' && !sansAgent && (
        <div className="mt-3">
          <Selecteur
            libelle="Agent"
            valeur={etat.agentId ?? ''}
            onChange={(v) => onChange({ agentId: v })}
            options={references.agents.map((a) => ({ valeur: a.id, libelle: a.label }))}
            vide="Aucun agent IA actif sur cet espace."
          />
        </div>
      )}

      {etat.devenir === 'inbox' && (
        <div className="mt-4 border-t border-ink-100 pt-4">
          <p className="text-sm font-medium text-ink-700">À qui va la conversation ?</p>
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
              <p className="text-xs text-ink-600">
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
            <p className="mt-3 text-xs text-ink-600">
              Chaque conversation est attribuée au suivant de l&apos;équipe au moment où elle arrive, jamais
              d&apos;avance.
            </p>
          )}
        </div>
      )}
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
      <span className="block font-medium text-ink-700">{libelle}</span>
      {options.length === 0 ? (
        <span className="mt-1 block text-xs text-ink-500">{vide}</span>
      ) : (
        <select
          value={valeur}
          onChange={(e) => onChange(e.target.value)}
          {...(testId ? { 'data-testid': testId } : {})}
          className="mt-1 w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand-400"
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
    <label className={`flex w-full items-center gap-2 text-sm text-ink-800 ${desactive ? 'opacity-50' : ''}`}>
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
