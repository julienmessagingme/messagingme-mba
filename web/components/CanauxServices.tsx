'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Toggle } from '@/components/Toggle';
import { LogoWhatsApp, LogoGoogleMessages, LogoChaineWhatsApp, LogoMeta, LogoHubSpot } from '@/components/LogosCanaux';
import { DOT_HEX } from '@/lib/ui';
import { useT, useLocale } from '@/lib/i18n';
import { dateHeure } from '@/lib/day';
import { estAnnulation } from '@/lib/http';
import { delierNumero, relierNumero, setHubspotActif, getVolumesCanaux, type AccountStatusResponse } from '@/lib/api';
import { lireVolumesCanaux, phraseVolume, phrasePublications, type Volume, type VolumesCanaux } from '@/lib/chiffres-canaux';
import { getConnexionChaine, listerPostsChaine, debrancherChaine, nomDeLaChaine, type ReponseConnexionChaine } from '@/lib/api-chaine';
import { getEtatPubs, deconnecterPubs, type EtatPubs } from '@/lib/api-pubs';
import type { CanalRcs } from '@/components/RcsChannelCard';
import type { ConnexionNumero } from '@/lib/connexion-numero';
import {
  demandeConfirmation, ligneNumero, ligneRcs, ligneChaine, lignePublicites, ligneHubspot, nombreDePublications, routeInconnue, teinte,
  numeroASurveiller, type Geste, type Ligne, type Teinte,
} from '@/lib/canaux-services';
import { Bouton } from '@/components/Bouton';
import { Modale } from '@/components/Modale';
import { Icone } from '@/components/Icone';

/**
 * LE BLOC « CANAUX ET SERVICES » DE L'ACCUEIL (plan du 2026-09-25, design validé par Julien).
 *
 * Une GRILLE DE CARTES depuis le 2026-09-25 après-midi (3 colonnes, 2, puis 1 selon la largeur) : le logo du
 * canal, l'interrupteur, une pastille d'état (`teinte`), la phrase, puis au bas de la carte sa ligne de chiffre
 * (`lib/chiffres-canaux.ts`, depuis le 2026-09-25) et, pour la chaîne, les publicités et HubSpot, le lien vers leur
 * écran (WhatsApp et RCS n'en ont plus : leur détail est plus bas sur l'Accueil). Les gestes n'ont pas bougé.
 *
 * Cinq lignes, cinq interrupteurs, chacun branché sur un geste qui existe (ou sur l'un des deux neufs : délier le
 * numéro, débrancher la chaîne). Les décisions vivent dans `lib/canaux-services.ts`, testées sans navigateur ;
 * ce composant ne fait que dire, confirmer et appeler.
 *
 * 🔴 ÉTEINDRE SE CONFIRME, ET LA CONFIRMATION DIT CE QUI S'ARRÊTE, service par service. Rallumer ne demande rien.
 *
 * ⚠️ ADMIN SEULEMENT : l'Accueil ne monte ce bloc que pour un administrateur. Tous ses gestes sont réservés aux
 * admins côté serveur, et deux de ses lectures aussi (les publicités, l'état du compte).
 */

type Service = 'numero' | 'rcs' | 'chaine' | 'publicites' | 'hubspot';
type Lecture<T> = T | 'echec' | null;
/** La ligne de chiffre d'une carte : le chiffre, et ce qu'il compte (au survol). */
interface Chiffre { texte: string; aide: string }

const COULEUR: Record<Teinte, string> = { vert: DOT_HEX.green, gris: DOT_HEX.grey, ambre: DOT_HEX.amber };

export function CanauxServices(p: {
  tenantId: string;
  /** Le statut du compte que l'Accueil a lu. `null` : pas encore lu, ou lecture en échec (`compteEnEchec`). */
  compte: AccountStatusResponse | null;
  compteEnEchec: boolean;
  /** Relit le statut du compte : après « Délier » ou « Relier ». */
  onNumeroChange: () => void;
  connexionNumero: ConnexionNumero;
  rcs: CanalRcs;
  /** L'interrupteur HubSpot de l'espace, tel que l'Accueil l'a lu (`undefined` = API plus ancienne). */
  hubspotActif: boolean | undefined;
  onHubspotActif: (actif: boolean) => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  const router = useRouter();
  const [chaine, setChaine] = useState<Lecture<ReponseConnexionChaine>>(null);
  const [publications, setPublications] = useState<number | null>(null);
  const [pubs, setPubs] = useState<Lecture<EtatPubs | 'absent'>>(null);
  const [confirmation, setConfirmation] = useState<Geste | null>(null);
  const [enCours, setEnCours] = useState<Service | null>(null);
  const [erreurs, setErreurs] = useState<Partial<Record<Service, string>>>({});
  const [info, setInfo] = useState<string | null>(null);

  /** Chaîne : l'état, puis le nombre de publications, seulement si elle est branchée (plan : `/connection`, `/posts`). */
  const chargerChaine = useCallback(async () => {
    // Le compte d'avant est oublié AVANT de relire : une lecture qui échoue ne doit pas laisser « 3 publications au
    // total » sous « État inconnu » (relecture du 2026-09-25).
    setPublications(null);
    try {
      const c = await getConnexionChaine(p.tenantId);
      setChaine(c);
      if (c?.connection) setPublications(nombreDePublications(await listerPostsChaine(p.tenantId).catch(() => null)));
    } catch (err) {
      if (!estAnnulation(err)) setChaine('echec');
    }
  }, [p.tenantId]);

  /** Publicités : un 404 est une route pas encore déployée, pas une panne (même règle que l'écran Publicités). */
  const chargerPubs = useCallback(async () => {
    try {
      setPubs(await getEtatPubs(p.tenantId));
    } catch (err) {
      if (estAnnulation(err)) return;
      setPubs(err !== null && typeof err === 'object' && (err as { status?: unknown }).status === 404 ? 'absent' : 'echec');
    }
  }, [p.tenantId]);

  /**
   * Envoyés et reçus sur 30 jours, pour les cartes WhatsApp et RCS (Julien, 2026-09-25). 🔴 Tout échec, 404 de
   * routeur compris (la console publiée avant l'API), laisse `null` : la carte n'affiche PAS de chiffre, et
   * surtout pas un zéro qui dirait que le canal n'a servi à rien.
   */
  const [volumes, setVolumes] = useState<VolumesCanaux | null>(null);
  const chargerVolumes = useCallback(async () => {
    try {
      setVolumes(lireVolumesCanaux(await getVolumesCanaux(p.tenantId)));
    } catch {
      setVolumes(null);
    }
  }, [p.tenantId]);

  useEffect(() => { void chargerChaine(); void chargerPubs(); void chargerVolumes(); }, [chargerChaine, chargerPubs, chargerVolumes]);

  const lignes: Record<Service, Ligne> = {
    numero: ligneNumero({ compte: p.compte, connexionDisponible: p.connexionNumero.cfg?.enabled === true }),
    rcs: ligneRcs(p.rcs.etat),
    chaine: ligneChaine(chaine === 'echec' ? null : chaine),
    publicites: lignePublicites(pubs === 'echec' ? null : pubs),
    hubspot: ligneHubspot({ actif: p.hubspotActif, portailRelie: p.compte ? p.compte.hubspotPortal?.connected === true : undefined }),
  };

  function messageDe(err: unknown): string {
    // 🔴 L'API DÉPLOYÉE PEUT NE PAS ENCORE CONNAÎTRE LE GESTE : Vercel publie cette console à chaque `git push`,
    // l'API attend son déploiement. Son 404 de routeur n'est pas une panne, et l'écran le dit ainsi.
    if (routeInconnue(err)) return t('Ce geste n’est pas encore disponible : le serveur n’est pas à jour. Réessayez un peu plus tard.', 'This action is not available yet: the server is not up to date. Try again a bit later.');
    return err instanceof Error ? err.message : t('Le changement n’a pas pu être appliqué.', 'The change could not be applied.');
  }

  const serviceDe = (g: Geste): Service =>
    g.endsWith('_numero') ? 'numero' : g.endsWith('_rcs') ? 'rcs' : g.endsWith('_chaine') ? 'chaine' : g.endsWith('_publicites') ? 'publicites' : 'hubspot';

  async function executer(g: Geste): Promise<void> {
    const s = serviceDe(g);
    setEnCours(s);
    setErreurs((e) => ({ ...e, [s]: undefined }));
    setInfo(null);
    try {
      switch (g) {
        case 'delier_numero': {
          const r = await delierNumero(p.tenantId);
          setInfo(r.campagnesEnPause > 0
            ? t(`Numéro délié. ${r.campagnesEnPause} campagne(s) mise(s) en pause.`, `Number unlinked. ${r.campagnesEnPause} campaign(s) paused.`)
            : t('Numéro délié.', 'Number unlinked.'));
          p.onNumeroChange();
          break;
        }
        case 'relier_numero': {
          const r = await relierNumero(p.tenantId);
          const n = r.campagnesReprises + r.campagnesReprogrammees;
          setInfo(n > 0
            ? t(`Numéro relié. ${n} campagne(s) reprennent dans la minute.`, `Number relinked. ${n} campaign(s) resume within a minute.`)
            : t('Numéro relié.', 'Number relinked.'));
          p.onNumeroChange();
          break;
        }
        // La fenêtre Meta : ses erreurs vivent dans `connexionNumero.error`, affichées sur la ligne.
        case 'connecter_numero': await p.connexionNumero.connect(); break;
        case 'activer_rcs': p.rcs.ouvrirActivation(); break;
        case 'couper_rcs': await p.rcs.couper(); break;
        case 'ouvrir_chaine': router.push('/chaine'); break;
        case 'debrancher_chaine': await debrancherChaine(p.tenantId); await chargerChaine(); break;
        case 'ouvrir_publicites': router.push('/publicites'); break;
        case 'deconnecter_publicites': await deconnecterPubs(p.tenantId); await chargerPubs(); break;
        case 'allumer_hubspot':
        case 'eteindre_hubspot': {
          const r = await setHubspotActif(p.tenantId, g === 'allumer_hubspot');
          p.onHubspotActif(r.hubspotActif === true);
          break;
        }
      }
    } catch (err) {
      setErreurs((e) => ({ ...e, [s]: messageDe(err) }));
    } finally {
      setEnCours(null);
    }
  }

  function actionner(g: Geste | null): void {
    if (g === null) return;
    if (demandeConfirmation(g)) setConfirmation(g);
    else void executer(g);
  }

  const date = (iso: string): string => dateHeure(iso, locale);
  const lecture = t('Lecture…', 'Loading…');
  const inconnu = t('État inconnu pour le moment.', 'State unknown right now.');

  const phraseNumero = (): string => {
    const c = p.compte;
    if (c === null) return p.compteEnEchec ? inconnu : lecture;
    if (!c.hasNumber) {
      return p.connexionNumero.cfg?.enabled === true
        ? t('Aucun numéro relié : l’allumer ouvre la connexion Meta.', 'No number linked: turning it on opens the Meta connection.')
        : t('Aucun numéro relié : la connexion n’est pas encore disponible sur cette instance.', 'No number linked: connection is not available on this instance yet.');
    }
    const numero = c.number ? (c.number.startsWith('+') ? c.number : `+${c.number}`) : t('le numéro', 'the number');
    if (typeof c.delieLe === 'string') {
      return t(
        `${numero} délié le ${date(c.delieLe)} : aucun message WhatsApp ne part, et les messages reçus ne sont pas enregistrés.`,
        `${numero} unlinked on ${date(c.delieLe)}: no WhatsApp message goes out, and incoming messages are not recorded.`,
      );
    }
    // Relié, mais Meta signale un problème : la phrase le dit, comme la pastille (ambre), plutôt qu'un « Relié »
    // tout court qui contredirait la carte du numéro, juste en dessous (`numeroASurveiller`).
    if (numeroASurveiller(c)) return t(`Relié : ${numero}. Chez Meta : ${c.status.label}.`, `Linked: ${numero}. At Meta: ${c.status.label}.`);
    return t(`Relié : ${numero}.`, `Linked: ${numero}.`);
  };

  const phraseRcs = (): string => {
    const e = p.rcs.etat;
    if (e === null) return lecture;
    if (e === 'echec') return inconnu;
    if (e.active !== true) return t('Inactif. L’allumer demande la clé du canal.', 'Inactive. Turning it on asks for the channel key.');
    const nom = e.channel?.displayName || e.channel?.brandName;
    return nom ? t(`Actif, sous l’agent « ${nom} ».`, `Active, under the “${nom}” agent.`) : t('Actif.', 'Active.');
  };

  const phraseChaine = (): string => {
    if (chaine === null) return lecture;
    if (chaine === 'echec' || lignes.chaine.allume === null) return inconnu;
    if (!chaine.connection) return t('Non branchée. L’allumer ouvre l’écran Chaîne, pour saisir les identifiants.', 'Not connected. Turning it on opens the Channel screen, to enter the credentials.');
    // Le nombre de publications a quitté la phrase le 2026-09-25 : il est la ligne de chiffre de la carte.
    const nom = nomDeLaChaine(chaine);
    return nom ? t(`Branchée : « ${nom} ».`, `Connected: “${nom}”.`) : t('Branchée.', 'Connected.');
  };

  const phrasePubs = (): string => {
    if (pubs === null) return lecture;
    if (pubs === 'echec') return inconnu;
    if (lignes.publicites.allume === null) return t('Indisponible sur cette instance pour le moment.', 'Not available on this instance yet.');
    const cx = pubs === 'absent' ? null : pubs.connexion;
    if (!cx) return t('Non connecté. L’allumer ouvre l’écran Publicités.', 'Not connected. Turning it on opens the Ads screen.');
    if (!cx.comptePubId) return t('Connexion à terminer : choisissez le compte et la Page dans l’écran Publicités.', 'Connection to finish: pick the account and the Page on the Ads screen.');
    return t(`Connecté : ${cx.compteNom ?? cx.comptePubId}.`, `Connected: ${cx.compteNom ?? cx.comptePubId}.`);
  };

  const phraseHubspot = (): string => {
    if (p.hubspotActif === undefined) return t('Réglage indisponible pour le moment.', 'Setting not available yet.');
    if (!p.hubspotActif) return t('Éteint : HubSpot n’apparaît pas sur l’Accueil.', 'Off: HubSpot does not show on the Home page.');
    if (lignes.hubspot.geste === null) {
      return t(
        'Pour l’éteindre, déconnectez d’abord le portail dans le bloc HubSpot.',
        'To turn it off, first disconnect the portal in the HubSpot block.',
      );
    }
    return t('Allumé : le bloc HubSpot s’affiche sur l’Accueil.', 'On: the HubSpot block shows on the Home page.');
  };

  // « À terminer » : la même condition que la phrase « Connexion à terminer » de `phrasePubs`.
  const pubsATerminer = pubs !== null && pubs !== 'echec' && pubs !== 'absent' && !!pubs.connexion && !pubs.connexion.comptePubId;

  /**
   * La LIGNE DE CHIFFRE d'une carte (Julien, 2026-09-25) : envoyés et reçus pour WhatsApp et RCS, publications pour
   * la chaîne. `null` = on ne sait pas, et la carte n'affiche rien à cet endroit. L'`aide` (au survol) dit ce
   * qui est compté, parce que ce n'est PAS le périmètre de « Messages échangés », juste au-dessus.
   *
   * ⚠️ LA PRÉCISION VISIBLE SOUS LE CHIFFRE EST PARTIE (Julien, 2026-09-25 : « on retire, on n'ajoute rien ») :
   * « tout le canal, envois de campagne compris » ne se lit plus qu'au survol.
   */
  const aideVolume = (jours: number): string => t(
    `Messages partis et arrivés sur ce canal ces ${jours} derniers jours, modèles de campagne compris, hors conversations de test.`,
    `Messages sent and received on this channel over the last ${jours} days, campaign templates included, test conversations excluded.`,
  );
  const chiffreVolume = (v: Volume | null | undefined): Chiffre | null => {
    const texte = volumes === null ? null : phraseVolume(v ?? null, volumes.jours, locale);
    return texte === null || volumes === null ? null : { texte, aide: aideVolume(volumes.jours) };
  };
  // `publications` ne se lit que sur une chaîne branchée (`chargerChaine`) : `null` partout ailleurs.
  const textePublications = phrasePublications(publications, locale);

  // ⚠️ « Voir le numéro » et « Voir le canal » sont partis le 2026-09-25 : le détail des deux est juste en
  // dessous, sur l'Accueil même. Leurs cartes portent désormais leur chiffre à la place.
  const rangees: Array<{
    service: Service; titre: string; phrase: string; lien?: { href: string; texte: string };
    chiffre: Chiffre | null;
    Logo: (x: { className?: string }) => React.ReactElement; aTerminer?: boolean;
  }> = [
    {
      service: 'numero', titre: t('Numéro WhatsApp', 'WhatsApp number'), phrase: phraseNumero(),
      chiffre: chiffreVolume(volumes?.whatsapp),
      Logo: LogoWhatsApp,
      // Relié mais signalé par Meta : ambre, comme la santé du compte plus bas (`numeroASurveiller`).
      aTerminer: numeroASurveiller(p.compte),
    },
    {
      service: 'rcs', titre: t('Canal RCS', 'RCS channel'), phrase: phraseRcs(),
      chiffre: chiffreVolume(volumes?.rcs),
      Logo: LogoGoogleMessages,
    },
    {
      service: 'chaine', titre: t('Chaîne', 'Channel'), phrase: phraseChaine(), lien: { href: '/chaine', texte: t('Ouvrir l’écran Chaîne', 'Open the Channel screen') },
      chiffre: textePublications === null ? null : { texte: textePublications, aide: t('Toutes les publications faites depuis la console.', 'Every post published from the console.') },
      Logo: LogoChaineWhatsApp,
    },
    { service: 'publicites', titre: t('Compte publicitaire', 'Ad account'), phrase: phrasePubs(), lien: { href: '/publicites', texte: t('Ouvrir l’écran Publicités', 'Open the Ads screen') }, chiffre: null, Logo: LogoMeta, aTerminer: pubsATerminer },
    { service: 'hubspot', titre: 'HubSpot', phrase: phraseHubspot(), lien: { href: '/parametres#integration-hubspot', texte: t('Ouvrir le réglage', 'Open the setting') }, chiffre: null, Logo: LogoHubSpot },
  ];

  // ⚠️ Les erreurs de la fenêtre Meta et de la clé RCS restent dans LEUR carte (la zone de connexion, la carte
  // RCS), qui porte le formulaire : les répéter ici ferait deux bandeaux pour une seule panne.
  const erreurDe = (s: Service): string | undefined => erreurs[s];
  const occupe = (s: Service): boolean =>
    enCours === s || (s === 'numero' && p.connexionNumero.busy) || (s === 'rcs' && p.rcs.busy);

  return (
    <section data-testid="canaux-services">
      <h3 className="text-sm font-semibold text-ink-900">{t('Canaux et services', 'Channels and services')}</h3>
      {info && <p data-testid="canaux-info" className="mt-3 rounded-controle bg-succes-50 px-3 py-2 text-xs text-succes-700">{info}</p>}
      {/* ⚠️ 3 colonnes à partir de `xl` et non de `lg` : la colonne latérale (240 px) apparaît à `lg`, et trois
          cartes y tomberaient sous 230 px, trop étroites pour une phrase d'état et un interrupteur. */}
      <ul className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {rangees.map(({ service, titre, phrase, lien, chiffre, Logo, aTerminer }) => {
          const l = lignes[service];
          const erreur = erreurDe(service);
          const pastille = teinte(l, aTerminer);
          return (
            <li key={service} data-testid={`canal-${service}`} className="flex flex-col rounded-carte border border-ink-200 bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  {/* Le logo est DÉCORATIF ici : le titre juste à côté nomme déjà la carte, et un lecteur d'écran
                      lisait « WhatsApp, image, Numéro WhatsApp » (relecture du 2026-09-25). Le titre est un `h4`,
                      sous le `h3` du bloc, pour que la carte se trouve par les titres. */}
                  <span data-testid={`canal-${service}-logo`} aria-hidden="true" className="shrink-0">
                    <Logo className="h-8 w-8" />
                  </span>
                  <h4 className="text-sm font-semibold text-ink-900">{titre}</h4>
                </div>
                {l.allume !== null && (
                  <Toggle
                    testid={`canal-${service}-toggle`}
                    checked={l.allume}
                    onChange={() => actionner(l.geste)}
                    disabled={l.geste === null || occupe(service)}
                    title={titre}
                  />
                )}
              </div>
              <div className="mt-3 flex items-start gap-2">
                {/* La phrase porte le sens : la pastille le double pour l'œil, d'où `aria-hidden`. */}
                {pastille !== null && (
                  <span
                    data-testid={`canal-${service}-pastille`}
                    data-teinte={pastille}
                    aria-hidden="true"
                    className="mt-[3px] h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: COULEUR[pastille] }}
                  />
                )}
                <p data-testid={`canal-${service}-etat`} className="text-xs text-ink-500">{phrase}</p>
              </div>
              {erreur && <p data-testid={`canal-${service}-erreur`} className="mt-2 text-xs text-danger">{erreur}</p>}
              {/* ⚠️ LE BAS DE CARTE RESTE, MÊME VIDE : son `mt-auto` pousse chiffre et lien au bas de la carte, ce
                  qui les aligne d'une carte à l'autre dans une même rangée. */}
              <div className="mt-auto flex flex-col items-start gap-1 pt-3">
                {chiffre !== null && (
                  <p data-testid={`canal-${service}-chiffre`} title={chiffre.aide} className="text-sm font-semibold tabular-nums text-ink-900">
                    {chiffre.texte}
                  </p>
                )}
                {lien && <Link href={lien.href} data-testid={`canal-${service}-lien`} className="text-xs text-brand-600 hover:underline">{lien.texte}</Link>}
              </div>
            </li>
          );
        })}
        {/* La sixième case : les intégrations qui n'ont pas de carte ici. Pas un service, donc ni interrupteur ni
            pastille. Elle mène à Paramètres « pour l'instant » (Julien, 2026-09-25) : sa cible changera le jour
            où les intégrations auront leur propre écran. */}
        <li data-testid="canal-autres">
          <Link
            href="/parametres"
            data-testid="canal-autres-lien"
            className="flex h-full min-h-[7.5rem] items-center justify-center gap-1.5 rounded-carte border border-dashed border-ink-300 p-4 text-sm font-semibold text-brand-600 transition-colors duration-150 hover:border-brand-300 hover:bg-brand-50"
          >
            {t('Autres intégrations', 'Other integrations')}<Icone nom="ajouter" />
          </Link>
        </li>
      </ul>

      {confirmation !== null && (
        <Confirmation
          geste={confirmation}
          onAnnuler={() => setConfirmation(null)}
          onConfirmer={() => { const g = confirmation; setConfirmation(null); void executer(g); }}
        />
      )}
    </section>
  );
}

/**
 * La confirmation d'une extinction : ce qui s'arrête, ce qui reste. Mêmes attributs d'accessibilité que le
 * dialogue HubSpot de l'Accueil (role=dialog, aria-modal, Échap et clic hors carte pour annuler).
 */
function Confirmation({ geste, onAnnuler, onConfirmer }: { geste: Geste; onAnnuler: () => void; onConfirmer: () => void }) {
  const t = useT();
  const textes: Partial<Record<Geste, { titre: string; corps: string[]; bouton: string }>> = {
    delier_numero: {
      titre: t('Délier le numéro WhatsApp ?', 'Unlink the WhatsApp number?'),
      corps: [
        // 🔴 « Le RCS et les e-mails continuent » était inexact des deux côtés (relecture du 2026-09-25) : une
        // campagne RCS dont le repli est WhatsApp passe ENTIÈRE en pause (`PgNumeroDelieStore.delier`), et un
        // scénario ne démarre pas s'il doit envoyer par WhatsApp, e-mails compris (`runFrom`).
        t('Plus aucun message WhatsApp ne part de cet espace : campagnes, scénarios, Inbox et API.', 'No WhatsApp message goes out of this workspace anymore: campaigns, scenarios, Inbox and API.'),
        t('Les campagnes en cours ou programmées qui ont un étage WhatsApp, repli compris, passent en pause. Les campagnes uniquement RCS continuent.', 'Running or scheduled campaigns with a WhatsApp stage, fallback included, are paused. RCS-only campaigns keep going.'),
        t('Un scénario s’arrête à son premier envoi WhatsApp ; un scénario sans WhatsApp (e-mail ou RCS seuls) continue.', 'A scenario stops at its first WhatsApp send; a scenario without WhatsApp (email or RCS only) keeps going.'),
        t('Une campagne « Au fil de l’eau » n’inscrit personne pendant ce temps : les contacts arrivés entre-temps ne seront pas repris au retour.', 'An “Au fil de l’eau” (live feed) campaign enrolls no one in the meantime: contacts who arrive then will not be picked up when the number is relinked.'),
        t('Les messages reçus sur ce numéro ne sont plus enregistrés.', 'Messages received on this number are no longer recorded.'),
        t('Rien ne change chez Meta : si l’agent de Meta est allumé, il continue de répondre. L’historique reste, et le numéro se relie d’un clic.', 'Nothing changes at Meta: if Meta’s agent is on, it keeps answering. History stays, and the number relinks in one click.'),
      ],
      bouton: t('Délier', 'Unlink'),
    },
    couper_rcs: {
      titre: t('Couper le canal RCS ?', 'Turn off the RCS channel?'),
      corps: [
        t('Les blocs et campagnes RCS redeviennent inactifs.', 'RCS blocks and campaigns become inactive again.'),
        t('La clé du canal est oubliée : il faudra la ressaisir pour le rallumer.', 'The channel key is forgotten: you will need to enter it again to turn it back on.'),
      ],
      bouton: t('Couper', 'Turn off'),
    },
    debrancher_chaine: {
      titre: t('Débrancher la chaîne ?', 'Disconnect the channel?'),
      corps: [
        t('Les identifiants de la chaîne sont oubliés : plus de publication tant qu’ils ne sont pas ressaisis.', 'The channel credentials are forgotten: no more posts until they are entered again.'),
        t('Les publications déjà parues restent, et leurs boutons continuent d’ouvrir la conversation.', 'Posts already published stay, and their buttons keep opening the conversation.'),
      ],
      bouton: t('Débrancher', 'Disconnect'),
    },
    deconnecter_publicites: {
      titre: t('Déconnecter le compte publicitaire ?', 'Disconnect the ad account?'),
      corps: [
        t('Engage Me retire son accès à votre compte publicitaire : plus de création, de publication ni de suivi des publicités depuis la console.', 'Engage Me removes its access to your ad account: no more creating, publishing or tracking ads from the console.'),
        t('Les publicités déjà en ligne ne sont pas arrêtées par ce geste.', 'Ads already running are not stopped by this action.'),
      ],
      bouton: t('Déconnecter', 'Disconnect'),
    },
    eteindre_hubspot: {
      titre: t('Éteindre HubSpot ?', 'Turn HubSpot off?'),
      corps: [t('Le bloc HubSpot disparaît de l’Accueil. Aucun portail n’est relié : rien d’autre ne change.', 'The HubSpot block disappears from the Home page. No portal is linked: nothing else changes.')],
      bouton: t('Éteindre', 'Turn off'),
    },
  };
  const x = textes[geste];
  if (!x) return null;
  return (
    <Modale titre={x.titre} taille="petite" testId="canaux-confirmation" onClose={onAnnuler}>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-500">
        {x.corps.map((c) => <li key={c}>{c}</li>)}
      </ul>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Bouton variante="secondaire" type="button" data-testid="canaux-confirmation-annuler" onClick={onAnnuler}>
          {t('Annuler', 'Cancel')}
        </Bouton>
        <button type="button" data-testid="canaux-confirmation-ok" onClick={onConfirmer} className="rounded-controle bg-danger-600 px-3 py-2 text-sm font-semibold text-white transition-colors duration-150 hover:bg-danger-700">
          {x.bouton}
        </button>
      </div>
    </Modale>
  );
}
