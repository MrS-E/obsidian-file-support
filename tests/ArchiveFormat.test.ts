import { describe, expect, it } from "vitest";
import {
  getArchiveBadgeLabel,
  getArchiveCompressionFormat,
  isArchiveFilename,
  isTarArchiveFilename,
} from "../src/archives/format";

describe("ArchiveFormat", () => {
  describe("getArchiveCompressionFormat", () => {
    it("matches plain tar extensions", () => {
      expect(getArchiveCompressionFormat("archive.tar")).toBe("plain");
      expect(getArchiveCompressionFormat("path/to/archive.TAR")).toBe("plain");
    });

    it("matches gzip compound and single extensions", () => {
      expect(getArchiveCompressionFormat("data.tar.gz")).toBe("gzip");
      expect(getArchiveCompressionFormat("bundle.tgz")).toBe("gzip");
      expect(getArchiveCompressionFormat("standalone.gz")).toBe("gzip");
      expect(getArchiveCompressionFormat("nested/PATH/file.TAR.GZ")).toBe("gzip");
    });

    it("matches bzip2 compound and single extensions", () => {
      expect(getArchiveCompressionFormat("data.tar.bz2")).toBe("bzip2");
      expect(getArchiveCompressionFormat("data.tbz2")).toBe("bzip2");
      expect(getArchiveCompressionFormat("data.tbz")).toBe("bzip2");
      expect(getArchiveCompressionFormat("data.bz2")).toBe("bzip2");
    });

    it("matches xz compound and single extensions", () => {
      expect(getArchiveCompressionFormat("data.tar.xz")).toBe("xz");
      expect(getArchiveCompressionFormat("data.txz")).toBe("xz");
      expect(getArchiveCompressionFormat("data.xz")).toBe("xz");
    });

    it("matches zstd compound and single extensions", () => {
      expect(getArchiveCompressionFormat("data.tar.zst")).toBe("zstd");
      expect(getArchiveCompressionFormat("data.tzst")).toBe("zstd");
      expect(getArchiveCompressionFormat("data.zst")).toBe("zstd");
    });

    it("returns null for non-archive filenames", () => {
      expect(getArchiveCompressionFormat("readme.md")).toBeNull();
      expect(getArchiveCompressionFormat("document.txt")).toBeNull();
      expect(getArchiveCompressionFormat("archive.zip")).toBeNull();
      expect(getArchiveCompressionFormat("file-without-extension")).toBeNull();
      expect(getArchiveCompressionFormat("")).toBeNull();
    });
  });

  describe("isTarArchiveFilename", () => {
    it("returns true for compound TAR names", () => {
      expect(isTarArchiveFilename("archive.tar")).toBe(true);
      expect(isTarArchiveFilename("archive.tar.gz")).toBe(true);
      expect(isTarArchiveFilename("archive.tgz")).toBe(true);
      expect(isTarArchiveFilename("archive.tar.bz2")).toBe(true);
      expect(isTarArchiveFilename("archive.tbz2")).toBe(true);
      expect(isTarArchiveFilename("archive.tbz")).toBe(true);
      expect(isTarArchiveFilename("archive.tar.xz")).toBe(true);
      expect(isTarArchiveFilename("archive.txz")).toBe(true);
      expect(isTarArchiveFilename("archive.tar.zst")).toBe(true);
      expect(isTarArchiveFilename("archive.tzst")).toBe(true);
    });

    it("returns false for bare compressed files without tar indicator", () => {
      expect(isTarArchiveFilename("data.gz")).toBe(false);
      expect(isTarArchiveFilename("data.bz2")).toBe(false);
      expect(isTarArchiveFilename("data.xz")).toBe(false);
      expect(isTarArchiveFilename("data.zst")).toBe(false);
      expect(isTarArchiveFilename("data.txt")).toBe(false);
    });
  });

  describe("isArchiveFilename", () => {
    it("returns true for any supported archive or compressed stream", () => {
      expect(isArchiveFilename("a.tar")).toBe(true);
      expect(isArchiveFilename("a.tar.gz")).toBe(true);
      expect(isArchiveFilename("a.gz")).toBe(true);
      expect(isArchiveFilename("a.tar.bz2")).toBe(true);
      expect(isArchiveFilename("a.bz2")).toBe(true);
      expect(isArchiveFilename("a.tar.xz")).toBe(true);
      expect(isArchiveFilename("a.xz")).toBe(true);
      expect(isArchiveFilename("a.tar.zst")).toBe(true);
      expect(isArchiveFilename("a.zst")).toBe(true);
    });

    it("returns false for unsupported files", () => {
      expect(isArchiveFilename("a.zip")).toBe(false);
      expect(isArchiveFilename("a.7z")).toBe(false);
      expect(isArchiveFilename("a.rar")).toBe(false);
    });
  });

  describe("getArchiveBadgeLabel", () => {
    it("returns correct short badges", () => {
      expect(getArchiveBadgeLabel("plain")).toBe("TAR");
      expect(getArchiveBadgeLabel("gzip")).toBe("TGZ");
      expect(getArchiveBadgeLabel("bzip2")).toBe("TBZ2");
      expect(getArchiveBadgeLabel("xz")).toBe("TXZ");
      expect(getArchiveBadgeLabel("zstd")).toBe("TZST");
    });
  });
});
