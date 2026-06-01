/**
 * PDF text extraction via the optional `unpdf` dependency (bundles pdf.js,
 * zero-config). Lazy-loaded behind a function so the base install works without
 * it; callers degrade to an install-hint string when it is absent.
 */

/** Raised when the optional `unpdf` dependency is not installed. */
export class PdfExtractorUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfExtractorUnavailable";
  }
}

interface UnpdfModule {
  getDocumentProxy(data: Uint8Array): Promise<unknown>;
  extractText(
    data: unknown,
    options: { mergePages: true },
  ): Promise<{ totalPages: number; text: string }>;
}

let cached: UnpdfModule | null = null;

async function loadUnpdf(): Promise<UnpdfModule> {
  if (cached) return cached;
  // Non-literal specifier so tsc does not statically resolve the optional dep.
  const moduleName: string = "unpdf";
  try {
    const mod = (await import(moduleName)) as unknown as UnpdfModule;
    if (!mod.getDocumentProxy || !mod.extractText) {
      throw new PdfExtractorUnavailable("unpdf loaded but expected exports are missing");
    }
    cached = mod;
    return cached;
  } catch (err) {
    if (err instanceof PdfExtractorUnavailable) throw err;
    throw new PdfExtractorUnavailable(err instanceof Error ? err.message : "failed to load unpdf");
  }
}

/**
 * Extract merged page text from a PDF buffer. Returns the concatenated text and
 * total page count. Throws `PdfExtractorUnavailable` if `unpdf` is not present.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  const unpdf = await loadUnpdf();
  const pdf = await unpdf.getDocumentProxy(bytes);
  const { totalPages, text } = await unpdf.extractText(pdf, { mergePages: true });
  return { text, pages: totalPages };
}
