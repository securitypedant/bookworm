import { routeAgentRequest, callable, type Schedule } from "agents";
import { Think, Session, Workspace } from "@cloudflare/think";
import type { LanguageModel, ToolSet } from "ai";
import { tool } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import type { ExtensionManifest } from "@cloudflare/think/extensions";
import { HostBridgeLoopback } from "@cloudflare/think/extensions";
import {
  BOOK_STATUSES,
  EMPTY_DIGEST,
  INITIAL_BOOKWORM_STATE,
  makeBookLookupKey,
  type BookEntry,
  type BookStatus,
  type BookWormState,
  type ExtensionSummary,
  type ReminderSummary
} from "./shared";

const DIGEST_PATH = "/bookworm-reading-digest.md";
const LIBRARY_PATH = "/bookworm-library.json";
const PROFILE_PATH = "/bookworm-profile.json";
const MEMORY_LABEL = "memory";
const READER_MEMORY_PATH = "/bookworm-reader-memory.json";

type ReaderPreferenceCategory =
  | "genre"
  | "mood"
  | "theme"
  | "pace"
  | "format"
  | "dislike"
  | "habit"
  | "review_style"
  | "other";

type ReaderPreference = {
  category: ReaderPreferenceCategory;
  value: string;
  note: string | null;
  updatedAt: string;
};

type ReaderMemory = {
  ownerName: string | null;
  preferences: ReaderPreference[];
  updatedAt: string | null;
};

type OpenLibraryDoc = {
  key?: string;
  title?: string;
  author_name?: string[];
  cover_i?: number;
  first_publish_year?: number;
  edition_count?: number;
};

type BookLinkMetadata = {
  openLibraryWorkKey: string | null;
  openLibraryUrl: string | null;
  coverImageUrl: string | null;
};

const statusSchema = z.enum(BOOK_STATUSES);
const readerPreferenceCategorySchema = z.enum([
  "genre",
  "mood",
  "theme",
  "pace",
  "format",
  "dislike",
  "habit",
  "review_style",
  "other"
]);

const contextBlockSchema = z.object({
  label: z
    .string()
    .regex(/^[a-z0-9_]+$/)
    .describe("Short snake_case label for the block"),
  description: z.string().optional(),
  type: z.enum(["readonly", "writable", "skill", "searchable"]),
  maxTokens: z.number().int().positive().max(8000).optional()
});

const extensionInstallSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9_]+$/)
    .describe("Lowercase extension name. Use letters, numbers, and underscores only."),
  version: z.string().default("1.0.0"),
  description: z.string().optional(),
  source: z
    .string()
    .describe("JavaScript object expression using the Think extension format: { tools, hooks }"),
  workspaceAccess: z.enum(["none", "read", "read-write"]).default("none"),
  network: z.array(z.string()).default([]),
  contextBlocks: z.array(contextBlockSchema).default([]),
  messageAccess: z.boolean().default(false),
  allowSendMessage: z.boolean().default(false)
});

const reminderSchema = z
  .object({
    mode: z.enum(["in", "at", "cron", "every"]),
    note: z.string().min(1),
    delaySeconds: z.number().int().positive().max(60 * 60 * 24 * 30).optional(),
    isoDateTime: z.string().optional(),
    cron: z.string().optional(),
    intervalSeconds: z.number().int().positive().max(60 * 60 * 24 * 30).optional()
  })
  .superRefine((value, ctx) => {
    if (value.mode === "in" && value.delaySeconds === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "delaySeconds is required when mode is 'in'",
        path: ["delaySeconds"]
      });
    }

    if (value.mode === "at" && !value.isoDateTime) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "isoDateTime is required when mode is 'at'",
        path: ["isoDateTime"]
      });
    }

    if (value.mode === "cron" && !value.cron) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "cron is required when mode is 'cron'",
        path: ["cron"]
      });
    }

    if (value.mode === "every" && value.intervalSeconds === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "intervalSeconds is required when mode is 'every'",
        path: ["intervalSeconds"]
      });
    }
  });

function normalizeExtensionPrefix(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

function buildReminderSummary(schedule: Schedule<{ note?: string }>): ReminderSummary {
  let cadence = "One-time reminder";

  if (schedule.type === "delayed") {
    cadence = `In ${schedule.delayInSeconds} seconds`;
  }

  if (schedule.type === "cron") {
    cadence = `Cron: ${schedule.cron}`;
  }

  if (schedule.type === "interval") {
    cadence = `Every ${schedule.intervalSeconds} seconds`;
  }

  return {
    id: schedule.id,
    callback: schedule.callback,
    kind: schedule.type,
    nextRunAt: new Date(schedule.time * 1000).toISOString(),
    note: schedule.payload?.note ?? "Reading reminder",
    cadence
  };
}

function normalizePreferenceValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function createEmptyReaderMemory(ownerName: string | null = null): ReaderMemory {
  return {
    ownerName,
    preferences: [],
    updatedAt: null
  };
}

function parseReaderMemoryContent(
  content: string | null,
  fallbackOwnerName: string | null
): ReaderMemory {
  const fallback = createEmptyReaderMemory(fallbackOwnerName);

  if (!content) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(content) as Partial<ReaderMemory>;

    return {
      ownerName:
        typeof parsed.ownerName === "string" && parsed.ownerName.trim()
          ? parsed.ownerName.trim()
          : fallback.ownerName,
      preferences: Array.isArray(parsed.preferences)
        ? parsed.preferences
            .filter(
              (item): item is ReaderPreference =>
                typeof item === "object" &&
                item !== null &&
                "category" in item &&
                "value" in item &&
                typeof item.category === "string" &&
                typeof item.value === "string"
            )
            .map((item) => ({
              category: item.category as ReaderPreferenceCategory,
              value: item.value.trim(),
              note: typeof item.note === "string" ? item.note : null,
              updatedAt:
                typeof item.updatedAt === "string" ? item.updatedAt : new Date().toISOString()
            }))
        : fallback.preferences,
      updatedAt:
        typeof parsed.updatedAt === "string" ? parsed.updatedAt : fallback.updatedAt
    };
  } catch {
    return {
      ...fallback,
      preferences: content.trim()
        ? [
            {
              category: "other",
              value: content.trim(),
              note: "Migrated from an older unstructured memory block.",
              updatedAt: new Date().toISOString()
            }
          ]
        : []
    };
  }
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function buildOpenLibraryUrl(workKey: string | null | undefined): string | null {
  return workKey ? `https://openlibrary.org${workKey}` : null;
}

function buildOpenLibraryCoverUrl(coverId: number | null | undefined): string | null {
  return typeof coverId === "number"
    ? `https://covers.openlibrary.org/b/id/${coverId}-M.jpg`
    : null;
}

function scoreOpenLibraryDoc(doc: OpenLibraryDoc, title: string, author?: string): number {
  let score = 0;
  const normalizedTitle = normalizeSearchText(title);
  const docTitle = normalizeSearchText(doc.title ?? "");

  if (docTitle === normalizedTitle) {
    score += 8;
  } else if (docTitle.includes(normalizedTitle) || normalizedTitle.includes(docTitle)) {
    score += 4;
  }

  if (author?.trim()) {
    const normalizedAuthor = normalizeSearchText(author);
    const authorNames = (doc.author_name ?? []).map(normalizeSearchText);
    if (authorNames.includes(normalizedAuthor)) {
      score += 8;
    } else if (authorNames.some((name) => name.includes(normalizedAuthor))) {
      score += 4;
    }
  }

  if (typeof doc.cover_i === "number") {
    score += 1;
  }

  return score;
}

function toOpenLibraryResult(doc: OpenLibraryDoc) {
  return {
    title: doc.title ?? "Unknown title",
    author: doc.author_name?.[0] ?? "Unknown author",
    openLibraryWorkKey: doc.key ?? null,
    openLibraryUrl: buildOpenLibraryUrl(doc.key),
    coverImageUrl: buildOpenLibraryCoverUrl(doc.cover_i),
    firstPublishedYear: doc.first_publish_year ?? null,
    editionCount: doc.edition_count ?? null
  };
}

function formatBookshelfMarkdown(state: BookWormState): string {
  return JSON.stringify(state, null, 2);
}

function formatDigestMarkdown(state: BookWormState): string {
  const total = state.books.length;
  const reading = state.books.filter((book) => book.status === "reading");
  const completed = state.books.filter((book) => book.status === "read");
  const backlog = state.books.filter((book) => book.status === "to-read");

  const lines = [
    `# BookWorm Digest for ${state.ownerName || "Reader"}`,
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    `- Total books tracked: ${total}`,
    `- Currently reading: ${reading.length}`,
    `- Finished: ${completed.length}`,
    `- Still on deck: ${backlog.length}`,
    "",
    "## Current reading lane",
    ...(reading.length > 0
      ? reading.map((book) => `- **${book.title}** by ${book.author}`)
      : ["- Nothing is marked as currently reading."]),
    "",
    "## Recent finished books",
    ...(completed.length > 0
      ? completed
          .slice()
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, 5)
          .map((book) => {
            const rating = book.rating ? ` (${book.rating}/5)` : "";
            const review = book.review ? ` - ${book.review}` : "";
            return `- **${book.title}** by ${book.author}${rating}${review}`;
          })
      : ["- No finished books yet."]),
    "",
    "## What looks next",
    ...(backlog.length > 0
      ? backlog
          .slice()
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, 5)
          .map((book) => `- ${book.title} by ${book.author}`)
      : ["- Your to-read shelf is clear."])
  ];

  return lines.join("\n");
}

export class BookWormAgent extends Think<Env> {
  initialState: BookWormState = INITIAL_BOOKWORM_STATE;
  override workspace = new Workspace({
    sql: this.ctx.storage.sql,
    r2: this.env.WORKSPACE_R2,
    name: () => this.name
  });
  override extensionLoader = this.env.LOADER;
  override maxSteps = 8;

  getModel(): LanguageModel {
    return createWorkersAI({ binding: this.env.AI })("@cf/moonshotai/kimi-k2.5", {
      sessionAffinity: this.sessionAffinity
    });
  }

  configureSession(session: Session) {
    return session
      .withContext("soul", {
        provider: {
          get: async () => this.buildSystemPrompt()
        }
      })
      .withContext("extension_builder", {
        provider: {
          get: async () =>
            [
              "BookWorm extension rules:",
              "- Use the current Think extension format: { tools, hooks }.",
              "- Each tool needs description, parameters, optional required, and async execute(args, host).",
              "- Persist extension data with workspace files or extension-owned context blocks.",
              "- If an extension declares context blocks, runtime labels are namespaced as <extension>_<label>.",
              "- The host bridge supports host.readFile, host.writeFile, host.deleteFile, host.listFiles, host.getContext, host.setContext, host.getMessages, host.sendMessage, and host.getSessionInfo when permissions allow.",
              "- Installed extension tools appear on the next turn, not the current tool step.",
              "- Keep permissions tight: default to no network and only the workspace access you truly need.",
              "- Good persistence pattern: save structured JSON to /extensions/<name>.json or write to your own writable context block.",
              "- Hooks are optional. beforeTurn can trim or steer context, but it cannot return live ToolSet objects or a new model instance."
            ].join("\n")
        }
      })
      .withContext("memory", {
        provider: this.createReaderMemoryProvider(),
        description:
          "Durable reader memory. Store the owner's name plus lasting reading preferences like favorite genres, moods, themes, formats, dislikes, habits, and review style. Keep this concise and up to date because it shapes future recommendations.",
        maxTokens: 1800
      })
      .withCachedPrompt();
  }

  getTools(): ToolSet {
    return {
      add_book: tool({
        description: "Add a book to the owner's bookshelf. Use this when the user wants to track a title.",
        inputSchema: z.object({
          title: z.string(),
          author: z.string(),
          status: statusSchema.default("to-read"),
          notes: z.string().optional(),
          openLibraryWorkKey: z.string().optional(),
          openLibraryUrl: z.string().url().optional(),
          coverImageUrl: z.string().url().optional()
        }),
        execute: async ({ title, author, status, notes, openLibraryWorkKey, openLibraryUrl, coverImageUrl }) => {
          const metadata = await this.resolveBookLinks({
            title,
            author,
            openLibraryWorkKey,
            openLibraryUrl,
            coverImageUrl
          });
          const state = await this.upsertBook({
            title,
            author,
            status,
            notes: notes ?? null,
            ...metadata
          });
          return {
            message: `Saved ${title} by ${author} to the ${status} shelf.`,
            books: state.books
          };
        }
      }),
      search_open_library: tool({
        description:
          "Search Open Library for a book before adding it to the shelf. Returns canonical Open Library links and cover image URLs.",
        inputSchema: z.object({
          title: z.string(),
          author: z.string().optional(),
          limit: z.number().int().min(1).max(10).default(5)
        }),
        execute: async ({ title, author, limit }) => {
          return {
            matches: await this.searchOpenLibrary({ title, author, limit })
          };
        }
      }),
      remember_reader_preference: tool({
        description:
          "Store a durable reader preference in the Think memory block. Use this for lasting tastes, dislikes, habits, and review style.",
        inputSchema: z.object({
          category: readerPreferenceCategorySchema,
          value: z.string(),
          note: z.string().optional()
        }),
        execute: async ({ category, value, note }) => {
          const memory = await this.updateReaderMemory((current) => {
            const now = new Date().toISOString();
            const normalized = normalizePreferenceValue(value);
            const existing = current.preferences.find(
              (preference) =>
                preference.category === category &&
                normalizePreferenceValue(preference.value) === normalized
            );

            if (existing) {
              return {
                ...current,
                preferences: current.preferences.map((preference) =>
                  preference === existing
                    ? {
                        ...preference,
                        value: value.trim(),
                        note: note?.trim() || preference.note,
                        updatedAt: now
                      }
                    : preference
                ),
                updatedAt: now
              };
            }

            return {
              ...current,
              preferences: [
                ...current.preferences,
                {
                  category,
                  value: value.trim(),
                  note: note?.trim() || null,
                  updatedAt: now
                }
              ],
              updatedAt: now
            };
          });

          return {
            saved: true,
            memory,
            message: `Stored the reader preference \"${value.trim()}\" under ${category}.`
          };
        }
      }),
      view_reader_memory: tool({
        description: "Show the current durable reader memory block used by BookWorm.",
        inputSchema: z.object({}),
        execute: async () => ({
          memory: await this.getReaderMemory()
        })
      }),
      forget_reader_preference: tool({
        description: "Remove a stored reader preference from the Think memory block.",
        inputSchema: z.object({
          category: readerPreferenceCategorySchema.optional(),
          value: z.string()
        }),
        execute: async ({ category, value }) => {
          const normalized = normalizePreferenceValue(value);
          const memory = await this.updateReaderMemory((current) => ({
            ...current,
            preferences: current.preferences.filter(
              (preference) =>
                normalizePreferenceValue(preference.value) !== normalized ||
                (category ? preference.category !== category : false)
            ),
            updatedAt: new Date().toISOString()
          }));

          return {
            removed: true,
            memory,
            message: `Removed the reader preference \"${value.trim()}\" from memory.`
          };
        }
      }),
      list_books: tool({
        description: "List books on the shelf, optionally filtered by status.",
        inputSchema: z.object({
          status: statusSchema.optional()
        }),
        execute: async ({ status }) => {
          const books = this.currentState.books
            .filter((book) => (status ? book.status === status : true))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

          return {
            count: books.length,
            books
          };
        }
      }),
      update_book_status: tool({
        description:
          "Move a book between to-read, reading, and read. Use this to reflect reading progress.",
        inputSchema: z.object({
          title: z.string(),
          author: z.string().optional(),
          status: statusSchema
        }),
        execute: async ({ title, author, status }) => {
          const state = await this.updateBook(title, author, (book) => ({
            ...book,
            status,
            updatedAt: new Date().toISOString()
          }));

          return {
            message: `Moved ${title} to ${status}.`,
            books: state.books
          };
        }
      }),
      save_book_review: tool({
        description:
          "Save the owner's review of a book. If the book was not yet marked read, this also marks it as read.",
        inputSchema: z.object({
          title: z.string(),
          author: z.string().optional(),
          review: z.string(),
          rating: z.number().int().min(1).max(5).optional()
        }),
        execute: async ({ title, author, review, rating }) => {
          const state = await this.updateBook(title, author, (book) => ({
            ...book,
            review,
            rating: rating ?? book.rating,
            status: "read",
            updatedAt: new Date().toISOString()
          }));

          return {
            message: `Stored the review for ${title}.`,
            books: state.books
          };
        }
      }),
      remove_book: tool({
        description: "Remove a book from the bookshelf.",
        inputSchema: z.object({
          title: z.string(),
          author: z.string().optional()
        }),
        execute: async ({ title, author }) => {
          const state = await this.removeBook(title, author);
          return {
            message: `Removed ${title} from the shelf.`,
            books: state.books
          };
        }
      }),
      schedule_reading_reminder: tool({
        description:
          "Schedule a reading reminder. Supports one-off reminders, cron reminders, and interval reminders.",
        inputSchema: reminderSchema,
        execute: async (input) => {
          const summary = await this.createReminder(input);
          return {
            message: `Scheduled ${summary.kind} reminder for ${summary.note}.`,
            reminder: summary
          };
        }
      }),
      list_scheduled_reminders: tool({
        description: "List all scheduled reading reminders for this BookWorm agent.",
        inputSchema: z.object({}),
        execute: async () => {
          return {
            reminders: this.listReminderSchedules()
          };
        }
      }),
      cancel_scheduled_reminder: tool({
        description: "Cancel a scheduled reading reminder by id.",
        inputSchema: z.object({
          id: z.string()
        }),
        execute: async ({ id }) => {
          const removed = await this.cancelSchedule(id);
          return {
            removed,
            reminders: this.listReminderSchedules()
          };
        }
      }),
      generate_reading_digest: tool({
        description:
          "Generate a durable reading digest in the workspace. Uses a background fiber so the agent can finish it even if the runtime is interrupted.",
        inputSchema: z.object({}),
        execute: async () => {
          const fiberName = `digest:${crypto.randomUUID()}`;

          await this.updateState((state) => ({
            ...state,
            lastDigest: {
              status: "running",
              generatedAt: new Date().toISOString(),
              path: DIGEST_PATH,
              note: "Digest generation is running in the background."
            }
          }));

          void this.runFiber(fiberName, async (fiber) => {
            if (!fiber.snapshot) {
              fiber.stash({ step: "collecting" });
            }

            const digest = formatDigestMarkdown(this.currentState);
            fiber.stash({ step: "writing" });
            await this.workspace.writeFile(DIGEST_PATH, digest);

            await this.updateState((state) => ({
              ...state,
              lastDigest: {
                status: "ready",
                generatedAt: new Date().toISOString(),
                path: DIGEST_PATH,
                note: "Digest written to the BookWorm workspace."
              }
            }));

            await this.saveMessages([
              {
                id: crypto.randomUUID(),
                role: "user",
                parts: [
                  {
                    type: "text",
                    text: `The reading digest finished in the background. Summarize the digest at ${DIGEST_PATH} for the reader.`
                  }
                ]
              }
            ]);
          }).catch((error) => {
            console.error("Digest fiber failed", error);
          });

          return {
            started: true,
            fiberName,
            path: DIGEST_PATH,
            message: "Digest generation started. It will survive hibernation and resume from its checkpoints."
          };
        }
      }),
      install_extension: tool({
        description:
          "Install a custom BookWorm extension. Use this only after the user explicitly asks for a new extension or pastes extension code.",
        inputSchema: extensionInstallSchema,
        needsApproval: async () => true,
        execute: async (input) => {
          const manifest = this.buildExtensionManifest(input);
          const manager = this.extensionManager;
          if (!manager) {
            throw new Error("Extension manager is not available.");
          }

          await manager.unload(manifest.name);
          const info = await manager.load(manifest, input.source);
          await this.registerExtensionContexts(manifest);
          await this.syncExtensionState();
          await this.persistExtensionSnapshot();

          return {
            loaded: true,
            name: info.name,
            version: info.version,
            tools: info.tools,
            permissions: info.permissions,
            message:
              "Extension installed. Its tools will be available on the next turn, so ask the user for a follow-up or continue in the next message."
          };
        }
      }),
      list_extensions: tool({
        description: "List installed BookWorm extensions and their tools.",
        inputSchema: z.object({}),
        execute: async () => ({
          extensions: this.listInstalledExtensions()
        })
      }),
      remove_extension: tool({
        description: "Remove an installed extension by name.",
        inputSchema: z.object({
          name: z.string()
        }),
        needsApproval: async () => true,
        execute: async ({ name }) => {
          const removed = await this.extensionManager?.unload(name);
          await this.syncExtensionState();
          await this.persistExtensionSnapshot();
          return {
            removed: Boolean(removed),
            extensions: this.listInstalledExtensions()
          };
        }
      })
    };
  }

  async onFiberRecovered(ctx: { name: string; snapshot: unknown | null }) {
    if (!ctx.name.startsWith("digest:")) {
      return;
    }

    await this.updateState((state) => ({
      ...state,
      lastDigest: {
        status: "interrupted",
        generatedAt: new Date().toISOString(),
        path: DIGEST_PATH,
        note:
          "A background digest fiber was interrupted by a restart. Ask BookWorm to generate the digest again if you still need it."
      }
    }));
  }

  @callable()
  async initializeOwner(ownerName: string) {
    const trimmed = ownerName.trim();
    if (!trimmed) {
      throw new Error("Owner name is required.");
    }

    const nextState = await this.updateState((state) => ({
      ...state,
      ownerName: trimmed
    }));

    await this.syncReaderNameInMemory(trimmed);
    await this.persistExtensionSnapshot();
    return nextState;
  }

  @callable()
  getReminderSchedules() {
    return this.listReminderSchedules();
  }

  @callable()
  async cancelReminder(id: string) {
    await this.cancelSchedule(id);
    return this.listReminderSchedules();
  }

  @callable()
  listInstalledExtensions() {
    return (this.extensionManager?.list() ?? []).map((extension): ExtensionSummary => ({
      name: extension.name,
      version: extension.version,
      description: extension.description,
      tools: extension.tools,
      permissions: {
        workspace: extension.permissions.workspace,
        network: extension.permissions.network
      }
    }));
  }

  private buildSystemPrompt(): string {
    const owner = this.currentState.ownerName || "Reader";

    return [
      `You are BookWorm, ${owner}'s long-running reading companion built on Cloudflare Think.`,
      "",
      "Priorities:",
      "- Maintain a durable bookshelf with three statuses only: to-read, reading, read.",
      "- Treat the Think memory block as the reader profile: keep the owner's name and durable preferences there.",
      "- Use remember_reader_preference when the reader reveals a lasting taste, dislike, habit, or review style.",
      "- Capture the owner's review voice faithfully and keep recommendations grounded in their real shelf.",
      "- When you need canonical book links or cover art, use search_open_library before adding the book.",
      "- Use built-in bookshelf tools instead of editing raw files for shelf changes.",
      "- Use scheduling tools when the user wants reminders or recurring reading nudges.",
      "- Generate extensions only when the user explicitly asks for new capabilities.",
      "- Keep extension permissions narrow and explain what the extension will save and where.",
      "- Prefer concise, practical responses with specific next actions or book thoughts.",
      "",
      "The workspace is durable and backed by Cloudflare's new workspace model. Use it for digests, exports, and extension data.",
      "When an extension installs successfully, its tools are not visible until the next turn."
    ].join("\n");
  }

  private get currentState(): BookWormState {
    return this.state ?? INITIAL_BOOKWORM_STATE;
  }

  private createReaderMemoryProvider() {
    return {
      get: async () => this.workspace.readFile(READER_MEMORY_PATH),
      set: async (content: string) => {
        await this.workspace.writeFile(READER_MEMORY_PATH, content);
      }
    };
  }

  private async getReaderMemory(): Promise<ReaderMemory> {
    const content = await this.workspace.readFile(READER_MEMORY_PATH);
    return parseReaderMemoryContent(content, this.currentState.ownerName || null);
  }

  private async replaceReaderMemory(memory: ReaderMemory) {
    await this.session.replaceContextBlock(MEMORY_LABEL, JSON.stringify(memory, null, 2));
    return memory;
  }

  private async updateReaderMemory(mutator: (memory: ReaderMemory) => ReaderMemory) {
    const nextMemory = mutator(await this.getReaderMemory());
    return this.replaceReaderMemory(nextMemory);
  }

  private async syncReaderNameInMemory(ownerName: string) {
    return this.updateReaderMemory((current) => {
      if (current.ownerName === ownerName.trim()) {
        return current;
      }

      return {
        ...current,
        ownerName: ownerName.trim(),
        updatedAt: new Date().toISOString()
      };
    });
  }

  private async updateState(mutator: (state: BookWormState) => BookWormState) {
    const nextState = mutator(this.currentState);
    this.setState(nextState);
    await this.persistStateSnapshot(nextState);
    return nextState;
  }

  private async upsertBook(input: {
    title: string;
    author: string;
    status: BookStatus;
    notes: string | null;
    openLibraryWorkKey: string | null;
    openLibraryUrl: string | null;
    coverImageUrl: string | null;
  }) {
    const now = new Date().toISOString();
    const lookup = makeBookLookupKey(input.title, input.author);

    return this.updateState((state) => {
      const existing = state.books.find(
        (book) => makeBookLookupKey(book.title, book.author) === lookup
      );

      if (existing) {
        return {
          ...state,
          books: state.books.map((book) =>
            book.id === existing.id
              ? {
                  ...book,
                  status: input.status,
                  notes: input.notes ?? book.notes,
                  openLibraryWorkKey: input.openLibraryWorkKey ?? book.openLibraryWorkKey ?? null,
                  openLibraryUrl: input.openLibraryUrl ?? book.openLibraryUrl ?? null,
                  coverImageUrl: input.coverImageUrl ?? book.coverImageUrl ?? null,
                  updatedAt: now
                }
              : book
          )
        };
      }

      const nextBook: BookEntry = {
        id: crypto.randomUUID(),
        title: input.title.trim(),
        author: input.author.trim(),
        openLibraryWorkKey: input.openLibraryWorkKey,
        openLibraryUrl: input.openLibraryUrl,
        coverImageUrl: input.coverImageUrl,
        status: input.status,
        review: null,
        rating: null,
        notes: input.notes,
        addedAt: now,
        updatedAt: now
      };

      return {
        ...state,
        books: [...state.books, nextBook]
      };
    });
  }

  private async updateBook(
    title: string,
    author: string | undefined,
    transform: (book: BookEntry) => BookEntry
  ) {
    const lookup = makeBookLookupKey(title, author);
    let didUpdate = false;

    const nextState = await this.updateState((state) => ({
      ...state,
      books: state.books.map((book) => {
        const bookLookup = makeBookLookupKey(book.title, author ?? book.author);
        const matches =
          author?.trim()
            ? makeBookLookupKey(book.title, book.author) === lookup
            : makeBookLookupKey(book.title, "") === makeBookLookupKey(title, "");

        if (!matches && bookLookup !== lookup) {
          return book;
        }

        didUpdate = true;
        return transform(book);
      })
    }));

    if (!didUpdate) {
      throw new Error(`Could not find ${title} on the shelf.`);
    }

    return nextState;
  }

  private async removeBook(title: string, author?: string) {
    const originalCount = this.currentState.books.length;

    const nextState = await this.updateState((state) => ({
      ...state,
      books: state.books.filter((book) => {
        if (author?.trim()) {
          return makeBookLookupKey(book.title, book.author) !== makeBookLookupKey(title, author);
        }

        return makeBookLookupKey(book.title, "") !== makeBookLookupKey(title, "");
      })
    }));

    if (nextState.books.length === originalCount) {
      throw new Error(`Could not find ${title} on the shelf.`);
    }

    return nextState;
  }

  private async createReminder(input: z.infer<typeof reminderSchema>) {
    let schedule: Schedule<{ note: string }>;

    if (input.mode === "in") {
      schedule = await this.schedule(input.delaySeconds!, "deliverReadingReminder", {
        note: input.note
      });
    } else if (input.mode === "at") {
      const date = new Date(input.isoDateTime!);
      if (Number.isNaN(date.getTime())) {
        throw new Error("isoDateTime must be a valid ISO date.");
      }

      schedule = await this.schedule(date, "deliverReadingReminder", {
        note: input.note
      });
    } else if (input.mode === "cron") {
      schedule = await this.schedule(input.cron!, "deliverReadingReminder", {
        note: input.note
      });
    } else {
      schedule = await this.scheduleEvery(input.intervalSeconds!, "deliverReadingReminder", {
        note: input.note
      });
    }

    return buildReminderSummary(schedule);
  }

  private listReminderSchedules() {
    return this.getSchedules({})
      .filter((schedule) => schedule.callback === "deliverReadingReminder")
      .sort((a, b) => a.time - b.time)
      .map((schedule) => buildReminderSummary(schedule as Schedule<{ note?: string }>));
  }

  private async searchOpenLibrary(input: {
    title: string;
    author?: string;
    limit: number;
  }) {
    const url = new URL("https://openlibrary.org/search.json");
    url.searchParams.set("title", input.title);
    url.searchParams.set("limit", String(input.limit));

    if (input.author?.trim()) {
      url.searchParams.set("author", input.author.trim());
    }

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Open Library search failed with status ${response.status}.`);
    }

    const payload = (await response.json()) as { docs?: OpenLibraryDoc[] };
    const docs = payload.docs ?? [];

    return docs
      .slice()
      .sort(
        (left, right) =>
          scoreOpenLibraryDoc(right, input.title, input.author) -
          scoreOpenLibraryDoc(left, input.title, input.author)
      )
      .slice(0, input.limit)
      .map((doc) => toOpenLibraryResult(doc));
  }

  private async resolveBookLinks(input: {
    title: string;
    author: string;
    openLibraryWorkKey?: string;
    openLibraryUrl?: string;
    coverImageUrl?: string;
  }): Promise<BookLinkMetadata> {
    const explicitWorkKey = input.openLibraryWorkKey?.trim() || null;
    const explicitUrl = input.openLibraryUrl?.trim() || buildOpenLibraryUrl(explicitWorkKey);
    const explicitCover = input.coverImageUrl?.trim() || null;

    if (explicitUrl || explicitCover || explicitWorkKey) {
      return {
        openLibraryWorkKey: explicitWorkKey,
        openLibraryUrl: explicitUrl,
        coverImageUrl: explicitCover
      };
    }

    const [bestMatch] = await this.searchOpenLibrary({
      title: input.title,
      author: input.author,
      limit: 1
    });

    return {
      openLibraryWorkKey: bestMatch?.openLibraryWorkKey ?? null,
      openLibraryUrl: bestMatch?.openLibraryUrl ?? null,
      coverImageUrl: bestMatch?.coverImageUrl ?? null
    };
  }

  private buildExtensionManifest(
    input: z.infer<typeof extensionInstallSchema>
  ): ExtensionManifest {
    const prefix = normalizeExtensionPrefix(input.name);
    const ownLabels = input.contextBlocks.map((block) => `${prefix}_${block.label}`);

    return {
      name: input.name,
      version: input.version,
      description: input.description,
      permissions: {
        workspace: input.workspaceAccess,
        network: input.network,
        context:
          ownLabels.length > 0
            ? {
                read: ownLabels,
                write: "own"
              }
            : undefined,
        messages: input.messageAccess ? "read" : "none",
        session:
          input.allowSendMessage
            ? {
                sendMessage: true,
                metadata: true
              }
            : undefined
      },
      context: input.contextBlocks
    };
  }

  private async syncExtensionState() {
    await this.updateState((state) => ({
      ...state,
      extensionCount: this.extensionManager?.list().length ?? 0
    }));
  }

  private async registerExtensionContexts(manifest: ExtensionManifest) {
    if (!manifest.context || manifest.context.length === 0) {
      await this.session.refreshSystemPrompt();
      return;
    }

    const prefix = normalizeExtensionPrefix(manifest.name);

    for (const contextBlock of manifest.context) {
      const label = `${prefix}_${contextBlock.label}`;
      this.session.removeContext(label);
      await this.session.addContext(label, {
        description: contextBlock.description,
        maxTokens: contextBlock.maxTokens
      });
    }

    await this.session.refreshSystemPrompt();
  }

  private async persistStateSnapshot(state: BookWormState) {
    await Promise.all([
      this.workspace.writeFile(LIBRARY_PATH, formatBookshelfMarkdown(state)),
      this.workspace.writeFile(
        PROFILE_PATH,
        JSON.stringify(
          {
            ownerName: state.ownerName,
            extensionCount: state.extensionCount,
            lastDigest: state.lastDigest
          },
          null,
          2
        )
      )
    ]);
  }

  private async persistExtensionSnapshot() {
    await this.workspace.writeFile(
      "/bookworm-extensions.json",
      JSON.stringify(this.listInstalledExtensions(), null, 2)
    );
  }

  async deliverReadingReminder(payload: { note: string }, schedule: Schedule<{ note: string }>) {
    const owner = this.currentState.ownerName || "reader";
    const scheduleLabel = buildReminderSummary(schedule).cadence;

    await this.saveMessages([
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [
          {
            type: "text",
            text: `BookWorm reminder for ${owner}: ${payload.note}. This reminder fired on the cadence ${scheduleLabel}. Respond like a thoughtful reading companion.`
          }
        ]
      }
    ]);
  }
}

export { HostBridgeLoopback };

export default {
  async fetch(request: Request, env: Env) {
    return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
