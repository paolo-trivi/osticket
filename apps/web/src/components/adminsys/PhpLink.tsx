/**
 * Rimando al pannello classico per le funzioni non gestite da Next: link a OST_PHP_URL + `path`
 * (es. "/scp/plugins.php"). Nulla se OST_PHP_URL non è configurato.
 */
export default function PhpLink({ path, label }: { path: string; label: string }) {
  const base = process.env.OST_PHP_URL;
  if (!base) return null;
  return (
    <a href={`${base.replace(/\/$/, "")}${path}`} className="font-medium underline" target="_blank" rel="noreferrer">
      {label}
    </a>
  );
}
