export const BOOK_STATUSES = ["to-read", "reading", "read"] as const;

export type BookStatus = (typeof BOOK_STATUSES)[number];

export type DigestStatus = {
  status: "idle" | "running" | "ready" | "interrupted";
  generatedAt: string | null;
  path: string | null;
  note: string;
};

export type BookEntry = {
  id: string;
  title: string;
  author: string;
  openLibraryWorkKey?: string | null;
  openLibraryUrl?: string | null;
  coverImageUrl?: string | null;
  status: BookStatus;
  review: string | null;
  rating: number | null;
  notes: string | null;
  addedAt: string;
  updatedAt: string;
};

export type BookWormState = {
  ownerName: string;
  books: BookEntry[];
  extensionCount: number;
  lastDigest: DigestStatus;
};

export type ReminderSummary = {
  id: string;
  callback: string;
  kind: "scheduled" | "delayed" | "cron" | "interval";
  nextRunAt: string;
  note: string;
  cadence: string;
};

export type ExtensionSummary = {
  name: string;
  version: string;
  description?: string;
  tools: string[];
  permissions: {
    workspace?: "read" | "read-write" | "none";
    network?: string[];
  };
};

export const EMPTY_DIGEST: DigestStatus = {
  status: "idle",
  generatedAt: null,
  path: null,
  note: "No reading digest has been generated yet."
};

export const INITIAL_BOOKWORM_STATE: BookWormState = {
  ownerName: "",
  books: [],
  extensionCount: 0,
  lastDigest: EMPTY_DIGEST
};

export function normalizeAgentName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return normalized || "reader";
}

export function makeBookLookupKey(title: string, author?: string): string {
  return `${title.trim().toLowerCase()}::${(author ?? "").trim().toLowerCase()}`;
}

export function groupBooks(books: BookEntry[]): Record<BookStatus, BookEntry[]> {
  return {
    "to-read": books.filter((book) => book.status === "to-read"),
    reading: books.filter((book) => book.status === "reading"),
    read: books.filter((book) => book.status === "read")
  };
}

export function formatRelativeShelfLabel(status: BookStatus): string {
  if (status === "to-read") return "To Read";
  if (status === "reading") return "Reading Now";
  return "Read & Reviewed";
}

export function formatTimestamp(value: string | null): string {
  if (!value) return "Not set";

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}
