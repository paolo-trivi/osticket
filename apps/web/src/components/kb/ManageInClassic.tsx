import Callout from "@/components/common/Callout";

/**
 * Nota per chi gestisce KB o risposte predefinite: la nuova interfaccia le mostra in sola lettura, la
 * creazione e la modifica restano nel pannello classico (scp/kb.php, scp/canned.php).
 */
export default function ManageInClassic({ note, linkLabel, href }: { note: string; linkLabel: string; href?: string }) {
  return (
    <Callout tone="info">
      {note}{" "}
      {href && (
        <a href={href} className="font-medium underline" target="_blank" rel="noreferrer">
          {linkLabel}
        </a>
      )}
    </Callout>
  );
}
