/** Preserve command text; each stored line break acts as the terminal Enter key. */
export function quickCommandTerminalInput(command: string): string {
  return command.replace(/\r\n|\r|\n/g, "\r");
}
