import { SessionID } from "./schema"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SubagentIdentityTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { and } from "drizzle-orm"

export function lookup(input: {
  parentSessionID: SessionID
  subagentSlug: string
}): Effect.Effect<SessionID | undefined, never, Database.Service> {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db
      .select({ child_session_id: SubagentIdentityTable.child_session_id })
      .from(SubagentIdentityTable)
      .where(
        and(
          eq(SubagentIdentityTable.parent_session_id, input.parentSessionID),
          eq(SubagentIdentityTable.subagent_slug, input.subagentSlug),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    if (rows.length === 0) return undefined
    return rows[0].child_session_id
  })
}

export function store(input: {
  parentSessionID: SessionID
  subagentSlug: string
  childSessionID: SessionID
}): Effect.Effect<void, never, Database.Service> {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SubagentIdentityTable)
      .values({
        parent_session_id: input.parentSessionID,
        subagent_slug: input.subagentSlug,
        child_session_id: input.childSessionID,
      })
      .onConflictDoUpdate({
        target: [SubagentIdentityTable.parent_session_id, SubagentIdentityTable.subagent_slug],
        set: { child_session_id: input.childSessionID },
      })
      .run()
      .pipe(Effect.orDie)
  })
}

export * as SubagentIdentity from "./subagent-identity"
