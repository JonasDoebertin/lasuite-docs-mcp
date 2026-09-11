import { CommentsExtension, DefaultThreadStoreAuth } from '@blocknote/core/comments';
import { YjsThreadStore } from '@blocknote/core/yjs';
import { ServerBlockNoteEditor } from '@blocknote/server-util';
import * as Y from 'yjs';

import {
  docsBlockNoteSchema,
  type DocsBlockSchema,
  type DocsInlineContentSchema,
  type DocsStyleSchema,
} from './schema.js';

export const YJS_FRAGMENT_KEY = 'document-store';

// The "comment" mark must exist in the editor schema. A mark with no matching
// type is dropped by y-prosemirror together with the text it wraps, which would
// empty out every commented block on read. Registering CommentsExtension is the
// only supported way to add it. The thread store is never exercised during
// conversion; it exists to satisfy the extension's constructor.
const commentsThreadStore = new YjsThreadStore(
  'lasuite-docs-mcp',
  new Y.Doc().getMap('comment-threads'),
  new DefaultThreadStoreAuth('lasuite-docs-mcp', 'editor'),
);

export const editor = ServerBlockNoteEditor.create<
  DocsBlockSchema,
  DocsInlineContentSchema,
  DocsStyleSchema
>({
  schema: docsBlockNoteSchema,
  extensions: [
    CommentsExtension({
      threadStore: commentsThreadStore,
      resolveUsers: (userIds) =>
        Promise.resolve(userIds.map((id) => ({ id, username: id, avatarUrl: '' }))),
    }),
  ],
});
