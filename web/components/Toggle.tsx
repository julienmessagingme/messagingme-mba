'use client';

/**
 * Interrupteur on/off de la page Accueil (MBA, relances automatiques, HubSpot, campagnes via listes).
 *
 * Le markup était recopié quatre fois dans le même écran : quatre pastilles à garder alignées au premier
 * ajustement de style. Les seules différences réelles sont l'état, le gestionnaire et la raison de blocage.
 */
export function Toggle({ checked, onChange, disabled = false, title, testid }: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  /** Info-bulle expliquant pourquoi l'interrupteur est bloqué (ex. « Réservé aux admins »). */
  title?: string;
  testid?: string;
}) {
  return (
    <button
      onClick={onChange}
      disabled={disabled}
      aria-pressed={checked}
      {...(title ? { title } : {})}
      {...(testid ? { 'data-testid': testid } : {})}
      className={`relative h-7 w-12 shrink-0 rounded-full transition ${checked ? 'bg-brand-500' : 'bg-ink-300'} ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
    >
      <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all ${checked ? 'left-[22px]' : 'left-0.5'}`} />
    </button>
  );
}
