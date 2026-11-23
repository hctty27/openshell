/** Window event asking the active terminal to take keyboard focus again. */
export const TERMINAL_FOCUS_EVENT = "openshell:focus-terminal";

export function requestTerminalFocus(): void {
  window.dispatchEvent(new Event(TERMINAL_FOCUS_EVENT));
}
