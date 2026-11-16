/** Built-in chat commands handled locally, without sending them to the model. */
export function isClearChatCommand(message: string): boolean {
  const normalized = message
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[!?.,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return /^(?:очисти|очистить|стереть|сотри|удали|удалить) (?:чат|переписку|историю)(?: полностью)?$/.test(normalized)
    || /^(?:clear|erase|delete) (?:the )?(?:chat|conversation|history)$/.test(normalized)
    || /^(?:очисти|очистить) всё$/.test(normalized);
}
