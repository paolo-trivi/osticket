import { afterAll, describe, expect, it } from "vitest";

import { closeDb, db, NOW, type Tx } from "@/server/db";
import { agentFileRef } from "@/server/domain/file/agent-access";
import { getCanned, getCategory, getFaq, searchFaqs } from "@/server/domain/kb/kb";
import { loadAgent, type Agent } from "@/server/domain/staff/staff";

/**
 * Controlli di accesso di KB, risposte predefinite e download per agenti sul DB di sviluppo.
 * I dati di prova sono creati dentro una transazione annullata alla fine di ogni test: nessuna
 * scrittura resta nel DB. Agenti: devadmin (id 1, visibility.departments, reparti 1–3) e gverdi
 * (id 4, solo reparto Sales = 2, nessun permesso visibility.departments).
 */

afterAll(closeDb);

class Rollback extends Error {}

async function inRollback(fn: (trx: Tx) => Promise<void>): Promise<void> {
  try {
    await db()
      .transaction()
      .execute(async (trx) => {
        await fn(trx);
        throw new Rollback();
      });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

async function agents(trx: Tx): Promise<{ admin: Agent; limited: Agent }> {
  const [admin, limited] = await Promise.all([loadAgent(1, trx), loadAgent(4, trx)]);
  expect(admin?.username).toBe("devadmin");
  expect(limited?.username).toBe("gverdi");
  return { admin: admin!, limited: limited! };
}

let seq = 0;
async function newFile(trx: Tx): Promise<{ id: number; key: string }> {
  const key = `kbtest${Date.now().toString(36)}${(seq++).toString(36)}`.padEnd(32, "x").slice(0, 32);
  const res = await trx
    .insertInto("file")
    .values({ key, signature: "", created: NOW, name: "prova.txt", type: "text/plain", size: 5, bk: "D", ft: "T" })
    .executeTakeFirstOrThrow();
  return { id: Number(res.insertId), key };
}

async function attach(trx: Tx, fileId: number, type: string, objectId: number): Promise<void> {
  await trx.insertInto("attachment").values({ file_id: fileId, type, object_id: objectId, inline: 0 }).execute();
}

/** Topic privato del reparto Maintenance (3): non visibile a gverdi. */
async function privateTopic(trx: Tx): Promise<number> {
  const res = await trx
    .insertInto("help_topic")
    .values({ topic: `KB test ${Date.now()}`, topic_pid: 0, ispublic: 0, dept_id: 3, flags: 2, created: NOW, updated: NOW })
    .executeTakeFirstOrThrow();
  return Number(res.insertId);
}

describe("download degli allegati per agenti", () => {
  it("allegato di FAQ: servito se la FAQ è visibile all'agente, altrimenti nessun accesso (404)", async () => {
    await inRollback(async (trx) => {
      const { admin, limited } = await agents(trx);
      const file = await newFile(trx);
      await attach(trx, file.id, "F", 1);
      expect(await agentFileRef(limited, file.key, trx)).toEqual({ fileId: file.id, name: null });

      // la FAQ 1 collegata solo a un topic privato di un reparto non accessibile a gverdi
      const topicId = await privateTopic(trx);
      await trx.deleteFrom("faq_topic").where("faq_id", "=", 1).execute();
      await trx.insertInto("faq_topic").values({ faq_id: 1, topic_id: topicId }).execute();
      expect(await agentFileRef(limited, file.key, trx)).toBeNull();
      expect(await agentFileRef(admin, file.key, trx)).toEqual({ fileId: file.id, name: null });
    });
  });

  it("allegato di risposta predefinita: solo per reparti accessibili", async () => {
    await inRollback(async (trx) => {
      const { admin, limited } = await agents(trx);
      const file = await newFile(trx);
      await attach(trx, file.id, "C", 1);
      expect(await agentFileRef(limited, file.key, trx)).not.toBeNull();

      await trx.updateTable("canned_response").set({ dept_id: 3 }).where("canned_id", "=", 1).execute();
      expect(await agentFileRef(limited, file.key, trx)).toBeNull();
      expect(await getCanned(limited, 1, trx)).toBeNull();
      expect(await agentFileRef(admin, file.key, trx)).not.toBeNull();
      expect((await getCanned(admin, 1, trx))?.attachments.map((a) => a.key)).toContain(file.key);
    });
  });

  it("allegato di una voce del thread di un task: serve checkTaskPerm", async () => {
    await inRollback(async (trx) => {
      const { admin, limited } = await agents(trx);
      const entryOf = async (taskId: number) =>
        (
          await trx
            .selectFrom("thread_entry as e")
            .innerJoin("thread as th", "th.id", "e.thread_id")
            .select("e.id")
            .where("th.object_type", "=", "A")
            .where("th.object_id", "=", taskId)
            .orderBy("e.id")
            .executeTakeFirstOrThrow()
        ).id;
      // task 1: aperto e assegnato a gverdi; task 2: reparto Support (1), assegnato ad altri
      const visible = await newFile(trx);
      const hidden = await newFile(trx);
      await attach(trx, visible.id, "H", await entryOf(1));
      await attach(trx, hidden.id, "H", await entryOf(2));

      expect(await agentFileRef(limited, visible.key, trx)).not.toBeNull();
      expect(await agentFileRef(limited, hidden.key, trx)).toBeNull();
      expect(await agentFileRef(admin, hidden.key, trx)).not.toBeNull();
    });
  });

  it("chiavi inesistenti o non valide: nessun file", async () => {
    const admin = (await loadAgent(1))!;
    expect(await agentFileRef(admin, "nonesiste-nonesiste-nonesiste-00")).toBeNull();
    expect(await agentFileRef(admin, "../../etc/passwd")).toBeNull();
  });
});

describe("filtro FAQ per help topic", () => {
  it("nasconde a gverdi le FAQ collegate solo a topic non visibili (categoria, ricerca, dettaglio)", async () => {
    await inRollback(async (trx) => {
      const { admin, limited } = await agents(trx);
      const faq = await trx.selectFrom("faq").select(["faq_id", "category_id", "question"]).where("faq_id", "=", 1).executeTakeFirstOrThrow();

      const before = await getCategory(limited, faq.category_id, trx);
      expect(before?.faqs.map((f) => f.id)).toContain(1);

      const topicId = await privateTopic(trx);
      await trx.deleteFrom("faq_topic").where("faq_id", "=", 1).execute();
      await trx.insertInto("faq_topic").values({ faq_id: 1, topic_id: topicId }).execute();

      const after = await getCategory(limited, faq.category_id, trx);
      expect(after?.faqs.map((f) => f.id)).not.toContain(1);
      expect(after?.hiddenFaqs).toBe(1);
      expect((await searchFaqs(limited, { q: faq.question }, trx)).map((f) => f.id)).not.toContain(1);
      expect(await getFaq(limited, 1, trx)).toBeNull();
      // filtro per topic della ricerca: gverdi non trova nulla, devadmin (visibility.departments) sì
      expect(await searchFaqs(limited, { topicId }, trx)).toEqual([]);
      expect((await searchFaqs(admin, { topicId }, trx)).map((f) => f.id)).toEqual([1]);
      expect((await getCategory(admin, faq.category_id, trx))?.faqs.map((f) => f.id)).toContain(1);
      expect((await getFaq(admin, 1, trx))?.topics.map((tp) => tp.id)).toEqual([topicId]);
    });
  });

  it("FAQ con un topic pubblico restano visibili a tutti", async () => {
    const limited = (await loadAgent(4))!;
    const faq = await getFaq(limited, 1);
    expect(faq?.path.length).toBeGreaterThan(0);
    expect(faq?.topics.length).toBeGreaterThan(0);
  });
});
