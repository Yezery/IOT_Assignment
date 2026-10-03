declare module "pdf-parse/lib/pdf-parse.js" {
  interface PdfParseResult {
    text: string;
    numpages: number;
    info: unknown;
  }
  function pdfParse(buffer: Buffer, options?: unknown): Promise<PdfParseResult>;
  export default pdfParse;
}
