/**
 * Emojis proposés dans les composeurs de messages (corps de template Meta, message RCS).
 *
 * Module PUR : importable depuis la suite de tests racine comme depuis un composant client. La liste vivait
 * dans `TemplateBodyField`, et une seconde a commencé à exister pour le RCS. Deux listes que l'utilisateur
 * voit dans deux écrans du même produit finissent par diverger sans que personne ne le décide.
 */
export const EMOJIS_MESSAGE: readonly string[] = [
  '😀','😊','😉','😍','🥳','🤩','😎','🙌','👋','👍','🙏','🤝','💪','👏','🔥','✨',
  '⭐','🌟','💯','✅','✔️','☑️','❌','⚡','🎉','🎊','🎁','🎈','🥂','🍾','❤️','🧡',
  '💛','💚','💙','💜','💖','💥','💡','📣','📢','🔔','📅','⏰','🕐','⌛','📍','📌',
  '🏷️','🛍️','🛒','💳','💰','🤑','📦','🚚','🚗','🏠','🚀','🎯','📈','📊','💬','💭',
  '📞','📲','✉️','📧','📝','🔗','➡️','👉','👀','🤗','🍽️','☀️','🌙','⚠️',
];
