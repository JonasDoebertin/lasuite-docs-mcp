export interface DocumentSummary {
  id: string;
  title: string;
  path?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface TreeNode {
  id: string;
  title: string;
  children: TreeNode[];
}

export interface ContentWithEtag {
  base64: string;
  etag: string | null;
}
