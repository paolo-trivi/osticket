"use client";

import type { DynamicFieldView } from "@/lib/forms/dynamic-field";

/** FreeTextField (testo informativo, HTML già sanificato dal server) e SectionBreakField */
export default function InfoField({ field }: { field: DynamicFieldView }) {
  if (field.kind === "break") {
    return (
      <div className="border-t border-gray-200 pt-4 dark:border-gray-800">
        {field.label && <h4 className="text-sm font-semibold text-gray-800 dark:text-white/90">{field.label}</h4>}
        {field.hint && <p className="text-theme-xs text-gray-500 dark:text-gray-400">{field.hint}</p>}
      </div>
    );
  }
  return (
    <div className="text-sm text-gray-700 dark:text-gray-300">
      {field.label && <p className="font-medium">{field.label}</p>}
      {field.config.content && <div dangerouslySetInnerHTML={{ __html: field.config.content }} />}
    </div>
  );
}
