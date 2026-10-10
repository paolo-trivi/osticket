import "server-only";

import { cachedEffectiveWriteMode, type EffectiveWriteMode } from "./write-mode";

/**
 * Modalità di scrittura per l'interfaccia (layout → WriteModeProvider): la stessa modalità effettiva
 * del gate delle scritture, con la stessa cache breve (write-mode.ts). Senza TAILTICKET_MODE vale
 * "full", salvo schema non verificato o problemi critici del doctor (allora "readonly", come il gate).
 */
export async function uiWriteMode(): Promise<EffectiveWriteMode> {
  return cachedEffectiveWriteMode();
}
