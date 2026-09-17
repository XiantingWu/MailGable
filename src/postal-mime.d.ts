declare module "postal-mime" {
  export type Address = { name?: string; address: string } | { name?: string; group: Address[] };
  export type Attachment = {
    filename?: string;
    mimeType?: string;
    disposition?: string;
    contentId?: string;
    related?: boolean;
    encoding?: string;
    content: Uint8Array | ArrayBuffer | string;
  };
  export type Email = {
    headers: Array<{ key: string; value: string }>;
    headerLines: unknown[];
    attachments: Attachment[];
    text?: string;
    html?: string;
    subject?: string;
    from?: Address | Address[];
    replyTo?: Address | Address[];
    to?: Address | Address[];
    cc?: Address | Address[];
    bcc?: Address | Address[];
  };
  const PostalMime: {
    parse(input: Uint8Array | ArrayBuffer, options?: { attachmentEncoding?: string }): Promise<Email>;
  };
  export default PostalMime;
}
