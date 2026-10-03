declare module "mammoth" {
  interface MammothInput {
    buffer?: Buffer;
    path?: string;
    arrayBuffer?: ArrayBuffer;
  }
  interface MammothMessage {
    type: string;
    message: string;
  }
  interface MammothResult {
    value: string;
    messages: MammothMessage[];
  }
  export function convertToMarkdown(input: MammothInput): Promise<MammothResult>;
  export function convertToHtml(input: MammothInput): Promise<MammothResult>;
  export function extractRawText(input: MammothInput): Promise<MammothResult>;
}
