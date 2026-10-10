/**
 * Messaggi divisi per area funzionale (src/messages/<area>/<locale>.json) uniti a quelli base
 * (src/messages/<locale>.json). Ogni area usa namespace propri: niente chiavi in comune.
 */
export const MESSAGE_AREAS = ["actions", "ticketedit", "create", "people", "portal", "admin", "adminsys", "board", "stats", "kb", "doctor"] as const;
