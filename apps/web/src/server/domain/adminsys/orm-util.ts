import "server-only";

import { str, type PhpVal } from "../../php/values";
import type { OrmValue } from "../admin/orm";

/** Valore di un OrmRow come variabile PHP (NOW() simbolico → null). */
export const pv = (v: OrmValue): PhpVal => (typeof v === "symbol" ? null : v);

/** Variabile PHP come valore di colonna (array → "Array" come il cast di PHP). */
export const ov = (v: PhpVal): OrmValue => (v === undefined ? null : typeof v === "object" && v !== null ? str(v) : v);
