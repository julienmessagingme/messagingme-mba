'use client';

import { useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/http';
import { useT } from '@/lib/i18n';
import { getWorkflow, estEnLigne } from '@/lib/api';
import { premiereReponse } from '@/lib/apercu-reponse';
import {
  creerPub, creerBrouillon, majBrouillon, supprimerBrouillon,
  demarrerDepotVideo, envoyerMorceauVideo, terminerDepotVideo, lireEtatVideo, listerAudiences,
  TAILLE_VISUEL_MAX, TYPES_VISUEL, AGE_MIN_BAS, AGE_MIN_HAUT, AGE_MAX, BOUTONS_PUB, BOUTON_PUB_DEFAUT, boutonConnu,
  type AudiencePub, type BoutonPub, type BrouillonPubComplet, type DestinationPub, type FormulaireBrouillonPub,
  type FormulaireCreationPub, type ListeAudiencesPub,
} from '@/lib/api-pubs';
import {
  cadrageDe, dureeDuFichier, dureeRetenue, morceauSuivant, refusVideo, TAILLE_VIDEO_MAX, DUREE_VIDEO_MAX_S, type RefusVideo,
} from '@/lib/pub-video';
import { PubApercu, type EtatReponse } from '@/components/PubApercu';
import { Bouton } from '@/components/Bouton';

/**
 * Où en est la vidéo : choisie, lue, envoyée morceau par morceau, puis traitée par Meta. Seule `prete` permet de
 * créer la publicité (le serveur le revérifie).
 */
type EtatDepot =
  | { etape: 'aucune' }
  /** Le navigateur lit la durée et le cadrage, avant tout envoi. */
  | { etape: 'lecture' }
  | { etape: 'envoi'; envoye: number; total: number }
  /** Déposée ; Meta la traite (durée non documentée), et l'écran interroge son état. */
  | { etape: 'traitement' }
  | { etape: 'prete' }
  /** L'attente a dépassé sa borne, ou l'état n'a pas pu être lu : un bouton relance la vérification. */
  | { etape: 'a_verifier'; raison: 'delai' | 'lecture' }
  | { etape: 'erreur'; message: string };

/**
 * L'attente du traitement de Meta, BORNÉE : une interrogation toutes les cinq secondes, dix minutes au plus. Au-delà,
 * l'écran le dit et propose de revérifier, plutôt que d'interroger Meta indéfiniment depuis un onglet oublié.
 */
const ATTENTE_PAS_MS = 5_000;
const ATTENTE_MAX_TOURS = 120;

/**
 * Ce que le navigateur lit d'une vidéo sans l'envoyer : sa durée et ses dimensions, ou `null` s'il n'y arrive pas.
 *
 * 🔴 LA DURÉE SE LIT D'ABORD DANS LE FICHIER (`dureeDuFichier`, la boîte `mvhd`), et le décodeur n'est que son
 * repli : Chrome sous Windows ne décode pas le HEVC d'un iPhone, donc un `<video>` seul refusait un MOV conforme pour
 * « durée illisible ». Les dimensions, elles, ne viennent que du décodeur : sans lui, pas de conseil de cadrage, ce
 * qui n'est jamais un refus.
 */
async function lireMetadonnees(f: File): Promise<{ url: string; duree: number | null; largeur: number; hauteur: number }> {
  const lire = async (debut: number, fin: number): Promise<Uint8Array> => new Uint8Array(await f.slice(debut, fin).arrayBuffer());
  const [dureeConteneur, parLeDecodeur] = await Promise.all([
    dureeDuFichier(lire, f.size).catch(() => null),
    lireParLeDecodeur(f),
  ]);
  return { ...parLeDecodeur, duree: dureeRetenue(dureeConteneur, parLeDecodeur.duree) };
}

/** Ce que le décodeur du navigateur dit d'une vidéo : sa durée, ses dimensions, et l'adresse locale de l'aperçu. */
async function lireParLeDecodeur(f: File): Promise<{ url: string; duree: number | null; largeur: number; hauteur: number }> {
  const url = URL.createObjectURL(f);
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  const lu = await new Promise<{ duree: number | null; largeur: number; hauteur: number }>((resolve) => {
    // Un navigateur qui ne sait pas lire le conteneur ne déclenche parfois ni l'un ni l'autre : la borne rend
    // alors « illisible », ce qui refuse la vidéo (voir `refusVideo`).
    const borne = window.setTimeout(() => resolve({ duree: null, largeur: 0, hauteur: 0 }), 10_000);
    video.onloadedmetadata = () => {
      window.clearTimeout(borne);
      resolve({ duree: Number.isFinite(video.duration) ? video.duration : null, largeur: video.videoWidth, hauteur: video.videoHeight });
    };
    video.onerror = () => { window.clearTimeout(borne); resolve({ duree: null, largeur: 0, hauteur: 0 }); };
    video.src = url;
  });
  video.removeAttribute('src');
  return { url, ...lu };
}

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
  /**
   * L'âge minimum, entre 18 et 25 : Advantage+ est laissé à Meta, qui n'accepte rien d'autre et FIXE le maximum à
   * 65 (il n'y a donc plus de champ pour lui). Un brouillon d'avant cette règle peut porter « 30 » : on le rouvre
   * VIDE plutôt que de le corriger en silence, et la création demande de choisir.
   */
  const [ageMin, setAgeMin] = useState(() => {
    if (brouillon === null) return String(AGE_MIN_BAS);
    const n = Number(brouillon.ageMin);
    return Number.isInteger(n) && n >= AGE_MIN_BAS && n <= AGE_MIN_HAUT ? String(n) : '';
  });
  const [destination, setDestination] = useState<DestinationPub>(brouillon?.destination ?? 'scenario');
  const [workflowId, setWorkflowId] = useState(brouillon?.workflowId ?? '');
  const [tagQualification, setTagQualification] = useState(brouillon?.tagQualification ?? '');
  const [horsCategorie, setHorsCategorie] = useState(false);
  const [image, setImage] = useState<{ type: 'image/jpeg' | 'image/png'; base64: string; nom: string } | null>(
    brouillon?.visuel ? { ...brouillon.visuel, nom: '' } : null,
  );
  /** Les deux champs fichier : « Changer » ouvre le leur, « Retirer » les vide pour qu'un même fichier se rechoisisse. */
  const refImage = useRef<HTMLInputElement>(null);
  const refVideo = useRef<HTMLInputElement>(null);
  /**
   * Le bouton de la publicité, et ce que le serveur en détient (même logique que `visuelServeur`, plus bas) : on ne
   * l'envoie que s'il diffère, pour qu'une API d'avant ce lot, qui refuse la clé, reste utilisable au bouton par défaut.
   */
  const [bouton, setBouton] = useState<BoutonPub>(boutonConnu(brouillon?.bouton));
  const [boutonServeur, setBoutonServeur] = useState<BoutonPub>(boutonConnu(brouillon?.bouton));
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
   * LE VISUEL EST UNE IMAGE OU UNE VIDÉO, jamais les deux (le serveur refuse les deux). Un brouillon qui porte une
   * vidéo se rouvre sur la vidéo.
   */
  const [format, setFormat] = useState<'image' | 'video'>(brouillon?.videoId ? 'video' : 'image');
  /**
   * La vidéo choisie. `id` est son identifiant CHEZ META, connu une fois le dépôt clos ; `apercu` est une adresse
   * locale (`blob:`) pour la montrer sans rien relire, absente quand on rouvre un brouillon (seul l'identifiant a été
   * gardé, jamais les octets).
   */
  const [video, setVideo] = useState<{ id: string | null; nom: string; apercu: string | null; cadrage: ReturnType<typeof cadrageDe> } | null>(
    brouillon?.videoId ? { id: brouillon.videoId, nom: '', apercu: null, cadrage: null } : null,
  );
  const [depot, setDepot] = useState<EtatDepot>(brouillon?.videoId ? { etape: 'traitement' } : { etape: 'aucune' });
  const [progression, setProgression] = useState<number | null>(null);
  /** Le numéro du dépôt en cours : un nouveau choix de fichier rend caduc l'envoi précédent, qui s'arrête. */
  const depotCourant = useRef(0);
  /** Coupe le morceau EN VOL quand on retire la vidéo pendant l'envoi, au lieu d'attendre qu'il finisse. */
  const envoiEnVol = useRef<AbortController | null>(null);
  /** Ce que le serveur détient comme vidéo pour ce brouillon, même logique que `visuelServeur`. */
  const [videoServeur, setVideoServeur] = useState<string | null>(brouillon?.videoId ?? null);

  /**
   * LES AUDIENCES DU COMPTE, lues chez Meta à l'ouverture. `absente` = l'API déployée ne connaît pas encore la
   * route (fenêtre entre la publication de la console et le déploiement de l'API) : l'écran cesse alors de proposer
   * les audiences ET la vidéo, qui arrivent avec la même mise à jour, plutôt que d'offrir un geste qui échouerait.
   */
  const [audiences, setAudiences] = useState<
    { etat: 'chargement' } | { etat: 'ok'; liste: ListeAudiencesPub } | { etat: 'erreur'; message: string } | { etat: 'absente' }
  >({ etat: 'chargement' });
  const [incluses, setIncluses] = useState<string[]>(brouillon?.audiencesIncluses ?? []);
  const [exclues, setExclues] = useState<string[]>(brouillon?.audiencesExclues ?? []);
  /** Le serveur connaît-il la vidéo et les audiences (migration 0187) ? Déduit de la lecture des audiences. */
  const serveurAJour = audiences.etat === 'ok' || audiences.etat === 'erreur';

  useEffect(() => {
    let vivant = true;
    listerAudiences(tenantId)
      // ⚠️ La forme est RELUE, pas crue : une réponse sans tableau (un intermédiaire, un serveur en retard)
      // ferait planter le rendu du formulaire entier sur un `.filter` d'`undefined`.
      .then((r) => {
        if (!vivant) return;
        const brut = r as Partial<ListeAudiencesPub> | null;
        setAudiences({
          etat: 'ok',
          liste: { audiences: Array.isArray(brut?.audiences) ? brut.audiences : [], tronquee: brut?.tronquee === true },
        });
      })
      .catch((err: unknown) => {
        if (!vivant) return;
        if (err instanceof ApiError && err.status === 404) setAudiences({ etat: 'absente' });
        else setAudiences({ etat: 'erreur', message: err instanceof Error ? err.message : '' });
      });
    return () => { vivant = false; };
  }, [tenantId]);

  /**
   * L'ATTENTE DU TRAITEMENT, BORNÉE ET VISIBLE. Elle ne tourne que pendant `traitement`, et s'arrête au démontage,
   * à un nouveau fichier, ou à la borne. ⚠️ La progression vit dans son propre état : la ranger dans `depot`
   * relancerait cet effet à chaque réponse.
   */
  useEffect(() => {
    const id = video?.id ?? null;
    if (depot.etape !== 'traitement' || id === null) return;
    let vivant = true;
    let tours = 0;
    let minuteur: number | undefined;
    const tour = async (): Promise<void> => {
      tours += 1;
      try {
        const e = await lireEtatVideo(tenantId, id);
        if (!vivant) return;
        setProgression(typeof e.progression === 'number' && Number.isFinite(e.progression) ? e.progression : null);
        if (e.etat === 'prete') { setDepot({ etape: 'prete' }); return; }
        if (e.etat === 'erreur') {
          setDepot({ etape: 'erreur', message: t('Meta n’a pas pu traiter cette vidéo. Choisissez-en une autre.', 'Meta could not process this video. Choose another one.') });
          return;
        }
      } catch {
        if (vivant) setDepot({ etape: 'a_verifier', raison: 'lecture' });
        return;
      }
      if (tours >= ATTENTE_MAX_TOURS) { setDepot({ etape: 'a_verifier', raison: 'delai' }); return; }
      minuteur = window.setTimeout(() => { void tour(); }, ATTENTE_PAS_MS);
    };
    void tour();
    return () => { vivant = false; if (minuteur !== undefined) window.clearTimeout(minuteur); };
    // `t` est stable pour une langue donnée ; le relancer à chaque rendu recommencerait l'attente.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, depot.etape, video?.id]);

  /** L'adresse locale de l'aperçu se libère quand elle est remplacée, ou au démontage. */
  useEffect(() => {
    const url = video?.apercu ?? null;
    return () => { if (url !== null) URL.revokeObjectURL(url); };
  }, [video?.apercu]);

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

  /**
   * 🔴 UN RETRAIT PART QUEL QUE SOIT LE FORMAT. En mode vidéo, une image encore dans le formulaire n'a été que quittée
   * des yeux : on n'en dit rien (poser une vidéo l'efface côté serveur). Mais une image RETIRÉE (plus rien dans le
   * formulaire) doit partir en `null` même si l'on est passé en vidéo sans en choisir une : sinon le brouillon
   * rouvrait sur l'image qu'on venait de retirer.
   */
  function visuelAEnvoyer(): VisuelEnvoye {
    if (format === 'video' && image !== null) return undefined;
    const actuel: VisuelEnvoye = image === null ? null : { type: image.type, base64: image.base64 };
    return memeVisuel(actuel, visuelDetenu()) ? undefined : actuel;
  }

  /** Même dérivation pour la vidéo : ce que le serveur détient, déduit, jamais apparié à la main. */
  function videoDetenue(): string | null {
    return brouillonId === null ? null : videoServeur;
  }

  /**
   * Ce qu'il faut dire de la vidéo au prochain enregistrement : `undefined` quand rien n'a changé (ou quand le
   * serveur ne connaît pas encore la vidéo, qui refuserait la clé), sinon l'identifiant ou `null`. En mode image, une
   * vidéo encore dans le formulaire n'a été que quittée des yeux : on n'en dit rien (une image posée l'efface côté
   * serveur). 🔴 Mais une vidéo RETIRÉE part en `null` quel que soit le format : retirer, passer en image sans en
   * choisir, enregistrer, et le brouillon rouvrait sur la vidéo retirée.
   */
  function videoAEnvoyer(): { id: string } | null | undefined {
    if (!serveurAJour || (format !== 'video' && video !== null)) return undefined;
    const actuelle = video?.id ?? null;
    if (actuelle === videoDetenue()) return undefined;
    return actuelle === null ? null : { id: actuelle };
  }

  /**
   * Ce qu'il faut dire du bouton : `undefined` quand le serveur a déjà celui-là. Sans brouillon, le serveur n'a rien,
   * et un brouillon neuf prend le défaut en base (migration 0188) : le défaut n'a donc jamais besoin de partir.
   */
  function boutonAEnvoyer(): BoutonPub | undefined {
    const detenu = brouillonId === null ? BOUTON_PUB_DEFAUT : boutonServeur;
    return bouton === detenu ? undefined : bouton;
  }

  /** Le refus d'une vidéo, en mots, dans les deux langues. */
  function messageRefusVideo(r: Exclude<RefusVideo, null>): string {
    if (r === 'type') return t('La vidéo doit être un MP4 ou un MOV.', 'The video must be an MP4 or a MOV.');
    if (r === 'taille') {
      return t(`La vidéo dépasse ${Math.round(TAILLE_VIDEO_MAX / (1024 * 1024))} Mo.`, `The video is over ${Math.round(TAILLE_VIDEO_MAX / (1024 * 1024))} MB.`);
    }
    if (r === 'duree') return t(`La vidéo dure plus de ${DUREE_VIDEO_MAX_S} secondes.`, `The video is longer than ${DUREE_VIDEO_MAX_S} seconds.`);
    return t('Votre navigateur n’a pas pu lire cette vidéo pour en vérifier la durée. Exportez-la en MP4 (H.264) et réessayez.',
             'Your browser could not read this video to check its length. Export it as MP4 (H.264) and try again.');
  }

  /**
   * CHOISIR UNE VIDÉO : la contrôler, puis la DÉPOSER CHEZ META tout de suite, morceau par morceau (rien n'y est
   * facturable). Le brouillon ne garde ensuite que son identifiant.
   *
   * 🔴 LES CONTRÔLES PASSENT AVANT LE PREMIER OCTET : type, poids, durée lue par le navigateur. Le serveur refait
   * ce qu'il peut (signature, poids, durée quand le fichier la porte au début), mais la règle des 60 secondes n'a
   * qu'ici un contrôle sûr.
   *
   * ⚠️ UN NOUVEAU CHOIX REND L'ENVOI EN COURS CADUC : chaque dépôt porte un numéro, et un morceau qui revient pour
   * un numéro dépassé n'est pas suivi du suivant.
   *
   * ⚠️ UN FICHIER REFUSÉ NE DÉFAIT PAS LA VIDÉO QU'ON AVAIT : « Changer » peut ouvrir sur un fichier trop long, et
   * perdre l'état « prête » de la vidéo en place pour ça obligerait à la redéposer. L'état d'avant est donc rendu.
   */
  async function choisirVideo(f: File): Promise<void> {
    setErreur(null);
    const numero = ++depotCourant.current;
    const avantLecture = { depot, progression };
    const avant = refusVideo(f, 1);
    if (avant === 'type' || avant === 'taille') { setErreur(messageRefusVideo(avant)); return; }
    setProgression(null);
    setDepot({ etape: 'lecture' });
    const meta = await lireMetadonnees(f);
    if (numero !== depotCourant.current) { URL.revokeObjectURL(meta.url); return; }
    const refus = refusVideo(f, meta.duree);
    if (refus !== null) {
      URL.revokeObjectURL(meta.url);
      setDepot(avantLecture.depot);
      setProgression(avantLecture.progression);
      setErreur(messageRefusVideo(refus));
      return;
    }
    setVideo({ id: null, nom: f.name, apercu: meta.url, cadrage: cadrageDe(meta.largeur, meta.hauteur) });
    setDepot({ etape: 'envoi', envoye: 0, total: f.size });
    const controleur = new AbortController();
    envoiEnVol.current = controleur;
    try {
      const d = await demarrerDepotVideo(tenantId, f.size);
      if (numero !== depotCourant.current) return;
      let precedent: { debut: number; fin: number } | null = null;
      let m = morceauSuivant(null, { debut: d.debut, fin: d.fin }, f.size);
      while (m !== 'fini') {
        if (m === null) {
          throw new Error(t('Meta a demandé un morceau incohérent de la vidéo. Réessayez.', 'Meta asked for an inconsistent part of the video. Try again.'));
        }
        const s = await envoyerMorceauVideo(tenantId, d.sessionId, m.debut, m.fin, f.slice(m.debut, m.fin), controleur.signal);
        if (numero !== depotCourant.current) return;
        precedent = m;
        setDepot({ etape: 'envoi', envoye: m.fin, total: f.size });
        m = morceauSuivant(precedent, s, f.size);
      }
      await terminerDepotVideo(tenantId, d.sessionId);
      if (numero !== depotCourant.current) return;
      setVideo((v) => (v === null ? v : { ...v, id: d.videoId }));
      setDepot({ etape: 'traitement' });
    } catch (err) {
      if (numero !== depotCourant.current) return;
      setDepot({ etape: 'erreur', message: err instanceof Error ? err.message : t('Dépôt impossible', 'Upload failed') });
    } finally {
      if (envoiEnVol.current === controleur) envoiEnVol.current = null;
    }
  }

  /**
   * RETIRER LA VIDÉO, ou annuler son dépôt en cours : le formulaire revient à « aucun visuel », et le prochain
   * enregistrement dira `video: null` au brouillon (`videoAEnvoyer`). La vidéo déjà déposée reste dans la
   * bibliothèque du compte chez Meta, où elle ne coûte rien : on ne la supprime pas.
   *
   * 🔴 L'ENVOI EN COURS S'ARRÊTE VRAIMENT : le numéro rend caduc tout ce qui revient ensuite, et le morceau en vol est
   * coupé. Sans cette coupure, il continuait de monter jusqu'à sa fin, sur le plafond de requêtes de la personne.
   */
  function retirerVideo(): void {
    depotCourant.current += 1;
    envoiEnVol.current?.abort();
    envoiEnVol.current = null;
    setVideo(null);
    setDepot({ etape: 'aucune' });
    setProgression(null);
    setErreur(null);
    if (refVideo.current !== null) refVideo.current.value = '';
  }

  /** RETIRER L'IMAGE : même geste, même effet. Le prochain enregistrement dira `image: null` (`visuelAEnvoyer`). */
  function retirerImage(): void {
    setImage(null);
    setErreur(null);
    if (refImage.current !== null) refImage.current.value = '';
  }

  /** Inclure, exclure ou ignorer une audience : les deux listes restent disjointes par construction. */
  function choisirAudience(id: string, choix: 'inclure' | 'exclure' | 'ignorer'): void {
    setIncluses((l) => (choix === 'inclure' ? [...l.filter((x) => x !== id), id] : l.filter((x) => x !== id)));
    setExclues((l) => (choix === 'exclure' ? [...l.filter((x) => x !== id), id] : l.filter((x) => x !== id)));
  }

  async function choisirImage(f: File): Promise<void> {
    setErreur(null);
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
  function champsBrouillon(
    aEnvoyer: VisuelEnvoye, videoEnvoyee: { id: string } | null | undefined, boutonEnvoye: BoutonPub | undefined,
  ): FormulaireBrouillonPub {
    return {
      nom, titre, texte, accueil, messagePreRempli,
      budgetTotal, debut, fin, pays, ageMin, ageMax: String(AGE_MAX), tagQualification, destination,
      workflowId: workflowId === '' ? null : workflowId,
      ...(aEnvoyer === undefined ? {} : { image: aEnvoyer }),
      ...(videoEnvoyee === undefined ? {} : { video: videoEnvoyee }),
      ...(boutonEnvoye === undefined ? {} : { bouton: boutonEnvoye }),
      // ⚠️ Les audiences ne partent que vers un serveur qui les connaît : l'ancien refuse toute clé inconnue.
      ...(serveurAJour ? { audiencesIncluses: incluses, audiencesExclues: exclues } : {}),
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
    const videoEnvoyee = videoAEnvoyer();
    const boutonEnvoye = boutonAEnvoyer();
    try {
      if (brouillonId === null) {
        const { id } = await creerBrouillon(tenantId, champsBrouillon(aEnvoyer, videoEnvoyee, boutonEnvoye));
        // ⚠️ On RETIENT l'identifiant : sans ça, trois clics sur « Enregistrer » créeraient trois brouillons.
        setBrouillonId(id);
      } else {
        await majBrouillon(tenantId, brouillonId, champsBrouillon(aEnvoyer, videoEnvoyee, boutonEnvoye));
      }
      // Le serveur détient désormais ce qui vient de PARTIR, et rien d'autre. Une clé omise ne change
      // rien à ce qu'il détenait déjà, donc on ne touche à cet état que si quelque chose est parti.
      if (aEnvoyer !== undefined) setVisuelServeur(aEnvoyer);
      if (videoEnvoyee !== undefined) setVideoServeur(videoEnvoyee === null ? null : videoEnvoyee.id);
      // Un brouillon CRÉÉ sans la clé a pris le défaut en base : c'est donc lui qu'il détient.
      setBoutonServeur(boutonEnvoye ?? (brouillonId === null ? BOUTON_PUB_DEFAUT : boutonServeur));
      // 🔴 L'EXCLUSIVITÉ, VUE D'ICI : le serveur a effacé l'autre visuel quand l'un a été POSÉ (non nul).
      if (videoEnvoyee) setVisuelServeur(null);
      if (aEnvoyer) setVideoServeur(null);
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
    if (format === 'image' && image === null) { setErreur(t('Choisissez un visuel.', 'Choose an image.')); return; }
    if (format === 'video' && (video?.id == null || depot.etape !== 'prete')) {
      setErreur(t('La vidéo n’est pas encore prête chez Meta : attendez la fin de son traitement.',
                  'The video is not ready at Meta yet: wait for its processing to finish.'));
      return;
    }
    const age = Number(ageMin);
    if (!Number.isInteger(age) || age < AGE_MIN_BAS || age > AGE_MIN_HAUT) {
      setErreur(t(`Choisissez un âge minimum entre ${AGE_MIN_BAS} et ${AGE_MIN_HAUT} ans.`, `Choose a minimum age between ${AGE_MIN_BAS} and ${AGE_MIN_HAUT}.`));
      return;
    }
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
      // `ageMax` est fixé par Meta avec Advantage+ ; il part quand même, parce que l'API d'avant cette règle
      // l'exige encore pendant la fenêtre de déploiement.
      ageMin: age, ageMax: AGE_MAX,
      destination,
      workflowId: destination === 'scenario' ? workflowId : null,
      tagQualification: tagQualification.trim() === '' ? null : tagQualification.trim(),
      horsCategorieSpeciale: true,
      ...(format === 'video' && video?.id
        ? { video: { id: video.id } }
        : image !== null ? { image: { type: image.type, base64: image.base64 } } : {}),
      // ⚠️ Seulement si on en a choisi : une publicité SANS audience doit rester créable sur l'API d'avant 0187.
      ...(incluses.length > 0 ? { audiencesIncluses: incluses } : {}),
      ...(exclues.length > 0 ? { audiencesExclues: exclues } : {}),
      // ⚠️ Même règle : le bouton WhatsApp est le défaut du serveur, il n'a pas besoin de partir.
      ...(bouton !== BOUTON_PUB_DEFAUT ? { bouton } : {}),
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

  const champ = 'mt-1 w-full rounded-carte border border-ink-200 px-3 py-2 text-sm';
  const label = 'mt-3 block text-xs font-medium text-ink-500';

  return (
    <div className="mt-4 rounded-carte border border-ink-200 bg-white p-5" data-testid="pub-formulaire">
      <h3 className="text-sm font-semibold text-ink-900">{t('Nouvelle publicité', 'New ad')}</h3>
      <p className="mt-1 text-xs text-ink-500">
        {t('Tout est créé en pause chez Meta : rien ne dépense tant que vous n’avez pas publié.',
           'Everything is created paused at Meta: nothing spends until you publish.')}
      </p>

      {erreur !== null && (
        <p role="alert" data-testid="pub-form-erreur" className="mt-3 rounded-carte bg-danger-50 px-3 py-2 text-sm text-danger-700">{erreur}</p>
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
      <p className="mt-1 text-xs text-ink-500">
        {/* Les deux textes se confondent facilement, et les inverser produit une publicité absurde. */}
        {t('C’est ce que WhatsApp écrit dans sa zone de saisie : il n’a plus qu’à l’envoyer.',
           'This is what WhatsApp types in their input box: they just press send.')}
      </p>

      {/* Un TYPE dans une liste fermée, jamais un texte libre : Meta pose lui-même le libellé du type choisi. */}
      <label className={label} htmlFor="pub-bouton">{t('Bouton de la publicité', 'Ad button')}</label>
      <select
        id="pub-bouton" className={champ} value={bouton} onChange={(e) => setBouton(boutonConnu(e.target.value))}
        data-testid="pub-bouton"
      >
        {BOUTONS_PUB.map((b) => <option key={b.type} value={b.type}>{t(b.fr, b.en)}</option>)}
      </select>
      <p className="mt-1 text-xs text-ink-500">
        {t('Quel que soit le libellé, un appui sur le bouton ouvre la conversation WhatsApp avec vous.',
           'Whatever the label, tapping the button opens the WhatsApp conversation with you.')}
      </p>

      {/* 🔴 IMAGE OU VIDÉO, UN SEUL VISUEL. La vidéo n'est proposée qu'à une API qui sait la recevoir (voir
          `serveurAJour`) : sur l'ancienne, le bouton appellerait une route absente. */}
      <fieldset className="mt-3" data-testid="pub-format">
        <legend className="block text-xs font-medium text-ink-500">{t('Visuel', 'Visual')}</legend>
        <div className="mt-1 flex gap-4 text-sm text-ink-900">
          <label className="flex items-center gap-1.5">
            <input type="radio" name="pub-format" checked={format === 'image'} onChange={() => setFormat('image')} data-testid="pub-format-image" />
            {t('Image', 'Image')}
          </label>
          <label className={`flex items-center gap-1.5 ${serveurAJour ? '' : 'text-ink-500'}`}>
            <input
              type="radio" name="pub-format" checked={format === 'video'} disabled={!serveurAJour && format !== 'video'}
              onChange={() => setFormat('video')} data-testid="pub-format-video"
            />
            {t('Vidéo', 'Video')}
          </label>
        </div>
        {audiences.etat === 'absente' && (
          <p className="mt-1 text-xs text-ink-500" data-testid="pub-video-indispo">
            {t('La vidéo et les audiences attendent la mise à jour du serveur. Vous pouvez créer une publicité avec une image.',
               'Video and audiences are waiting for the server update. You can still create an ad with an image.')}
          </p>
        )}
      </fieldset>

      {/* 🔴 UNE FOIS LE VISUEL CHOISI, LE CHAMP FICHIER S'EFFACE AU PROFIT DE « CHANGER » ET « RETIRER », le même
          geste pour l'image et pour la vidéo. Le champ reste dans la page (le bouton « Changer » l'ouvre), et un
          choix annulé dans la fenêtre du système ne retire plus rien : seul « Retirer » retire. */}
      {format === 'image' && (
        <>
          <label className={label} htmlFor="pub-image">{t('Image (JPEG ou PNG, 5 Mo maximum)', 'Image (JPEG or PNG, 5 MB max)')}</label>
          <input
            id="pub-image" ref={refImage} type="file" accept="image/jpeg,image/png" className={image === null ? champ : 'sr-only'}
            onChange={(e) => { const f = e.target.files?.[0]; if (f !== undefined) void choisirImage(f); }}
          />
          {image !== null && (
            <div className="mt-1 flex flex-wrap items-center gap-2" data-testid="pub-image-choisie">
              <span className="min-w-0 truncate text-xs text-ink-900">
                {image.nom !== '' ? image.nom : t('Image enregistrée avec le brouillon', 'Image saved with the draft')}
              </span>
              <Bouton variante="discret" taille="petite" type="button" onClick={() => refImage.current?.click()} data-testid="pub-image-changer">
                {t('Changer', 'Change')}
              </Bouton>
              <Bouton variante="discret" taille="petite" type="button" onClick={retirerImage} data-testid="pub-image-retirer">
                {t('Retirer', 'Remove')}
              </Bouton>
            </div>
          )}
        </>
      )}

      {format === 'video' && (
        <div data-testid="pub-video">
          <label className={label} htmlFor="pub-video-fichier">
            {t(`Vidéo (MP4 ou MOV, ${Math.round(TAILLE_VIDEO_MAX / (1024 * 1024))} Mo et ${DUREE_VIDEO_MAX_S} secondes au plus)`,
               `Video (MP4 or MOV, ${Math.round(TAILLE_VIDEO_MAX / (1024 * 1024))} MB and ${DUREE_VIDEO_MAX_S} seconds max)`)}
          </label>
          <input
            id="pub-video-fichier" ref={refVideo} type="file" accept="video/mp4,video/quicktime,.mp4,.mov,.m4v"
            className={video === null && depot.etape === 'aucune' ? champ : 'sr-only'}
            disabled={depot.etape === 'lecture' || depot.etape === 'envoi'}
            onChange={(e) => { const f = e.target.files?.[0]; if (f !== undefined) void choisirVideo(f); }}
          />
          <p className="mt-1 text-xs text-ink-500">
            {/* Un conseil, jamais un refus : Meta place la publicité lui-même. */}
            {t('Conseil : un cadrage vertical 9:16 pour les stories, les Reels et le statut WhatsApp, ou 4:5 pour le fil. Meta choisit les emplacements.',
               'Tip: vertical 9:16 framing for stories, Reels and WhatsApp status, or 4:5 for the feed. Meta picks the placements.')}
          </p>
          {video?.cadrage === 'autre' && (
            <p className="mt-1 text-xs text-alerte-700" data-testid="pub-video-cadrage">
              {t('Cette vidéo n’est ni en 9:16 ni en 4:5 : Meta la recadrera sur certains emplacements.',
                 'This video is neither 9:16 nor 4:5: Meta will crop it on some placements.')}
            </p>
          )}
          <EtatDuDepot depot={depot} progression={progression} nom={video?.nom ?? ''}
            reverifier={() => setDepot({ etape: 'traitement' })} />
          {/* Pendant l'envoi, on peut l'annuler ; pendant la courte lecture du fichier, rien (elle est bornée) ;
              ensuite, changer ou retirer. */}
          {video !== null && depot.etape !== 'lecture' && (
            <div className="mt-1 flex flex-wrap items-center gap-2" data-testid="pub-video-choisie">
              {depot.etape === 'envoi' ? (
                <Bouton variante="discret" taille="petite" type="button" onClick={retirerVideo} data-testid="pub-video-annuler">
                  {t('Annuler l’envoi', 'Cancel upload')}
                </Bouton>
              ) : (
                <>
                  <Bouton variante="discret" taille="petite" type="button" onClick={() => refVideo.current?.click()} data-testid="pub-video-changer">
                    {t('Changer', 'Change')}
                  </Bouton>
                  <Bouton variante="discret" taille="petite" type="button" onClick={retirerVideo} data-testid="pub-video-retirer">
                    {t('Retirer', 'Remove')}
                  </Bouton>
                </>
              )}
            </div>
          )}
        </div>
      )}

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
      <p className="mt-1 text-xs text-ink-500">
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
          <select id="pub-age-min" className={champ} value={ageMin} onChange={(e) => setAgeMin(e.target.value)}>
            {ageMin === '' && <option value="">{t('Choisir…', 'Choose…')}</option>}
            {Array.from({ length: AGE_MIN_HAUT - AGE_MIN_BAS + 1 }, (_, i) => AGE_MIN_BAS + i).map((a) => (
              <option key={a} value={String(a)}>{a}</option>
            ))}
          </select>
        </div>
        <div>
          <p className={label}>{t('Âge maximum', 'Maximum age')}</p>
          <p className="mt-1 px-1 py-2 text-sm text-ink-900" data-testid="pub-age-max">{t(`${AGE_MAX} ans`, `${AGE_MAX}`)}</p>
        </div>
      </div>
      <p className="mt-1 text-xs text-ink-500" data-testid="pub-advantage-age">
        {/* 🔴 La règle est de Meta, pas de nous : on la dit là où elle contraint, pour qu'un « pourquoi pas 30 ans ? »
            ait sa réponse sous les yeux. */}
        {t(`Advantage+ est laissé à Meta, qui n’accepte qu’un âge minimum entre ${AGE_MIN_BAS} et ${AGE_MIN_HAUT} ans et fixe le maximum à ${AGE_MAX}.`,
           `Advantage+ is left to Meta, which only accepts a minimum age between ${AGE_MIN_BAS} and ${AGE_MIN_HAUT} and sets the maximum to ${AGE_MAX}.`)}
      </p>

      <SectionAudiences
        audiences={audiences} incluses={incluses} exclues={exclues} choisir={choisirAudience}
      />

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
        <p className="mt-1 text-xs text-ink-500" data-testid="pub-agent-indispo">
          {t('L’agent de Meta n’est pas allumé pour cet espace : il ne peut pas répondre à ces prospects.',
             'The Meta agent is not turned on for this space: it cannot answer these leads.')}
        </p>
      )}
      {agentMetaOuvert === null && (
        /* ⚠️ ON DIT NOTRE IGNORANCE, PAS UN VERDICT SUR LEUR NUMÉRO. L'option reste cachée, ce qui est le
           bon sens d'erreur, mais la phrase décrit CE QUI S'EST PASSÉ CHEZ NOUS. */
        <p className="mt-1 text-xs text-ink-500" data-testid="pub-agent-inconnu">
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
            <p className="mt-1 text-xs text-ink-500" data-testid="pub-agent-ecarte">
              {t('L’agent de Meta sera écarté des prospects de cette publicité : c’est le scénario qui répond.',
                 'The Meta agent will be kept away from this ad’s leads: the scenario answers.')}
            </p>
          )}
        </>
      )}

      <label className={label} htmlFor="pub-tag">{t('Tag qui marque un prospect qualifié (facultatif)', 'Tag marking a qualified lead (optional)')}</label>
      <input id="pub-tag" className={champ} value={tagQualification} onChange={(e) => setTagQualification(e.target.value)} maxLength={64} />
      <p className="mt-1 text-xs text-ink-500">
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
          <span className="text-ink-500">
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
        <p className="mt-2 text-xs text-ink-500" data-testid="pub-brouillon-actif">
          {t('Ce brouillon est enregistré. Rien n’a été envoyé chez Meta : il disparaîtra quand la publicité sera créée.',
             'This draft is saved. Nothing was sent to Meta: it will disappear once the ad is created.')}
        </p>
      )}
        </div>

        <div className="mt-6 lg:mt-0">
          <PubApercu
            titre={titre} texte={texte} accueil={accueil} messagePreRempli={messagePreRempli}
            visuel={format === 'image' && image !== null ? { type: image.type, base64: image.base64 } : null}
            video={format === 'video' ? { url: video?.apercu ?? null, deposee: video?.id != null } : null}
            bouton={bouton} nomPage={nomPage} reponse={reponse}
            className="lg:sticky lg:top-4"
          />
        </div>
      </div>
    </div>
  );
}

/**
 * OÙ EN EST LA VIDÉO, DIT À LA PERSONNE : lecture, envoi (avec sa progression), traitement chez Meta (avec la
 * sienne quand Meta la donne), prête, ou ce qui a échoué. L'attente est visible, jamais un bouton qui tourne sans
 * rien dire.
 */
function EtatDuDepot({ depot, progression, nom, reverifier }: {
  depot: EtatDepot; progression: number | null; nom: string; reverifier: () => void;
}) {
  const t = useT();
  if (depot.etape === 'aucune') return null;
  const barre = (pct: number) => (
    <div className="mt-1 h-1.5 w-full rounded-full bg-ink-100" aria-hidden>
      <div className="h-1.5 rounded-full bg-brand-600" style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
    </div>
  );
  return (
    <div className="mt-2 text-xs text-ink-500" data-testid="pub-video-etat" aria-live="polite">
      {nom !== '' && <p className="truncate text-ink-900">{nom}</p>}
      {depot.etape === 'lecture' && <p>{t('Lecture de la vidéo…', 'Reading the video…')}</p>}
      {depot.etape === 'envoi' && (
        <>
          <p>{t(`Envoi chez Meta : ${Math.floor((depot.envoye / depot.total) * 100)} %`, `Uploading to Meta: ${Math.floor((depot.envoye / depot.total) * 100)}%`)}</p>
          {barre((depot.envoye / depot.total) * 100)}
        </>
      )}
      {depot.etape === 'traitement' && (
        <>
          <p>
            {t('Meta prépare la vidéo. Cela prend en général quelques minutes ; vous pouvez continuer à remplir le formulaire.',
               'Meta is processing the video. It usually takes a few minutes; you can keep filling in the form.')}
            {progression !== null ? ` (${Math.round(progression)} %)` : ''}
          </p>
          {progression !== null && barre(progression)}
        </>
      )}
      {depot.etape === 'prete' && (
        <p className="text-ink-900" data-testid="pub-video-prete">{t('La vidéo est prête chez Meta.', 'The video is ready at Meta.')}</p>
      )}
      {depot.etape === 'a_verifier' && (
        <p>
          {depot.raison === 'delai'
            ? t('Meta traite encore la vidéo. ', 'Meta is still processing the video. ')
            : t('Nous n’avons pas pu lire l’état de la vidéo chez Meta. ', 'We could not read the video state at Meta. ')}
          <button type="button" className="font-medium text-brand-600 underline" onClick={reverifier} data-testid="pub-video-reverifier">
            {t('Vérifier à nouveau', 'Check again')}
          </button>
        </p>
      )}
      {depot.etape === 'erreur' && (
        <p role="alert" className="text-danger-700" data-testid="pub-video-erreur">{depot.message}</p>
      )}
    </div>
  );
}

/**
 * LES AUDIENCES DU COMPTE PUBLICITAIRE : à inclure, à exclure, ou à ignorer. Seules les audiences UTILISABLES se
 * choisissent ; les autres sont montrées avec la raison de Meta, pour qu'une audience attendue ne semble pas
 * simplement disparue.
 *
 * 🔴 LA PHRASE SUR ADVANTAGE+ N'EST PAS DÉCORATIVE : avec lui, les audiences incluses deviennent des SUGGESTIONS,
 * Meta peut diffuser au-delà. Seules les exclusions sont fermes. Un client qui croit « je ne vise que mes clients »
 * paierait des impressions ailleurs sans le savoir.
 */
function SectionAudiences({ audiences, incluses, exclues, choisir }: {
  audiences: { etat: 'chargement' } | { etat: 'ok'; liste: ListeAudiencesPub } | { etat: 'erreur'; message: string } | { etat: 'absente' };
  incluses: string[];
  exclues: string[];
  choisir: (id: string, choix: 'inclure' | 'exclure' | 'ignorer') => void;
}) {
  const t = useT();
  if (audiences.etat === 'absente') return null;
  const choixDe = (id: string): 'inclure' | 'exclure' | 'ignorer' =>
    incluses.includes(id) ? 'inclure' : exclues.includes(id) ? 'exclure' : 'ignorer';
  const taille = (a: AudiencePub): string => {
    if (a.tailleMin === null && a.tailleMax === null) return t('taille non communiquée par Meta', 'size not given by Meta');
    const f = (n: number | null) => (n === null ? '?' : n.toLocaleString('fr-FR'));
    return t(`environ ${f(a.tailleMin)} à ${f(a.tailleMax)} personnes`, `about ${f(a.tailleMin)} to ${f(a.tailleMax)} people`);
  };
  const liste = audiences.etat === 'ok' ? audiences.liste.audiences : [];
  const utilisables = liste.filter((a) => a.utilisable);
  const inutilisables = liste.filter((a) => !a.utilisable);
  // Une audience retenue (par un brouillon) que la liste ne rend plus : on la montre, pour pouvoir la retirer.
  const connues = new Set(liste.map((a) => a.id));
  const orphelines = audiences.etat === 'ok' ? [...incluses, ...exclues].filter((id) => !connues.has(id)) : [];

  const selecteur = (id: string, nom: string) => (
    <select
      className="rounded-controle border border-ink-200 px-2 py-1 text-xs" value={choixDe(id)}
      onChange={(e) => choisir(id, e.target.value === 'inclure' ? 'inclure' : e.target.value === 'exclure' ? 'exclure' : 'ignorer')}
      aria-label={t(`Que faire de l’audience ${nom}`, `What to do with audience ${nom}`)}
      data-testid={`pub-audience-${id}`}
    >
      <option value="ignorer">{t('Ignorer', 'Ignore')}</option>
      <option value="inclure">{t('Inclure', 'Include')}</option>
      <option value="exclure">{t('Exclure', 'Exclude')}</option>
    </select>
  );

  return (
    <div className="mt-4" data-testid="pub-audiences">
      <p className="block text-xs font-medium text-ink-500">{t('Audiences du compte publicitaire (facultatif)', 'Ad account audiences (optional)')}</p>
      <p className="mt-1 text-xs text-ink-500" data-testid="pub-advantage-audiences">
        {t('Avec Advantage+, les audiences incluses servent de suggestion à Meta, qui peut diffuser au-delà. Les exclusions, le lieu et l’âge minimum restent respectés.',
           'With Advantage+, included audiences are suggestions to Meta, which may deliver beyond them. Exclusions, location and minimum age are always respected.')}
      </p>
      {audiences.etat === 'chargement' && <p className="mt-2 text-xs text-ink-500">{t('Lecture des audiences…', 'Reading audiences…')}</p>}
      {audiences.etat === 'erreur' && (
        <p className="mt-2 text-xs text-ink-500" data-testid="pub-audiences-erreur">
          {t('Nous n’avons pas pu lire les audiences de votre compte. ', 'We could not read your account audiences. ')}
          {audiences.message}
        </p>
      )}
      {audiences.etat === 'ok' && liste.length === 0 && (
        <p className="mt-2 text-xs text-ink-500">
          {t('Aucune audience dans ce compte publicitaire. Elles se créent dans le Gestionnaire de Meta.',
             'No audience in this ad account. They are created in Meta Ads Manager.')}
        </p>
      )}
      {utilisables.length > 0 && (
        <ul className="mt-2 divide-y divide-ink-100 rounded-carte border border-ink-200">
          {utilisables.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm text-ink-900">{a.nom ?? a.id}</p>
                <p className="text-xs text-ink-500">{taille(a)}</p>
              </div>
              {selecteur(a.id, a.nom ?? a.id)}
            </li>
          ))}
        </ul>
      )}
      {orphelines.length > 0 && (
        <ul className="mt-2 space-y-1">
          {orphelines.map((id) => (
            <li key={id} className="flex items-center justify-between gap-3 text-xs text-alerte-700" data-testid="pub-audience-orpheline">
              <span>{t(`L’audience ${id} n’est plus dans ce compte : elle serait refusée à la création.`, `Audience ${id} is no longer in this account: creation would refuse it.`)}</span>
              {selecteur(id, id)}
            </li>
          ))}
        </ul>
      )}
      {inutilisables.length > 0 && (
        <ul className="mt-2 space-y-1" data-testid="pub-audiences-inutilisables">
          {inutilisables.map((a) => (
            <li key={a.id} className="text-xs text-ink-500">
              {a.nom ?? a.id}{' : '}{a.raison ?? t('pas encore utilisable chez Meta', 'not usable at Meta yet')}
            </li>
          ))}
        </ul>
      )}
      {audiences.etat === 'ok' && audiences.liste.tronquee && (
        <p className="mt-2 text-xs text-ink-500">
          {t('Seules les 200 premières audiences sont montrées. Les autres se choisissent dans le Gestionnaire de Meta.',
             'Only the first 200 audiences are shown. Others can be chosen in Meta Ads Manager.')}
        </p>
      )}
      {audiences.etat === 'ok' && (
        <p className="mt-2 text-xs text-ink-500">
          {t('Seules les audiences partagées avec ce compte publicitaire apparaissent ici.', 'Only audiences shared with this ad account appear here.')}
        </p>
      )}
    </div>
  );
}
