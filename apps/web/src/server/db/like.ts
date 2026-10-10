import "server-only";

/**
 * MySqlCompiler::like_escape (include/class.orm.php): protegge `\`, `%` e `_` con `\` prima di
 * usare il testo in un LIKE, come fanno i lookup __contains / __startswith dell'ORM.
 */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
