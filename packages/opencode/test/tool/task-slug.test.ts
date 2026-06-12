import { describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"

import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import * as SubagentIdentity from "@/session/subagent-identity"
import { eq } from "drizzle-orm"
import { and } from "drizzle-orm"
import { SubagentIdentityTable } from "@opencode-ai/core/session/sql"
import { afterEach } from "bun:test"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  Layer.mergeAll(
    Agent.defaultLayer,
    BackgroundJob.defaultLayer,
    EventV2Bridge.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    SessionRunState.defaultLayer,
    SessionStatus.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
    Database.defaultLayer,
    RuntimeFlags.layer(flags),
  ).pipe(Layer.provide(Ripgrep.defaultLayer))

const it = testEffect(layer())

const seed = Effect.fn("TaskSlugTest.seed")(function* (title = "Slug test") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function stubOps(opts?: { onPrompt?: (input: SessionPrompt.PromptInput) => void; text?: string }): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done")
      }),
  }
}

function reply(input: SessionPrompt.PromptInput, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

function makeContext(chat: { id: SessionID }, assistant: { id: MessageID }, promptOps: TaskPromptOps) {
  return {
    sessionID: chat.id,
    messageID: assistant.id,
    agent: "build",
    abort: new AbortController().signal,
    extra: { promptOps, bypassAgentCheck: true },
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

describe("tool.task.subagent_slug", () => {
  // AC1: Identity creation
  it.instance("creates child session and identity mapping when subagent_slug is provided", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps = stubOps()

      yield* def.execute(
        {
          description: "review code",
          prompt: "check the files",
          subagent_type: "general",
          subagent_slug: "code-reviewer",
        },
        makeContext(chat, assistant, promptOps),
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)

      const rows = yield* database.db
        .select()
        .from(SubagentIdentityTable)
        .where(
          and(
            eq(SubagentIdentityTable.parent_session_id, chat.id),
            eq(SubagentIdentityTable.subagent_slug, "code-reviewer"),
          ),
        )
        .all()
        .pipe(Effect.orDie)

      expect(rows).toHaveLength(1)
      expect(rows[0].child_session_id).toBe(kids[0].id)
      expect(rows[0].parent_session_id).toBe(chat.id)
    }),
  )

  // AC2: History reuse
  it.instance("reuses the same child session when subagent_slug is reused", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps = stubOps()

      const first = yield* def.execute(
        {
          description: "review code",
          prompt: "check the files",
          subagent_type: "general",
          subagent_slug: "reviewer",
        },
        makeContext(chat, assistant, promptOps),
      )

      const secondAssistant: SessionV1.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: assistant.id,
        sessionID: chat.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        variant: "xhigh",
        time: { created: Date.now() },
      }
      const sess = yield* Session.Service
      yield* sess.updateMessage(secondAssistant)

      const second = yield* def.execute(
        {
          description: "continue review",
          prompt: "now check tests",
          subagent_type: "general",
          subagent_slug: "reviewer",
        },
        makeContext(chat, secondAssistant, promptOps),
      )

      expect(first.metadata.sessionId).toBe(second.metadata.sessionId)

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
    }),
  )

  // AC3: Backward compat — no slug creates fresh sessions
  it.instance("creates separate child sessions when no subagent_slug is provided", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps = stubOps()

      yield* def.execute(
        {
          description: "first task",
          prompt: "do something",
          subagent_type: "general",
        },
        makeContext(chat, assistant, promptOps),
      )

      const secondAssistant: SessionV1.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: assistant.id,
        sessionID: chat.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        variant: "xhigh",
        time: { created: Date.now() },
      }
      yield* sessions.updateMessage(secondAssistant)

      yield* def.execute(
        {
          description: "second task",
          prompt: "do another thing",
          subagent_type: "general",
        },
        makeContext(chat, secondAssistant, promptOps),
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(2)
    }),
  )

  // AC3: task_id without slug works as before
  it.instance("task_id without slug resumes existing session", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps = stubOps()

      const result = yield* def.execute(
        {
          description: "resume",
          prompt: "continue",
          subagent_type: "general",
          task_id: child.id,
        },
        makeContext(chat, assistant, promptOps),
      )

      expect(result.metadata.sessionId).toBe(child.id)
    }),
  )

  // AC4: Isolation between different slugs
  it.instance("different slugs create different child sessions", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps = stubOps()

      const first = yield* def.execute(
        {
          description: "frontend work",
          prompt: "build component",
          subagent_type: "general",
          subagent_slug: "frontend-dev",
        },
        makeContext(chat, assistant, promptOps),
      )

      const secondAssistant: SessionV1.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: assistant.id,
        sessionID: chat.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        variant: "xhigh",
        time: { created: Date.now() },
      }
      yield* sessions.updateMessage(secondAssistant)

      const second = yield* def.execute(
        {
          description: "backend work",
          prompt: "build api",
          subagent_type: "general",
          subagent_slug: "backend-dev",
        },
        makeContext(chat, secondAssistant, promptOps),
      )

      expect(first.metadata.sessionId).not.toBe(second.metadata.sessionId)

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(2)
    }),
  )

  // AC5: Slug scope is per parent session
  it.instance("same slug in different parent sessions creates independent children", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat: chat1, assistant: assistant1 } = yield* seed("Session 1")
      const { chat: chat2, assistant: assistant2 } = yield* seed("Session 2")
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps = stubOps()

      const result1 = yield* def.execute(
        {
          description: "work in session 1",
          prompt: "do something",
          subagent_type: "general",
          subagent_slug: "worker",
        },
        makeContext(chat1, assistant1, promptOps),
      )

      const result2 = yield* def.execute(
        {
          description: "work in session 2",
          prompt: "do something else",
          subagent_type: "general",
          subagent_slug: "worker",
        },
        makeContext(chat2, assistant2, promptOps),
      )

      expect(result1.metadata.sessionId).not.toBe(result2.metadata.sessionId)

      const kids1 = yield* sessions.children(chat1.id)
      const kids2 = yield* sessions.children(chat2.id)
      expect(kids1).toHaveLength(1)
      expect(kids2).toHaveLength(1)
      expect(kids1[0].id).not.toBe(kids2[0].id)
    }),
  )

  // AC7: task_id takes priority over subagent_slug
  it.instance("task_id takes priority over subagent_slug when both are provided", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Pre-existing child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps = stubOps()

      // First, create an identity mapping for "worker"
      yield* SubagentIdentity.store({
        parentSessionID: chat.id,
        subagentSlug: "worker",
        childSessionID: child.id,
      }).pipe(Effect.provideService(Database.Service, database))

      const otherChild = yield* sessions.create({ parentID: chat.id, title: "Other child" })

      const result = yield* def.execute(
        {
          description: "resume specific",
          prompt: "continue",
          subagent_type: "general",
          task_id: otherChild.id,
          subagent_slug: "worker",
        },
        makeContext(chat, assistant, promptOps),
      )

      // task_id wins — should use otherChild, not the slug-mapped child
      expect(result.metadata.sessionId).toBe(otherChild.id)
    }),
  )

  // Edge: child session deleted → lookup returns undefined → creates new
  it.instance("creates new session when slug-mapped child session no longer exists", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps = stubOps()

      // First call creates a child with slug
      const first = yield* def.execute(
        {
          description: "initial work",
          prompt: "do something",
          subagent_type: "general",
          subagent_slug: "worker",
        },
        makeContext(chat, assistant, promptOps),
      )

      // Delete the child session
      yield* sessions.remove(first.metadata.sessionId)

      const secondAssistant: SessionV1.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: assistant.id,
        sessionID: chat.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        variant: "xhigh",
        time: { created: Date.now() },
      }
      yield* sessions.updateMessage(secondAssistant)

      // Second call with same slug — should create new session since old one is gone
      const second = yield* def.execute(
        {
          description: "retry work",
          prompt: "try again",
          subagent_type: "general",
          subagent_slug: "worker",
        },
        makeContext(chat, secondAssistant, promptOps),
      )

      expect(second.metadata.sessionId).not.toBe(first.metadata.sessionId)

      // The identity mapping should point to the new session
      const rows = yield* database.db
        .select()
        .from(SubagentIdentityTable)
        .where(
          and(
            eq(SubagentIdentityTable.parent_session_id, chat.id),
            eq(SubagentIdentityTable.subagent_slug, "worker"),
          ),
        )
        .all()
        .pipe(Effect.orDie)

      expect(rows).toHaveLength(1)
      expect(rows[0].child_session_id).toBe(second.metadata.sessionId)
    }),
  )

  // Edge: slug mapping is not updated when task_id is used
  it.instance("does not update slug mapping when task_id resumes a different session", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps = stubOps()

      // First call with slug creates mapping
      const first = yield* def.execute(
        {
          description: "slug work",
          prompt: "do something",
          subagent_type: "general",
          subagent_slug: "reviewer",
        },
        makeContext(chat, assistant, promptOps),
      )

      const otherChild = yield* sessions.create({ parentID: chat.id, title: "Other child" })

      const secondAssistant: SessionV1.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: assistant.id,
        sessionID: chat.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        variant: "xhigh",
        time: { created: Date.now() },
      }
      yield* sessions.updateMessage(secondAssistant)

      // Resume using task_id with the same slug present
      yield* def.execute(
        {
          description: "resume other",
          prompt: "continue",
          subagent_type: "general",
          task_id: otherChild.id,
          subagent_slug: "reviewer",
        },
        makeContext(chat, secondAssistant, promptOps),
      )

      // Slug mapping should still point to the first session
      const rows = yield* database.db
        .select()
        .from(SubagentIdentityTable)
        .where(
          and(
            eq(SubagentIdentityTable.parent_session_id, chat.id),
            eq(SubagentIdentityTable.subagent_slug, "reviewer"),
          ),
        )
        .all()
        .pipe(Effect.orDie)

      expect(rows).toHaveLength(1)
      expect(rows[0].child_session_id).toBe(first.metadata.sessionId)
    }),
  )

  // Edge: lookup returns undefined for unknown slug
  it.instance("lookup returns undefined for unknown slug", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const { chat } = yield* seed()

      const result = yield* SubagentIdentity.lookup({
        parentSessionID: chat.id,
        subagentSlug: "unknown",
      }).pipe(Effect.provideService(Database.Service, database))

      expect(result).toBeUndefined()
    }),
  )

  // Edge: store is idempotent via upsert
  it.instance("store upsert is idempotent for the same slug", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const { chat } = yield* seed()
      const child1 = yield* sessions.create({ parentID: chat.id, title: "Child 1" })
      const child2 = yield* sessions.create({ parentID: chat.id, title: "Child 2" })

      yield* SubagentIdentity.store({
        parentSessionID: chat.id,
        subagentSlug: "worker",
        childSessionID: child1.id,
      }).pipe(Effect.provideService(Database.Service, database))

      yield* SubagentIdentity.store({
        parentSessionID: chat.id,
        subagentSlug: "worker",
        childSessionID: child2.id,
      }).pipe(Effect.provideService(Database.Service, database))

      const rows = yield* database.db
        .select()
        .from(SubagentIdentityTable)
        .where(eq(SubagentIdentityTable.parent_session_id, chat.id))
        .all()
        .pipe(Effect.orDie)

      expect(rows).toHaveLength(1)
      expect(rows[0].child_session_id).toBe(child2.id)
    }),
  )

  // Description includes subagent_slug info
  it.instance(
    "description mentions subagent_slug parameter",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const description =
          (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

        expect(description).toContain("subagent_slug")
      }),
  )
})
