import { describe, expect, it } from "vitest";

import {
  aggregateAudiobookshelfCounts,
  classifyAudiobookshelfLibrary,
  fetchAudiobookshelfWidgetStats,
} from "./homepage-audiobookshelf-stats.mjs";

describe("classifyAudiobookshelfLibrary", () => {
  it("classifies podcast libraries as other", () => {
    expect(
      classifyAudiobookshelfLibrary({ name: "Podcasts", mediaType: "podcast", folders: [{ fullPath: "/podcasts" }] }),
    ).toBe("other");
  });

  it("classifies audiobook libraries by folder path and name", () => {
    expect(
      classifyAudiobookshelfLibrary({
        name: "My Library",
        mediaType: "book",
        folders: [{ fullPath: "/data/audiobooks" }],
      }),
    ).toBe("audiobooks");
    expect(classifyAudiobookshelfLibrary({ name: "Audiobooks", mediaType: "book", folders: [] })).toBe("audiobooks");
  });

  it("classifies ebook libraries by folder path and name", () => {
    expect(
      classifyAudiobookshelfLibrary({
        name: "Reading",
        mediaType: "book",
        folders: [{ fullPath: "/data/ebooks" }],
      }),
    ).toBe("ebooks");
    expect(classifyAudiobookshelfLibrary({ name: "Ebooks", mediaType: "book", folders: [] })).toBe("ebooks");
  });

  it("uses explicit library_buckets by exact name", () => {
    const buckets = {
      audiobooks: ["Spoken"],
      ebooks: ["Reading"],
      other: ["Podcasts"],
    };
    expect(classifyAudiobookshelfLibrary({ name: "Spoken", mediaType: "book" }, buckets)).toBe("audiobooks");
    expect(classifyAudiobookshelfLibrary({ name: "Reading", mediaType: "book" }, buckets)).toBe("ebooks");
    expect(classifyAudiobookshelfLibrary({ name: "Podcasts", mediaType: "podcast" }, buckets)).toBe("other");
  });

  it("falls back to heuristics when name is not in library_buckets", () => {
    const buckets = { audiobooks: ["Spoken"] };
    expect(
      classifyAudiobookshelfLibrary(
        { name: "Ebooks", mediaType: "book", folders: [{ fullPath: "/ebooks" }] },
        buckets,
      ),
    ).toBe("ebooks");
  });
});

describe("aggregateAudiobookshelfCounts", () => {
  it("sums totalItems per bucket", () => {
    const libraries = [
      { id: "lib-a", name: "Audiobooks", mediaType: "book", folders: [{ fullPath: "/audiobooks" }] },
      { id: "lib-e", name: "Ebooks", mediaType: "book", folders: [{ fullPath: "/ebooks" }] },
      { id: "lib-p", name: "Podcasts", mediaType: "podcast", folders: [{ fullPath: "/podcasts" }] },
    ];
    const stats = {
      "lib-a": { totalItems: 10, totalSize: 1_000_000_000 },
      "lib-e": { totalItems: 25, totalSize: 500_000_000 },
      "lib-p": { totalItems: 3, totalSize: 50_000_000 },
    };
    expect(aggregateAudiobookshelfCounts(libraries, stats)).toEqual({
      audiobooks: 10,
      ebooks: 25,
      other: 3,
      total_storage_bytes: 1_550_000_000,
    });
  });
});

describe("fetchAudiobookshelfWidgetStats", () => {
  it("fetches libraries and stats via injected requestFn", async () => {
    /** @type {Record<string, unknown>} */
    const responses = {
      "/api/libraries": {
        libraries: [
          { id: "lib-a", name: "Audiobooks", mediaType: "book", folders: [{ fullPath: "/audiobooks" }] },
          { id: "lib-p", name: "Podcasts", mediaType: "podcast", folders: [{ fullPath: "/podcasts" }] },
        ],
      },
      "/api/libraries/lib-a/stats": { totalItems: 7, totalSize: 7000 },
      "/api/libraries/lib-p/stats": { totalItems: 2, totalSize: 2000 },
    };

    async function requestFn(_url, _token, path) {
      return responses[path] ?? null;
    }

    const counts = await fetchAudiobookshelfWidgetStats({
      url: "http://10.0.0.160:13378",
      token: "test-token",
      requestFn,
    });

    expect(counts).toEqual({ audiobooks: 7, ebooks: 0, other: 2, total_storage_bytes: 9000 });
  });
});
