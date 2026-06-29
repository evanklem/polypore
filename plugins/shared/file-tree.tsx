import React, { useState } from 'react';
import type { FileNode } from './index';

export type FileMeta = {
  status?: 'M' | 'A' | 'D';
  diagnostics?: number;
};

export type FileTreeContextInfo =
  | { kind: 'folder'; path: string }
  | { kind: 'file'; path: string; folderPath: string };

export type FileTreeProps = {
  nodes: FileNode[];
  activePath?: string;
  onSelect?: (path: string) => void;
  draggable?: boolean;
  dragMime?: string;
  depth?: number;
  defaultExpanded?: boolean;
  metaFor?: (path: string) => FileMeta | undefined;
  basePath?: string;
  onContextMenu?: (e: React.MouseEvent, info: FileTreeContextInfo) => void;
  /* opt-in lazy loading: when set, a folder's children are requested via
     onExpand(folderPath) on first expand instead of being walked up front.
     Omit it for eager trees whose children are already fully resolved. */
  onExpand?: (folderPath: string) => void;
};

export function FileTree({
  nodes,
  activePath,
  onSelect,
  draggable = false,
  dragMime,
  depth = 0,
  defaultExpanded = false,
  metaFor,
  basePath = '',
  onContextMenu,
  onExpand,
}: FileTreeProps) {
  return (
    <div className="file-tree" role={depth === 0 ? 'tree' : 'group'}>
      {nodes.map((node) =>
        node.kind === 'folder' ? (
          <FileTreeFolder
            key={`f-${depth}-${node.name}`}
            node={node}
            depth={depth}
            activePath={activePath}
            onSelect={onSelect}
            draggable={draggable}
            dragMime={dragMime}
            defaultExpanded={defaultExpanded}
            metaFor={metaFor}
            basePath={basePath}
            onContextMenu={onContextMenu}
            onExpand={onExpand}
          />
        ) : (
          <FileTreeFile
            key={`x-${node.path}`}
            node={node}
            depth={depth}
            active={node.path === activePath}
            onSelect={onSelect}
            draggable={draggable}
            dragMime={dragMime}
            meta={metaFor?.(node.path)}
            folderPath={basePath}
            onContextMenu={onContextMenu}
          />
        ),
      )}
    </div>
  );
}

function FileTreeFolder({
  node,
  depth,
  activePath,
  onSelect,
  draggable,
  dragMime,
  defaultExpanded,
  metaFor,
  basePath,
  onContextMenu,
  onExpand,
}: {
  node: Extract<FileNode, { kind: 'folder' }>;
  depth: number;
  activePath?: string;
  onSelect?: (path: string) => void;
  draggable: boolean;
  dragMime?: string;
  defaultExpanded: boolean;
  metaFor?: (path: string) => FileMeta | undefined;
  basePath: string;
  onContextMenu?: (e: React.MouseEvent, info: FileTreeContextInfo) => void;
  onExpand?: (folderPath: string) => void;
}) {
  const [open, setOpen] = useState(defaultExpanded);
  const folderPath = basePath ? `${basePath}/${node.name}` : node.name;
  // lazy mode reveals child count only once the level has been resolved
  const showCount = !onExpand || node.loaded;

  const toggle = () => {
    setOpen((v) => {
      const next = !v;
      if (next && onExpand && !node.loaded) onExpand(folderPath);
      return next;
    });
  };

  return (
    <div className="file-tree__folder" role="treeitem" aria-expanded={open}>
      <button
        type="button"
        className="file-tree__row file-tree__row--folder"
        style={{ paddingLeft: 6 + depth * 12 }}
        title={folderPath}
        onClick={toggle}
        onContextMenu={
          onContextMenu
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                onContextMenu(e, { kind: 'folder', path: folderPath });
              }
            : undefined
        }
      >
        <span className="file-tree__chevron" aria-hidden="true">{open ? 'v' : '>'}</span>
        <span className="file-tree__icon file-tree__icon--folder" aria-hidden="true" />
        <span className="file-tree__label">{node.name}</span>
        {showCount && <small className="file-tree__count">{node.children.length}</small>}
      </button>
      {open && (
        <FileTree
          nodes={node.children}
          activePath={activePath}
          onSelect={onSelect}
          draggable={draggable}
          dragMime={dragMime}
          depth={depth + 1}
          defaultExpanded={defaultExpanded}
          metaFor={metaFor}
          basePath={folderPath}
          onContextMenu={onContextMenu}
          onExpand={onExpand}
        />
      )}
    </div>
  );
}

function FileTreeFile({
  node,
  depth,
  active,
  onSelect,
  draggable,
  dragMime,
  meta,
  folderPath,
  onContextMenu,
}: {
  node: Extract<FileNode, { kind: 'file' }>;
  depth: number;
  active: boolean;
  onSelect?: (path: string) => void;
  draggable: boolean;
  dragMime?: string;
  meta?: FileMeta;
  folderPath: string;
  onContextMenu?: (e: React.MouseEvent, info: FileTreeContextInfo) => void;
}) {
  const ftype = fileExtType(node.name);
  return (
    <button
      type="button"
      data-ftype={ftype}
      className={`file-tree__row file-tree__row--file ${active ? 'file-tree__row--active' : ''}`}
      style={{ paddingLeft: 8 + depth * 12 }}
      title={node.path}
      onClick={() => onSelect?.(node.path)}
      draggable={draggable}
      onDragStart={
        draggable && dragMime
          ? (event) => {
              event.dataTransfer.effectAllowed = 'copy';
              event.dataTransfer.setData(dragMime, node.path);
              event.dataTransfer.setData('text/plain', node.path);
            }
          : undefined
      }
      onContextMenu={
        onContextMenu
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              onContextMenu(e, { kind: 'file', path: node.path, folderPath });
            }
          : undefined
      }
    >
      <span className="file-tree__icon file-tree__icon--file" aria-hidden="true" />
      <span className="file-tree__label">{node.name}</span>
      {meta?.status && <small className={`file-tree__badge file-tree__badge--${meta.status.toLowerCase()}`}>{meta.status}</small>}
      {meta?.diagnostics && <small className="file-tree__badge file-tree__badge--diagnostic">!</small>}
      <small className="file-tree__path">{node.path}</small>
    </button>
  );
}

function fileExtType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.lock') || lower === 'package-lock.json' || lower === 'pnpm-lock.yaml' || lower === 'cargo.lock') return 'lock';
  if (lower.startsWith('.env') || lower === '.env') return 'env';
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return 'plain';
  return lower.slice(dot + 1);
}
