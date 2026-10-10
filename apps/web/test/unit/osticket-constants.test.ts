import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as Flags from "@/lib/osticket/flags";
import { AttachmentType, FormType, ObjectType, ThreadEntryType } from "@/lib/osticket/object-types";
import { likeEscape } from "@/server/db/like";

/** Sorgenti PHP di osTicket (legacy/include) */
const INCLUDE = fileURLToPath(new URL("../../../../legacy/include/", import.meta.url));
const php = (file: string) => readFileSync(INCLUDE + file, "utf8");

/** Costanti intere o a una lettera di ogni classe dichiarata in include/class.*.php */
function phpClassConstants(): Map<string, Map<string, number | string>> {
  const out = new Map<string, Map<string, number | string>>();
  for (const file of readdirSync(INCLUDE).filter((f) => /^class\..+\.php$/.test(f))) {
    let consts: Map<string, number | string> | undefined;
    for (const line of php(file).split("\n")) {
      const c = line.match(/^\s*(?:abstract\s+|final\s+)?(?:class|interface)\s+(\w+)/);
      if (c) {
        consts = out.get(c[1]) ?? new Map();
        out.set(c[1], consts);
      }
      const k = line.match(/^\s*const\s+([A-Z0-9_]+)\s*=\s*(0x[0-9a-fA-F]+|\d+|'[A-Z]')\s*;/);
      if (k && consts) consts.set(k[1], k[2].startsWith("'") ? k[2].slice(1, -1) : Number(k[2]));
    }
  }
  return out;
}

const PHP = phpClassConstants();

describe("costanti di osTicket (src/lib/osticket) uguali a quelle del PHP", () => {
  it.each(Object.entries(Flags))("flags.ts: %s", (cls, values) => {
    const consts = PHP.get(cls);
    expect(consts, `classe PHP ${cls}`).toBeDefined();
    for (const [key, value] of Object.entries(values)) {
      const phpValue = consts?.get(`FLAG_${key}`) ?? consts?.get(key);
      expect(phpValue, `${cls}::${key}`).toBe(value);
    }
  });

  it("ObjectModel::OBJECT_TYPE_*", () => {
    const consts = PHP.get("ObjectModel");
    for (const [key, value] of Object.entries(ObjectType)) expect(consts?.get(`OBJECT_TYPE_${key}`), key).toBe(value);
  });

  it("tipi delle voci di thread (ENTRY_TYPE)", () => {
    expect(PHP.get("MessageThreadEntry")?.get("ENTRY_TYPE")).toBe(ThreadEntryType.MESSAGE);
    expect(PHP.get("ResponseThreadEntry")?.get("ENTRY_TYPE")).toBe(ThreadEntryType.RESPONSE);
    expect(PHP.get("NoteThreadEntry")?.get("ENTRY_TYPE")).toBe(ThreadEntryType.NOTE);
  });

  it("tipi di allegato (attachment.type)", () => {
    expect(php("class.attachment.php")).toContain(`'type' => "'${AttachmentType.THREAD_ENTRY}'",\n                    'object_id' => 'ThreadEntry.id'`);
    expect(php("class.canned.php")).toContain(`"'${AttachmentType.CANNED}'" => 'Attachment.type'`);
    expect(php("class.faq.php")).toContain(`"'${AttachmentType.FAQ}'" => 'Attachment.type'`);
    expect(php("class.page.php")).toContain(`"'${AttachmentType.PAGE}'" => 'Attachment.type'`);
    expect(php("class.draft.php")).toContain(`"'${AttachmentType.DRAFT}'" => 'Attachment.type'`);
    expect(php("class.template.php")).toContain(`GenericAttachments::forIdAndType($this->id, '${AttachmentType.EMAIL_TEMPLATE}')`);
    expect(php("class.forms.php")).toMatch(new RegExp(`crc32\\('E'\\.\\$this->get\\('id'\\)\\.\\$e->get\\('id'\\)\\)\\)\\),\\s*'${AttachmentType.FORM_FILE}'\\)`));
    expect(php("class.forms.php")).toContain(`GenericAttachments::forIdAndType($this->get('id'), '${AttachmentType.FORM_INFO}')`);
  });

  it("tipi di form (form.type)", () => {
    expect(php("class.dynamic_forms.php")).toMatch(
      new RegExp(`'${FormType.TICKET}' => 'Ticket Information',\\s*'${FormType.USER}' => 'User Information',\\s*'${FormType.ORG}' => 'Organization Information'`),
    );
    expect(php("class.dynamic_forms.php")).toContain(`filter(array('type'=>'${FormType.GENERIC}'))`);
    expect(php("class.company.php")).toContain(`DynamicForm::lookup(array('type'=>'${FormType.COMPANY}'))`);
    expect(php("class.list.php")).toContain(`'type' => '${FormType.LIST_PREFIX}'.$this->getId()`);
    expect(php("class.task.php")).toContain("$os->filter(array('type'=>ObjectModel::OBJECT_TYPE_TASK))");
    expect(FormType.TASK).toBe(ObjectType.TASK);
  });
});

describe("likeEscape", () => {
  it("come MySqlCompiler::like_escape: \\ poi % e _", () => {
    expect(likeEscape("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
    expect(likeEscape("draft.ticket.reply.12")).toBe("draft.ticket.reply.12");
  });
});
