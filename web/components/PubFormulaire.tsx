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
import { Bouton } from '@/components/Bouton';

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


/**
 * Ce qu'un enregistrement dit du visuel : `undefined` = rien (le serveur garde le sien), `null` = efface,
 * un objet = remplace. Les trois sens de la clé `image`, nommés une fois plutôt que devinés trois fois.
 */
type VisuelEnvoye = { type: 'image/jpeg' | 'image/png'; base64: string } | null | undefined;

/** Deux visuels sont-ils le MÊME ? Comparaison par VALEUR : les objets sont reconstruits à chaque rendu. */
function memeVisuel(a: VisuelEnvoye, b: VisuelEnvoye): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  return a.type === b.type && a.base64 === b.base64;
}

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
   * 🔴 CE QUE LE SERVEUR EST CENSÉ DÉTENIR COMME VISUEL. `null` = rien.
   *
   * C'EST LA TROISIÈME FORME DE CET ÉTAT, ET LES DEUX PREMIÈRES ONT PERDU DES IMAGES. C'était un booléen
   * « le visuel a-t-il été touché ? », c'est-à-dire un DOUBLON STOCKÉ d'un fait DÉRIVABLE : « ce qui est à
   * l'écran diffère-t-il de ce que le serveur a ? ». Tant qu'on le stockait, il fallait penser à le bouger
   * à chaque transition, et on l'a oublié DEUX fois, à deux endroits, avec le même symptôme : une image
   * affichée à l'écran que le serveur n'avait pas.
   *
   * ⚠️ EN GARDANT LA VALEUR PLUTÔT QU'UN DRAPEAU, la question se REPOSE à chaque envoi au lieu de se
   * mémoriser : il n'y a plus de remise à zéro APRÈS CHAQUE ENREGISTREMENT, qui était la source des deux
   * pertes.
   *
   * 🔴 ET CE CHAMP N'EST PAS LU DIRECTEMENT : passer par `visuelDetenu()`. Sans brouillon sur le serveur,
   * le serveur ne détient RIEN, quoi que ce champ ait gardé. Écrire cette implication une fois vaut mieux
   * que d'apparier deux remises à zéro à la main : une première version de ce commentaire affirmait qu'il
   * n'y avait « plus rien à tenir en cohérence » alors que la branche du 404 appariait encore deux
   * `set`. Relevé en relecture à froid. Une justification fausse est pire qu'aucune : celle-là aurait fait
   * croire au prochain qu'il pouvait remettre `brouillonId` à `null` tout seul, et la perte silencieuse du
   * visuel serait revenue une troisième fois.
   */
  const [visuelServeur, setVisuelServeur] = useState<VisuelEnvoye>(
    brouillon?.visuel ? { type: brouillon.visuel.type, base64: brouillon.visuel.base64 } : null,
  );
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

  /**
   * Ce qu'il faut dire du visuel au prochain enregistrement, DÉRIVÉ et jamais mémorisé.
   *
   * ⚠️ `undefined` quand l'écran et le serveur portent le même visuel : il n'y a rien à dire, donc la clé
   * ne part pas, donc on ne remonte pas plusieurs mégaoctets pour corriger une faute de frappe.
   */
  /**
   * Ce que le serveur détient VRAIMENT, dérivé et jamais apparié à la main.
   *
   * 🔴 PAS DE BROUILLON, PAS DE VISUEL. C'est une implication, pas une coïncidence : un brouillon qui
   * n'existe plus ne détient rien. L'écrire ici supprime la seule paire de remises à zéro qui restait
   * (`brouillonId` et ce champ, sur la branche du 404), donc le seul endroit où l'on pouvait encore en
   * oublier une. C'est la même faute que le drapeau d'avant, à un cran de profondeur.
   */
  function visuelDetenu(): VisuelEnvoye {
    return brouillonId === null ? null : visuelServeur;
  }

  function visuelAEnvoyer(): VisuelEnvoye {
    const actuel: VisuelEnvoye = image === null ? null : { type: image.type, base64: image.base64 };
    return memeVisuel(actuel, visuelDetenu()) ? undefined : actuel;
  }

  async function choisirImage(f: File | null): Promise<void> {
    setErreur(null);
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
   * 🔴 LA CLÉ `image` N'EST POSÉE QUE SI LE VISUEL DIFFÈRE DE CELUI QUE LE SERVEUR DÉTIENT. Absente, le
   * serveur conserve le sien ; c'est ce qui permet de corriger un texte sans renvoyer, ni perdre, plusieurs
   * mégaoctets. `aEnvoyer` vaut `undefined` quand il n'y a rien à dire du visuel.
   */
  function champsBrouillon(aEnvoyer: VisuelEnvoye): FormulaireBrouillonPub {
    return {
      nom, titre, texte, accueil, messagePreRempli,
      budgetTotal, debut, fin, pays, ageMin, ageMax, tagQualification, destination,
      workflowId: workflowId === '' ? null : workflowId,
      ...(aEnvoyer === undefined ? {} : { image: aEnvoyer }),
    };
  }

  async function enregistrerBrouillon(): Promise<void> {
    setErreur(null);
    setBrouillonBusy(true);
    /**
     * 🔴 CE QUI PART EST CALCULÉ **AVANT** L'ATTENTE, ET C'EST CE QUI FERME LA COURSE.
     *
     * Le champ fichier reste utilisable pendant l'envoi : choisir une autre image au milieu d'un
     * téléversement de 5 Mo changeait `image`, et la remise à zéro d'après la réponse déclarait alors que
     * le serveur détenait la NOUVELLE alors qu'il avait reçu l'ANCIENNE. L'écran affichait la neuve, le
     * serveur gardait la vieille, et l'enregistrement suivant n'envoyait plus rien : perte définitive et
     * muette. En capturant ici, on n'enregistre jamais comme « détenu » autre chose que ce qui est parti.
     */
    const aEnvoyer = visuelAEnvoyer();
    try {
      if (brouillonId === null) {
        const { id } = await creerBrouillon(tenantId, champsBrouillon(aEnvoyer));
        // ⚠️ On RETIENT l'identifiant : sans ça, trois clics sur « Enregistrer » créeraient trois brouillons.
        setBrouillonId(id);
      } else {
        await majBrouillon(tenantId, brouillonId, champsBrouillon(aEnvoyer));
      }
      // Le serveur détient désormais ce qui vient de PARTIR, et rien d'autre. Une clé omise ne change
      // rien à ce qu'il détenait déjà, donc on ne touche à cet état que si quelque chose est parti.
      if (aEnvoyer !== undefined) setVisuelServeur(aEnvoyer);
      await brouillonsChanges();
    } catch (err) {
      /**
       * 🔴 DEUX 404 DIFFÉRENTS ARRIVENT ICI, ET LES CONFONDRE PERD LE TRAVAIL EN SILENCE.
       *
       * La route rend 404 pour « je n'existe pas » (fenêtre Vercel/API) ET pour « ce brouillon n'existe
       * pas » (`src/http/pubs.ts:484`, quand il a été supprimé entre-temps). La première version de ce
       * `catch` les habillait tous les deux en « le serveur se met à jour » : on reprend un brouillon, on
       * le supprime par erreur dans la liste juste en dessous, on continue d'écrire, et l'écran annonce
       * une panne passagère sur un brouillon MORT. On réessaie, même message rassurant, travail perdu.
       * Trouvé par une relecture à froid du correctif lui-même, avant tout déploiement.
       *
       * ⚠️ LE CRITÈRE QUI LES SÉPARE EST `brouillonId`. À la CRÉATION, un 404 ne peut vouloir dire que
       * « la route n'existe pas » : il n'y a aucun identifiant à ne pas trouver. À la MISE À JOUR, c'est
       * le brouillon qui a disparu, et on le DIT, en remettant l'identifiant à `null` pour que le clic
       * suivant le recrée. Le travail redevient récupérable en un geste au lieu d'être perdu.
       */
      if (err instanceof ApiError && err.status === 404 && brouillonId === null) {
        setErreur(t('Les brouillons attendent la mise à jour du serveur. Vous pouvez créer la publicité normalement.',
                    'Drafts are waiting for the server update. You can still create the ad as usual.'));
      } else if (err instanceof ApiError && err.status === 404) {
        /**
         * 🔴 UN SEUL `set`, ET C'EST TOUT L'INTÉRÊT. Le brouillon n'existe plus, donc le serveur ne détient
         * plus rien : `visuelDetenu()` le DÉDUIT de `brouillonId`, il n'y a pas de second état à remettre à
         * zéro ici. Le prochain envoi comparera l'image de l'écran à « rien », les trouvera différentes, et
         * la re-création emportera le visuel, ce que deux versions précédentes rataient.
         */
        setBrouillonId(null);
        setErreur(t('Ce brouillon n’existe plus. Cliquez de nouveau pour l’enregistrer comme un nouveau brouillon.',
                    'This draft no longer exists. Click again to save it as a new draft.'));
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
        <p role="alert" data-testid="pub-form-erreur" className="mt-3 rounded-xl bg-danger-50 px-3 py-2 text-sm text-danger-700">{erreur}</p>
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
        <p className="mt-1 text-xs text-alerte-700">
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

      <label className="mt-4 flex items-start gap-2 text-xs text-ink-900">
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
        <Bouton
          type="button" disabled={busy || !horsCategorie} onClick={() => void envoyer()}
          data-testid="pub-creer"
        >
          {t('Créer (en pause)', 'Create (paused)')}
        </Bouton>
        {/* 🔴 IL N'A AUCUNE CONDITION DE CONTENU, ET C'EST TOUT L'INTÉRÊT. « Créer » exige la case de
            catégorie, un visuel, un budget et un scénario ; « Enregistrer le brouillon » n'exige rien,
            parce qu'on enregistre précisément ce qui n'est pas encore prêt.
            ⚠️ La SEULE condition est l'existence de la route côté serveur : un bouton qui appelle une
            route que la production n'a pas est le motif « offert-et-inerte », en pire, puisqu'il rend
            une erreur de routeur que personne ne peut relier à quoi que ce soit. */}
        {!brouillonsIndisponibles && (
          <Bouton variante="secondaire"
            type="button" disabled={brouillonBusy} onClick={() => void enregistrerBrouillon()}
            data-testid="pub-enregistrer-brouillon"
          >
            {brouillonId === null
              ? t('Enregistrer le brouillon', 'Save draft')
              : t('Enregistrer les modifications', 'Save changes')}
          </Bouton>
        )}
        <Bouton variante="secondaire" type="button" onClick={fermer}>
          {t('Annuler', 'Cancel')}
        </Bouton>
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
