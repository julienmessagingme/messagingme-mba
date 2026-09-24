'use client';

import { useEffect, useState } from 'react';
import { ApiError } from '@/lib/http';
import { useT } from '@/lib/i18n';
import { getWorkflow, estEnLigne } from '@/lib/api';
import { premiereReponse } from '@/lib/apercu-reponse';
import {
  creerPub, creerBrouillon, majBrouillon, supprimerBrouillon,
  TAILLE_VISUEL_MAX, TYPES_VISUEL,
  type BrouillonPubComplet, type DestinationPub, type FormulaireBrouillonPub, type FormulaireCreationPub,
} from '@/lib/api-pubs';
import { PubApercu, type EtatReponse } from '@/components/PubApercu';

/**
 * LE FORMULAIRE DE CRÉATION D'UNE PUBLICITÉ (lot 3, spec § 3.2). Minimal, délibérément : tout ce qui n'est
 * pas ici se fait dans le Gestionnaire de Meta, et c'est une décision produit, pas une limite technique.
 *
 * 🔴 CE FORMULAIRE NE FAIT DÉPENSER PERSONNE. Tout est créé EN PAUSE chez Meta ; c'est le bouton
 * « Publier » de la liste, un geste distinct, qui engage le budget. Le dire ici évite qu'on hésite à
 * essayer.
 *
 * 🔴 LES BORNES SONT VÉRIFIÉES CÔTÉ SERVEUR, ET C'EST LUI QUI FAIT AUTORITÉ. Ce qui est fait ici ne sert
 * qu'à éviter un aller-retour : un contrôle de navigateur n'est pas une garde, il est contournable en
 * ouvrant la console. Les deux existent, et seul le second protège.
 */


export function PubFormulaire({
  tenantId, scenarios, agentMetaOuvert, nomPage, brouillon, brouillonsIndisponibles,
  fermer, creee, brouillonsChanges,
}: {
  tenantId: string;
  /** Les scénarios publiés de l'espace, pour choisir qui répond. */
  scenarios: Array<{ id: string; name: string }>;
  /**
   * L'agent de Meta répond-il à tout le monde sur ce numéro ?
   *
   * 🔴 QUAND IL EST ÉTEINT, LE CHOIX N'EST PAS PROPOSÉ, et l'écran dit pourquoi. Le proposer quand même
   * créerait une publicité dont les prospects n'arriveraient nulle part : c'est le « proposé mais inerte »
   * que le produit s'interdit.
   */
  /**
   * 🔴 `null` = PAS ENCORE LU, ET CE N'EST PAS « éteint ». Le formulaire se FERME sur l'inconnu (bon
   * sens d'erreur : proposer l'agent de Meta sans l'avoir lu ferait créer une publicité sans répondeur),
   * mais il ne l'AFFIRME pas : dire « l'agent de Meta n'est pas ouvert sur ce numéro » est un énoncé sur
   * la configuration Meta du client, et nous n'avons fait qu'échouer à lire NOTRE réglage.
   */
  agentMetaOuvert: boolean | null;
  /**
   * Le nom de la Page connectée, pour l'aperçu seulement (migration 0169).
   *
   * ⚠️ Il ne sert QU'À MONTRER, jamais à envoyer : la publicité part sur le `pageId` de la connexion, lu
   * côté serveur. Un nom manquant dégrade donc l'aperçu et rien d'autre, ce qui est la bonne dépendance
   * pour un champ décoratif.
   */
  nomPage: string | null;
  /**
   * Le brouillon qu'on rouvre, visuel compris, ou `null` pour un formulaire neuf.
   *
   * ⚠️ IL NE SERT QU'À L'INITIALISATION, et le composant doit donc être monté avec une `key` qui change
   * avec lui. Le relire en cours de saisie écraserait ce que la personne est en train de taper.
   */
  brouillon: BrouillonPubComplet | null;
  /**
   * 🔴 L'API DÉPLOYÉE N'A PAS ENCORE LA ROUTE DES BROUILLONS, ET LE FORMULAIRE CESSE DE LA PROPOSER.
   *
   * Vercel publie cette console à CHAQUE `git push`, l'API attend son `up` : entre les deux, un bouton
   * qui appelle une route absente rend le message brut du routeur. Tolérer l'absence en LECTURE ne
   * suffisait pas, c'est l'ÉCRITURE qu'il fallait fermer. Même défaut que l'onglet « Outils » du
   * 2026-09-21, resté en 404 plus d'une heure sur un espace qui avait pourtant des outils publiés.
   */
  brouillonsIndisponibles: boolean;
  fermer: () => void;
  creee: () => Promise<void>;
  /** Recharge la liste des brouillons après un enregistrement ou une suppression. */
  brouillonsChanges: () => Promise<void>;
}) {
  const t = useT();
  // Les valeurs de DÉPART viennent du brouillon quand il y en a un. Les défauts d'un formulaire neuf
  // (« FR », 18, 65) ne s'appliquent donc qu'à un formulaire neuf : un brouillon qui a vidé le pays doit
  // rouvrir vide, sinon l'écran réécrirait un choix que la personne avait retiré.
  const [nom, setNom] = useState(brouillon?.nom ?? '');
  const [texte, setTexte] = useState(brouillon?.texte ?? '');
  const [titre, setTitre] = useState(brouillon?.titre ?? '');
  const [messagePreRempli, setMessagePreRempli] = useState(brouillon?.messagePreRempli ?? '');
  const [accueil, setAccueil] = useState(brouillon?.accueil ?? '');
  const [budgetTotal, setBudgetTotal] = useState(brouillon?.budgetTotal ?? '');
  const [debut, setDebut] = useState(brouillon?.debut ?? '');
  const [fin, setFin] = useState(brouillon?.fin ?? '');
  const [pays, setPays] = useState(brouillon === null ? 'FR' : brouillon.pays);
  const [ageMin, setAgeMin] = useState(brouillon === null ? '18' : brouillon.ageMin);
  const [ageMax, setAgeMax] = useState(brouillon === null ? '65' : brouillon.ageMax);
  const [destination, setDestination] = useState<DestinationPub>(brouillon?.destination ?? 'scenario');
  const [workflowId, setWorkflowId] = useState(brouillon?.workflowId ?? '');
  const [tagQualification, setTagQualification] = useState(brouillon?.tagQualification ?? '');
  const [horsCategorie, setHorsCategorie] = useState(false);
  const [image, setImage] = useState<{ type: 'image/jpeg' | 'image/png'; base64: string; nom: string } | null>(
    brouillon?.visuel ? { ...brouillon.visuel, nom: '' } : null,
  );
  /**
   * L'identifiant du brouillon en cours d'édition. `null` = on n'en a pas encore enregistré.
   *
   * ⚠️ IL BOUGE APRÈS LE PREMIER ENREGISTREMENT, ce qui évite le défaut le plus banal de ce genre d'écran :
   * cliquer trois fois sur « Enregistrer le brouillon » créerait trois brouillons identiques.
   */
  const [brouillonId, setBrouillonId] = useState<string | null>(brouillon?.id ?? null);
  /**
   * 🔴 LE VISUEL A-T-IL ÉTÉ TOUCHÉ DEPUIS L'OUVERTURE ? C'est ce drapeau qui porte la sémantique à trois
   * états côté serveur. Sans lui, on ne saurait pas distinguer « le brouillon avait une image et je n'y ai
   * pas touché » (ne pas l'envoyer, donc la conserver) de « j'ai retiré l'image » (envoyer `null`). Envoyer
   * systématiquement l'image relue serait possible mais ferait remonter 5 Mo à chaque enregistrement.
   */
  const [visuelTouche, setVisuelTouche] = useState(false);
  const [brouillonBusy, setBrouillonBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reponse, setReponse] = useState<EtatReponse>({ etat: 'sans_scenario' });

  /**
   * LE TROISIÈME ÉCRAN DE L'APERÇU : ce que le prospect recevra.
   *
   * 🔴 ON LIT LE GRAPHE PUBLIÉ, ET UNIQUEMENT LUI. `WorkflowSummary.graph` est « celui que les contacts
   * parcourent » ; `draftGraph` est l'édition en cours. Un lead publicitaire ne verra JAMAIS le brouillon,
   * donc l'afficher ferait valider un message que personne ne recevra tant qu'on n'a pas republié.
   *
   * ⚠️ `vivant` ferme la course : on change de scénario dans la liste plus vite que les réponses
   * n'arrivent, et sans lui la réponse d'un scénario abandonné écraserait celle du scénario choisi.
   */
  useEffect(() => {
    if (destination === 'agent_meta') { setReponse({ etat: 'agent_meta' }); return; }
    if (workflowId === '') { setReponse({ etat: 'sans_scenario' }); return; }
    let vivant = true;
    setReponse({ etat: 'chargement' });
    getWorkflow(tenantId, workflowId)
      .then((r) => {
        if (!vivant) return;
        // Jamais publié : un clic payé recevrait le silence, et c'est une ALERTE, pas une information.
        if (!estEnLigne(r.workflow)) { setReponse({ etat: 'hors_ligne' }); return; }
        setReponse({ etat: 'connue', reponse: premiereReponse(r.workflow.graph ?? { nodes: [], edges: [] }) });
      })
      // ⚠️ NOTRE ÉCHEC DE LECTURE N'EST PAS UN VERDICT SUR LEUR SCÉNARIO : l'aperçu le dit, il n'invente
      // ni réponse ni alerte. Même règle que l'état de l'agent de Meta, trois fois payée sur ce lot.
      .catch(() => { if (vivant) setReponse({ etat: 'illisible' }); });
    return () => { vivant = false; };
  }, [tenantId, destination, workflowId]);

  async function choisirImage(f: File | null): Promise<void> {
    setErreur(null);
    // Toute interaction avec le champ compte comme « touché », y compris celle qui vide la sélection :
    // c'est le geste par lequel on RETIRE le visuel d'un brouillon.
    setVisuelTouche(true);
    if (f === null) { setImage(null); return; }
    if (!(TYPES_VISUEL as readonly string[]).includes(f.type)) {
      setErreur(t('Le visuel doit être un JPEG ou un PNG.', 'The image must be a JPEG or a PNG.'));
      return;
    }
    if (f.size > TAILLE_VISUEL_MAX) {
      setErreur(t('Le visuel dépasse 5 Mo.', 'The image is over 5 MB.'));
      return;
    }
    const octets = new Uint8Array(await f.arrayBuffer());
    let binaire = '';
    for (const o of octets) binaire += String.fromCharCode(o);
    setImage({ type: f.type as 'image/jpeg' | 'image/png', base64: btoa(binaire), nom: f.name });
  }

  /**
   * Le formulaire TEL QU'IL EST, sans aucune validation : c'est tout ce qu'un brouillon promet.
   *
   * 🔴 LA CLÉ `image` N'EST POSÉE QUE SI LE VISUEL A ÉTÉ TOUCHÉ. Absente, le serveur conserve celui qu'il a ;
   * c'est ce qui permet de corriger un texte sans renvoyer, ni perdre, plusieurs mégaoctets.
   */
  function champsBrouillon(): FormulaireBrouillonPub {
    return {
      nom, titre, texte, accueil, messagePreRempli,
      budgetTotal, debut, fin, pays, ageMin, ageMax, tagQualification, destination,
      workflowId: workflowId === '' ? null : workflowId,
      ...(visuelTouche ? { image: image === null ? null : { type: image.type, base64: image.base64 } } : {}),
    };
  }

  async function enregistrerBrouillon(): Promise<void> {
    setErreur(null);
    setBrouillonBusy(true);
    try {
      if (brouillonId === null) {
        const { id } = await creerBrouillon(tenantId, champsBrouillon());
        // ⚠️ On RETIENT l'identifiant : sans ça, trois clics sur « Enregistrer » créeraient trois brouillons.
        setBrouillonId(id);
      } else {
        await majBrouillon(tenantId, brouillonId, champsBrouillon());
      }
      // Le serveur porte désormais ce que nous venons d'envoyer : le visuel n'est plus « touché ».
      setVisuelTouche(false);
      await brouillonsChanges();
    } catch (err) {
      // ⚠️ CEINTURE EN PLUS DU BOUTON MASQUÉ : la route peut disparaître ENTRE le montage de l'écran et
      // le clic (c'est la fenêtre Vercel/API, qui dure quelques minutes). Un message de routeur brut ne
      // se relie à rien ; celui-ci dit ce qui se passe et que la création, elle, reste possible.
      if (err instanceof ApiError && err.status === 404) {
        setErreur(t('Les brouillons attendent la mise à jour du serveur. Vous pouvez créer la publicité normalement.',
                    'Drafts are waiting for the server update. You can still create the ad as usual.'));
      } else {
        setErreur(err instanceof Error ? err.message : t('Enregistrement impossible', 'Could not save'));
      }
    } finally {
      setBrouillonBusy(false);
    }
  }

  async function envoyer(): Promise<void> {
    setErreur(null);
    if (image === null) { setErreur(t('Choisissez un visuel.', 'Choose an image.')); return; }
    const budget = Number(budgetTotal);
    if (!Number.isFinite(budget) || budget <= 0) {
      setErreur(t('Indiquez un budget total supérieur à zéro.', 'Enter a total budget above zero.'));
      return;
    }
    if (destination === 'scenario' && workflowId === '') {
      setErreur(t('Choisissez le scénario qui répondra aux prospects.', 'Choose the scenario that will answer leads.'));
      return;
    }
    const f: FormulaireCreationPub = {
      nom: nom.trim(), texte: texte.trim(), titre: titre.trim(),
      messagePreRempli: messagePreRempli.trim(), accueil: accueil.trim(),
      budgetTotal: budget,
      debut, fin,
      pays: pays.split(',').map((p) => p.trim().toUpperCase()).filter((p) => p.length === 2),
      villes: [],
      ageMin: Number(ageMin), ageMax: Number(ageMax),
      destination,
      workflowId: destination === 'scenario' ? workflowId : null,
      tagQualification: tagQualification.trim() === '' ? null : tagQualification.trim(),
      horsCategorieSpeciale: true,
      image: { type: image.type, base64: image.base64 },
    };
    setBusy(true);
    try {
      await creerPub(tenantId, f);
      if (brouillonId !== null) {
        /**
         * 🔴 LE BROUILLON DISPARAÎT AVEC LA CRÉATION, dans le même geste. Le laisser produirait deux lignes
         * pour une seule intention, et le client corrigerait un jour le brouillon en croyant corriger sa
         * publicité.
         *
         * ⚠️ MAIS SON ÉCHEC NE FAIT PAS ÉCHOUER LA CRÉATION, et c'est délibéré : la publicité EXISTE chez
         * Meta à ce stade. Remonter une erreur ici ferait croire que rien n'a été créé, ce qui est le pire
         * message possible sur un geste qui engage de l'argent. Le brouillon restant se voit dans la liste
         * et se supprime à la main.
         */
        await supprimerBrouillon(tenantId, brouillonId).catch(() => {});
        await brouillonsChanges();
      }
      await creee();
      fermer();
    } catch (err) {
      // Le message de META, tel quel : c'est son compte, et lui seul peut agir sur ce qu'il refuse.
      setErreur(err instanceof Error ? err.message : t('Création impossible', 'Could not create'));
    } finally {
      setBusy(false);
    }
  }

  const champ = 'mt-1 w-full rounded-xl border border-ink-200 px-3 py-2 text-sm';
  const label = 'mt-3 block text-xs font-medium text-ink-500';

  return (
    <div className="mt-4 rounded-2xl border border-ink-200 bg-white p-5" data-testid="pub-formulaire">
      <h3 className="text-sm font-semibold text-ink-900">{t('Nouvelle publicité', 'New ad')}</h3>
      <p className="mt-1 text-xs text-ink-500">
        {t('Tout est créé EN PAUSE chez Meta : rien ne dépense tant que vous n’avez pas publié.',
           'Everything is created PAUSED at Meta: nothing spends until you publish.')}
      </p>

      {erreur !== null && (
        <p role="alert" data-testid="pub-form-erreur" className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{erreur}</p>
      )}

      {/* 🔴 DEUX COLONNES À PARTIR DE `lg`, ET L'APERÇU RESTE COLLÉ. Les champs seuls ne disaient rien de ce
          qu'ils fabriquent : on saisissait six textes et une image sans jamais voir l'annonce. Sous `lg`,
          la grille retombe en une colonne et l'aperçu passe SOUS le formulaire, jamais au-dessus : sur un
          téléphone, ce qu'on vient remplir doit rester la première chose à portée. */}
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-6">
        <div>
      <label className={label} htmlFor="pub-nom">{t('Nom de la campagne', 'Campaign name')}</label>
      <input id="pub-nom" className={champ} value={nom} onChange={(e) => setNom(e.target.value)} maxLength={120} />

      <label className={label} htmlFor="pub-titre">{t('Titre affiché', 'Headline')}</label>
      <input id="pub-titre" className={champ} value={titre} onChange={(e) => setTitre(e.target.value)} maxLength={60} />

      <label className={label} htmlFor="pub-texte">{t('Texte principal', 'Primary text')}</label>
      <textarea id="pub-texte" className={champ} rows={3} value={texte} onChange={(e) => setTexte(e.target.value)} maxLength={1000} />

      <label className={label} htmlFor="pub-accueil">{t('Phrase d’accueil dans la conversation', 'Greeting in the conversation')}</label>
      <input id="pub-accueil" className={champ} value={accueil} onChange={(e) => setAccueil(e.target.value)} maxLength={500} />

      <label className={label} htmlFor="pub-prerempli">{t('Message pré-rempli chez le prospect', 'Message pre-filled for the lead')}</label>
      <input id="pub-prerempli" className={champ} value={messagePreRempli} onChange={(e) => setMessagePreRempli(e.target.value)} maxLength={200} />
      <p className="mt-1 text-xs text-ink-400">
        {/* Les deux textes se confondent facilement, et les inverser produit une publicité absurde. */}
        {t('C’est ce que WhatsApp écrit dans sa zone de saisie : il n’a plus qu’à l’envoyer.',
           'This is what WhatsApp types in their input box: they just press send.')}
      </p>

      <label className={label} htmlFor="pub-image">{t('Visuel (JPEG ou PNG, 5 Mo maximum)', 'Image (JPEG or PNG, 5 MB max)')}</label>
      <input
        id="pub-image" type="file" accept="image/jpeg,image/png" className={champ}
        onChange={(e) => void choisirImage(e.target.files?.[0] ?? null)}
      />
      {image !== null && <p className="mt-1 text-xs text-ink-500">{image.nom}</p>}

      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className={label} htmlFor="pub-budget">{t('Budget total', 'Total budget')}</label>
          <input id="pub-budget" className={champ} inputMode="decimal" value={budgetTotal} onChange={(e) => setBudgetTotal(e.target.value)} />
        </div>
        <div>
          <label className={label} htmlFor="pub-debut">{t('Début', 'Start')}</label>
          <input id="pub-debut" className={champ} type="datetime-local" value={debut} onChange={(e) => setDebut(e.target.value)} />
        </div>
        <div>
          <label className={label} htmlFor="pub-fin">{t('Fin', 'End')}</label>
          <input id="pub-fin" className={champ} type="datetime-local" value={fin} onChange={(e) => setFin(e.target.value)} />
        </div>
      </div>
      <p className="mt-1 text-xs text-ink-400">
        {/* 🔴 Le garde-fou de dépense, dit à l'endroit où on le saisit. */}
        {t('Le budget total et la date de fin sont obligatoires : ce sont eux qui bornent la dépense.',
           'Total budget and end date are required: they are what caps the spend.')}
      </p>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className={label} htmlFor="pub-pays">{t('Pays (codes à deux lettres)', 'Countries (two-letter codes)')}</label>
          <input id="pub-pays" className={champ} value={pays} onChange={(e) => setPays(e.target.value)} />
        </div>
        <div>
          <label className={label} htmlFor="pub-age-min">{t('Âge minimum', 'Minimum age')}</label>
          <input id="pub-age-min" className={champ} inputMode="numeric" value={ageMin} onChange={(e) => setAgeMin(e.target.value)} />
        </div>
        <div>
          <label className={label} htmlFor="pub-age-max">{t('Âge maximum', 'Maximum age')}</label>
          <input id="pub-age-max" className={champ} inputMode="numeric" value={ageMax} onChange={(e) => setAgeMax(e.target.value)} />
        </div>
      </div>

      <label className={label} htmlFor="pub-destination">{t('Qui répond aux prospects', 'Who answers leads')}</label>
      <select
        id="pub-destination" className={champ} value={destination}
        onChange={(e) => setDestination(e.target.value === 'agent_meta' ? 'agent_meta' : 'scenario')}
        data-testid="pub-destination"
      >
        <option value="scenario">{t('Un scénario', 'A scenario')}</option>
        {/* 🔴 PROPOSÉ SEULEMENT SI L'AGENT DE META RÉPOND VRAIMENT. Sinon, les prospects de cette publicité
            n'arriveraient nulle part, et rien ne le dirait. */}
        {agentMetaOuvert === true && <option value="agent_meta">{t('L’agent de Meta', 'The Meta agent')}</option>}
      </select>
      {agentMetaOuvert === false && (
        <p className="mt-1 text-xs text-ink-400" data-testid="pub-agent-indispo">
          {t('L’agent de Meta n’est pas ouvert à tout le monde sur ce numéro : il ne peut pas répondre à ces prospects.',
             'The Meta agent is not open to everyone on this number: it cannot answer these leads.')}
        </p>
      )}
      {agentMetaOuvert === null && (
        /* ⚠️ ON DIT NOTRE IGNORANCE, PAS UN VERDICT SUR LEUR NUMÉRO. L'option reste cachée, ce qui est le
           bon sens d'erreur, mais la phrase décrit CE QUI S'EST PASSÉ CHEZ NOUS. */
        <p className="mt-1 text-xs text-ink-400" data-testid="pub-agent-inconnu">
          {t('Nous n’avons pas pu lire l’état de l’agent de Meta pour cet espace : rechargez la page pour le proposer.',
             'We could not read the Meta agent state for this space: reload the page to offer it.')}
        </p>
      )}
      {destination === 'agent_meta' && (
        <p className="mt-1 text-xs text-amber-700">
          {t('Ses messages restent facturés au jeton, même pendant les 72 heures gratuites.',
             'Its messages are still billed per token, even during the free 72 hours.')}
        </p>
      )}

      {destination === 'scenario' && (
        <>
          <label className={label} htmlFor="pub-scenario">{t('Scénario', 'Scenario')}</label>
          <select id="pub-scenario" className={champ} value={workflowId} onChange={(e) => setWorkflowId(e.target.value)} data-testid="pub-scenario">
            <option value="">{t('Choisir…', 'Choose…')}</option>
            {scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          {/* ⚠️ `=== true` ET PAS UNE VÉRACITÉ : `null` est falsy, donc le comportement serait le même,
              mais c'est précisément la forme qui a effacé la distinction trois fois dans ce lot. */}
          {agentMetaOuvert === true && (
            <p className="mt-1 text-xs text-ink-400" data-testid="pub-agent-ecarte">
              {t('L’agent de Meta sera écarté des prospects de cette publicité : c’est le scénario qui répond.',
                 'The Meta agent will be kept away from this ad’s leads: the scenario answers.')}
            </p>
          )}
        </>
      )}

      <label className={label} htmlFor="pub-tag">{t('Tag qui marque un prospect qualifié (facultatif)', 'Tag marking a qualified lead (optional)')}</label>
      <input id="pub-tag" className={champ} value={tagQualification} onChange={(e) => setTagQualification(e.target.value)} maxLength={64} />
      <p className="mt-1 text-xs text-ink-400">
        {/* ⚠️ LA LIMITE EST DITE ICI, pas découverte plus tard devant un entonnoir qui ne bouge pas. */}
        {t('Compté quand le tag est posé par un scénario, l’Inbox ou un agent IA, dans les 28 jours. Une pose en masse ou un import ne comptent pas.',
           'Counted when the tag is set by a scenario, the Inbox or an AI agent, within 28 days. Bulk tagging and imports do not count.')}
      </p>

      <label className="mt-4 flex items-start gap-2 text-xs text-ink-700">
        <input
          type="checkbox" checked={horsCategorie} onChange={(e) => setHorsCategorie(e.target.checked)}
          data-testid="pub-hors-categorie" className="mt-0.5"
        />
        <span>
          {t('Cette publicité ne relève d’aucune catégorie spéciale (logement, emploi, crédit, politique).',
             'This ad does not fall under any special category (housing, employment, credit, politics).')}
          {' '}
          <span className="text-ink-400">
            {t('Ces catégories imposent des obligations que cet écran ne porte pas : passez par le Gestionnaire de Meta.',
               'Those categories carry obligations this screen does not handle: use Meta Ads Manager.')}
          </span>
        </span>
      </label>

      <div className="mt-5 flex items-center gap-2">
        <button
          type="button" disabled={busy || !horsCategorie} onClick={() => void envoyer()}
          className="rounded-xl bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          data-testid="pub-creer"
        >
          {t('Créer (en pause)', 'Create (paused)')}
        </button>
        {/* 🔴 IL N'A AUCUNE CONDITION DE CONTENU, ET C'EST TOUT L'INTÉRÊT. « Créer » exige la case de
            catégorie, un visuel, un budget et un scénario ; « Enregistrer le brouillon » n'exige rien,
            parce qu'on enregistre précisément ce qui n'est pas encore prêt.
            ⚠️ La SEULE condition est l'existence de la route côté serveur : un bouton qui appelle une
            route que la production n'a pas est le motif « offert-et-inerte », en pire, puisqu'il rend
            une erreur de routeur que personne ne peut relier à quoi que ce soit. */}
        {!brouillonsIndisponibles && (
          <button
            type="button" disabled={brouillonBusy} onClick={() => void enregistrerBrouillon()}
            className="rounded-xl border border-ink-300 px-4 py-2 text-sm font-medium text-ink-800 disabled:opacity-40"
            data-testid="pub-enregistrer-brouillon"
          >
            {brouillonId === null
              ? t('Enregistrer le brouillon', 'Save draft')
              : t('Enregistrer les modifications', 'Save changes')}
          </button>
        )}
        <button type="button" onClick={fermer} className="rounded-xl border border-ink-200 px-4 py-2 text-sm text-ink-700">
          {t('Annuler', 'Cancel')}
        </button>
      </div>
      {brouillonsIndisponibles && (
        <p className="mt-2 text-xs text-ink-500" data-testid="pub-brouillons-indispo">
          {t('Les brouillons attendent la mise à jour du serveur. Vous pouvez créer la publicité normalement.',
             'Drafts are waiting for the server update. You can still create the ad as usual.')}
        </p>
      )}
      {brouillonId !== null && (
        <p className="mt-2 text-xs text-ink-400" data-testid="pub-brouillon-actif">
          {t('Ce brouillon est enregistré. Rien n’a été envoyé chez Meta : il disparaîtra quand la publicité sera créée.',
             'This draft is saved. Nothing was sent to Meta: it will disappear once the ad is created.')}
        </p>
      )}
        </div>

        <div className="mt-6 lg:mt-0">
          <PubApercu
            titre={titre} texte={texte} accueil={accueil} messagePreRempli={messagePreRempli}
            visuel={image === null ? null : { type: image.type, base64: image.base64 }}
            nomPage={nomPage} reponse={reponse}
            className="lg:sticky lg:top-4"
          />
        </div>
      </div>
    </div>
  );
}
