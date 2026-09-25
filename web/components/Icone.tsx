'use client';

import {
  AddressBookIcon, ArrowBendUpLeftIcon, BookOpenIcon, BuildingsIcon, CalendarBlankIcon, CaretDownIcon,
  CaretLeftIcon, CaretRightIcon, ChartBarIcon, ChatCircleDotsIcon, ChatCircleIcon, CheckCircleIcon,
  ClipboardTextIcon, CodeIcon, CursorClickIcon, DeviceMobileIcon, EnvelopeSimpleIcon, EyeIcon, FileArrowUpIcon, FlagIcon,
  FileTextIcon, FlowArrowIcon, FunctionIcon, GearIcon, GitBranchIcon, HeadsetIcon, HourglassMediumIcon, HouseIcon,
  ImageIcon, LightbulbIcon, LightningIcon, LinkIcon, ListIcon, MagicWandIcon, MagnifyingGlassIcon, MapPinIcon, MapTrifoldIcon, MegaphoneIcon,
  MicrophoneIcon, MinusIcon, PaperPlaneTiltIcon, PaperclipIcon, PencilSimpleIcon, PhoneIcon, PlayIcon, PlugIcon, PlusIcon,
  ProhibitIcon, PuzzlePieceIcon, QuestionIcon, RobotIcon, ShieldCheckIcon, SmileyIcon, SparkleIcon,
  SquaresFourIcon, TagIcon, TargetIcon, TimerIcon, TrashIcon, TrayIcon, TrendDownIcon, TrendUpIcon,
  UploadSimpleIcon, UserIcon, UsersIcon, VideoCameraIcon, WarningIcon, WebhooksLogoIcon, XCircleIcon, XIcon,
  type Icon,
} from '@phosphor-icons/react';
import type { NomIcone } from '@/lib/icones';

/**
 * LES ICÔNES DE LA CONSOLE, UNE SEULE FAMILLE (Phosphor, décision de Julien du 2026-09-25).
 *
 * La console mélangeait des emojis posés comme icônes (📋 🧩 📱 dans la barre d'envoi, un emoji par bloc du
 * builder), des tracés SVG écrits à la main en six épaisseurs, et des flèches Unicode. C'est l'un des
 * marqueurs les plus sûrs d'une interface générée : chaque écran dessinait ses signes à sa façon.
 *
 * 🔴 CE FICHIER EST LE SEUL QUI IMPORTE `@phosphor-icons/react`, et c'est ce qui tient les deux règles :
 * - UNE épaisseur : `regular`, posée ici et nulle part ailleurs ;
 * - UNE taille par contexte : `nav` (barre latérale), `ligne` (dans un bouton ou une ligne de texte courant),
 *   `petite` (à côté d'un texte `xs`), `mini` (les lignes des blocs du canevas de scénario, en 10 px), `grande`
 *   (un signe seul, sans texte : bouton d'aide, zone de dépôt).
 * `tests/web-icones.test.ts` refuse un import de Phosphor ailleurs.
 *
 * ⚠️ `aria-hidden` PAR DÉFAUT : une icône posée à côté de son libellé est un dessin, pas un mot, et un lecteur
 * d'écran qui l'annoncerait répéterait le libellé. Une icône SEULE (bouton sans texte) reçoit son nom par
 * `titre`, ou mieux par l'`aria-label` du bouton qui l'entoure.
 *
 * ⚠️ Les emojis qui restent dans le code sont du CONTENU : le sélecteur d'emojis, et ce que le destinataire
 * verra dans un aperçu de message. Les logos de marque (WhatsApp, HubSpot, Meta) restent dans `LogosCanaux`.
 */
const ICONES = {
  // Navigation.
  accueil: HouseIcon,
  inbox: TrayIcon,
  contacts: UsersIcon,
  campagnes: MegaphoneIcon,
  chaine: ChatCircleDotsIcon,
  publicites: TargetIcon,
  contenu: SquaresFourIcon,
  analytics: ChartBarIcon,
  scenario: FlowArrowIcon,
  automation: LightningIcon,
  aide: QuestionIcon,
  developpeurs: CodeIcon,
  securite: ShieldCheckIcon,
  outils: PlugIcon,
  ia: SparkleIcon,
  baguette: MagicWandIcon,
  reglages: GearIcon,
  menu: ListIcon,
  // Gestes et repères.
  deplier: CaretDownIcon,
  precedent: CaretLeftIcon,
  suivant: CaretRightIcon,
  fermer: XIcon,
  ajouter: PlusIcon,
  supprimer: TrashIcon,
  modifier: PencilSimpleIcon,
  lien: LinkIcon,
  televerser: UploadSimpleIcon,
  ecouter: PlayIcon,
  voir: EyeIcon,
  idee: LightbulbIcon,
  smiley: SmileyIcon,
  // États.
  valide: CheckCircleIcon,
  refuse: ProhibitIcon,
  attention: WarningIcon,
  echec: XCircleIcon,
  hausse: TrendUpIcon,
  baisse: TrendDownIcon,
  stable: MinusIcon,
  // Contenus et canaux.
  modele: FileTextIcon,
  formulaire: ClipboardTextIcon,
  mobile: DeviceMobileIcon,
  message: ChatCircleIcon,
  email: EnvelopeSimpleIcon,
  envoi: PaperPlaneTiltIcon,
  piece: PaperclipIcon,
  image: ImageIcon,
  video: VideoCameraIcon,
  micro: MicrophoneIcon,
  clic: CursorClickIcon,
  entreprise: BuildingsIcon,
  telephone: PhoneIcon,
  calendrier: CalendarBlankIcon,
  carte: MapTrifoldIcon,
  position: MapPinIcon,
  carnet: AddressBookIcon,
  fichier: FileArrowUpIcon,
  webhook: WebhooksLogoIcon,
  reponse: ArrowBendUpLeftIcon,
  // Blocs du builder de scénario.
  question: QuestionIcon,
  etiquette: TagIcon,
  condition: GitBranchIcon,
  attente: HourglassMediumIcon,
  chrono: TimerIcon,
  humain: HeadsetIcon,
  robot: RobotIcon,
  fonction: FunctionIcon,
  bloc: PuzzlePieceIcon,
  connaissance: BookOpenIcon,
  // Outils d'un agent (`components/IconeOutil.tsx`).
  rechercher: MagnifyingGlassIcon,
  contact: UserIcon,
  fin: FlagIcon,
} satisfies Record<NomIcone, Icon>;

export type { NomIcone };

const TAILLES = { nav: 18, ligne: 16, petite: 14, mini: 12, grande: 22 } as const;
export type TailleIcone = keyof typeof TAILLES;

export function Icone({ nom, taille = 'ligne', className, titre }: {
  nom: NomIcone;
  taille?: TailleIcone;
  className?: string;
  /** Le nom de l'icône quand elle est SEULE à porter le sens. Absent, elle est masquée aux lecteurs d'écran. */
  titre?: string;
}) {
  const Dessin = ICONES[nom];
  return (
    <Dessin
      size={TAILLES[taille]}
      weight="regular"
      className={`shrink-0${className ? ` ${className}` : ''}`}
      aria-hidden={titre ? undefined : true}
      aria-label={titre}
      role={titre ? 'img' : undefined}
      focusable="false"
    />
  );
}
