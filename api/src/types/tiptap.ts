/**
 * TipTap / ProseMirror JSON content types.
 *
 * These replace the many `any` annotations used when building or reading
 * TipTap document structures throughout the API and the Yjs converter.
 */

/** A text formatting mark (bold, italic, link, etc.) */
export interface TipTapMark {
  type: string;
  attrs?: Record<string, unknown>;
}

/** A single node in the TipTap document tree */
export interface TipTapNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TipTapNode[];
  text?: string;
  marks?: TipTapMark[];
}

/** Top-level TipTap document (type is always "doc") */
export interface TipTapDocument {
  type: 'doc';
  content: TipTapNode[];
}
