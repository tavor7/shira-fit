/** No-op digital signature provider — replace with Israeli provider later. */
export type DocumentSignMetadata = {
  document_id: string;
  document_number: string;
};

export type SignedPdfResult = {
  pdfBytes: Uint8Array;
  provider: string | null;
  signedAt: string | null;
};

export interface SignatureProvider {
  sign(pdfBytes: Uint8Array, metadata: DocumentSignMetadata): Promise<SignedPdfResult>;
}

export class NoOpSignatureProvider implements SignatureProvider {
  async sign(pdfBytes: Uint8Array, _metadata: DocumentSignMetadata): Promise<SignedPdfResult> {
    return { pdfBytes, provider: null, signedAt: null };
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
