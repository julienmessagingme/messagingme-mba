'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import { useT } from '@/lib/i18n';
import { ApiError, estAnnulation } from '@/lib/http';
import { loadFbSdk } from '@/lib/fb-sdk';
import {
  choisirActifsPub, deconnecterPubs, echangerCodePub, getEtatPubs, listerPubs,
  listerBrouillons, lireBrouillon, supprimerBrouillon,
  type ActifsAccordes, type BrouillonPub, type BrouillonPubComplet, type EtatComptePub,
  type EtatPubs, type Publicite,
} from '@/lib/api-pubs';
import { listWorkflows, estEnLigne, getSettings, type WorkflowSummary } from '@/lib/api';
import { PubsListe } from '@/components/PubsListe';
import { PubFormulaire } from '@/components/PubFormulaire';

/**
 * PUBLICITÉS CLICK-TO-WHATSAPP : la connexion de l'espace à son compte publicitaire (lot 2 « Connecter »).
 *
 * 🔴 CET ÉCRAN TOLÈRE L'ABSENCE DE SES ROUTES, ET CE N'EST PAS DE LA PRUDENCE DÉCORATIVE. Vercel publie la
 * console à CHAQUE `git push`, quand l'API attend son déploiement : entre les deux, l'écran appelle une
 * route que la production n'a pas. L'onglet « Outils » de l'agent de Meta est resté en 404 plus d'une heure
 * pour cette raison, le 2026-09-21. Un 404 est donc traité ici comme « pas encore configuré », exactement
 * comme une instance sans `META_ADS_CONFIG_ID`.
 *
 * ⚠️ ÉCRAN ADMIN PAR CONSTRUCTION : `accesAutorise` (`lib/nav.ts`) ne laisse ouvrir cette page qu'à un
 * administrateur, les autres rôles sont redirigés par `AppShell`. Un second contrôle de rôle DANS la page
 * serait du code mort, et le vrai contrôle reste de toute façon le `preHandler` du serveur.
 *
 * ⚠️ CE QUE L'ÉCRAN NE DIT PAS, ET C'EST UNE DÉCISION DE JULIEN (2026-09-23). La déconnexion retire nos
 * trois permissions publicitaires ; trois autres, partagées avec l'application qui porte WhatsApp,
 * restent accordées. L'écran l'annonçait, et ce bandeau a été RETIRÉ : le jeton résiduel n'est détenu par
 * PERSONNE (nous venons de supprimer notre seule copie, aucun tiers ne l'a jamais eue), donc l'avertir
 * revenait à inquiéter un client pour un accès que nul ne peut exercer. Le retrait, lui, reste tenté, et
 * son résultat va au journal d'audit : c'est là qu'on mesurera s'il fonctionne sur ce type de jeton.
 *
 * 🔴 LE BOUTON CRÉER N'EXISTE QUE QUAND LA CONNEXION EST COMPLÈTE, et quand il manque, l'écran DIT ce qui
 * manque. Un bouton présent mais inerte est le motif « offert-et-inerte » que le produit s'interdit ; un
 * bouton absent sans explication fait chercher une panne là où il n'y a qu'une étape non faite.
 */
export default function PublicitesPage() {
  return <AppShell active="publicites">{(session) => <PublicitesInner session={session} />}</AppShell>;
}

function PublicitesInner({ session }: { session: Session }) {
  const t = useT();
  const [etat, setEtat] = useState<EtatPubs | null>(null);
  const [absent, setAbsent] = useState(false);
  const [actifs, setActifs] = useState<ActifsAccordes | null>(null);
  const [compteChoisi, setCompteChoisi] = useState('');
  const [pageChoisie, setPageChoisie] = useState('');
  /**
   * L'ERREUR DE LA COQUILLE : connexion, choix des actifs, déconnexion, lecture de l'état. QUATRE
   * écrivains, et la liste n'en fait PAS partie.
   *
   * 🔴 C'EST LE QUATRIÈME ESSAI, ET LES TROIS PREMIERS PARTAGEAIENT UN SEUL EMPLACEMENT. Le partage a
   * produit trois défauts de suite, chacun corrigé par une discipline un peu plus fine que la
   * précédente : effacer à l'entrée laissait un bandeau périmé ; effacer au succès emportait l'erreur
   * des autres ; une étiquette de source y remédiait SAUF si la liste échouait entre-temps, auquel cas
   * elle prenait l'emplacement puis l'effaçait légitimement, et le message de la déconnexion était perdu.
   *
   * ⚠️ DEUX EMPLACEMENTS FERMENT LA FAMILLE ENTIÈRE, là où une étiquette ne fermait qu'un ordre d'arrivée :
   * la liste ne peut PLUS écrire ici, donc elle ne peut plus rien y écraser, et il n'y a plus d'ordre à
   * raisonner. Une discipline partagée sur une ressource unique se défait toujours par un cas qu'on n'a
   * pas énuméré ; une séparation, non.
   */
  const [erreur, setErreur] = useState<string | null>(null);
  /**
   * L'ERREUR DE LA LISTE DES PUBLICITÉS, rendue DANS sa section et par elle seule.
   *
   * ⚠️ Elle vit ici et non dans `PubsListe` parce que `chargerPubs` a DEUX appelants : cet écran au
   * montage, et la liste elle-même après une action. La descendre dans le composant en ferait une
   * seconde copie pour le premier appelant.
   */
  const [erreurListe, setErreurListe] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pubs, setPubs] = useState<Publicite[] | null>(null);
  const [scenarios, setScenarios] = useState<WorkflowSummary[]>([]);
  /**
   * LES BROUILLONS (migration 0171).
   *
   * ⚠️ TABLEAU VIDE PAR DÉFAUT, ET PAS `null` : contrairement à `pubs`, leur absence n'a aucune
   * conséquence à l'écran. Une API antérieure à ce lot rend 404 sur leur route, et la bonne réponse est
   * alors de ne montrer aucun brouillon, pas d'afficher une panne pour une commodité.
   */
  const [brouillons, setBrouillons] = useState<BrouillonPub[]>([]);
  /** Le brouillon qu'on vient d'ouvrir, visuel compris. `null` = formulaire neuf. */
  const [brouillonOuvert, setBrouillonOuvert] = useState<BrouillonPubComplet | null>(null);
  /**
   * 🔴 TROIS ÉTATS, PAS DEUX : `null` VEUT DIRE « PAS ENCORE LU ». À `false` par défaut, l'écran
   * affichait « l'agent de Meta ne répond plus, rallumez-le » sur le chemin NOMINAL, pendant les deux
   * allers-retours que met `chargerContexte` à lire le réglage, puis le retirait. Et un échec de lecture
   * en faisait un verdict PERMANENT, sur des publicités qui vont bien, avec un geste à faire qui est faux.
   * C'est exactement ce que `enPauseChezMeta` interdit deux fichiers plus loin : on n'invente pas un
   * état qu'on n'a pas lu.
   */
  const [agentMetaOuvert, setAgentMetaOuvert] = useState<boolean | null>(null);
  /**
   * 🔴 L'API DÉPLOYÉE N'A PAS ENCORE LA ROUTE DES PUBLICITÉS, ET L'ÉCRAN DOIT LE DIRE.
   *
   * Vercel publie cette console à CHAQUE `git push`, l'API attend son `up -d --build` : entre les deux,
   * la route répond 404. Sans cet état, `pubs` restait à `null` et l'écran affichait « Chargement… »
   * POUR TOUJOURS, ce qui fait chercher une panne de réseau là où il n'y a qu'une fenêtre qui se referme
   * toute seule. Il ferme aussi le bouton « Créer », dont l'envoi tomberait en 404.
   */
  const [routeAbsente, setRouteAbsente] = useState(false);
  /** L'API a déjà servi la liste au moins une fois. Référence, pour ne pas entrer en dépendance. */
  const listeDejaServie = useRef(false);
  const [formOuvert, setFormOuvert] = useState(false);

  const charger = useCallback(async () => {
    setErreur(null);
    try {
      setEtat(await getEtatPubs(session.tenantId));
    } catch (err) {
      if (estAnnulation(err)) return;
      // Route absente : l'API qui la porte n'est pas encore déployée. On le dit comme une fonctionnalité
      // éteinte, jamais comme une panne, parce que pour le client c'est exactement la même chose.
      if (err instanceof ApiError && err.status === 404) { setAbsent(true); return; }
      setErreur(err instanceof Error ? err.message : t('Chargement impossible', 'Loading failed'));
    }
  }, [session.tenantId, t]);

  /**
   * LES PUBLICITÉS, ET CE QUE LE FORMULAIRE A BESOIN DE SAVOIR.
   *
   * ⚠️ TOUT EST BEST-EFFORT, ET C'EST DÉLIBÉRÉ. Une liste de scénarios qui ne charge pas ne doit pas
   * empêcher de VOIR ses publicités, et une route pas encore déployée ne doit pas casser la page. C'est la
   * même règle que le lot 2 : Vercel publie cette console à chaque `git push`, l'API attend son
   * déploiement, et entre les deux ces routes n'existent pas.
   */
  const chargerPubs = useCallback(async () => {
    try {
      // ⚠️ `?? []` N'EST PAS DE LA PARANOÏA : la même route peut, pendant la fenêtre de déploiement,
      // répondre 200 avec un corps qui n'a pas encore cette clé. Un `undefined` traverserait le type sans
      // que rien ne proteste et casserait la liste à l'affichage, sur un écran qui doit surtout ne pas
      // disparaître.
      setPubs((await listerPubs(session.tenantId)).publicites ?? []);
      listeDejaServie.current = true;
      setRouteAbsente(false);
      /**
       * 🔴 ON N'EFFACE QUE SA PROPRE ERREUR, ET C'EST LE TROISIÈME PLACEMENT DE CETTE LIGNE.
       *
       * À l'entrée, elle effaçait avant tout `await`, donc rien ne pouvait exister : inoffensif, mais
       * elle laissait un bandeau périmé quand un 404 passager était suivi d'un succès. Au succès SANS
       * condition, elle effaçait l'erreur des QUATRE AUTRES opérations qui partagent cet unique
       * emplacement : un échec de `charger()` non rejoué (403, 422, et surtout 429, que le plafond de
       * débit de ce produit rend atteignable) arrivait APRÈS le succès de la liste et se faisait
       * effacer, laissant l'écran sur « Chargement… » sans dire pourquoi. Mesuré en navigateur.
       *
       * ⚠️ ET LA JUSTIFICATION DU PLACEMENT PRÉCÉDENT ÉTAIT FAUSSE. Elle disait que l'effacement à
       * l'entrée était trop large parce qu'« une action de liste effacerait l'échec d'une déconnexion » :
       * or une action de liste qui RÉUSSIT appelle `recharger`, donc passe ici, donc effaçait pareil.
       * Les deux placements avaient le même défaut ; seule la signature le ferme.
       *
       * ⚠️ Le 500 masquait le défaut par HASARD : `web/lib/http.ts` le rejoue, donc `charger()` met
       * deux allers-retours quand la liste n'en met qu'un, et son erreur arrivait après l'effacement.
       */
      // Son emplacement à elle : elle ne peut pas effacer celui de la coquille, par construction.
      setErreurListe(null);
    } catch (err) {
      if (estAnnulation(err)) return;
      // Route absente : l'écran le DIT, au lieu de tourner indéfiniment sur « Chargement… ».
      /**
       * ⚠️ SEULEMENT SI LA LISTE N'A JAMAIS ÉTÉ SERVIE. Un 404 sur un rafraîchissement postérieur à un
       * chargement réussi remplacerait une liste VIVANTE par « attend la mise à jour du serveur », donc
       * ferait perdre ses chiffres au client pour une panne passagère.
       *
       * 🔴 C'EST UNE RÉFÉRENCE ET PAS L'ÉTAT `pubs`, ET CE N'EST PAS UN DÉTAIL. Lire `pubs` ici obligerait
       * à le mettre dans les dépendances de ce `useCallback` ; son identité changerait alors à chaque
       * chargement, l'effet qui l'appelle se rejouerait, et l'écran bombarderait l'API en boucle.
       */
      // ⚠️ ET S'IL ARRIVE APRÈS UN SUCCÈS, IL TOMBE DANS L'ERREUR ORDINAIRE plutôt que d'être MUET : une
      // liste qui a cessé de se rafraîchir sans le dire est « un chiffre périmé qui a l'air frais ».
      if (err instanceof ApiError && err.status === 404 && !listeDejaServie.current) { setRouteAbsente(true); return; }
      setErreurListe(err instanceof Error ? err.message : t('Chargement impossible', 'Loading failed'));
    }
  }, [session.tenantId, t]);

  const chargerContexte = useCallback(async () => {
    // 🔴 SEULS LES SCÉNARIOS EN LIGNE SONT PROPOSÉS. Un brouillon ne répondrait à personne : le proposer
    // ferait créer une publicité dont les prospects payés tomberaient dans le vide.
    await listWorkflows(session.tenantId)
      .then((r) => setScenarios((r.workflows ?? []).filter(estEnLigne)))
      .catch(() => setScenarios([]));
    await getSettings(session.tenantId)
      // ⚠️ UNE CLÉ ABSENTE VAUT INCONNU, PAS « éteint » : la réponse n'est pas validée, et c'est le même
      // cas que le 200 sans la clé décrit trente lignes plus haut.
      .then((r) => setAgentMetaOuvert(typeof r.mbaEnabled === 'boolean' ? r.mbaEnabled : null))
      // ⚠️ `null`, PAS `false` : un échec de lecture ne dit pas que l'agent est éteint, il dit qu'on ne
      // sait pas. Écrire `false` ici posait un avertissement définitif sur une panne passagère.
      .catch(() => setAgentMetaOuvert(null));
  }, [session.tenantId]);

  /**
   * LES BROUILLONS. Silencieux en cas d'échec, et c'est la bonne réponse ici.
   *
   * ⚠️ UNE API ANTÉRIEURE À CE LOT REND 404 SUR CETTE ROUTE, pendant la fenêtre entre le `git push` qui
   * publie la console chez Vercel et le `up` qui déploie l'API. Un brouillon est une commodité : ne pas en
   * montrer est exact, afficher une panne ne le serait pas. Les publicités, elles, ont leur propre
   * traitement du 404 (`routeAbsente`), parce que leur absence CHANGE ce que l'écran promet.
   */
  const chargerBrouillons = useCallback(async () => {
    await listerBrouillons(session.tenantId)
      .then((r) => setBrouillons(r.brouillons ?? []))
      .catch(() => setBrouillons([]));
  }, [session.tenantId]);

  /** Ouvre un brouillon dans le formulaire, visuel compris. */
  const ouvrirBrouillon = useCallback(async (id: string) => {
    setErreurListe(null);
    try {
      const r = await lireBrouillon(session.tenantId, id);
      setBrouillonOuvert(r.brouillon);
      setFormOuvert(true);
    } catch (err) {
      if (estAnnulation(err)) return;
      setErreurListe(err instanceof Error ? err.message : t('Brouillon illisible', 'Could not read draft'));
    }
  }, [session.tenantId, t]);

  const jeterBrouillon = useCallback(async (id: string) => {
    setErreurListe(null);
    try {
      await supprimerBrouillon(session.tenantId, id);
      await chargerBrouillons();
    } catch (err) {
      if (estAnnulation(err)) return;
      setErreurListe(err instanceof Error ? err.message : t('Suppression impossible', 'Could not delete'));
    }
  }, [session.tenantId, chargerBrouillons, t]);

  useEffect(() => { void charger(); }, [charger]);
  useEffect(() => { void chargerPubs(); void chargerContexte(); void chargerBrouillons(); },
    [chargerPubs, chargerContexte, chargerBrouillons]);

  async function connecter(): Promise<void> {
    if (etat === null || !etat.configure) return;
    setErreur(null);
    setBusy(true);
    try {
      await loadFbSdk(etat.appId, etat.graphVersion, t);
      window.FB!.login(
        (resp) => {
          void (async () => {
            try {
              const code = resp?.authResponse?.code;
              if (typeof code !== 'string' || code === '') {
                setErreur(t('Connexion Meta annulée ou refusée.', 'Meta connection cancelled or denied.'));
                return;
              }
              const accordes = await echangerCodePub(session.tenantId, code);
              setActifs(accordes);
              setCompteChoisi(accordes.comptesPub[0]?.id ?? '');
              setPageChoisie(accordes.pages[0]?.id ?? '');
              await charger();
            } catch (err) {
              setErreur(err instanceof Error ? err.message : t('Connexion impossible', 'Connection failed'));
            } finally {
              setBusy(false);
            }
          })();
        },
        { config_id: etat.configId, response_type: 'code', override_default_response_type: true },
      );
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Connexion impossible', 'Connection failed'));
      setBusy(false);
    }
  }

  async function valider(): Promise<void> {
    setErreur(null);
    setBusy(true);
    try {
      await choisirActifsPub(session.tenantId, { comptePubId: compteChoisi, pageId: pageChoisie });
      setActifs(null);
      await charger();
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Enregistrement impossible', 'Could not save'));
    } finally {
      setBusy(false);
    }
  }

  /**
   * 🔴 RECONNECTER PASSE PAR LA DÉCONNEXION, ET CE N'EST PAS UN DÉTOUR. Un second jeton écrasait le
   * premier dans la base, or il est SANS EXPIRATION : l'ancien restait vivant chez Meta et nous venions
   * d'en perdre le seul exemplaire. Les deux chemins qui perdent un jeton passent donc par le même, celui
   * qui révoque d'abord. Relevé en relecture à froid le 2026-09-23.
   *
   * ⚠️ LA RÉVOCATION A LIEU AVANT LA FENÊTRE META, et l'ordre est le tout : la retirer APRÈS la nouvelle
   * autorisation révoquerait ce que le client vient d'accorder.
   *
   * ⚠️ Conséquence assumée : une fenêtre Meta abandonnée laisse l'espace DÉCONNECTÉ. C'est réparable d'un
   * clic, quand un jeton orphelin ne l'est jamais.
   */
  async function reconnecter(): Promise<void> {
    // 🔴 ON S'ARRÊTE SI LA DÉCONNEXION A ÉCHOUÉ, et c'est le tout. Enchaîner quand même ferait échanger un
    // nouveau jeton par-dessus un ancien qu'on n'a pas révoqué, et `connecter` effacerait au passage le
    // message d'erreur que personne n'aurait eu le temps de lire. Une garde qui n'arrête pas la suite ne
    // garde rien (relecture croisée du 2026-09-23). Le serveur refuse de toute façon : c'est la ceinture.
    if (!await deconnecter()) return;
    await connecter();
  }

  async function deconnecter(): Promise<boolean> {
    setErreur(null);
    setBusy(true);
    try {
      // 🔴 LE RÉSULTAT DU RETRAIT N'EST DÉLIBÉRÉMENT PAS AFFICHÉ, et ce n'est pas un oubli : c'est la
      // décision de Julien du 2026-09-23, dont la raison est en tête de ce fichier. Un bandeau a été
      // réécrit ici le même jour, sur la foi du plan et de commentaires périmés ; une relecture à froid
      // l'a rattrapé et a montré qu'il était DANGEREUX : il survivait à une reconnexion et disait alors
      // à un client fraîchement reconnecté de retirer lui-même les permissions publicitaires, donc de
      // désarmer le jeton qu'il venait d'accorder. Le retrait reste TENTÉ, et son résultat va au journal.
      await deconnecterPubs(session.tenantId);
      // 🔴 ET ON RECHARGE, ce qui N'A RIEN À VOIR avec le bandeau ci-dessus : une première version de
      // ce correctif a emporté ces deux lignes en retirant le bandeau. ⚠️ C'est `charger()` qui porte
      // l'effet : `setActifs(null)` est une ceinture, sans consommateur atteignable aujourd'hui (on
      // n'arrive ici que depuis `Connecte`, où `actifs` est déjà nul). Sans le rechargement, `etat` garde son
      // ancienne connexion, donc l'écran continue d'afficher « Compte publicitaire connecté », le nom
      // du compte, le verdict « prêt à diffuser » et jusqu'à l'alerte de jeton refusé, sur un espace
      // dont la ligne vient d'être supprimée. L'ironie était complète : on retirait un bandeau qui
      // SURVIVAIT à une reconnexion en laissant toute la carte SURVIVRE à une déconnexion.
      setActifs(null);
      await charger();
      return true;
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Déconnexion impossible', 'Could not disconnect'));
      return false;
    } finally {
      setBusy(false);
    }
  }

  // ⚠️ `5xl` ET PAS `3xl`, ET C'EST UNE CONTRAINTE MESURÉE, PAS UNE PRÉFÉRENCE. Le formulaire de création
  // porte désormais l'aperçu dans une seconde colonne : dans 768 px, les deux se partageaient 678 px, et
  // les champs de date rendaient « dd/mr » tronqué. Le point de rupture `lg:` de l'aperçu regarde la
  // FENÊTRE, pas ce conteneur, donc l'élargir est ce qui rend les deux colonnes tenables. La liste et
  // l'entonnoir y gagnent au passage : ce sont des tableaux, et 768 px les serrait.
  return (
    <div className="mx-auto w-full max-w-5xl p-6">
      <h1 className="text-xl font-semibold tracking-tight text-ink-900">{t('Publicités', 'Ads')}</h1>
      <p className="mt-1 text-sm text-ink-500">
        {t('Les publicités Meta dont le bouton ouvre une conversation WhatsApp.',
           'Meta ads whose button opens a WhatsApp conversation.')}
      </p>

      {erreur !== null && (
        <p role="alert" data-testid="pubs-erreur" className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{erreur}</p>
      )}

      <section className="mt-5 rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
        {absent || (etat !== null && !etat.configure) ? (
          <Eteint t={t} />
        ) : etat === null ? (
          <p className="text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>
        ) : actifs !== null ? (
          <Choix
            t={t} actifs={actifs} busy={busy}
            compte={compteChoisi} page={pageChoisie}
            setCompte={setCompteChoisi} setPage={setPageChoisie}
            valider={valider}
          />
        ) : etat.connexion === null ? (
          <NonConnecte t={t} busy={busy} connecter={connecter} />
        ) : (
          <Connecte t={t} etat={etat} compte={etat.compte} busy={busy} deconnecter={deconnecter} reconnecter={reconnecter} />
        )}
      </section>

      {/* LES PUBLICITÉS (lot 3). La section n'apparaît qu'une fois la connexion établie : avant, il n'y a
          rien à lister et rien à créer, et l'afficher vide donnerait l'impression d'un écran cassé. */}
      {!absent && etat !== null && etat.configure && etat.connexion !== null && (
        <section className="mt-5 rounded-2xl border border-ink-200 bg-white p-5 shadow-sm" data-testid="pubs-section">
          {/* ⚠️ L'ERREUR DE LA LISTE VIT DANS SA SECTION, pas dans le bandeau de la coquille. C'est ce qui
              rend impossible qu'elle efface le message d'une déconnexion ratée, quel que soit l'ordre
              d'arrivée : elle n'écrit tout simplement plus au même endroit. */}
          {erreurListe !== null && (
            <p role="alert" data-testid="pubs-liste-erreur" className="mb-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{erreurListe}</p>
          )}
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-ink-900">{t('Vos publicités', 'Your ads')}</h2>
              <p className="mt-1 text-xs text-ink-500">
                {t('Créées ici, en pause chez Meta tant que vous ne les publiez pas.',
                   'Created here, paused at Meta until you publish them.')}
              </p>
            </div>
            {/* 🔴 LE BOUTON N'EXISTE QUE SI LA CONNEXION EST COMPLÈTE, et la RAISON est dite juste dessous
                quand il manque. Un bouton désactivé sans explication fait chercher une panne.
                ⚠️ DEUXIÈME RAISON DE LE CACHER : `routeAbsente`, quand l'API déployée n'a pas encore la
                route. Sa raison à lui n'est pas dite ici mais à l'emplacement de la liste, plus bas. */}
            {peutCreer(etat) && !routeAbsente ? (
              <button
                type="button" onClick={() => { setBrouillonOuvert(null); setFormOuvert(true); }}
                className="shrink-0 rounded-xl bg-ink-900 px-4 py-2 text-sm font-medium text-white"
                data-testid="pubs-creer"
              >
                {t('Créer une publicité', 'Create an ad')}
              </button>
            ) : null}
          </div>

          {!peutCreer(etat) && (
            <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800" data-testid="pubs-creation-bloquee">
              {raisonPasDeCreation(etat, t)}
            </p>
          )}

          {formOuvert && (
            <PubFormulaire
              /* 🔴 LA `key` REMONTE LE COMPOSANT QUAND ON CHANGE DE BROUILLON. Ses champs sont initialisés
                 depuis la prop `brouillon` : sans cette clé, React réutiliserait l'instance et garderait
                 l'état du brouillon précédent, donc ouvrir le second montrerait le premier. */
              key={brouillonOuvert?.id ?? 'neuf'}
              tenantId={session.tenantId}
              scenarios={scenarios.map((w) => ({ id: w.id, name: w.name }))}
              /* Il reçoit les TROIS états : il se ferme sur l'inconnu, ce qui est le bon sens d'erreur,
                 mais il ne doit pas ANNONCER que l'agent de Meta est éteint quand nous avons seulement
                 échoué à lire notre réglage. Un `=== true` ici lui ôtait le moyen de faire la différence. */
              agentMetaOuvert={agentMetaOuvert}
              /* Pour l'APERÇU seulement : le prospect lit le nom de la Page, jamais son identifiant. La
                 publicité, elle, part sur le `pageId` que le serveur relit dans la connexion. */
              nomPage={etat.connexion.pageNom}
              brouillon={brouillonOuvert}
              fermer={() => { setFormOuvert(false); setBrouillonOuvert(null); }}
              creee={chargerPubs}
              brouillonsChanges={chargerBrouillons}
            />
          )}

          <div className="mt-4">
            {routeAbsente ? (
              <p className="text-sm text-ink-500" data-testid="pubs-bientot">
                {t('Cette partie de la console attend la mise à jour du serveur. Elle sera disponible dans quelques minutes.',
                   'This part of the console is waiting for the server update. It will be available in a few minutes.')}
              </p>
            ) : pubs === null ? (
              <p className="text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>
            ) : (
              <PubsListe
                tenantId={session.tenantId} publicites={pubs} recharger={chargerPubs}
                comptePubId={etat.connexion.comptePubId} agentMetaOuvert={agentMetaOuvert}
                brouillons={brouillons} ouvrirBrouillon={ouvrirBrouillon} jeterBrouillon={jeterBrouillon}
              />
            )}
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * PEUT-ON CRÉER UNE PUBLICITÉ ?
 *
 * 🔴 TROIS CONDITIONS, ET CHACUNE A DÉJÀ COÛTÉ QUELQUE CHOSE AILLEURS. Le compte et la Page doivent être
 * choisis (sans eux, la création échouerait chez Meta après avoir créé une campagne). Le jeton ne doit pas
 * être rejeté (tous les appels échoueraient). Et le compte doit pouvoir diffuser : sans moyen de paiement,
 * la publicité se crée, se publie, et ne part JAMAIS, ce qui est le pire des trois cas parce que tout a
 * l'air d'avoir marché.
 *
 * ⚠️ `compte === undefined` N'EST PAS UN REFUS : c'est une API pas encore déployée. `null` non plus : c'est
 * « nous n'avons pas pu demander ». Dans les deux cas on laisse créer, et c'est Meta qui tranchera, avec
 * son message. Refuser sur une ignorance bloquerait un client dont le compte va très bien.
 */
function peutCreer(etat: EtatPubs): boolean {
  if (etat.connexion === null) return false;
  if (etat.connexion.comptePubId === null || etat.connexion.pageId === null) return false;
  if (etat.connexion.jetonRejeteLe !== null) return false;
  const c = etat.compte;
  if (c === undefined || c === null) return true;
  return c.moyenPaiement && (c.statut === null || c.statut === 1);
}

function raisonPasDeCreation(etat: EtatPubs, t: T): string {
  if (etat.connexion === null) return t('Connectez votre compte publicitaire.', 'Connect your ad account.');
  if (etat.connexion.comptePubId === null || etat.connexion.pageId === null) {
    return t('Choisissez le compte publicitaire et la Page avant de créer une publicité.',
             'Choose the ad account and the Page before creating an ad.');
  }
  if (etat.connexion.jetonRejeteLe !== null) {
    return t('Meta a refusé notre accès à ce compte : reconnectez-vous avant de créer une publicité.',
             'Meta rejected our access to this account: reconnect before creating an ad.');
  }
  const c = etat.compte;
  if (c !== undefined && c !== null && !c.moyenPaiement) {
    return t('Ce compte publicitaire n’a pas de moyen de paiement : une publicité s’y créerait mais ne partirait jamais.',
             'This ad account has no payment method: an ad would be created but would never run.');
  }
  return t('Ce compte publicitaire ne peut pas diffuser pour l’instant, d’après Meta.',
           'This ad account cannot deliver right now, according to Meta.');
}

type T = (fr: string, en?: string) => string;

function Eteint({ t }: { t: T }) {
  return (
    <div>
      <h2 className="text-sm font-semibold text-ink-900">{t('Publicités non configurées', 'Ads not configured')}</h2>
      <p className="mt-2 text-sm text-ink-500">
        {t('Cette fonctionnalité n’est pas encore activée sur cette instance. Rien à faire de votre côté.',
           'This feature is not enabled on this instance yet. Nothing to do on your side.')}
      </p>
    </div>
  );
}

function NonConnecte({ t, busy, connecter }: { t: T; busy: boolean; connecter: () => Promise<void> }) {
  return (
    <div>
      <h2 className="text-sm font-semibold text-ink-900">{t('Compte publicitaire', 'Ad account')}</h2>
      <p className="mt-2 text-sm text-ink-500">
        {t('Connectez votre compte publicitaire Meta et la Page qui portera vos publicités.',
           'Connect your Meta ad account and the Page that will carry your ads.')}
      </p>
      <button
        type="button" disabled={busy} onClick={() => void connecter()}
        className="mt-4 rounded-xl bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
      >
        {t('Connecter mes publicités', 'Connect my ads')}
      </button>
    </div>
  );
}

function Choix({ t, actifs, busy, compte, page, setCompte, setPage, valider }: {
  t: T; actifs: ActifsAccordes; busy: boolean; compte: string; page: string;
  setCompte: (v: string) => void; setPage: (v: string) => void; valider: () => Promise<void>;
}) {
  const rien = actifs.comptesPub.length === 0 || actifs.pages.length === 0;
  return (
    <div>
      <h2 className="text-sm font-semibold text-ink-900">{t('Choisissez le compte et la Page', 'Choose the account and Page')}</h2>
      {rien ? (
        <p className="mt-2 text-sm text-ink-500">
          {/* Une liste vide n'est pas une panne : le client n'a simplement rien accordé dans la fenêtre. */}
          {t('La connexion n’a donné accès à aucun compte publicitaire ou à aucune Page. Reprenez la connexion et cochez les deux.',
             'The connection granted no ad account or no Page. Start over and select both.')}
        </p>
      ) : (
        <>
          <label className="mt-3 block text-xs font-medium text-ink-500" htmlFor="compte-pub">{t('Compte publicitaire', 'Ad account')}</label>
          <select id="compte-pub" value={compte} onChange={(e) => setCompte(e.target.value)} className="mt-1 w-full rounded-xl border border-ink-200 px-3 py-2 text-sm">
            {/* Le NOM d'abord : un admin reconnaît « GMC », pas un identifiant de quinze chiffres. Et un
                compte que Meta ne dit pas actif (`statut !== 1`) le dit ici, avant qu'on s'étonne qu'une
                pub ne parte pas. */}
            {actifs.comptesPub.map((c) => (
              <option key={c.id} value={c.id}>
                {(c.nom ?? c.id) + (c.devise !== null ? ` (${c.devise})` : '')}
                {c.statut !== null && c.statut !== 1 ? t(' — compte inactif chez Meta', ' — account inactive at Meta') : ''}
              </option>
            ))}
          </select>
          <label className="mt-3 block text-xs font-medium text-ink-500" htmlFor="page-pub">{t('Page Facebook', 'Facebook Page')}</label>
          <select id="page-pub" value={page} onChange={(e) => setPage(e.target.value)} className="mt-1 w-full rounded-xl border border-ink-200 px-3 py-2 text-sm">
            {actifs.pages.map((p) => <option key={p.id} value={p.id}>{p.nom ?? p.id}</option>)}
          </select>
          <button
            type="button" disabled={busy || compte === '' || page === ''} onClick={() => void valider()}
            className="mt-4 rounded-xl bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {t('Enregistrer', 'Save')}
          </button>
        </>
      )}
    </div>
  );
}

/**
 * CE QUI EMPÊCHE, OU NON, DE DIFFUSER, en une phrase.
 *
 * 🔴 QUATRE CAS ET PAS TROIS : `statut` à `null` est une IGNORANCE, pas un refus. Meta peut répondre
 * 200 sans `account_status` (champ absent, réponse d'une forme inattendue). Le ranger avec
 * `statut !== 1` faisait écrire « ce compte n'est pas actif » sur une chose qu'on ne sait pas, donc
 * envoyait le client réparer un compte qui va bien. C'est exactement le raisonnement que ce lot a
 * RETIRÉ de la liaison Page : une ignorance ne s'affiche jamais comme un constat.
 *
 * ⚠️ `raisonDesactivation` EST LUE ICI, et nulle part ailleurs. Elle traversait le client, la route et
 * le type du front sans que rien ne l'affiche : c'est pourtant le seul chiffre qui dise au client CE
 * QU'IL doit corriger. Le code brut suffit, il est ce qu'il donnera au support de Meta.
 */
function messageDiffusion(compte: EtatComptePub | null, t: T): string {
  if (compte === null) {
    return t('Nous n’avons pas pu demander à Meta si ce compte peut diffuser.',
            'We could not ask Meta whether this account can deliver.');
  }
  if (compte.statut === null) {
    return t('Meta ne nous a pas dit l’état de ce compte : nous ne savons pas s’il peut diffuser.',
            'Meta did not tell us this account’s status: we do not know whether it can deliver.');
  }
  if (compte.statut !== 1) {
    const raison = compte.raisonDesactivation !== null && compte.raisonDesactivation !== 0
      ? t(` (motif Meta n°${compte.raisonDesactivation})`, ` (Meta reason #${compte.raisonDesactivation})`)
      : '';
    return t(`Ce compte publicitaire n’est pas actif chez Meta${raison} : une publicité ne partirait pas.`,
            `This ad account is not active at Meta${raison}: an ad would not deliver.`);
  }
  if (!compte.moyenPaiement) {
    return t('Aucun moyen de paiement sur ce compte : une publicité se créerait mais ne partirait jamais.',
            'No payment method on this account: an ad would be created but would never deliver.');
  }
  return t('✓ Prêt à diffuser : compte actif, moyen de paiement en place.',
          '✓ Ready to deliver: account active, payment method in place.');
}

function Connecte({ t, etat, compte, busy, deconnecter, reconnecter }: {
  t: T; etat: EtatPubs; compte: EtatComptePub | null | undefined; busy: boolean;
  deconnecter: () => Promise<boolean>; reconnecter: () => Promise<void>;
}) {
  const c = etat.connexion!;
  // L'absence du champ et son `null` disent la MÊME chose (« je n'ai pas pu demander »), et les
  // ramener ici évite que chaque lecture plus bas ait à y penser. Voir `EtatPubs.compte`.
  const diffusion = compte ?? null;
  return (
    <div>
      <h2 className="text-sm font-semibold text-ink-900">{t('Compte publicitaire connecté', 'Ad account connected')}</h2>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
        {/* Le NOM d'abord, l'identifiant en repli : « GMC » se reconnaît, pas quinze chiffres. Les
            connexions faites avant la migration 0169 n'ont pas de nom, d'où le repli. */}
        <Ligne id="compte" cle={t('Compte', 'Account')}
          valeur={c.compteNom ?? c.comptePubId ?? t('à choisir', 'to be chosen')}
          sous={c.compteNom !== null ? c.comptePubId : null} />
        <Ligne id="page" cle={t('Page', 'Page')}
          valeur={c.pageNom ?? c.pageId ?? t('à choisir', 'to be chosen')}
          sous={c.pageNom !== null ? c.pageId : null} />
        <Ligne id="devise" cle={t('Devise', 'Currency')} valeur={c.devise ?? '—'} />
        <Ligne id="fuseau" cle={t('Fuseau', 'Time zone')} valeur={c.fuseau ?? '—'} />
      </dl>

      {/*
        🔴 PRÊT À DIFFUSER, LU EN DIRECT. Le statut du compte et la présence d'un moyen de paiement
        décident si une pub PARTIRA : sans eux, elle se crée et ne diffuse jamais, et l'erreur arrive
        tard. `null` = nous n'avons pas pu demander à Meta, ce qui n'est PAS un feu vert.
      */}
      {/*
        ⚠️ RIEN TANT QU'AUCUN COMPTE N'EST CHOISI, et ce n'est pas un détail. Cet écran s'affiche AUSSI
        dans l'état « jeton posé, choix pas encore fait », que la migration 0167 décrit comme normal au
        retour. Y annoncer « nous n'avons pas pu demander à Meta » serait faux : il n'y a rien à
        demander tant qu'on ne sait pas DE QUEL compte on parle.
      */}
      {c.comptePubId !== null && (
        <p data-testid="pubs-diffusion" className="mt-4 text-sm text-ink-600">
          {messageDiffusion(diffusion, t)}
        </p>
      )}

      {/*
        🔴 META N'EXPOSE PAS CETTE LIAISON, ET ON LE DIT AU LIEU DE FAIRE SEMBLANT. Mesuré le 2026-09-23 :
        dix champs essayés sur les trois objets concernés (numéro, compte WhatsApp, Page). Aucun ne la
        rend, alors que le WhatsApp Manager l'affiche. On emmène donc le client là où c'est écrit,
        plutôt que de le laisser avec un « je ne sais pas » sans suite.
      */}
      <p className="mt-2 text-sm text-ink-500">
        {t('La Page doit être reliée à votre numéro WhatsApp pour que les clics arrivent dans votre Inbox. Meta ne nous permet pas de le vérifier : ',
           'The Page must be linked to your WhatsApp number for clicks to reach your Inbox. Meta does not let us verify it: ')}
        <a href="https://business.facebook.com/wa/manage/phone-numbers/" target="_blank" rel="noreferrer"
          className="underline hover:text-ink-700">
          {t('voir la liaison chez Meta', 'check the link at Meta')}
        </a>
        {t(' (section « Comptes sociaux » du numéro).', ' (the number’s “Social accounts” section).')}
      </p>

      {c.jetonRejeteLe !== null && (
        <p role="alert" data-testid="pubs-jeton-rejete" className="mt-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {t('Meta a refusé notre accès à ce compte. Reconnectez-vous pour continuer.',
             'Meta refused our access to this account. Reconnect to continue.')}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <button
          type="button" disabled={busy} onClick={() => void reconnecter()}
          className="rounded-xl border border-ink-200 px-4 py-2 text-sm font-medium text-ink-700 disabled:opacity-40"
        >
          {t('Reconnecter', 'Reconnect')}
        </button>
        <button
          type="button" disabled={busy} onClick={() => void deconnecter()}
          className="rounded-xl border border-red-200 px-4 py-2 text-sm font-medium text-red-700 disabled:opacity-40"
        >
          {t('Déconnecter', 'Disconnect')}
        </button>
      </div>
    </div>
  );
}

/** `sous` : l'identifiant, en petit sous le nom. On le garde à vue, c'est lui qu'on donne au support. */
function Ligne({ id, cle, valeur, sous }: { id: string; cle: string; valeur: string; sous?: string | null }) {
  return (
    <div>
      <dt className="text-xs font-medium text-ink-400">{cle}</dt>
      <dd data-testid={`pubs-${id}`} className="text-ink-900">{valeur}</dd>
      {sous !== null && sous !== undefined && <div className="text-xs text-ink-400">{sous}</div>}
    </div>
  );
}
