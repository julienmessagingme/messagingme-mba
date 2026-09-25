'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Toggle } from '@/components/Toggle';
import { LogoWhatsApp, LogoGoogleMessages, LogoChaineWhatsApp, LogoMeta, LogoHubSpot } from '@/components/LogosCanaux';
import { DOT_HEX } from '@/lib/ui';
import { useT, useLocale } from '@/lib/i18n';
import { estAnnulation } from '@/lib/http';
import { delierNumero, relierNumero, setHubspotActif, type AccountStatusResponse } from '@/lib/api';
import { getConnexionChaine, listerPostsChaine, debrancherChaine, nomDeLaChaine, type ReponseConnexionChaine } from '@/lib/api-chaine';
import { getEtatPubs, deconnecterPubs, type EtatPubs } from '@/lib/api-pubs';
import type { CanalRcs } from '@/components/RcsChannelCard';
import type { ConnexionNumero } from '@/lib/connexion-numero';
import {
  demandeConfirmation, ligneNumero, ligneRcs, ligneChaine, lignePublicites, ligneHubspot, nombreDePublications, routeInconnue, teinte,
  type Geste, type Ligne, type Teinte,
} from '@/lib/canaux-services';

/**
 * LE BLOC « CANAUX ET SERVICES » DE L'ACCUEIL (plan du 2026-09-25, design validé par Julien).
 *
 * Une GRILLE DE CARTES depuis le 2026-09-25 après-midi (3 colonnes, 2, puis 1 selon la largeur) : le logo du
 * canal, l'interrupteur, une pastille d'état (`teinte`), la phrase, puis le lien. Les gestes n'ont pas bougé.
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
    try {
      const c = await getConnexionChaine(p.tenantId);
      setChaine(c);
      setPublications(null);
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

  useEffect(() => { void chargerChaine(); void chargerPubs(); }, [chargerChaine, chargerPubs]);

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

  const date = (iso: string): string =>
    new Date(iso).toLocaleString(locale === 'en' ? 'en-GB' : 'fr-FR', { dateStyle: 'short', timeStyle: 'short' });
  const lecture = t('Lecture…', 'Loading…');
  const inconnu = t('État inconnu pour le moment.', 'State unknown right now.');

  const phraseNumero = (): string => {
    const c = p.compte;
    if (c === null) return p.compteEnEchec ? inconnu : lecture;
    if (!c.hasNumber) {
      return p.connexionNumero.cfg?.enabled === true
        ? t('Aucun numéro relié à cet espace. L’allumer ouvre la connexion Meta.', 'No number linked to this workspace. Turning it on opens the Meta connection.')
        : t('Aucun numéro relié. La connexion n’est pas encore disponible sur cette instance.', 'No number linked. Connection is not available on this instance yet.');
    }
    const numero = c.number ? (c.number.startsWith('+') ? c.number : `+${c.number}`) : t('le numéro', 'the number');
    if (typeof c.delieLe === 'string') {
      return t(
        `${numero} délié le ${date(c.delieLe)} : aucun message WhatsApp ne part, et les messages reçus ne sont pas enregistrés.`,
        `${numero} unlinked on ${date(c.delieLe)}: no WhatsApp message goes out, and incoming messages are not recorded.`,
      );
    }
    return t(`Relié : ${numero}.`, `Linked: ${numero}.`);
  };

  const phraseRcs = (): string => {
    const e = p.rcs.etat;
    if (e === null) return lecture;
    if (e.active !== true) return t('Inactif. L’allumer demande la clé du canal.', 'Inactive. Turning it on asks for the channel key.');
    const nom = e.channel?.displayName || e.channel?.brandName;
    return nom ? t(`Actif, sous l’agent « ${nom} ».`, `Active, under the “${nom}” agent.`) : t('Actif.', 'Active.');
  };

  const phraseChaine = (): string => {
    if (chaine === null) return lecture;
    if (chaine === 'echec' || lignes.chaine.allume === null) return inconnu;
    if (!chaine.connection) return t('Non branchée. L’allumer ouvre l’écran Chaîne, pour saisir les identifiants.', 'Not connected. Turning it on opens the Channel screen, to enter the credentials.');
    const nom = nomDeLaChaine(chaine);
    const debut = nom ? t(`Branchée : « ${nom} »`, `Connected: “${nom}”`) : t('Branchée', 'Connected');
    return publications === null ? `${debut}.` : t(`${debut}, ${publications} publication(s).`, `${debut}, ${publications} post(s).`);
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
        'Allumé, et un portail est relié : pour l’éteindre, faites d’abord la déconnexion du portail dans le bloc HubSpot.',
        'On, and a portal is linked: to turn it off, first disconnect the portal in the HubSpot block.',
      );
    }
    return t('Allumé : le bloc HubSpot s’affiche sur l’Accueil.', 'On: the HubSpot block shows on the Home page.');
  };

  // « À terminer » : la même condition que la phrase « Connexion à terminer » de `phrasePubs`.
  const pubsATerminer = pubs !== null && pubs !== 'echec' && pubs !== 'absent' && !!pubs.connexion && !pubs.connexion.comptePubId;

  const rangees: Array<{
    service: Service; titre: string; phrase: string; lien: { href: string; texte: string };
    Logo: (x: { className?: string }) => React.ReactElement; aTerminer?: boolean;
  }> = [
    { service: 'numero', titre: t('Numéro WhatsApp', 'WhatsApp number'), phrase: phraseNumero(), lien: { href: '#numero-whatsapp', texte: t('Voir le numéro', 'See the number') }, Logo: LogoWhatsApp },
    { service: 'rcs', titre: t('Canal RCS', 'RCS channel'), phrase: phraseRcs(), lien: { href: '#canal-rcs', texte: t('Voir le canal', 'See the channel') }, Logo: LogoGoogleMessages },
    { service: 'chaine', titre: t('Chaîne', 'Channel'), phrase: phraseChaine(), lien: { href: '/chaine', texte: t('Ouvrir l’écran Chaîne', 'Open the Channel screen') }, Logo: LogoChaineWhatsApp },
    { service: 'publicites', titre: t('Compte publicitaire', 'Ad account'), phrase: phrasePubs(), lien: { href: '/publicites', texte: t('Ouvrir l’écran Publicités', 'Open the Ads screen') }, Logo: LogoMeta, aTerminer: pubsATerminer },
    { service: 'hubspot', titre: 'HubSpot', phrase: phraseHubspot(), lien: { href: '/parametres#integration-hubspot', texte: t('Ouvrir le réglage', 'Open the setting') }, Logo: LogoHubSpot },
  ];

  // ⚠️ Les erreurs de la fenêtre Meta et de la clé RCS restent dans LEUR carte (la zone de connexion, la carte
  // RCS), qui porte le formulaire : les répéter ici ferait deux bandeaux pour une seule panne.
  const erreurDe = (s: Service): string | undefined => erreurs[s];
  const occupe = (s: Service): boolean =>
    enCours === s || (s === 'numero' && p.connexionNumero.busy) || (s === 'rcs' && p.rcs.busy);

  return (
    <section data-testid="canaux-services">
      <h3 className="text-sm font-semibold tracking-tight text-ink-900">{t('Canaux et services', 'Channels and services')}</h3>
      {info && <p data-testid="canaux-info" className="mt-3 rounded-lg bg-mint-50 px-3 py-2 text-xs text-mint-700">{info}</p>}
      {/* ⚠️ 3 colonnes à partir de `xl` et non de `lg` : la colonne latérale (240 px) apparaît à `lg`, et trois
          cartes y tomberaient sous 230 px, trop étroites pour une phrase d'état et un interrupteur. */}
      <ul className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {rangees.map(({ service, titre, phrase, lien, Logo, aTerminer }) => {
          const l = lignes[service];
          const erreur = erreurDe(service);
          const pastille = teinte(l, aTerminer);
          return (
            <li key={service} data-testid={`canal-${service}`} className="flex flex-col rounded-2xl border border-ink-200 bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <Logo className="h-8 w-8 shrink-0" />
                  <div className="text-sm font-semibold text-ink-900">{titre}</div>
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
                <p data-testid={`canal-${service}-etat`} className="text-xs text-ink-600">{phrase}</p>
              </div>
              {erreur && <p data-testid={`canal-${service}-erreur`} className="mt-2 text-xs text-coral">{erreur}</p>}
              <div className="mt-auto pt-3">
                {lien.href.startsWith('#')
                  ? <a href={lien.href} data-testid={`canal-${service}-lien`} className="text-xs text-brand-600 hover:underline">{lien.texte}</a>
                  : <Link href={lien.href} data-testid={`canal-${service}-lien`} className="text-xs text-brand-600 hover:underline">{lien.texte}</Link>}
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
            className="flex h-full min-h-[7.5rem] items-center justify-center gap-1.5 rounded-2xl border border-dashed border-ink-300 p-4 text-sm font-semibold text-brand-600 transition hover:border-brand-300 hover:bg-brand-50"
          >
            {t('Autres intégrations', 'Other integrations')}<span aria-hidden="true">+</span>
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
        t('Plus aucun message WhatsApp ne part de cet espace : campagnes, scénarios, Inbox et API. Le RCS et les e-mails continuent.', 'No WhatsApp message goes out of this workspace anymore: campaigns, scenarios, Inbox and API. RCS and emails keep going.'),
        t('Les campagnes en cours ou programmées passent en pause.', 'Running or scheduled campaigns are paused.'),
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="canaux-confirmation-titre"
      data-testid="canaux-confirmation"
      onClick={onAnnuler}
      onKeyDown={(e) => { if (e.key === 'Escape') onAnnuler(); }}
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 id="canaux-confirmation-titre" className="text-base font-semibold tracking-tight text-ink-900">{x.titre}</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-600">
          {x.corps.map((c) => <li key={c}>{c}</li>)}
        </ul>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button type="button" data-testid="canaux-confirmation-annuler" onClick={onAnnuler} className="rounded-lg border border-ink-200 px-3 py-2 text-sm font-medium text-ink-700 transition hover:bg-ink-50">
            {t('Annuler', 'Cancel')}
          </button>
          <button type="button" data-testid="canaux-confirmation-ok" onClick={onConfirmer} className="rounded-lg bg-red-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-red-600">
            {x.bouton}
          </button>
        </div>
      </div>
    </div>
  );
}
