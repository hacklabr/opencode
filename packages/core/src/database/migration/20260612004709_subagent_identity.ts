import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260612004709_subagent_identity",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`subagent_identity\` (
          \`parent_session_id\` text NOT NULL,
          \`subagent_slug\` text NOT NULL,
          \`child_session_id\` text NOT NULL,
          CONSTRAINT \`subagent_identity_pk\` PRIMARY KEY(\`parent_session_id\`, \`subagent_slug\`),
          CONSTRAINT \`fk_subagent_identity_parent_session_id_session_id_fk\` FOREIGN KEY (\`parent_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_subagent_identity_child_session_id_session_id_fk\` FOREIGN KEY (\`child_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`subagent_identity_child_idx\` ON \`subagent_identity\` (\`child_session_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
