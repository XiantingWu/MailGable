import type { Row } from "../lib.js";

export type ParsedAddress = { name: string; address: string };
export type UploadAttachment = { filename: string; contentType: string; content: string; bytes: Uint8Array };
export type SendPlan = {
  body: Row;
  mailbox: Row;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  text: string;
  uploads: UploadAttachment[];
  parent: Row | null;
  threadId: string;
  requestHash: string;
};