import {
  IdentifierNode,
  OperationNodeTransformer,
  type KyselyPlugin,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type QueryResult,
  type RootOperationNode,
  type SchemableIdentifierNode,
  type UnknownRow,
} from "kysely";

import { OST_TABLES } from "./schema.gen";

const KNOWN = new Set<string>(OST_TABLES);

class PrefixTransformer extends OperationNodeTransformer {
  constructor(private readonly prefix: string) {
    super();
  }

  protected override transformSchemableIdentifier(
    node: SchemableIdentifierNode,
  ): SchemableIdentifierNode {
    const transformed = super.transformSchemableIdentifier(node);
    const name = transformed.identifier.name;
    if (transformed.schema || !KNOWN.has(name)) return transformed;
    return { ...transformed, identifier: IdentifierNode.create(this.prefix + name) };
  }
}

/**
 * Aggiunge il prefisso dell'installazione (TABLE_PREFIX di osTicket) ai nomi di tabella noti.
 * Nel codice si scrive `selectFrom("ticket")`, in SQL diventa `ost_ticket`.
 * Gli alias (`ticket as t`) e i riferimenti `ticket.campo` vengono trattati in modo coerente.
 */
export class TablePrefixPlugin implements KyselyPlugin {
  readonly #transformer: PrefixTransformer;

  constructor(prefix: string) {
    this.#transformer = new PrefixTransformer(prefix);
  }

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return this.#transformer.transformNode(args.node);
  }

  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return args.result;
  }
}
