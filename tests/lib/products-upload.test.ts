import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock supabase before importing lib/products, matching tests/lib/products.test.ts
const mockStorageFrom = {
  upload: vi.fn(),
  getPublicUrl: vi.fn(),
  remove: vi.fn(),
};

vi.mock("../../lib/supabase", () => ({
  supabase: {
    from: vi.fn(),
    storage: {
      from: (bucket: string) => mockStorageFrom,
    },
  },
}));

import {
  uploadProductImage,
  validateProductImage,
  ALLOWED_PRODUCT_IMAGE_TYPES,
  MAX_PRODUCT_IMAGE_BYTES,
} from "../../lib/products";

const pngFile = () => new File(["x"], "product.png", { type: "image/png" });

describe("uploadProductImage image validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStorageFrom.upload.mockResolvedValue({ data: { path: "stored.png" }, error: null });
    mockStorageFrom.getPublicUrl.mockReturnValue({
      data: {
        publicUrl: "https://proj.supabase.co/storage/v1/object/public/products/stored.png",
      },
    });
  });

  it.each(["image/svg+xml", "text/html", "application/pdf", "image/gif", ""])(
    "rejects a file whose MIME type is not on the allow-list: %s",
    async (type) => {
      const file = new File(["<svg onload=alert(1)/>"], "product.png", { type });

      await expect(uploadProductImage(file)).rejects.toThrow(/PNG, JPEG or WebP/);
      // The rejected payload must never reach storage.
      expect(mockStorageFrom.upload).not.toHaveBeenCalled();
    }
  );

  it("rejects an image above the size limit before uploading", async () => {
    const file = pngFile();
    Object.defineProperty(file, "size", { value: MAX_PRODUCT_IMAGE_BYTES + 1 });

    await expect(uploadProductImage(file)).rejects.toThrow(/too large/);
    expect(mockStorageFrom.upload).not.toHaveBeenCalled();
  });

  it("rejects a value that is not a file", async () => {
    await expect(uploadProductImage(undefined)).rejects.toThrow(/choose an image file/);
  });

  it("derives the stored extension from the MIME type, not the filename", async () => {
    // A JPEG renamed to .png must still be stored (and served) as a JPEG.
    const file = new File(["jpeg-bytes"], "product.png", { type: "image/jpeg" });

    const url = await uploadProductImage(file);

    const [path, fileArg, options] = mockStorageFrom.upload.mock.calls[0];
    expect(path).toMatch(/^\d+-[a-z0-9]+\.jpg$/);
    expect(fileArg).toBe(file);
    expect(options).toEqual({
      cacheControl: "3600",
      upsert: false,
      contentType: "image/jpeg",
    });
    expect(url).toBe(
      "https://proj.supabase.co/storage/v1/object/public/products/stored.png"
    );
  });

  it("normalizes the MIME type before matching the allow-list", async () => {
    await uploadProductImage(new File(["webp-bytes"], "shot.WEBP", { type: "IMAGE/WEBP" }));

    const [path, , options] = mockStorageFrom.upload.mock.calls[0];
    expect(path).toMatch(/\.webp$/);
    expect(options.contentType).toBe("image/webp");
  });

  it("accepts every allow-listed type with the matching extension", async () => {
    for (const [type, ext] of Object.entries(ALLOWED_PRODUCT_IMAGE_TYPES)) {
      vi.clearAllMocks();
      await uploadProductImage(new File(["bytes"], "upload", { type }));

      const [path, , options] = mockStorageFrom.upload.mock.calls[0];
      expect(path).toMatch(new RegExp(`\\.${ext}$`));
      expect(options.contentType).toBe(type);
    }
  });

  it("reports the validated type, extension and size", () => {
    expect(validateProductImage(pngFile())).toEqual({
      type: "image/png",
      ext: "png",
      size: 1,
    });
  });
});
