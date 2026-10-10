import { startTransition, type FormEvent } from "react";

/**
 * onSubmit per i form con una server action (useActionState) da usare al posto di `<form action>`: con action
 * React 19 azzera il form al termine dell'azione anche quando fallisce, e chi deve correggere un campo perderebbe
 * quanto scritto negli altri. Invia lo stesso FormData (compreso il pulsante premuto) dentro una transizione.
 * I pulsanti con una `formAction` propria restano gestiti da React.
 */
export function submitKeepingValues(action: (data: FormData) => void) {
  return (e: FormEvent<HTMLFormElement>) => {
    const submitter = (e.nativeEvent as SubmitEvent).submitter;
    if (submitter?.hasAttribute("formaction")) return;
    e.preventDefault();
    const data = new FormData(e.currentTarget, submitter);
    startTransition(() => action(data));
  };
}
